import * as ledger from '@midnight-ntwrk/ledger-v8';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { getNetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { toHex } from '@midnight-ntwrk/midnight-js/utils';
// Single coherent wallet SDK via the barrel package — it re-exports the whole version-locked family, so we avoid
// declaring (and risking split/duplicate copies of) the individual @midnightntwrk/wallet-sdk-* packages.
import {
  createKeystore,
  DustWallet,
  type FacadeState,
  generateRandomSeed,
  HDWallet,
  InMemoryTransactionHistoryStorage,
  MidnightBech32m,
  PublicKey,
  Roles,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  ShieldedWallet,
  TransactionHistoryStorage,
  UnshieldedAddress,
  type UnshieldedKeystore,
  UnshieldedWallet,
  WalletFacade,
} from '@midnightntwrk/wallet-sdk';
import { Buffer } from 'buffer';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';
import { GENESIS_MINT_SEED, type NetworkConfig } from './network.js';
import { deleteWalletState, loadWalletState, saveWalletState, type WalletStateSnapshot } from './wallet-state-cache.js';

/**
 * How long to wait for a _restored_ wallet to reach a synced state before treating the snapshot as incompatible (e.g.
 * the chain was reset/reorged under it). Generous relative to a delta-sync but far below a multi-hour cold sync, so a
 * kept-current cache never trips it. Cold (non-restored) syncs are not bounded by this.
 */
export const DEFAULT_RESTORED_SYNC_TIMEOUT_MS = 15 * 60_000;

/**
 * Best-effort chain identity (genesis block hash) for a network, used to detect a reset/replacement under the same
 * network id. Returns `null` on any failure (RPC unavailable, unexpected shape, timeout) — callers then skip the
 * proactive check and rely on the restore self-heal. Never throws.
 */
export const fetchChainFingerprint = async (nodeUrl: string, timeoutMs = 5_000): Promise<string | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(nodeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'chain_getBlockHash', params: [0] }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    const result = (json as { result?: unknown }).result;
    return typeof result === 'string' && result.length > 0 ? result : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// @ts-expect-error apollo client wants a global WebSocket
globalThis.WebSocket = WebSocket;

export interface WalletContext {
  wallet: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
  /**
   * Persist the current synced wallet state to the on-disk cache. Set only for cacheable (hosted) networks; `undefined`
   * on `undeployed`, whose ephemeral chain makes a cross-run snapshot meaningless. Called by `awaitWalletReady` after
   * sync.
   */
  persistState?: () => Promise<void>;
  /**
   * Begin checkpointing the wallet state to the on-disk cache while it syncs, so a long (potentially multi-hour) cold
   * sync that is interrupted resumes from the last checkpoint instead of restarting. Returns a `stop()` that
   * unsubscribes and writes a final snapshot. Set only for cacheable (hosted) networks. Intended for the cache-warming
   * flow; normal test runs (small delta-sync) just rely on `persistState`.
   */
  checkpointWhileSyncing?: (opts?: { readonly intervalMs?: number }) => () => Promise<void>;
  /** True if this wallet was constructed by restoring a cached snapshot (vs. a fresh sync). */
  readonly restoredFromCache: boolean;
  /**
   * Discard the on-disk snapshot for this (network, seed) and disable further writes from this context (so an in-flight
   * checkpoint can't re-create it). Called when a restored wallet fails to become ready, so the next run cold-syncs
   * clean. Set only for cacheable (hosted) networks.
   */
  invalidateCache?: () => void;
}

export interface BuildWalletOpts {
  /**
   * If true, throw instead of triggering a cold sync when no cached snapshot exists on a cacheable network. Use for
   * restore-only runs against networks where a fresh sync is prohibitively slow — the snapshot must be produced
   * out-of-band first (e.g. `yarn workspace @midnight-canary/cli warm`).
   */
  readonly requireCachedState?: boolean;
}

const deriveKeysFromSeed = (seed: string) => {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Failed to initialize HDWallet from seed');
  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Failed to derive keys');
  hdWallet.hdWallet.clear();
  return result.keys;
};

const buildShieldedConfig = (cfg: NetworkConfig) => ({
  networkId: getNetworkId(),
  indexerClientConnection: { indexerHttpUrl: cfg.indexer, indexerWsUrl: cfg.indexerWS },
  provingServerUrl: new URL(cfg.proofServer),
  relayURL: new URL(cfg.node.replace(/^http/, 'ws')),
});

const buildUnshieldedConfig = (cfg: NetworkConfig) => ({
  networkId: getNetworkId(),
  indexerClientConnection: { indexerHttpUrl: cfg.indexer, indexerWsUrl: cfg.indexerWS },
  txHistoryStorage: new InMemoryTransactionHistoryStorage(TransactionHistoryStorage.TransactionHistoryCommonSchema),
});

const buildDustConfig = (cfg: NetworkConfig) => ({
  networkId: getNetworkId(),
  costParameters: {
    additionalFeeOverhead: 300_000_000_000_000n,
    feeBlocksMargin: 5,
  },
  indexerClientConnection: { indexerHttpUrl: cfg.indexer, indexerWsUrl: cfg.indexerWS },
  provingServerUrl: new URL(cfg.proofServer),
  relayURL: new URL(cfg.node.replace(/^http/, 'ws')),
});

/**
 * Resolve with the wallet's first synced `FacadeState`. The canonical "wait until the wallet is synced, then read its
 * state once" primitive — used wherever a one-shot read of synced state is needed (balances, keys, snapshots). Unlike
 * `waitForSync` this is unthrottled; use `waitForSync` when you want the 2s throttle to coalesce a burst of states.
 */
export const firstSyncedState = (wallet: WalletFacade): Promise<FacadeState> =>
  Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));

