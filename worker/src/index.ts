/**
 * Worker entry point.
 *
 * Startup sequence:
 *  1. Spawn fhe-sidecar (Rust) — provides real FHE via tfhe-rs ServerKey.
 *  2. initFhe() — wait for sidecar HTTP health check.
 *  3. Bootstrap on-chain state (ConfidentialMint, SwapPool, initial liquidity).
 *  4. Register Anchor event listeners for both programs.
 *  5. Start Express REST API.
 *
 * REST endpoints:
 *  GET  /health              — liveness check
 *  GET  /public-key          — serialized CompactPublicKey bytes (from sidecar)
 *  GET  /status/:userId      — pending ops for a user
 *  GET  /balance/:userId     — decrypt user's balance (sidecar decrypts)
 *  POST /transfer-intent     — register { recipient, amount } before transfer_request
 *  POST /swap-intent         — register { tokenAmount } before swap_token_for_sol_request
 */

import 'dotenv/config';
import { spawn } from 'child_process';
import * as path from 'path';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import BN from 'bn.js';

import { initFhe, getPublicKeyBytes, decrypt } from './fhe';
import { verifyAndCreateSession, requireAuth } from './auth';
import {
  tokenProgram,
  swapProgram,
  getUserAccountData,
  getEncryptedBalance,
  getMintData,
  getPoolData,
  mintPda,
  vaultPda,
  workerKeypair,
  getPoolPda,
  getSwapVaultPda,
} from './program';
import {
  pendingOps,
  pendingTransfers,
  pendingSwapAmounts,
  PendingOp,
  TransferIntent,
} from './types';
import { handleMintRequested } from './mint';
import { handleBurnRequested } from './burn';
import { handleTransferRequested } from './transfer';
import { handleSwapSolForToken, handleSwapTokenForSol } from './swap';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const SIDECAR_PORT = parseInt(process.env.FHE_SIDECAR_PORT ?? '3002', 10);

// ── Sidecar launcher ──────────────────────────────────────────────────────────

