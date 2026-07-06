export type ErrorCategory = 'proof' | 'submit' | 'mine' | 'indexer' | 'state-mismatch' | 'wallet' | 'other';

// Known midnight-node custom error codes mapped to categories. The exhaustive
// list lives in midnight-status-codes:lookup; extend this table as we encounter
// new codes in tests.
const CUSTOM_CODE_CATEGORY: Readonly<Record<number, ErrorCategory>> = {
  194: 'wallet', // BalanceCheckOutOfBounds
};

const categorizeByString = (err: unknown): ErrorCategory => {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes('proof') || lower.includes('prover')) return 'proof';
  if (lower.includes('indexer') || lower.includes('graphql')) return 'indexer';
  if (lower.includes('balance') || lower.includes('wallet') || lower.includes('insufficient')) return 'wallet';
  if (lower.includes('submit') || lower.includes('mempool') || lower.includes('rejected')) return 'submit';
  if (lower.includes('block') || lower.includes('finaliz') || lower.includes('timeout')) return 'mine';
  return 'other';
};

export const categorizeError = (err: unknown): ErrorCategory => {
  // Prefer structured RPC cause when present — stable across wallet-SDK
  // message wording changes.
  const cause = extractRpcCause(err);
  if (cause) {
    const mapped = CUSTOM_CODE_CATEGORY[cause.customCode];
    if (mapped) return mapped;
    // Any RPC rejection that doesn't have a known mapping is still a submit
    // problem at heart.
    return 'submit';
  }
  return categorizeByString(err);
};

export interface Timed<T> {
  value: T;
  ms: number;
}

export const timed = async <T>(fn: () => Promise<T>): Promise<Timed<T>> => {
  const start = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - start) };
};

export interface RetryOpts {
  readonly attempts?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Only retry when this returns true. Default: any thrown value. */
  readonly retryable?: (err: unknown) => boolean;
}

/**
 * Retry an idempotent async operation with exponential backoff. Intended for indexer reads, state observations, and
 * other safe-to-repeat calls.
 *
 * DO NOT use for transaction submission — retrying a submit can double-spend.
 */
export const withRetry = async <T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> => {
  const attempts = opts.attempts ?? 3;
  const initial = opts.initialBackoffMs ?? 1_000;
  const max = opts.maxBackoffMs ?? 8_000;
  const retryable = opts.retryable ?? (() => true);

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !retryable(err)) break;
      const delay = Math.min(max, initial * 2 ** i);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
};

/**
 * Parsed Polkadot `Invalid Transaction` cause, e.g. `1010: Invalid Transaction: Custom error: 194`. Walks the `cause`
 * chain (the wallet SDK wraps the RPC error in two layers — see api/test/spike notes for the structure).
 *
 * The `customCode` field maps to a midnight-node error (e.g. 194 = `BalanceCheckOutOfBounds`). Use this for stable
 * assertions instead of regex over `.message`.
 */
export interface RpcCauseInfo {
  readonly polkadotCode: number;
  readonly customCode: number;
  readonly message: string;
}

const RPC_CAUSE_RE = /(\d+):\s[^\n]+?Custom error:\s(\d+)/;

// Effect's FiberFailureImpl stores its cause under a Symbol-keyed property
// instead of the standard `.cause`, so a naive `.cause`-walk stops there.
// `toString()` on a FiberFailure renders the full cause tree, so as a last
// resort we scan that — handles both plain Error chains and effect wrappers.
const FIBER_FAILURE_CAUSE_ID = Symbol.for('effect/Runtime/FiberFailure/Cause');

export const extractRpcCause = (err: unknown): RpcCauseInfo | null => {
  const tryMatch = (s: string | undefined): RpcCauseInfo | null => {
    if (typeof s !== 'string') return null;
    const m = s.match(RPC_CAUSE_RE);
    return m ? { polkadotCode: Number(m[1]), customCode: Number(m[2]), message: s } : null;
  };

  let cur: unknown = err;
  let depth = 0;
  while (cur != null && depth < 8) {
    const o = cur as { message?: unknown; cause?: unknown; toString?: () => string };
    const matched = tryMatch(typeof o.message === 'string' ? o.message : undefined);
    if (matched) return matched;
    cur = o.cause ?? (cur as Record<symbol, unknown>)[FIBER_FAILURE_CAUSE_ID];
    depth++;
  }

  // Fallback: scan the whole pretty-printed error (covers FiberFailure
  // sub-trees that don't expose nested Errors via plain properties).
  if (err != null && typeof (err as { toString?: () => string }).toString === 'function') {
    return tryMatch((err as { toString: () => string }).toString());
  }
  return null;
};
