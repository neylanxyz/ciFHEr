use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount, Transfer as SolTransfer};

const TRANSFER_FEE: u64 = 5_000_000; // 0.005 SOL

declare_id!("86C1FkYaVUjV2wyWmRMrnGhXGNNpnH9aFLAJQKkAtf6u");

// discriminator(8) + authority(32) + denomination(8) + bump(1)
const MINT_SPACE: usize = 8 + 32 + 8 + 1;
// discriminator(8) + owner(32) + balance_len(4) + bump(1)
// Raw ciphertext bytes are stored at offset 45+ in the account data (not in the struct).
const ACCOUNT_INIT_SPACE: usize = 8 + 32 + 4 + 1;

#[program]
pub mod confidential_token {
    use super::*;

    pub fn initialize_mint(ctx: Context<InitializeMint>, denomination: u64) -> Result<()> {
        let mint = &mut ctx.accounts.confidential_mint;
        mint.authority = ctx.accounts.authority.key();
        mint.denomination = denomination;
        mint.bump = ctx.bumps.confidential_mint;

        let mint_key = mint.key();
        let vault_bump = ctx.bumps.vault;
        let vault_seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), &[vault_bump]];
        let rent = Rent::get()?.minimum_balance(0);
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            rent,
            0,
            &System::id(),
        )?;
        Ok(())
    }

    pub fn initialize_account(ctx: Context<InitializeAccount>) -> Result<()> {
        let account = &mut ctx.accounts.confidential_account;
        account.owner = ctx.accounts.owner.key();
        account.balance_len = 0;
        account.bump = ctx.bumps.confidential_account;
        Ok(())
    }

    pub fn mint_request(ctx: Context<MintRequest>) -> Result<()> {
        let denomination = ctx.accounts.confidential_mint.denomination;
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            denomination,
        )?;
        emit!(MintRequested {
            user: ctx.accounts.user.key(),
            amount_lamports: denomination,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    // User signals transfer intent; amount + recipient are registered with worker out-of-band.
    // Worker handles all FHE: decrypts sender balance, re-encrypts new balances, writes chunks.
    pub fn transfer_request(ctx: Context<TransferRequest>, recipient: Pubkey) -> Result<()> {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            TRANSFER_FEE,
        )?;
        emit!(TransferRequested {
            sender: ctx.accounts.user.key(),
            recipient,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn burn_request(ctx: Context<BurnRequest>) -> Result<()> {
        emit!(BurnRequested {
            user: ctx.accounts.user.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    // WORKER: Shrink user account to ACCOUNT_INIT_SPACE and clear balance_len.
    // This returns excess rent lamports to the authority payer.
    // Each subsequent write_balance_chunk grows the account by at most CHUNK_SIZE (880 bytes),
    // staying well under Solana's 10 KB per-tx realloc limit.
    pub fn begin_write_balance(ctx: Context<BeginWriteBalance>, _new_size: u32) -> Result<()> {
        ctx.accounts.user_account.balance_len = 0;
        Ok(())
    }

    // WORKER: Append a chunk of the FHE ciphertext directly to the account data.
    // Bypasses Vec<u8> deserialization to avoid BPF heap exhaustion with 16 KB ciphertexts.
    // Chunks must be written sequentially; offset must equal the current balance_len.
    pub fn write_balance_chunk(
        ctx: Context<WriteBalanceChunk>,
        offset: u32,
        chunk: Vec<u8>,
    ) -> Result<()> {
        let current_len = ctx.accounts.user_account.balance_len;
        require!(offset == current_len, ConfidentialTokenError::OutOfBounds);

        // Write directly to the raw account data, skipping Vec deserialization.
        // The account was realloc'd to ACCOUNT_INIT_SPACE + current_len + chunk.len().
        {
            let info = ctx.accounts.user_account.to_account_info();
            let mut data = info.data.borrow_mut();
            let start = ACCOUNT_INIT_SPACE + current_len as usize;
            let end = start + chunk.len();
            data[start..end].copy_from_slice(&chunk);
        }

        ctx.accounts.user_account.balance_len += chunk.len() as u32;
        Ok(())
    }

    // WORKER: Transfer SOL from the vault to the user and shrink the user account.
    pub fn fulfill_burn(ctx: Context<FulfillBurn>, sol_to_send: u64) -> Result<()> {
        ctx.accounts.user_account.balance_len = 0;

        let mint_key = ctx.accounts.confidential_mint.key();
        let vault_bump = ctx.bumps.vault;
        let vault_seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), &[vault_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user.to_account_info(),
                },
                &[vault_seeds],
            ),
            sol_to_send,
        )?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account structs
// ---------------------------------------------------------------------------

#[account]
pub struct ConfidentialMint {
    pub authority: Pubkey,
    pub denomination: u64,
    pub bump: u8,
}

// balance_len tracks the byte length of the FHE ciphertext stored in the
// account data at offset ACCOUNT_INIT_SPACE (45 bytes). The raw bytes are
// written directly by write_balance_chunk to avoid BPF heap limits.
#[account]
pub struct ConfidentialAccount {
    pub owner: Pubkey,
    pub balance_len: u32,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Accounts contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeMint<'info> {
    #[account(
        init,
        payer = authority,
        space = MINT_SPACE,
        seeds = [b"mint"],
        bump,
    )]
    pub confidential_mint: Account<'info, ConfidentialMint>,

    /// CHECK: PDA vault; space=0, owned by System. Created via CPI in this instruction.
    #[account(
        mut,
        seeds = [b"vault", confidential_mint.key().as_ref()],
        bump,
    )]
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeAccount<'info> {
    #[account(seeds = [b"mint"], bump = confidential_mint.bump)]
    pub confidential_mint: Account<'info, ConfidentialMint>,

    #[account(
        init,
        payer = owner,
        space = ACCOUNT_INIT_SPACE,
        seeds = [b"account", confidential_mint.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub confidential_account: Account<'info, ConfidentialAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintRequest<'info> {
    #[account(seeds = [b"mint"], bump = confidential_mint.bump)]
    pub confidential_mint: Account<'info, ConfidentialMint>,

    /// CHECK: PDA vault; seeds verified.
    #[account(
        mut,
        seeds = [b"vault", confidential_mint.key().as_ref()],
        bump,
    )]
    pub vault: UncheckedAccount<'info>,

    #[account(
        seeds = [b"account", confidential_mint.key().as_ref(), user.key().as_ref()],
        bump = user_account.bump,
    )]
    pub user_account: Account<'info, ConfidentialAccount>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferRequest<'info> {
    #[account(seeds = [b"mint"], bump = confidential_mint.bump)]
    pub confidential_mint: Account<'info, ConfidentialMint>,

    #[account(
        seeds = [b"account", confidential_mint.key().as_ref(), user.key().as_ref()],
        bump = user_account.bump,
    )]
    pub user_account: Account<'info, ConfidentialAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    /// Fee recipient — must be the mint authority (worker).
    #[account(
        mut,
        constraint = treasury.key() == confidential_mint.authority @ ConfidentialTokenError::Unauthorized,
    )]
    pub treasury: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BurnRequest<'info> {
    #[account(seeds = [b"mint"], bump = confidential_mint.bump)]
    pub confidential_mint: Account<'info, ConfidentialMint>,

    #[account(
        seeds = [b"account", confidential_mint.key().as_ref(), user.key().as_ref()],
        bump = user_account.bump,
    )]
    pub user_account: Account<'info, ConfidentialAccount>,

    pub user: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(_new_size: u32)]
