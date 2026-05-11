import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ConfidentialToken } from "../target/types/confidential_token";
import { ConfidentialSwap } from "../target/types/confidential_swap";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";

// ── tfhe WASM setup ───────────────────────────────────────────────────────────

// tfhe ships as ESM with no "main" field; require by explicit path using
// --experimental-require-module (Node >=22) to load it in the CJS test runner.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tfhe = require(path.join(__dirname, "..", "node_modules", "tfhe", "tfhe.js")) as typeof import("tfhe");

const wasmPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "tfhe",
  "tfhe_bg.wasm",
);
tfhe.initSync(fs.readFileSync(wasmPath));

const fheConfig = tfhe.TfheConfigBuilder.default().build();
const clientKey = tfhe.TfheClientKey.generate(fheConfig);
const compactPublicKey = tfhe.TfheCompactPublicKey.new(clientKey);

function fheEncrypt(value: bigint): Uint8Array {
  return tfhe.CompactFheUint64.encrypt_with_compact_public_key(
    value,
    compactPublicKey,
  ).serialize();
}

function fheDecrypt(bytes: Uint8Array): bigint {
  return tfhe.CompactFheUint64.deserialize(bytes).expand().decrypt(clientKey);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TOKEN_PROGRAM_ID = new PublicKey(
  "H6TaxPd91m5NMm3t3KSubsBTnMHBJHbaC4B3WhccuY7T",
);
const SWAP_PROGRAM_ID = new PublicKey(
  "HyL5r4euova77wUoJVMA7hj8Y2s1jvJr55zSqAB1gvAa",
);
const DENOMINATION = new anchor.BN(LAMPORTS_PER_SOL);
const CHUNK_SIZE = 880;

// Raw ciphertext bytes in ConfidentialAccount start at this offset in account data.
// discriminator(8) + owner(32) + balance_len(4) + bump(1) = 45
const ACCOUNT_INIT_SPACE = 45;
// Raw ciphertext bytes in SwapPool start at this offset.
// discriminator(8) + worker_authority(32) + token_mint(32) + token_reserve_len(4)
// + sol_reserve(8) + price_numerator(8) + price_denominator(8) + bump(1) = 101
const POOL_INIT_SPACE = 101;

// ── PDA helpers ───────────────────────────────────────────────────────────────

function getMintPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint")],
    TOKEN_PROGRAM_ID,
  );
}

function getVaultPda(mintPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), mintPda.toBuffer()],
    TOKEN_PROGRAM_ID,
  );
}

function getConfidentialAccountPda(
  mintPda: PublicKey,
  owner: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("account"), mintPda.toBuffer(), owner.toBuffer()],
    TOKEN_PROGRAM_ID,
  );
}

function getSwapPoolPda(mintPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mintPda.toBuffer()],
    SWAP_PROGRAM_ID,
  );
}

function getSwapVaultPda(poolPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("swap_vault"), poolPda.toBuffer()],
    SWAP_PROGRAM_ID,
  );
}

// ── Raw ciphertext readers ────────────────────────────────────────────────────

async function fetchEncryptedBalance(
  connection: anchor.web3.Connection,
  accountPda: PublicKey,
): Promise<Uint8Array | null> {
  const info = await connection.getAccountInfo(accountPda);
  if (!info) return null;
  const dataView = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  const balanceLen = dataView.getUint32(40, true); // offset 8+32=40
  if (balanceLen === 0) return null;
  return new Uint8Array(info.data.slice(ACCOUNT_INIT_SPACE, ACCOUNT_INIT_SPACE + balanceLen));
}

async function fetchEncryptedPoolReserve(
  connection: anchor.web3.Connection,
  poolPda: PublicKey,
): Promise<Uint8Array | null> {
  const info = await connection.getAccountInfo(poolPda);
  if (!info) return null;
  const dataView = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  const reserveLen = dataView.getUint32(72, true); // offset 8+32+32=72
  if (reserveLen === 0) return null;
  return new Uint8Array(info.data.slice(POOL_INIT_SPACE, POOL_INIT_SPACE + reserveLen));
}

// ── Chunked write helpers ─────────────────────────────────────────────────────

