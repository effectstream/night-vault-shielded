import { type ContractAddress } from '@midnight-ntwrk/compact-runtime';
import type { ProvableCircuitId } from '@midnight-ntwrk/compact-js';
import type { Contract } from '@midnight-ntwrk/compact-js/effect/Contract';
import type { ContractFactory, ContractInitArgs, ContractProviders } from './contract-factory.js';
import { type NetworkConfig } from './network.js';
import { configureProviders, resolveZkConfigPath } from './provider-wiring.js';
import { type WalletContext } from './wallet-builder.js';

export interface SetupContractInput {
  readonly network: NetworkConfig;
  readonly walletCtx: WalletContext;
  /**
   * Optional LevelDB database name. When multiple wallets in the same vitest worker need providers against the same
   * factory (multi-party tests), each wallet must pass a distinct `midnightDbName` — sharing one trips a "Database
   * failed to open" lock error in `level-private-state-provider`. Omit for the common single-wallet case.
   */
  readonly midnightDbName?: string;
}

// Provider instances are keyed by (walletCoinPublicKey, factory.name, midnightDbName)
// so two callers (e.g. a test file and a CLI subcommand, or two `describeContract`
// blocks) targeting the same factory + same wallet + same db share one
// `levelPrivateStateProvider`. Multi-wallet tests pass distinct
// `midnightDbName`s so each wallet gets its own leveldb without colliding on
// the SDK default path.
const providersCache = new Map<string, Promise<unknown>>();

export interface SetupContractResult<Name extends string, PsId extends string, C extends Contract.Any, LS> {
  readonly providers: ContractProviders<ContractFactory<Name, PsId, C, LS>>;
  readonly zkConfigPath: string;
  /**
   * Deploy a fresh instance of the contract from this wallet.
   *
   * Pass `initialPrivateState` to seed this wallet's `levelPrivateStateProvider` under the factory's `privateStateId` —
   * required whenever the constructor consumes a witness/secret that later circuits also need to read (e.g.
   * `private-party`'s organizer secret, `bboard`'s poster key). Omit for contracts whose private state is empty
   * (`hello-world`, `public-counter`).
   */
  readonly deployFresh: (
    args: ContractInitArgs<ContractFactory<Name, PsId, C, LS>>,
    initialPrivateState?: Contract.PrivateState<C>,
  ) => ReturnType<ContractFactory<Name, PsId, C, LS>['deploy']>;
  /**
   * Attach this wallet's providers to an already-deployed contract at `address`. Use for multi-party tests where one
   * wallet deploys and a second wallet calls circuits against the same address with its own keys/private state.
   *
   * Pass `initialPrivateState` whenever this wallet has just `.set()` its own per-player private state into leveldb and
   * needs the `findDeployedContract` write-back to be idempotent rather than reverting to the factory default. Required
   * for contracts whose witnesses read per-caller state (e.g. battleship's `localSk`).
   */
  readonly connect: (
    address: ContractAddress,
    initialPrivateState?: Contract.PrivateState<C>,
  ) => ReturnType<ContractFactory<Name, PsId, C, LS>['connect']>;
}

/**
 * Framework-agnostic contract wiring: takes a (network, walletCtx) plus a factory, returns `{ providers, zkConfigPath,
 * deployFresh, connect }`. Both vitest (via `describeContract`) and the CLI use this so the wallet → providers → deploy
 * plumbing has a single implementation.
 */
export const setupContract = async <Name extends string, PsId extends string, C extends Contract.Any, LS>(
  factory: ContractFactory<Name, PsId, C, LS>,
  input: SetupContractInput,
): Promise<SetupContractResult<Name, PsId, C, LS>> => {
  const { network, walletCtx, midnightDbName } = input;
  const zkConfigPath = resolveZkConfigPath(factory.name);

  const accountId = walletCtx.shieldedSecretKeys.coinPublicKey;
  const pKey = `${accountId}:${factory.name}:${midnightDbName ?? '<default>'}`;
  let providersPromise = providersCache.get(pKey) as
    | Promise<ContractProviders<ContractFactory<Name, PsId, C, LS>>>
    | undefined;
  if (providersPromise == null) {
    providersPromise = configureProviders<PsId, ProvableCircuitId<C>>(walletCtx, network, {
      privateStateStoreName: factory.privateStateStoreName,
      zkConfigPath,
      ...(midnightDbName !== undefined && { midnightDbName }),
    });
    providersCache.set(pKey, providersPromise);
  }
  const providers = await providersPromise;

  return {
    providers,
    zkConfigPath,
    deployFresh: (args, initialPrivateState) => factory.deploy(providers, zkConfigPath, args, initialPrivateState),
    connect: (address, initialPrivateState) => factory.connect(providers, zkConfigPath, address, initialPrivateState),
  };
};