export const waitForSync = (wallet: WalletFacade, timeoutMs?: number): Promise<FacadeState> => {
  const synced$ = wallet.state().pipe(
    Rx.throttleTime(2_000),
    Rx.filter((s) => s.isSynced),
  );
  return Rx.firstValueFrom(timeoutMs === undefined ? synced$ : synced$.pipe(Rx.timeout({ first: timeoutMs })));
};

/** Monotonic progress watermark for the sync heartbeat: the highest applied-index sum seen and when it last rose. */
export interface HeartbeatProgress {
  readonly best: bigint;
  readonly lastProgressAtMs: number;
}

// Read the first present bigint field among candidate names. The sub-wallets' `SyncProgress` shape is inconsistent
// across SDK versions/sub-wallets (shielded/dust use `appliedId`/`highestTransactionId`, unshielded `appliedIndex`/
// `highestIndex`), so we probe generically rather than couple to one name.
const APPLIED_KEYS = ['appliedIndex', 'appliedId', 'highestRelevantWalletIndex'] as const;
const HIGHEST_KEYS = ['highestIndex', 'highestTransactionId', 'highestRelevantIndex'] as const;

const pickBigint = (obj: unknown, keys: readonly string[]): bigint | null => {
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'bigint') return v;
  }
  return null;
};

const formatProgress = (progress: unknown): { applied: bigint; text: string } => {
  const applied = pickBigint(progress, APPLIED_KEYS) ?? 0n;
  const highest = pickBigint(progress, HIGHEST_KEYS);
  return { applied, text: `${applied}/${highest ?? '?'}` };
};

/**
 * One heartbeat evaluation. Pure (exported for testing): formats a one-line progress summary from the latest wallet
 * state and decides whether the sync has stalled. The applied-index sum across the three sub-wallets only rises as the
 * chain is applied, so a flat sum for `stallMs` while not yet synced means stuck. Defensive: an unexpected shape
 * degrades to an "unavailable" line rather than throwing.
 */
export const syncProgressTick = (
  state: FacadeState | null,
  prev: HeartbeatProgress,
  nowMs: number,
  stallMs: number,
): { readonly next: HeartbeatProgress; readonly line: string; readonly stalled: boolean } => {
  if (state === null) return { next: prev, line: 'waiting for first wallet state…', stalled: false };
  let synced = false;
  try {
    synced = state.isSynced;
  } catch {
    /* treat as not-synced */
  }
  let applied = 0n;
  let detail = 'progress detail unavailable';
  try {
    const sh = formatProgress(state.shielded.progress);
    const un = formatProgress(state.unshielded.progress);
    const du = formatProgress(state.dust.progress);
    applied = sh.applied + un.applied + du.applied;
    detail = `shielded ${sh.text} · unshielded ${un.text} · dust ${du.text}`;
  } catch {
    /* shape surprise — keep the "unavailable" line, fall back to no measurable progress */
  }
  const next: HeartbeatProgress = applied > prev.best ? { best: applied, lastProgressAtMs: nowMs } : prev;
  const stalled = stallMs > 0 && !synced && nowMs - next.lastProgressAtMs >= stallMs;
  return { next, line: `${detail} (synced=${synced})`, stalled };
};