async function writeBalance(
  tokenProgram: Program<ConfidentialToken>,
  authority: anchor.web3.Keypair | anchor.Wallet,
  mintPda: PublicKey,
  userAccountPda: PublicKey,
  ciphertext: Uint8Array,
  provider: anchor.AnchorProvider,
): Promise<void> {
  const isKeypair = (authority as any).secretKey !== undefined;

  const buildTx = (methods: any, extra?: anchor.web3.Keypair[]) =>
    extra ? methods.signers(extra).rpc() : methods.rpc();

  const signers = isKeypair ? [(authority as anchor.web3.Keypair)] : [];
  const authKey = isKeypair
    ? (authority as anchor.web3.Keypair).publicKey
    : (authority as anchor.Wallet).publicKey;

  await tokenProgram.methods
    .beginWriteBalance(ciphertext.length)
    .accounts({
      confidentialMint: mintPda,
      userAccount: userAccountPda,
      authority: authKey,
      systemProgram: SystemProgram.programId,
    })
    .signers(signers)
    .rpc();

  for (let offset = 0; offset < ciphertext.length; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, ciphertext.length);
    const chunk = Buffer.from(ciphertext.slice(offset, end));
    await tokenProgram.methods
      .writeBalanceChunk(offset, chunk)
      .accounts({
        confidentialMint: mintPda,
        userAccount: userAccountPda,
        authority: authKey,
        systemProgram: SystemProgram.programId,
      })
      .signers(signers)
      .rpc();
  }
}

