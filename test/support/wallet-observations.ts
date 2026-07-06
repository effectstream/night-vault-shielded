import * as ledger from '@midnight-ntwrk/ledger-v8';
import { type FacadeState, type WalletFacade } from '@midnightntwrk/wallet-sdk';
import * as Rx from 'rxjs';
import { firstSyncedState, type WalletContext } from './wallet-builder.js';

const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60_000;

/**
 * Compact's `UserAddress` parameter shape (`{ bytes: Uint8Array }`) for the caller wallet — pass straight into circuits
 * like `sendToUser(amount, addr)`.
 */
export const getUserAddress = (ctx: WalletContext): { bytes: Uint8Array } => ({
  bytes: ledger.encodeUserAddress(ctx.unshieldedKeystore.getAddress()),
});

/**
 * Compact's `ZswapCoinPublicKey` parameter shape (`{ bytes: Uint8Array }`) for the caller wallet's shielded address.
 * Reads the synced wallet state.
 */
export const getCoinPublicKey = async (ctx: WalletContext): Promise<{ bytes: Uint8Array }> => {
  const state = await firstSyncedState(ctx.wallet);
  return { bytes: state.shielded.coinPublicKey.data };
};

/** Lowercase hex encoding of a byte array, no separators (e.g. for display or as a map key). */
export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Hex key under which a token color appears in `state.{unshielded,shielded}.balances`. */
export const tokenColorHex = (color: Uint8Array): string => bytesToHex(color);

export interface WaitForBalanceOpts {
  readonly timeoutMs?: number;
  readonly throttleMs?: number;
}

const waitForBalance = (
  wallet: WalletFacade,
  bucket: 'unshielded' | 'shielded',
  tokenHex: string,
  predicate: (balance: bigint) => boolean,
  opts: WaitForBalanceOpts = {},
): Promise<bigint> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const throttleMs = opts.throttleMs ?? 2_000;
  return Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(throttleMs),
      Rx.filter((s) => s.isSynced),
      Rx.map((s) => s[bucket].balances[tokenHex] ?? 0n),
      Rx.filter(predicate),
      Rx.timeout({
        each: timeoutMs,
        with: () =>
          Rx.throwError(() => new Error(`waitForBalance(${bucket}, ${tokenHex}) timed out after ${timeoutMs}ms`)),
      }),
    ),
  );
};

export const waitForUnshieldedBalance = (
  wallet: WalletFacade,
  tokenHex: string,
  predicate: (balance: bigint) => boolean,
  opts?: WaitForBalanceOpts,
): Promise<bigint> => waitForBalance(wallet, 'unshielded', tokenHex, predicate, opts);

export const waitForShieldedBalance = (
  wallet: WalletFacade,
  tokenHex: string,
  predicate: (balance: bigint) => boolean,
  opts?: WaitForBalanceOpts,
): Promise<bigint> => waitForBalance(wallet, 'shielded', tokenHex, predicate, opts);

/** Right-pad a UTF-8 string into a `Bytes<N>` for use as a domain separator. */
export const padDomain = (s: string, length = 32): Uint8Array => {
  const buf = new Uint8Array(length);
  const bytes = new TextEncoder().encode(s);
  if (bytes.length > length) {
    throw new Error(`Domain "${s}" is ${bytes.length} bytes; max ${length}.`);
  }
  buf.set(bytes);
  return buf;
};

/** Current unshielded NIGHT balance (raw NIGHT token). Waits for wallet sync. */
export const getNightBalance = async (ctx: WalletContext): Promise<bigint> => {
  const state = await firstSyncedState(ctx.wallet);
  return state.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;
};

/**
 * Current DUST balance at the given (or current) time. DUST is generated over time from registered NIGHT UTXOs, so the
 * balance is parameterized by time. Waits for wallet sync.
 */
export const getDustBalance = async (ctx: WalletContext, at: Date = new Date()): Promise<bigint> => {
  const state = await firstSyncedState(ctx.wallet);
  return state.dust.balance(at);
};

/** Cryptographic random 32-byte nonce (for shielded mint inputs). */
export const randomBytes32 = (): Uint8Array => {
  const buf = new Uint8Array(32);
  globalThis.crypto.getRandomValues(buf);
  return buf;
};

export interface WalletBalanceSnapshot {
  readonly unshielded: Record<string, bigint>;
  readonly shielded: Record<string, bigint>;
}

const pct = (applied: bigint, total: bigint): number => {
  if (total === 0n) return 100;
  const a = Number(applied);
  const t = Number(total);
  return Math.max(0, Math.min(100, Math.floor((a / t) * 100)));
};

/**
 * Overall wallet sync percentage averaged across the shielded, unshielded, and dust sub-wallets. Mirrors the formula
 * used by midnight-wallet-cli — each sub-wallet's percent is `appliedIndex / highestRelevantWalletIndex` (shielded &
 * dust) or `appliedId / highestTransactionId` (unshielded), averaged.
 *
 * Returns a value in `[0, 100]`. Returns 100 when a sub-wallet's highest index is 0 (nothing to sync yet — treated as
 * already in sync).
 */
export const walletSyncPercent = (state: FacadeState): number => {
  const shielded = pct(state.shielded.progress.appliedIndex, state.shielded.progress.highestRelevantWalletIndex);
  const unshielded = pct(state.unshielded.progress.appliedId, state.unshielded.progress.highestTransactionId);
  const dust = pct(state.dust.progress.appliedIndex, state.dust.progress.highestRelevantWalletIndex);
  return Math.floor((shielded + unshielded + dust) / 3);
};

/** Human-readable wallet sync status, e.g. `synced` or `syncing 42%`. */
export const walletSyncStatus = (state: FacadeState): string => {
  const p = walletSyncPercent(state);
  return state.isSynced || p === 100 ? 'synced' : `syncing ${p}%`;
};

/** One-shot read of the wallet's per-color balances (waits for sync). */
export const snapshotWalletState = async (ctx: WalletContext): Promise<WalletBalanceSnapshot> => {
  const state = await firstSyncedState(ctx.wallet);
  return {
    unshielded: { ...state.unshielded.balances },
    shielded: { ...state.shielded.balances },
  };
};
