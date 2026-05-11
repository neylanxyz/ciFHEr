export type OpStatus = 'pending' | 'processing' | 'done' | 'error';

export interface PendingOp {
  id: string;
  type: 'mint' | 'burn' | 'transfer' | 'swap_sol_for_token' | 'swap_token_for_sol';
  user: string;
  status: OpStatus;
  error?: string;
  timestamp: number;
}

/** Global in-memory operation tracker. Frontend polls GET /status/:userId. */
export const pendingOps: Map<string, PendingOp> = new Map();

/**
 * Transfer intents registered via POST /transfer-intent.
 * Maps sender base58 pubkey → { recipient, amount }.
 * Consumed once when the TransferRequested event fires.
 */
export interface TransferIntent {
  recipient: string;
  amount: bigint;
}
export const pendingTransfers: Map<string, TransferIntent> = new Map();

/**
 * Swap intents registered via POST /swap-intent.
 * Maps user base58 pubkey → token amount to swap.
 * Consumed once when SwapTokenForSolRequested fires.
 */
export const pendingSwapAmounts: Map<string, bigint> = new Map();

export function makeOpId(type: PendingOp['type'], user: string): string {
  return `${type}-${user}-${Date.now()}`;
}

export function opProcessing(op: PendingOp): void {
  op.status = 'processing';
}

export function opDone(op: PendingOp): void {
  op.status = 'done';
}

export function opError(op: PendingOp, message: string): void {
  op.status = 'error';
  op.error = message;
}