function spawnSidecar(): void {
  const sidecarBin = path.join(__dirname, '..', '..', 'fhe-sidecar', 'target', 'release', 'fhe-sidecar');
  const sidecarCwd = path.join(__dirname, '..', '..', 'fhe-sidecar');

  console.log(`[worker] Spawning fhe-sidecar on port ${SIDECAR_PORT}…`);

  const proc = spawn(sidecarBin, [], {
    cwd: sidecarCwd,
    env: { ...process.env, FHE_SIDECAR_PORT: String(SIDECAR_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  proc.stdout.on('data', (d: Buffer) => process.stdout.write(`[sidecar] ${d}`));
  proc.stderr.on('data', (d: Buffer) => process.stderr.write(`[sidecar] ${d}`));

  proc.on('exit', (code) => {
    if (code !== 0) console.error(`[worker] fhe-sidecar exited with code ${code}`);
  });

  process.on('exit', () => proc.kill());
  process.on('SIGINT', () => { proc.kill(); process.exit(0); });
  process.on('SIGTERM', () => { proc.kill(); process.exit(0); });
}

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// POST /auth — verify wallet signature, return session token (4h TTL)
app.post('/auth', (req: Request, res: Response) => {
  const result = verifyAndCreateSession(req.body as {
    pubkey?: string; message?: string; signature?: string
  });
  if ('error' in result) {
    res.status(401).json(result);
  } else {
    res.json(result);
  }
});

// Returns the raw serialized CompactPublicKey bytes (proxied from sidecar).
app.get('/public-key', async (_req: Request, res: Response) => {
  try {
    const bytes = await getPublicKeyBytes();
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(Buffer.from(bytes));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Frontend calls this BEFORE submitting transfer_request on-chain.
app.post('/transfer-intent', requireAuth(req => (req.body as any)?.user), (req: Request, res: Response) => {
  const { user, recipient, amount } = req.body as {
    user?: string;
    recipient?: string;
    amount?: string;
  };
  if (!user || !recipient || amount === undefined) {
    res.status(400).json({ error: 'Missing user, recipient, or amount' });
    return;
  }
  try {
    new PublicKey(user);
    new PublicKey(recipient);
    const intent: TransferIntent = { recipient, amount: BigInt(amount) };
    pendingTransfers.set(user, intent);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Invalid pubkey or amount' });
  }
});

// Frontend calls this BEFORE submitting swap_token_for_sol_request on-chain.
app.post('/swap-intent', requireAuth(req => (req.body as any)?.user), (req: Request, res: Response) => {
  const { user, tokenAmount } = req.body as { user?: string; tokenAmount?: string };
  if (!user || tokenAmount === undefined) {
    res.status(400).json({ error: 'Missing user or tokenAmount' });
    return;
  }
  try {
    new PublicKey(user);
    pendingSwapAmounts.set(user, BigInt(tokenAmount));
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Invalid pubkey or tokenAmount' });
  }
});

app.get('/status/:userId', (req: Request, res: Response) => {
  const { userId } = req.params;
  const ops: PendingOp[] = [];
  for (const op of pendingOps.values()) {
    if (op.user === userId) ops.push(op);
  }
  ops.sort((a, b) => b.timestamp - a.timestamp);
  res.json({ ops });
});

app.get('/balance/:userId', requireAuth(req => req.params.userId as string), async (req: Request, res: Response) => {
  const { userId } = req.params;
  try {
    const userPubkey = new PublicKey(userId);
    const accountData = await getUserAccountData(userPubkey);
    if (!accountData) {
      res.status(404).json({ error: 'ConfidentialAccount not found' });
      return;
    }
    const enc = await getEncryptedBalance(userPubkey);
    if (!enc) {
      res.json({ balance: '0' });
      return;
    }
    try {
      const balance = await decrypt(enc);
      res.json({ balance: balance.toString() });
    } catch {
      res.status(409).json({
        error: 'Balance encrypted under a different worker key. Re-mint to reset.',
        code: 'KEY_MISMATCH',
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/recover-swap — manually credit a user whose swap event was processed
// but whose balance write failed (e.g. worker ran out of SOL mid-operation).
// Body: { secret, userPubkey, solAmountNet }
// solAmountNet: the net lamports that landed in the vault (sol_amount after 0.3% fee).
app.post('/admin/recover-swap', async (req: Request, res: Response) => {
  const { secret, userPubkey, solAmountNet } = req.body as {
    secret?: string; userPubkey?: string; solAmountNet?: string;
  };
  if (secret !== process.env.ADMIN_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!userPubkey || !solAmountNet) {
    res.status(400).json({ error: 'Missing userPubkey or solAmountNet' });
    return;
  }
  try {
    const event = {
      user: new PublicKey(userPubkey),
      solAmount: solAmountNet,
      sol_amount: solAmountNet,
    };
    await handleSwapSolForToken(event);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Event listeners ───────────────────────────────────────────────────────────

function registerEventListeners(): void {
  tokenProgram.addEventListener('mintRequested', (event: any, slot: number) => {
    console.log(`[event] mintRequested slot=${slot}`);
    handleMintRequested(event).catch((e) => console.error('[event] mintRequested:', e));
  });

  tokenProgram.addEventListener('burnRequested', (event: any, slot: number) => {
    console.log(`[event] burnRequested slot=${slot}`);
    handleBurnRequested(event).catch((e) => console.error('[event] burnRequested:', e));
  });

  tokenProgram.addEventListener('transferRequested', (event: any, slot: number) => {
    console.log(`[event] transferRequested slot=${slot}`);
    handleTransferRequested(event).catch((e) => console.error('[event] transferRequested:', e));
  });

  swapProgram.addEventListener('swapSolForTokenRequested', (event: any, slot: number) => {
    console.log(`[event] swapSolForTokenRequested slot=${slot}`);
    handleSwapSolForToken(event).catch((e) =>
      console.error('[event] swapSolForTokenRequested:', e),
    );
  });

  swapProgram.addEventListener('swapTokenForSolRequested', (event: any, slot: number) => {
    console.log(`[event] swapTokenForSolRequested slot=${slot}`);
    handleSwapTokenForSol(event).catch((e) =>
      console.error('[event] swapTokenForSolRequested:', e),
    );
  });

  console.log('[worker] Event listeners registered.');
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function bootstrapOnChain(): Promise<void> {
  const DENOMINATION = new BN(process.env.DENOMINATION ?? '1000000000');

  const mintData = await getMintData().catch(() => null);
  if (!mintData) {
    console.log('[bootstrap] Initializing ConfidentialMint...');
    await tokenProgram.methods
      .initializeMint(DENOMINATION)
      .accounts({
        authority: workerKeypair.publicKey,
        confidentialMint: mintPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log('[bootstrap] ConfidentialMint initialized.');
  } else {
    console.log('[bootstrap] ConfidentialMint already exists.');
  }

  const [poolPda] = getPoolPda(mintPda);
  const [swapVaultPda] = getSwapVaultPda(poolPda);
  const poolData = await getPoolData().catch(() => null);
  if (!poolData) {
    console.log('[bootstrap] Initializing SwapPool...');
    await swapProgram.methods
      .initializePool(new BN(1), DENOMINATION)
      .accounts({
        workerAuthority: workerKeypair.publicKey,
        tokenMint: mintPda,
        pool: poolPda,
        swapVault: swapVaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log('[bootstrap] SwapPool initialized.');
  } else {
    console.log('[bootstrap] SwapPool already exists.');
  }

  const freshPool = await getPoolData().catch(() => null);
  const solReserve = freshPool ? BigInt(freshPool.solReserve.toString()) : 0n;
  if (solReserve === 0n) {
    const SEED_LAMPORTS = new BN(1_000_000_000);
    console.log('[bootstrap] Seeding swap pool with 1 SOL...');
    await swapProgram.methods
      .swapSolForToken(SEED_LAMPORTS)
      .accounts({
        user: workerKeypair.publicKey,
        pool: poolPda,
        swapVault: swapVaultPda,
        treasury: workerKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log('[bootstrap] Pool seeded.');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  spawnSidecar();

  console.log('[worker] Waiting for FHE sidecar...');
  await initFhe();
  console.log('[worker] FHE sidecar ready.');

  await bootstrapOnChain();
  registerEventListeners();

  app.listen(PORT, () => {
    console.log(`[worker] Listening on http://localhost:${PORT}`);
    console.log(`[worker]   GET /health`);
    console.log(`[worker]   GET /public-key`);
    console.log(`[worker]   GET /status/:userId`);
    console.log(`[worker]   GET /balance/:userId`);
    console.log(`[worker]   POST /transfer-intent`);
    console.log(`[worker]   POST /swap-intent`);
  });
}

main().catch((err) => {
  console.error('[worker] Fatal error:', err);
  process.exit(1);
});
