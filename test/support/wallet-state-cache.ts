import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * A serialized snapshot of the three sub-wallets, produced by `wallet.{shielded,unshielded,dust}.serializeState()`.
 * Restoring from one lets a wallet resume from a checkpoint and only delta-sync, instead of scanning the chain from
 * scratch — the difference between seconds and 5–15 minutes on a hosted network with history.
 *
 * The wallet SDK's serialization format is stable, so snapshots survive across runs. They contain coin-set data
 * (privacy-sensitive) but never secret keys — keys are always supplied fresh at wallet start — so the cache is treated
 * as private (gitignored `.cache/`, `0600` files) but is safe to persist for a test seed.
 */
export interface WalletStateSnapshot {
  readonly shielded: string;
  readonly unshielded: string;
  readonly dust: string;
  /**
   * Identifier of the chain the snapshot was taken on (e.g. genesis block hash). When present on both the cached
   * snapshot and the current chain, a mismatch means the network was reset/replaced under the same network id — the
   * snapshot is for a dead chain and must not be restored. Optional: absent when the chain id could not be determined,
   * in which case the restore self-heal (delete-and-cold-sync on failure) is the safety net instead.
   */
  readonly chainFingerprint?: string;
}

const CACHE_DIR = path.resolve(process.cwd(), '.cache', 'wallet-state');

/**
 * Cache file for a (network, wallet) pair. Named by network id + recognizable head/tail slices of the seed so the file
 * says _which wallet on which network_ is cached, without writing the full seed to disk.
 */
const cacheFile = (networkId: string, seed: string): string => {
  const head = seed.slice(0, 8);
  const tail = seed.slice(-8);
  const safeNetwork = networkId.replace(/[^a-z0-9_-]/gi, '_');
  return path.join(CACHE_DIR, `${safeNetwork}-${head}-${tail}.wstate.gz`);
};

const isSnapshot = (value: unknown): value is WalletStateSnapshot => {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o.shielded === 'string' && typeof o.unshielded === 'string' && typeof o.dust === 'string';
};

/**
 * Load a cached snapshot for (networkId, seed), or `null` on a miss. Any read/parse failure is treated as a miss so a
 * corrupt cache degrades to a full sync rather than breaking the run.
 */
export const loadWalletState = (networkId: string, seed: string): WalletStateSnapshot | null => {
  const file = cacheFile(networkId, seed);
  try {
    if (!existsSync(file)) return null;
    const json = gunzipSync(readFileSync(file)).toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return isSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Persist (gzipped, `0600`) a snapshot for (networkId, seed), overwriting any previous one. Written via a temp file +
 * atomic rename so an interrupted write (or a concurrent reader during checkpointing) never sees a truncated file.
 */
export const saveWalletState = (networkId: string, seed: string, snapshot: WalletStateSnapshot): void => {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = cacheFile(networkId, seed);
  const tmp = `${file}.${process.pid}.tmp`;
  const gz = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'));
  writeFileSync(tmp, gz, { mode: 0o600 });
  renameSync(tmp, file);
};

/** Remove the cached snapshot for (networkId, seed), if any. Used to invalidate a snapshot that failed to restore. */
export const deleteWalletState = (networkId: string, seed: string): void => {
  rmSync(cacheFile(networkId, seed), { force: true });
};
