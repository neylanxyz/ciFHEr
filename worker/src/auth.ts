/**
 * Wallet-based authentication for the worker REST API.
 *
 * Flow:
 *  1. Frontend signs `"ciFHEr auth\npubkey: <pk>\ntimestamp: <ms>"` with Phantom.
 *  2. POST /auth { pubkey, message, signature, timestamp } → { token }.
 *  3. Worker verifies Ed25519 sig + message content + timestamp window.
 *  4. Protected routes require `Authorization: Bearer <token>`.
 */

import { createPublicKey, verify as edVerify, randomUUID } from 'crypto'
import bs58 from 'bs58'
import type { Request, Response, NextFunction } from 'express'

// Ed25519 SPKI DER prefix: SEQUENCE { SEQUENCE { OID 1.3.101.112 } BIT STRING { 0x00 … } }
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function verifyEd25519(pubkeyBase58: string, message: Buffer, signature: Buffer): boolean {
  try {
    const rawKey = Buffer.from(bs58.decode(pubkeyBase58))
    const derKey = Buffer.concat([ED25519_SPKI_PREFIX, rawKey])
    const nodeKey = createPublicKey({ key: derKey, format: 'der', type: 'spki' })
    return edVerify(null, message, nodeKey, signature)
  } catch {
    return false
  }
}

// ── Session store ─────────────────────────────────────────────────────────────

const sessions = new Map<string, { pubkey: string; expiry: number }>()
const SESSION_TTL_MS = 4 * 60 * 60 * 1000 // 4 hours
const TIMESTAMP_WINDOW_MS = 60_000         // ±60s on auth request

const AUTH_PREFIX = 'ciFHEr auth\npubkey: '
const AUTH_TS_SEP = '\ntimestamp: '

export type AuthResult = { token: string } | { error: string }

export function verifyAndCreateSession(body: {
  pubkey?: string
  message?: string   // base64-encoded
  signature?: string // base64-encoded
}): AuthResult {
  const { pubkey, message, signature } = body
  if (!pubkey || !message || !signature) {
    return { error: 'Missing pubkey, message, or signature' }
  }

  const msgBuf = Buffer.from(message, 'base64')
  const msgText = msgBuf.toString('utf-8')

  // Verify message format: "ciFHEr auth\npubkey: <pk>\ntimestamp: <ms>"
  const expectedStart = `${AUTH_PREFIX}${pubkey}${AUTH_TS_SEP}`
  if (!msgText.startsWith(expectedStart)) {
    return { error: 'Invalid message format' }
  }
  const ts = parseInt(msgText.slice(expectedStart.length), 10)
  if (isNaN(ts) || Math.abs(Date.now() - ts) > TIMESTAMP_WINDOW_MS) {
    return { error: 'Timestamp out of window (±60s)' }
  }

  const sigBuf = Buffer.from(signature, 'base64')
  if (!verifyEd25519(pubkey, msgBuf, sigBuf)) {
    return { error: 'Invalid signature' }
  }

  const token = randomUUID()
  sessions.set(token, { pubkey, expiry: Date.now() + SESSION_TTL_MS })
  return { token }
}

export function lookupSession(token: string): string | null {
  const s = sessions.get(token)
  if (!s) return null
  if (Date.now() > s.expiry) { sessions.delete(token); return null }
  return s.pubkey
}

// ── Middleware ────────────────────────────────────────────────────────────────

export function requireAuth(getPubkey: (req: Request) => string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const pubkey = getPubkey(req)
    if (!pubkey) { res.status(400).json({ error: 'Missing pubkey' }); return }
    const authHeader = req.headers.authorization ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (lookupSession(token) !== pubkey) {
      res.status(401).json({ error: 'Unauthorized — call POST /auth first' })
      return
    }
    next()
  }
}