export interface SyncHeartbeatOpts {
  /** How often to log a progress line and check for a stall. Default 60s. */
  readonly intervalMs?: number;
  /** Abort (reject `stalled`) after this long with no forward progress. 0 disables (log only). */
  readonly stallMs?: number;
  /** Label for the log prefix, e.g. the env name. */
  readonly label?: string;
  /** Injectable logger (tests). */
  readonly log?: (msg: string) => void;
}

export interface SyncHeartbeat {
  /** Rejects if the sync stalls (no progress for `stallMs`); otherwise never settles. Race it against the sync. */
  readonly stalled: Promise<never>;
  readonly stop: () => void;
}

/**
 * Periodically log wallet sync progress and, optionally, abort on a stall. Timer-driven (not observable-driven) so a
 * truly hung sync — where the state observable goes silent — is still detected. Without this, a multi-hour warm sync is
 * indistinguishable from a hang (the command emits no per-tick output). The returned `stalled` promise lets the caller
 * `Promise.race` the sync against the stall so a stuck run fails fast (checkpoint persists for the next resume) instead
 * of burning the whole job budget.
 */
export const startSyncHeartbeat = (wallet: WalletFacade, opts: SyncHeartbeatOpts = {}): SyncHeartbeat => {
  const intervalMs = opts.intervalMs ?? 60_000;
  const stallMs = opts.stallMs ?? 0;
  const prefix = `[warm${opts.label ? ` ${opts.label}` : ''}]`;
  // eslint-disable-next-line no-console -- progress heartbeat is the whole point; goes to the CI run log.
  const log = opts.log ?? ((m: string): void => console.log(m));
  const startedMs = Date.now();
  let latest: FacadeState | null = null;
  let progress: HeartbeatProgress = { best: -1n, lastProgressAtMs: startedMs };
  let stopped = false;
  let rejectStalled: ((e: Error) => void) | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    rejectStalled = reject;
  });
  const sub = wallet.state().subscribe({
    next: (s) => {
      latest = s;
    },
  });
  const timer = setInterval(() => {
    if (stopped) return;
    const tick = syncProgressTick(latest, progress, Date.now(), stallMs);
    progress = tick.next;
    log(`${prefix} progress @${Math.round((Date.now() - startedMs) / 60_000)}m — ${tick.line}`);
    if (tick.stalled) {
      stopped = true;
      clearInterval(timer);
      sub.unsubscribe();
      rejectStalled?.(
        new Error(
          `${prefix} no sync progress for ${Math.round(stallMs / 60_000)}m — aborting (likely stalled; checkpoint saved for resume)`,
        ),
      );
    }
  }, intervalMs);
  timer.unref(); // don't keep the event loop alive for the heartbeat alone
  return {
    stalled,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      sub.unsubscribe();
    },
  };
};

export const waitForFunds = (wallet: WalletFacade): Promise<bigint> =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.filter((s) => s.isSynced),
      Rx.map((s) => s.unshielded.balances[unshieldedToken().raw] ?? 0n),
      Rx.filter((b) => b > 0n),
    ),
  );

const registerForDustGeneration = async (
  wallet: WalletFacade,
  unshieldedKeystore: UnshieldedKeystore,
): Promise<void> => {
  const state = await firstSyncedState(wallet);
  if (state.dust.availableCoins.length > 0 && state.dust.balance(new Date()) > 0n) return;

  const nightUtxos = state.unshielded.availableCoins.filter(
    (coin: { meta?: { registeredForDustGeneration?: boolean } }) => coin.meta?.registeredForDustGeneration !== true,
  );

  // No NIGHT UTXOs → nothing to register, dust stays at 0. Returning here
  // avoids hanging on the dust-balance>0 filter below (it would never fire).
  if (nightUtxos.length === 0) return;

  const recipe = await wallet.registerNightUtxosForDustGeneration(
    nightUtxos,
    unshieldedKeystore.getPublicKey(),
    (payload) => unshieldedKeystore.signData(payload),
  );
  const finalized = await wallet.finalizeRecipe(recipe);
  await wallet.submitTransaction(finalized);

  await Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(2_000),
      Rx.filter((s) => s.isSynced),
      Rx.filter((s) => s.dust.balance(new Date()) > 0n),
    ),
  );
};