async function writePoolReserve(
  swapProgram: Program<ConfidentialSwap>,
  workerAuthority: anchor.web3.Keypair | anchor.Wallet,
  poolPda: PublicKey,
  ciphertext: Uint8Array,
): Promise<void> {
  const isKeypair = (workerAuthority as any).secretKey !== undefined;
  const signers = isKeypair ? [(workerAuthority as anchor.web3.Keypair)] : [];
  const authKey = isKeypair
    ? (workerAuthority as anchor.web3.Keypair).publicKey
    : (workerAuthority as anchor.Wallet).publicKey;

  await swapProgram.methods
    .beginWritePoolReserve(ciphertext.length)
    .accounts({
      workerAuthority: authKey,
      pool: poolPda,
      systemProgram: SystemProgram.programId,
    })
    .signers(signers)
    .rpc();

  for (let offset = 0; offset < ciphertext.length; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, ciphertext.length);
    const chunk = Buffer.from(ciphertext.slice(offset, end));
    await swapProgram.methods
      .writePoolReserveChunk(offset, chunk)
      .accounts({
        workerAuthority: authKey,
        pool: poolPda,
        systemProgram: SystemProgram.programId,
      })
      .signers(signers)
      .rpc();
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("ciFHEr — confidential token (real FHE)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const tokenProgram = anchor.workspace
    .ConfidentialToken as Program<ConfidentialToken>;
  const swapProgram = anchor.workspace
    .ConfidentialSwap as Program<ConfidentialSwap>;

  const worker = provider.wallet; // plays the worker role in tests
  const user = anchor.web3.Keypair.generate();
  const recipient = anchor.web3.Keypair.generate();

  const [mintPda] = getMintPda();
  const [vaultPda] = getVaultPda(mintPda);
  const [userAccountPda] = getConfidentialAccountPda(mintPda, user.publicKey);
  const [recipientAccountPda] = getConfidentialAccountPda(
    mintPda,
    recipient.publicKey,
  );
  const [poolPda] = getSwapPoolPda(mintPda);
  const [swapVaultPda] = getSwapVaultPda(poolPda);

  before(async () => {
    // Fund user and recipient
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        user.publicKey,
        20 * LAMPORTS_PER_SOL,
      ),
      "confirmed",
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        recipient.publicKey,
        5 * LAMPORTS_PER_SOL,
      ),
      "confirmed",
    );
  });

  it("initializes the mint", async () => {
    await tokenProgram.methods
      .initializeMint(DENOMINATION)
      .accounts({
        authority: worker.publicKey,
        confidentialMint: mintPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const mintAccount =
      await tokenProgram.account.confidentialMint.fetch(mintPda);
    assert.ok(mintAccount.authority.equals(worker.publicKey));
    assert.ok(mintAccount.denomination.eq(DENOMINATION));
  });

  it("initializes confidential accounts for user and recipient", async () => {
    await tokenProgram.methods
      .initializeAccount()
      .accounts({
        owner: user.publicKey,
        confidentialMint: mintPda,
        confidentialAccount: userAccountPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    await tokenProgram.methods
      .initializeAccount()
      .accounts({
        owner: recipient.publicKey,
        confidentialMint: mintPda,
        confidentialAccount: recipientAccountPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([recipient])
      .rpc();

    const userAcc =
      await tokenProgram.account.confidentialAccount.fetch(userAccountPda);
    assert.ok(userAcc.owner.equals(user.publicKey));
    assert.equal(userAcc.balanceLen, 0);
  });

  it("processes a mint request (user pays SOL)", async () => {
    const balanceBefore = await provider.connection.getBalance(user.publicKey);

    await tokenProgram.methods
      .mintRequest()
      .accounts({
        user: user.publicKey,
        confidentialMint: mintPda,
        vault: vaultPda,
        userAccount: userAccountPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const balanceAfter = await provider.connection.getBalance(user.publicKey);
    assert.ok(balanceBefore - balanceAfter >= LAMPORTS_PER_SOL);
  });

  it("worker writes FHE-encrypted balance after mint (chunked)", async () => {
    const ciphertext = fheEncrypt(1n);
    assert.isAbove(ciphertext.length, 1000, "ciphertext should be multi-KB FHE data");

    await writeBalance(tokenProgram, worker, mintPda, userAccountPda, ciphertext, provider);

    const account =
      await tokenProgram.account.confidentialAccount.fetch(userAccountPda);
    assert.equal(account.balanceLen, ciphertext.length);

    const rawBytes = await fetchEncryptedBalance(provider.connection, userAccountPda);
    assert.ok(rawBytes, "raw ciphertext should be present");
    const decrypted = fheDecrypt(rawBytes!);
    assert.equal(decrypted, 1n);
  });

  it("worker writes FHE-encrypted balance via transfer to recipient (chunked)", async () => {
    // Simulate a transfer: user sends 1 token to recipient
    // Worker decrypts user's balance (1), computes new_user=0, new_recipient=1
    // Then writes both in chunks

    const userRawBytes = await fetchEncryptedBalance(provider.connection, userAccountPda);
    assert.ok(userRawBytes, "user should have an encrypted balance");
    const currentBalance = fheDecrypt(userRawBytes!);
    assert.equal(currentBalance, 1n);

    const transferAmount = 1n;
    const newUserBalance = currentBalance - transferAmount;
    const newRecipientBalance = transferAmount;

    // Emit the transfer_request event on-chain
    await tokenProgram.methods
      .transferRequest(recipient.publicKey)
      .accounts({
        confidentialMint: mintPda,
        userAccount: userAccountPda,
        user: user.publicKey,
      })
      .signers([user])
      .rpc();

    // Worker writes new balances
    const newUserCt = fheEncrypt(newUserBalance);
    const newRecipientCt = fheEncrypt(newRecipientBalance);

    await writeBalance(tokenProgram, worker, mintPda, userAccountPda, newUserCt, provider);
    await writeBalance(tokenProgram, worker, mintPda, recipientAccountPda, newRecipientCt, provider);

    const updatedRecipient =
      await tokenProgram.account.confidentialAccount.fetch(recipientAccountPda);
    assert.equal(updatedRecipient.balanceLen, newRecipientCt.length);

    const recipientRawBytes = await fetchEncryptedBalance(provider.connection, recipientAccountPda);
    assert.ok(recipientRawBytes);
    assert.equal(fheDecrypt(recipientRawBytes!), 1n);

    const updatedUser =
      await tokenProgram.account.confidentialAccount.fetch(userAccountPda);
    assert.equal(updatedUser.balanceLen, newUserCt.length);

    const userRawBytes2 = await fetchEncryptedBalance(provider.connection, userAccountPda);
    assert.ok(userRawBytes2);
    assert.equal(fheDecrypt(userRawBytes2!), 0n);
  });

  it("initializes swap pool", async () => {
    await swapProgram.methods
      .initializePool(new anchor.BN(1), new anchor.BN(1))
      .accounts({
        workerAuthority: worker.publicKey,
        tokenMint: mintPda,
        pool: poolPda,
        swapVault: swapVaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const pool = await swapProgram.account.swapPool.fetch(poolPda);
    assert.ok(pool.workerAuthority.equals(worker.publicKey));
    assert.ok(pool.tokenMint.equals(mintPda));
  });

  it("user swaps SOL for token", async () => {
    const solAmount = new anchor.BN(LAMPORTS_PER_SOL);
    await swapProgram.methods
      .swapSolForToken(solAmount)
      .accounts({
        user: user.publicKey,
        pool: poolPda,
        swapVault: swapVaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const pool = await swapProgram.account.swapPool.fetch(poolPda);
    assert.ok(pool.solReserve.eq(solAmount));
  });

  it("worker writes pool reserve ciphertext after SOL→token swap (chunked)", async () => {
    const reserveCt = fheEncrypt(1n);
    await writePoolReserve(swapProgram, worker, poolPda, reserveCt);

    const pool = await swapProgram.account.swapPool.fetch(poolPda);
    assert.equal(pool.tokenReserveLen, reserveCt.length);

    const poolRawBytes = await fetchEncryptedPoolReserve(provider.connection, poolPda);
    assert.ok(poolRawBytes);
    assert.equal(fheDecrypt(poolRawBytes!), 1n);
  });

  it("worker fulfills token→SOL swap", async () => {
    // Seed the swap vault so it can pay out
    const fundTx = anchor.web3.SystemProgram.transfer({
      fromPubkey: worker.publicKey,
      toPubkey: swapVaultPda,
      lamports: LAMPORTS_PER_SOL * 5,
    });
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(fundTx));

    // Sync pool.sol_reserve by calling swap_sol_for_token from worker
    await swapProgram.methods
      .swapSolForToken(new anchor.BN(LAMPORTS_PER_SOL * 5))
      .accounts({
        user: worker.publicKey,
        pool: poolPda,
        swapVault: swapVaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const userBalanceBefore = await provider.connection.getBalance(
      user.publicKey,
    );

    await swapProgram.methods
      .fulfillTokenForSol(new anchor.BN(LAMPORTS_PER_SOL))
      .accounts({
        workerAuthority: worker.publicKey,
        user: user.publicKey,
        pool: poolPda,
        swapVault: swapVaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const userBalanceAfter = await provider.connection.getBalance(user.publicKey);
    assert.ok(userBalanceAfter > userBalanceBefore);

    // Worker zeros user's token balance and updates pool reserve
    const zeroCt = fheEncrypt(0n);
    await writeBalance(tokenProgram, worker, mintPda, userAccountPda, zeroCt, provider);

    const zeroRawBytes = await fetchEncryptedBalance(provider.connection, userAccountPda);
    assert.ok(zeroRawBytes);
    assert.equal(fheDecrypt(zeroRawBytes!), 0n);
  });

  it("worker fulfills burn (redeem tokens for SOL)", async () => {
    // Give user a non-zero balance first
    const mintCt = fheEncrypt(2n);
    await writeBalance(tokenProgram, worker, mintPda, userAccountPda, mintCt, provider);

    const burnRawBytes = await fetchEncryptedBalance(provider.connection, userAccountPda);
    assert.ok(burnRawBytes);
    const tokenBalance = fheDecrypt(burnRawBytes!);
    assert.equal(tokenBalance, 2n);

    // Fund vault for payout
    const vaultFundTx = anchor.web3.SystemProgram.transfer({
      fromPubkey: worker.publicKey,
      toPubkey: vaultPda,
      lamports: 3 * LAMPORTS_PER_SOL,
    });
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(vaultFundTx));

    const userBalanceBefore = await provider.connection.getBalance(user.publicKey);
    const solToReturn = new anchor.BN((tokenBalance * BigInt(LAMPORTS_PER_SOL)).toString());

    await tokenProgram.methods
      .fulfillBurn(solToReturn)
      .accounts({
        authority: worker.publicKey,
        confidentialMint: mintPda,
        userAccount: userAccountPda,
        user: user.publicKey,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const userBalanceAfter = await provider.connection.getBalance(user.publicKey);
    assert.ok(userBalanceAfter > userBalanceBefore);

    const accountAfter =
      await tokenProgram.account.confidentialAccount.fetch(userAccountPda);
    assert.equal(accountAfter.balanceLen, 0);
  });
});
