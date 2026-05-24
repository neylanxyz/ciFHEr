use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount, Transfer as SolTransfer};

const SWAP_FEE_BPS: u64 = 30; // 0.30 %

declare_id!("A2vktybx3Nahc7THvSckeVioTobVkHNEXM5ZteGkoLDK");

// discriminator(8) + worker_authority(32) + token_mint(32) +
// token_reserve_len(4) + sol_reserve(8) +
// price_numerator(8) + price_denominator(8) + bump(1)
// Raw ciphertext bytes are stored at offset 101+ in the account data.
const POOL_INIT_SPACE: usize = 8 + 32 + 32 + 4 + 8 + 8 + 8 + 1;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum SwapType {
    SolForToken,
    TokenForSol,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct PoolInitialized {
    pub worker_authority: Pubkey,
    pub token_mint: Pubkey,
    pub price_numerator: u64,
    pub price_denominator: u64,
    pub timestamp: i64,
}

#[event]
pub struct SwapSolForTokenRequested {
    pub user: Pubkey,
    pub sol_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct SwapTokenForSolRequested {
    pub user: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct SwapFulfilled {
    pub user: Pubkey,
    pub swap_type: SwapType,
    pub timestamp: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum ConfidentialSwapError {
    #[msg("Only the worker authority can call this instruction")]
    Unauthorized,
    #[msg("Insufficient SOL in pool")]
    InsufficientSolReserve,
    #[msg("Zero amount not allowed")]
    ZeroAmount,
    #[msg("Chunk write out of bounds")]
    OutOfBounds,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// token_reserve_len tracks the byte length of the FHE ciphertext stored in
// the pool account data at offset POOL_INIT_SPACE (101 bytes). Raw bytes are
// written directly by write_pool_reserve_chunk to avoid BPF heap limits.
#[account]
pub struct SwapPool {
    pub worker_authority: Pubkey,
    pub token_mint: Pubkey,
    pub token_reserve_len: u32,
    pub sol_reserve: u64,
    pub price_numerator: u64,
    pub price_denominator: u64,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod confidential_swap {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        price_numerator: u64,
        price_denominator: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.worker_authority = ctx.accounts.worker_authority.key();
        pool.token_mint = ctx.accounts.token_mint.key();
        pool.token_reserve_len = 0;
        pool.sol_reserve = 0;
        pool.price_numerator = price_numerator;
        pool.price_denominator = price_denominator;
        pool.bump = ctx.bumps.pool;

        let pool_key = pool.key();
        let vault_bump = ctx.bumps.swap_vault;
        let vault_seeds: &[&[u8]] = &[b"swap_vault", pool_key.as_ref(), &[vault_bump]];
        let rent = Rent::get()?.minimum_balance(0);
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.worker_authority.to_account_info(),
                    to: ctx.accounts.swap_vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            rent,
            0,
            &System::id(),
        )?;

        emit!(PoolInitialized {
            worker_authority: pool.worker_authority,
            token_mint: pool.token_mint,
            price_numerator,
            price_denominator,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    // sol_amount = what the user wants to swap (goes to vault 1:1).
    // Fee (0.3% of sol_amount) is charged on top and sent to treasury.
    // Total deducted from user = sol_amount + fee.
    pub fn swap_sol_for_token(ctx: Context<SwapSolForToken>, sol_amount: u64) -> Result<()> {
        require!(sol_amount > 0, ConfidentialSwapError::ZeroAmount);

        let fee = sol_amount * SWAP_FEE_BPS / 10_000;

        // Full swap amount → vault (backs the token 1:1)
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.swap_vault.to_account_info(),
                },
            ),
            sol_amount,
        )?;

        // Fee on top → treasury
        if fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    SolTransfer {
                        from: ctx.accounts.user.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                    },
                ),
                fee,
            )?;
        }

        let pool = &mut ctx.accounts.pool;
        pool.sol_reserve = pool.sol_reserve.checked_add(sol_amount).unwrap();

        emit!(SwapSolForTokenRequested {
            user: ctx.accounts.user.key(),
            sol_amount,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn swap_token_for_sol_request(ctx: Context<SwapTokenForSolRequest>) -> Result<()> {
        emit!(SwapTokenForSolRequested {
            user: ctx.accounts.user.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    // WORKER: Shrink pool account to POOL_INIT_SPACE and clear token_reserve_len.
    pub fn begin_write_pool_reserve(
        ctx: Context<BeginWritePoolReserve>,
        _new_size: u32,
    ) -> Result<()> {
        ctx.accounts.pool.token_reserve_len = 0;
        Ok(())
    }

    // WORKER: Append a chunk of the FHE ciphertext directly to the pool account data.
    // Bypasses Vec<u8> to avoid BPF heap exhaustion. Sequential writes only.
    pub fn write_pool_reserve_chunk(
        ctx: Context<WritePoolReserveChunk>,
        offset: u32,
        chunk: Vec<u8>,
    ) -> Result<()> {
        let current_len = ctx.accounts.pool.token_reserve_len;
        require!(offset == current_len, ConfidentialSwapError::OutOfBounds);

        {
            let info = ctx.accounts.pool.to_account_info();
            let mut data = info.data.borrow_mut();
            let start = POOL_INIT_SPACE + current_len as usize;
            let end = start + chunk.len();
            data[start..end].copy_from_slice(&chunk);
        }

        ctx.accounts.pool.token_reserve_len += chunk.len() as u32;
        Ok(())
    }

    // WORKER: Transfer SOL from swap vault to user and update sol_reserve.
    pub fn fulfill_token_for_sol(
        ctx: Context<FulfillTokenForSol>,
        sol_amount_to_send: u64,
    ) -> Result<()> {
        require!(sol_amount_to_send > 0, ConfidentialSwapError::ZeroAmount);
        {
            let pool = &ctx.accounts.pool;
            require!(
                pool.sol_reserve >= sol_amount_to_send,
                ConfidentialSwapError::InsufficientSolReserve
            );
        }

        let pool_key = ctx.accounts.pool.key();
        let vault_bump = ctx.bumps.swap_vault;
        let seeds: &[&[u8]] = &[b"swap_vault", pool_key.as_ref(), &[vault_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.swap_vault.to_account_info(),
                    to: ctx.accounts.user.to_account_info(),
                },
                &[seeds],
            ),
            sol_amount_to_send,
        )?;

        let pool = &mut ctx.accounts.pool;
        pool.sol_reserve = pool.sol_reserve.checked_sub(sol_amount_to_send).unwrap();

        emit!(SwapFulfilled {
            user: ctx.accounts.user.key(),
            swap_type: SwapType::TokenForSol,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(price_numerator: u64, price_denominator: u64)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub worker_authority: Signer<'info>,

    /// CHECK: Just storing the mint pubkey for PDA derivation.
    pub token_mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = worker_authority,
        space = POOL_INIT_SPACE,
        seeds = [b"pool", token_mint.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, SwapPool>,

    /// CHECK: Created via CPI in this instruction; owned by System program.
    #[account(
        mut,
        seeds = [b"swap_vault", pool.key().as_ref()],
        bump,
    )]
    pub swap_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(sol_amount: u64)]
pub struct SwapSolForToken<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, SwapPool>,

    #[account(
        mut,
        seeds = [b"swap_vault", pool.key().as_ref()],
        bump,
    )]
    pub swap_vault: SystemAccount<'info>,

    /// Fee recipient — must be the pool's worker authority.
    #[account(
        mut,
        constraint = treasury.key() == pool.worker_authority @ ConfidentialSwapError::Unauthorized,
    )]
    pub treasury: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SwapTokenForSolRequest<'info> {
    pub user: Signer<'info>,

    #[account(
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, SwapPool>,
}

#[derive(Accounts)]
#[instruction(_new_size: u32)]
pub struct BeginWritePoolReserve<'info> {
    #[account(mut)]
    pub worker_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
        constraint = pool.worker_authority == worker_authority.key() @ ConfidentialSwapError::Unauthorized,
        realloc = POOL_INIT_SPACE,
        realloc::payer = worker_authority,
        realloc::zero = false,
    )]
    pub pool: Account<'info, SwapPool>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(offset: u32, chunk: Vec<u8>)]
pub struct WritePoolReserveChunk<'info> {
    #[account(mut)]
    pub worker_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
        constraint = pool.worker_authority == worker_authority.key() @ ConfidentialSwapError::Unauthorized,
        realloc = POOL_INIT_SPACE + pool.token_reserve_len as usize + chunk.len(),
        realloc::payer = worker_authority,
        realloc::zero = false,
    )]
    pub pool: Account<'info, SwapPool>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FulfillTokenForSol<'info> {
    #[account(mut)]
    pub worker_authority: Signer<'info>,

    /// CHECK: Recipient of SOL payout.
    #[account(mut)]
    pub user: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
        constraint = pool.worker_authority == worker_authority.key() @ ConfidentialSwapError::Unauthorized,
    )]
    pub pool: Account<'info, SwapPool>,

    #[account(
        mut,
        seeds = [b"swap_vault", pool.key().as_ref()],
        bump,
    )]
    pub swap_vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}
