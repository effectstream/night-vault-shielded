import type { Contract } from '@midnight-ntwrk/compact-js/effect/Contract';
import { afterAll, beforeAll } from 'vitest';
import type { ContractFactory } from './contract-factory.js';
import {
  type EnvName,
  GENESIS_FUNDED_SEEDS,
  type GenesisFundedSeedName,
  GENESIS_MINT_SEED,
  type NetworkConfig,
} from './network.js';
import { setupContract, type SetupContractResult } from './setup-contract.js';
import {
  awaitWalletReady,
  buildWallet,
  DEFAULT_RESTORED_SYNC_TIMEOUT_MS,
  type WalletContext,
} from './wallet-builder.js';

interface EnvFromSetup {
  readonly env: EnvName;
  readonly network: NetworkConfig;
  readonly seed: string;
}

/**
 * Read the env/network/seed stashed by `global-setup.ts`. Centralizes the `__MN_ENV__` / `__MN_CFG__` contract so each
 * test file doesn't re-implement it.
 */
export const readEnvFromSetup = (): EnvFromSetup => {
  const env = process.env.__MN_ENV__ as EnvName | undefined;
  const cfgRaw = process.env.__MN_CFG__;
  if (!env || !cfgRaw) throw new Error('global-setup did not populate __MN_ENV__/__MN_CFG__');
  const network = JSON.parse(cfgRaw) as NetworkConfig;
  const seed = process.env.MN_SEED ?? (env === 'undeployed' ? GENESIS_MINT_SEED : '');
  if (!seed) throw new Error(`MN_SEED is required for env=${env}`);
  return { env, network, seed };
};

/**
 * Build a wallet for the given (env, network, seed). One wallet per `describeContract` block — i.e. typically one per
 * test file.
 *
 * We don't share wallets across describe blocks: the wallet's local UTXO view doesn't immediately reflect spends
 * submitted by the previous block until the indexer + sync stream catches up, which races against the next file's first
 * deploy and trips `DustDoubleSpend` (midnight-node error 196). Building per describe pays ~30s extra per test file
 * (much more on hosted envs), but the runs are deterministic.
 *
 * `requireFunds` is set from `env`:
 *
 * - `undeployed` (true): genesis seed; balance + dust are guaranteed and we can safely block on `waitForFunds` +
 *   auto-register dust.
 * - `preprod`/`preview` (false): operator-supplied seed; we wait for chain sync only. The operator must pre-fund the seed
 *   with NIGHT and register it for DUST generation before running the smoke. Skipping the auto-funding path here means
 *   an unprepared seed surfaces as a clean "tx couldn't be balanced" error at deploy time instead of an indefinite hang
 *   in `waitForFunds`.
 *
 * Within a single describe block all tests share one wallet (handled by the `beforeAll` below).
 */
const buildWalletForBlock = async (
  env: EnvName,
  network: NetworkConfig,
  seed: string,
): Promise<{ ctx: WalletContext; stop: () => Promise<void> }> => {
  // Restore-only: when MN_REQUIRE_WALLET_CACHE=1, refuse to cold-sync a hosted
  // wallet inside a test run (warm the cache out-of-band first). No effect on
  // undeployed (not cacheable) or when unset.
  const requireCachedState = process.env.MN_REQUIRE_WALLET_CACHE === '1';
  const raw = await buildWallet(network, seed, { requireCachedState });
  // Bound the sync for a restored wallet: if it can't catch up (chain changed
  // under the snapshot), the cache is invalidated and this fails fast rather
  // than hanging to the hook timeout — the next run cold-syncs clean.
  const ctx = await awaitWalletReady(raw, {
    requireFunds: env === 'undeployed',
    syncTimeoutMs: DEFAULT_RESTORED_SYNC_TIMEOUT_MS,
  });
  const stop = async () => {
    await ctx.wallet.stop().catch(() => undefined);
  };
  return { ctx, stop };
};

/**
 * One-liner for the common case: read env, get shared wallet, configure providers, expose to the `body` callback.
 * Wallet teardown is lazy (`process.on('beforeExit')`) so multiple `describeContract` blocks in different files share
 * the same wallet.
 *
 * Usage: describeContract(publicCounter.factory, (ctx) => { test('…', async () => { await ctx().deployFresh([7n]); });
 * });
 */
export const describeContract = <Name extends string, PsId extends string, C extends Contract.Any, LS>(
  factory: ContractFactory<Name, PsId, C, LS>,
  body: (
    getCtx: () => SetupContractResult<Name, PsId, C, LS> & {
      readonly env: EnvName;
      readonly network: NetworkConfig;
      readonly walletCtx: WalletContext;
    },
  ) => void,
): void => {
  let ctx:
    | (SetupContractResult<Name, PsId, C, LS> & {
        readonly env: EnvName;
        readonly network: NetworkConfig;
        readonly walletCtx: WalletContext;
      })
    | undefined;
  let stopWallet: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const { env, network, seed } = readEnvFromSetup();
    const { ctx: walletCtx, stop } = await buildWalletForBlock(env, network, seed);
    stopWallet = stop;
    const base = await setupContract(factory, { network, walletCtx });
    ctx = { ...base, env, network, walletCtx };
  });
  afterAll(async () => {
    ctx = undefined;
    if (stopWallet) await stopWallet();
    stopWallet = undefined;
  });
  body(() => {
    if (ctx == null) throw new Error('describeContract body ran before beforeAll resolved');
    return ctx;
  });
};