/**
 * Construct and start the three sub-wallets (shielded, unshielded, dust) for a given seed. Returns a `WalletContext`
 * whose `wallet` is started but not yet synced or funded. Callers wanting the old "wait until funded" behavior should
 * follow with `awaitWalletReady`, or just call `buildWalletAndWaitForFunds`.
 */
export const buildWallet = async (
  cfg: NetworkConfig,
  seed: string,
  opts: BuildWalletOpts = {},
): Promise<WalletContext> => {
  setNetworkId(cfg.networkId);

  const keys = deriveKeysFromSeed(seed);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());

  const walletConfig = {
    ...buildShieldedConfig(cfg),
    ...buildUnshieldedConfig(cfg),
    ...buildDustConfig(cfg),
  };

  // Wallet-state caching: on hosted networks, resume from a cached snapshot
  // (delta-sync) instead of scanning the chain from scratch. `undeployed` is
  // skipped — its stack is recreated each run, so a prior snapshot points at a
  // dead chain. Misses, corrupt files, chain resets, and failed restores all
  // fall back to a full sync (and the bad snapshot is invalidated).
  const cacheable = cfg.networkId !== 'undeployed';
  const chainFingerprint = cacheable ? await fetchChainFingerprint(cfg.node) : null;
  let cached = cacheable ? loadWalletState(cfg.networkId, seed) : null;

  // (5) Proactive network-change detection: a snapshot stamped with a different
  // chain id is for a dead chain — drop it rather than attempt a doomed restore.
  if (cached?.chainFingerprint && chainFingerprint && cached.chainFingerprint !== chainFingerprint) {
    // eslint-disable-next-line no-console
    console.warn(`[wallet-cache] ${cfg.networkId} chain changed since snapshot; discarding cached wallet state.`);
    deleteWalletState(cfg.networkId, seed);
    cached = null;
  }

  if (opts.requireCachedState && cacheable && !cached) {
    throw new Error(
      `No cached wallet state for network "${cfg.networkId}". A fresh sync may take hours; create the cache ` +
        `out-of-band first (e.g. \`yarn workspace @midnight-canary/cli warm --env ${cfg.networkId}\`).`,
    );
  }

  const startFacade = async (restore: WalletStateSnapshot | null): Promise<WalletFacade> => {
    const w = await WalletFacade.init({
      configuration: walletConfig,
      shielded: (c) =>
        restore
          ? ShieldedWallet(c).restore(restore.shielded)
          : ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (c) =>
        restore
          ? UnshieldedWallet(c).restore(restore.unshielded)
          : UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
      dust: (c) =>
        restore
          ? DustWallet(c).restore(restore.dust)
          : DustWallet(c).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
    });
    await w.start(shieldedSecretKeys, dustSecretKey);
    return w;
  };

  // (1) Self-heal: if restoring a snapshot throws at init/start (incompatible
  // serialized state), discard it and cold-sync fresh instead of failing.
  let wallet: WalletFacade;
  let restoredFromCache = false;
  if (cached) {
    try {
      wallet = await startFacade(cached);
      restoredFromCache = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[wallet-cache] ${cfg.networkId} restore failed (${err instanceof Error ? err.message : String(err)}); ` +
          'discarding snapshot and cold-syncing.',
      );
      deleteWalletState(cfg.networkId, seed);
      wallet = await startFacade(null);
    }
  } else {
    wallet = await startFacade(null);
  }

  // Saves can be disabled (after invalidation) so an in-flight checkpoint can't
  // re-create a snapshot we just discarded.
  let cacheDisabled = false;

  // Single serialize+save of the current (possibly mid-sync) state, stamped with
  // the chain id. Mid-sync snapshots are coherent and cheap to restore.
  const saveSnapshot = async (): Promise<void> => {
    if (!cacheable || cacheDisabled) return;
    saveWalletState(cfg.networkId, seed, {
      shielded: await wallet.shielded.serializeState(),
      unshielded: await wallet.unshielded.serializeState(),
      dust: await wallet.dust.serializeState(),
      ...(chainFingerprint ? { chainFingerprint } : {}),
    });
  };

  const persistState = cacheable ? saveSnapshot : undefined;
  const invalidateCache = cacheable
    ? (): void => {
        cacheDisabled = true;
        deleteWalletState(cfg.networkId, seed);
      }
    : undefined;

  const checkpointWhileSyncing = cacheable
    ? (checkpointOpts: { readonly intervalMs?: number } = {}): (() => Promise<void>) => {
        const intervalMs = checkpointOpts.intervalMs ?? 30_000;
        let inFlight = false;
        const sub = wallet
          .state()
          .pipe(Rx.throttleTime(intervalMs, undefined, { leading: true, trailing: true }))
          .subscribe({
            next: () => {
              if (inFlight) return;
              inFlight = true;
              // A failed checkpoint must never break the sync — swallow and retry next tick.
              void saveSnapshot()
                .catch(() => undefined)
                .finally(() => {
                  inFlight = false;
                });
            },
          });
        return async () => {
          sub.unsubscribe();
          await saveSnapshot().catch(() => undefined);
        };
      }
    : undefined;

  return {
    wallet,
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
    persistState,
    checkpointWhileSyncing,
    restoredFromCache,
    invalidateCache,
  };
};

export interface AwaitWalletReadyOpts {
  /**
   * If true (default), block until the wallet has a positive unshielded NIGHT balance and dust generation is producing
   * — appropriate for `undeployed` with the genesis-mint seed where funding is guaranteed.
   *
   * If false, only wait for chain sync. Use for hosted environments (preprod/preview) with user-supplied seeds, where
   * the wallet may have zero funds and `waitForFunds` / dust-registration would otherwise hang indefinitely.
   */
  readonly requireFunds?: boolean;
  /**
   * Bound the wait for the wallet to reach a synced state. When the wallet was restored from cache and doesn't sync
   * within this window, the snapshot is treated as incompatible (chain changed): the cache is invalidated and the call
   * rejects so the next run cold-syncs clean. Omit (undefined) to wait indefinitely — appropriate for a deliberate cold
   * sync (e.g. the `warm` flow). Has no effect when the wallet wasn't restored.
   */
  readonly syncTimeoutMs?: number;
}

/**
 * Wait for the wallet to sync, and (depending on opts) for unshielded funds
 *
 * - Dust generation. Returns the same `WalletContext` that was passed in. Split out of `buildWalletAndWaitForFunds` so
 *   callers (e.g. the CLI) can wrap this with a live progress spinner.
 */
export const awaitWalletReady = async (ctx: WalletContext, opts: AwaitWalletReadyOpts = {}): Promise<WalletContext> => {
  const requireFunds = opts.requireFunds ?? true;
  // Only bound the sync when the wallet was restored — a restored wallet that
  // can't catch up signals an incompatible snapshot (chain changed). A cold
  // sync is left unbounded.
  const syncTimeoutMs = ctx.restoredFromCache ? opts.syncTimeoutMs : undefined;
  try {
    const synced = await waitForSync(ctx.wallet, syncTimeoutMs);
    // (2) Refresh the cache best-effort — a write failure must not fail an
    // otherwise-good run. No-op on undeployed (persistState is undefined).
    try {
      await ctx.persistState?.();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[wallet-cache] failed to persist wallet state: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!requireFunds) return ctx;
    const balance = synced.unshielded.balances[unshieldedToken().raw] ?? 0n;
    if (balance === 0n) {
      await waitForFunds(ctx.wallet);
    }
    await registerForDustGeneration(ctx.wallet, ctx.unshieldedKeystore);
    return ctx;
  } catch (err) {
    // (3)/(4) A restored wallet that failed to become ready is almost certainly
    // a stale/incompatible snapshot — invalidate it so the next run cold-syncs
    // clean, then surface the error.
    if (ctx.restoredFromCache) {
      ctx.invalidateCache?.();
      // eslint-disable-next-line no-console
      console.warn(
        '[wallet-cache] restored wallet failed to become ready; snapshot invalidated, next run will cold-sync.',
      );
    }
    throw err;
  }
};

export const buildWalletAndWaitForFunds = async (cfg: NetworkConfig, seed: string): Promise<WalletContext> => {
  const ctx = await buildWallet(cfg, seed);
  return awaitWalletReady(ctx);
};

export const buildFreshFundedWallet = (cfg: NetworkConfig): Promise<WalletContext> =>
  buildWalletAndWaitForFunds(cfg, GENESIS_MINT_SEED);

export const generateFreshSeed = (): string => toHex(Buffer.from(generateRandomSeed()));

/**
 * Derive an unshielded address from a seed and return both the bech32m string form (for display/paste) and the raw
 * 32-byte form circuits expect. Caller must have already invoked `setNetworkId(...)` (done by
 * `buildWalletAndWaitForFunds`).
 */
export const deriveUnshieldedAddressFromSeed = (
  seed: string,
): { readonly encoded: string; readonly bytes: Uint8Array } => {
  const keys = deriveKeysFromSeed(seed);
  const keystore = createKeystore(keys[Roles.NightExternal], getNetworkId());
  const bech = keystore.getBech32Address();
  return { encoded: bech.asString(), bytes: bech.data };
};

/**
 * Parse a user-supplied bech32m unshielded address (e.g. `mn_addr_<network>1…`) into the `{ bytes }` shape circuits
 * expect. Throws with a friendly message on malformed input or network mismatch.
 */
export const parseUnshieldedBech32m = (input: string): { bytes: Uint8Array } => {
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('Empty unshielded address.');
  let parsed: MidnightBech32m;
  try {
    parsed = MidnightBech32m.parse(trimmed);
  } catch (err) {
    throw new Error(`Not a valid bech32m string: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  try {
    const addr = parsed.decode(UnshieldedAddress, getNetworkId());
    return { bytes: addr.data };
  } catch (err) {
    throw new Error(
      `Could not decode as an unshielded address (wrong type or network): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
};

/**
 * Get the current wallet's user-facing addresses as bech32m strings for display. Useful when echoing "this is your
 * address" back to the user.
 */
export const getWalletAddressesBech32m = (ctx: WalletContext): { readonly unshielded: string } => {
  return { unshielded: ctx.unshieldedKeystore.getBech32Address().asString() };
};

/**
 * Derive a full bech32m shielded address from a seed. Returns the encoded address string for display, plus the bytes of
 * the `ZswapCoinPublicKey` portion — which is what shielded `sendShielded(..., publicKey, ...)` circuits expect as the
 * recipient.
 */
export const deriveShieldedCoinPublicKeyFromSeed = (
  seed: string,
): { readonly encoded: string; readonly bytes: Uint8Array } => {
  const keys = deriveKeysFromSeed(seed);
  const sks = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const cpkBytes = ledger.encodeCoinPublicKey(sks.coinPublicKey);
  const cpk = new ShieldedCoinPublicKey(Buffer.from(cpkBytes));
  const epk = ShieldedEncryptionPublicKey.fromHexString(sks.encryptionPublicKey);
  const address = new ShieldedAddress(cpk, epk);
  const bech = MidnightBech32m.encode(getNetworkId(), address);
  return { encoded: bech.asString(), bytes: cpk.data };
};

/**
 * Parse a user-supplied bech32m shielded address into the `{ bytes }` shape shielded circuits expect. Returns just the
 * coin pubkey portion — the encryption pubkey is unused by the contract circuit. Throws on malformed input or network
 * mismatch.
 */
export const parseShieldedAddressBech32m = (input: string): { bytes: Uint8Array } => {
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('Empty shielded address.');
  let parsed: MidnightBech32m;
  try {
    parsed = MidnightBech32m.parse(trimmed);
  } catch (err) {
    throw new Error(`Not a valid bech32m string: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  try {
    const addr = parsed.decode(ShieldedAddress, getNetworkId());
    return { bytes: addr.coinPublicKey.data };
  } catch (err) {
    throw new Error(
      `Could not decode as a shielded address (wrong type or network): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
};