pub struct BeginWriteBalance<'info> {
    #[account(
        seeds = [b"mint"],
        bump = confidential_mint.bump,
        constraint = confidential_mint.authority == authority.key() @ ConfidentialTokenError::Unauthorized,
    )]
    pub confidential_mint: Account<'info, ConfidentialMint>,

    // Shrink to baseline so each write_balance_chunk grows by ≤880 bytes.
    #[account(
        mut,
        realloc = ACCOUNT_INIT_SPACE,
        realloc::payer = authority,
        realloc::zero = false,
        seeds = [b"account", confidential_mint.key().as_ref(), user_account.owner.as_ref()],
        bump = user_account.bump,
    )]
    pub user_account: Account<'info, ConfidentialAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(offset: u32, chunk: Vec<u8>)]
pub struct WriteBalanceChunk<'info> {
    #[account(
        seeds = [b"mint"],
        bump = confidential_mint.bump,
        constraint = confidential_mint.authority == authority.key() @ ConfidentialTokenError::Unauthorized,
    )]
    pub confidential_mint: Account<'info, ConfidentialMint>,

    // Grow by chunk.len() per call; at most 880 bytes per transaction.
    #[account(
        mut,
        realloc = ACCOUNT_INIT_SPACE + user_account.balance_len as usize + chunk.len(),
        realloc::payer = authority,
        realloc::zero = false,
        seeds = [b"account", confidential_mint.key().as_ref(), user_account.owner.as_ref()],
        bump = user_account.bump,
    )]
    pub user_account: Account<'info, ConfidentialAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FulfillBurn<'info> {
    #[account(
        seeds = [b"mint"],
        bump = confidential_mint.bump,
        constraint = confidential_mint.authority == authority.key() @ ConfidentialTokenError::Unauthorized,
    )]
    pub confidential_mint: Account<'info, ConfidentialMint>,

    #[account(
        mut,
        realloc = ACCOUNT_INIT_SPACE,
        realloc::payer = authority,
        realloc::zero = false,
        seeds = [b"account", confidential_mint.key().as_ref(), user_account.owner.as_ref()],
        bump = user_account.bump,
    )]
    pub user_account: Account<'info, ConfidentialAccount>,

    /// CHECK: PDA vault; seeds verified.
    #[account(
        mut,
        seeds = [b"vault", confidential_mint.key().as_ref()],
        bump,
    )]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: Destination wallet for SOL payout.
    #[account(mut)]
    pub user: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct MintRequested {
    pub user: Pubkey,
    pub amount_lamports: u64,
    pub timestamp: i64,
}

#[event]
pub struct TransferRequested {
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct BurnRequested {
    pub user: Pubkey,
    pub timestamp: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum ConfidentialTokenError {
    #[msg("Only the worker authority can call this instruction")]
    Unauthorized,
    #[msg("Chunk write out of bounds")]
    OutOfBounds,
}