/**
 * Per-wallet view exposed inside a `describeContractWithWallets` body: each named wallet carries its own providers,
 * `deployFresh` (sign+submit with its keys), `connect` (attach to an existing contract via its providers), and the raw
 * `walletCtx` for advanced reads (addresses, balances).
 */
export type WalletSlot<Name extends string, PsId extends string, C extends Contract.Any, LS> = SetupContractResult<
  Name,
  PsId,
  C,
  LS
> & {
  readonly walletCtx: WalletContext;
};

/**
 * Body context for `describeContractWithWallets`: one `WalletSlot` per requested wallet name, plus the shared `env` and
 * `network`. Typed as `Record<W, WalletSlot>` so `ctx().alice.deployFresh(...)` is statically valid only for wallets
 * that were actually requested.
 */
export type MultiWalletCtx<
  W extends string,
  Name extends string,
  PsId extends string,
  C extends Contract.Any,
  LS,
> = Record<W, WalletSlot<Name, PsId, C, LS>> & {
  readonly env: EnvName;
  readonly network: NetworkConfig;
};

/**
 * Multi-wallet variant of `describeContract` for tests that need >1 party (e.g. Alice deploys, Bob/Claire connect with
 * their own keys and call circuits against the same contract).
 *
 * Only supported on `undeployed`, where the local devnet genesis pre-funds the seeds in `GENESIS_FUNDED_SEEDS`. On
 * hosted environments this throws — each operator-supplied seed there would need its own seed env var (out of scope for
 * the canary smoke).
 *
 * Each wallet gets its own LevelDB path (`midnight-level-db-${name}`) so multiple `levelPrivateStateProvider`s in the
 * same vitest worker don't trip the "Database failed to open" lock error (see provider-wiring.ts).
 *
 * Usage: describeContractWithWallets(helloWorld.factory, ['alice', 'bob', 'claire'], (ctx) => { test('Alice deploys,
 * Bob writes', async () => { const { alice, bob } = ctx(); const deployed = await alice.deployFresh([]); const bobView
 * = await bob.connect(deployed.deployTxData.public.contractAddress); // bobView.callTx.someCircuit(...) }); });
 */
export const describeContractWithWallets = <
  W extends GenesisFundedSeedName,
  Name extends string,
  PsId extends string,
  C extends Contract.Any,
  LS,
>(
  factory: ContractFactory<Name, PsId, C, LS>,
  wallets: ReadonlyArray<W>,
  body: (getCtx: () => MultiWalletCtx<W, Name, PsId, C, LS>) => void,
): void => {
  let ctx: MultiWalletCtx<W, Name, PsId, C, LS> | undefined;
  const stopFns: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    const { env, network } = readEnvFromSetup();
    if (env !== 'undeployed') {
      throw new Error(
        `describeContractWithWallets is only supported on env=undeployed (pre-funded genesis seeds). ` +
          `Got env=${env}.`,
      );
    }
    if (wallets.length === 0) throw new Error('describeContractWithWallets requires at least one wallet name.');
    const unique = new Set<W>(wallets);
    if (unique.size !== wallets.length) {
      throw new Error(`describeContractWithWallets: duplicate wallet names in ${JSON.stringify(wallets)}.`);
    }

    // Build all wallets in parallel — three cold syncs take ~30s each on
    // undeployed, so serialising them would triple beforeAll latency.
    const built = await Promise.all(
      wallets.map(async (name) => {
        const seed = GENESIS_FUNDED_SEEDS[name];
        const { ctx: walletCtx, stop } = await buildWalletForBlock(env, network, seed);
        stopFns.push(stop);
        const setup = await setupContract(factory, {
          network,
          walletCtx,
          // One leveldb directory per wallet — concurrent providers against the
          // SDK default path collide on the leveldb lock.
          midnightDbName: `midnight-level-db-${name}`,
        });
        const slot: WalletSlot<Name, PsId, C, LS> = { ...setup, walletCtx };
        return [name, slot] as const;
      }),
    );

    const slots = Object.fromEntries(built) as Record<W, WalletSlot<Name, PsId, C, LS>>;
    ctx = { ...slots, env, network };
  });

  afterAll(async () => {
    ctx = undefined;
    // Stop wallets in parallel; swallow individual stop errors so one bad
    // wallet doesn't prevent the others from closing their sockets.
    await Promise.all(stopFns.map((stop) => stop().catch(() => undefined)));
    stopFns.length = 0;
  });

  body(() => {
    if (ctx == null) throw new Error('describeContractWithWallets body ran before beforeAll resolved');
    return ctx;
  });
};
