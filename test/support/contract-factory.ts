import { type ContractAddress } from '@midnight-ntwrk/compact-runtime';
import { CompiledContract, type ProvableCircuitId } from '@midnight-ntwrk/compact-js';
import type { Contract } from '@midnight-ntwrk/compact-js/effect/Contract';
import type { ChargedState } from '@midnight-ntwrk/ledger-v8';
import type { Types } from 'effect';
import {
  deployContract,
  type DeployedContract,
  findDeployedContract,
  type FoundContract,
} from '@midnight-ntwrk/midnight-js/contracts';
import { type MidnightProviders } from '@midnight-ntwrk/midnight-js/types';
import { withRetry } from './instrumentation.js';

export interface ContractFactoryConfig<Name extends string, PsId extends string, C extends Contract.Any, LS> {
  readonly name: Name;
  readonly contractCtor: Types.Ctor<C>;
  readonly ledger: (data: ChargedState) => LS;
  readonly privateStateId: PsId;
  readonly initialPrivateState: Contract.PrivateState<C>;
  readonly privateStateStoreName?: string;
  readonly witnesses?: unknown;
}

export interface ContractFactory<Name extends string, PsId extends string, C extends Contract.Any, LS> {
  readonly name: Name;
  readonly privateStateId: PsId;
  readonly privateStateStoreName: string;
  /** Decoder from on-chain `ChargedState` to the typed ledger view. */
  readonly ledger: (data: ChargedState) => LS;
  readonly deploy: (
    providers: MidnightProviders<ProvableCircuitId<C>, PsId, Contract.PrivateState<C>>,
    zkConfigPath: string,
    args: Contract.InitializeParameters<C>,
    /**
     * Per-deploy override for `initialPrivateState`. When omitted, falls back to the value supplied at `defineContract`
     * time. Useful for contracts with non-trivial private state (e.g. bboard's secret key) where each deploy needs a
     * fresh value, or for tests that need to pin the private state deterministically.
     */
    initialPrivateState?: Contract.PrivateState<C>,
  ) => Promise<DeployedContract<C>>;
  /**
   * Attach providers to an already-deployed contract.
   *
   * `initialPrivateState` is written to `privateStateProvider[privateStateId]` (per the SDK's `findDeployedContract`
   * semantics). For contracts whose witnesses read per-caller state (e.g. battleship's `localSk`), each wallet must
   * connect with its OWN previously-built PS so its leveldb isn't overwritten with the factory default. Omit for
   * contracts with no witnesses (the factory's default state is used).
   */
  readonly connect: (
    providers: MidnightProviders<ProvableCircuitId<C>, PsId, Contract.PrivateState<C>>,
    zkConfigPath: string,
    contractAddress: ContractAddress,
    initialPrivateState?: Contract.PrivateState<C>,
  ) => Promise<FoundContract<C>>;
  readonly readLedger: (
    providers: MidnightProviders<ProvableCircuitId<C>, PsId, Contract.PrivateState<C>>,
    contractAddress: ContractAddress,
  ) => Promise<LS | null>;
}

export type ContractProviders<F> =
  F extends ContractFactory<infer _Name, infer PsId, infer C, infer _LS>
    ? MidnightProviders<ProvableCircuitId<C>, PsId, Contract.PrivateState<C>>
    : never;

export type ContractDeployed<F> =
  F extends ContractFactory<infer _Name, infer _PsId, infer C, infer _LS>
    ? DeployedContract<C> | FoundContract<C>
    : never;

export type ContractInitArgs<F> =
  F extends ContractFactory<infer _Name, infer _PsId, infer C, infer _LS> ? Contract.InitializeParameters<C> : never;

export type ContractLedgerState<F> =
  F extends ContractFactory<infer _Name, infer _PsId, infer _C, infer LS> ? LS : never;

export type ContractCircuits<F> =
  F extends ContractFactory<infer _Name, infer _PsId, infer C, infer _LS> ? ProvableCircuitId<C> : never;

const registry = new Map<string, ContractFactory<string, string, Contract.Any, unknown>>();

export const defineContract = <Name extends string, PsId extends string, C extends Contract.Any, LS>(
  cfg: ContractFactoryConfig<Name, PsId, C, LS>,
): ContractFactory<Name, PsId, C, LS> => {
  const privateStateStoreName = cfg.privateStateStoreName ?? `${cfg.name}-private-state`;

  const buildCompiledContract = (
    zkConfigPath: string,
  ): CompiledContract.CompiledContract<C, Contract.PrivateState<C>> => {
    const base = CompiledContract.make<C>(cfg.name, cfg.contractCtor);
    const compiled =
      cfg.witnesses == null
        ? base.pipe(CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(zkConfigPath))
        : base.pipe(
            CompiledContract.withWitnesses(cfg.witnesses as never),
            CompiledContract.withCompiledFileAssets(zkConfigPath),
          );
    return compiled;
  };

  // The SDK's `deployContract`/`findDeployedContract` use a conditional type
  // on `args` (present only when `InitializeParameters<C>` is non-empty),
  // which TypeScript can't resolve from inside this generic. We hide that
  // discrepancy here so callers can pass `args` as a plain tuple — including
  // `[]` for no-arg constructors — without `as never` casts.
  const sdkDeploy = deployContract as unknown as (
    providers: MidnightProviders<ProvableCircuitId<C>, PsId, Contract.PrivateState<C>>,
    options: {
      readonly compiledContract: CompiledContract.CompiledContract<C, Contract.PrivateState<C>>;
      readonly privateStateId: PsId;
      readonly initialPrivateState: Contract.PrivateState<C>;
      readonly args: Contract.InitializeParameters<C>;
    },
  ) => Promise<DeployedContract<C>>;

  const sdkFind = findDeployedContract as unknown as (
    providers: MidnightProviders<ProvableCircuitId<C>, PsId, Contract.PrivateState<C>>,
    options: {
      readonly contractAddress: ContractAddress;
      readonly compiledContract: CompiledContract.CompiledContract<C, Contract.PrivateState<C>>;
      readonly privateStateId: PsId;
      readonly initialPrivateState: Contract.PrivateState<C>;
    },
  ) => Promise<FoundContract<C>>;

  const factory: ContractFactory<Name, PsId, C, LS> = {
    name: cfg.name,
    privateStateId: cfg.privateStateId,
    privateStateStoreName,
    ledger: cfg.ledger,
    deploy: (providers, zkConfigPath, args, initialPrivateState) =>
      sdkDeploy(providers, {
        compiledContract: buildCompiledContract(zkConfigPath),
        privateStateId: cfg.privateStateId,
        initialPrivateState: initialPrivateState ?? cfg.initialPrivateState,
        args,
      }),
    connect: (providers, zkConfigPath, contractAddress, initialPrivateState) =>
      sdkFind(providers, {
        contractAddress,
        compiledContract: buildCompiledContract(zkConfigPath),
        privateStateId: cfg.privateStateId,
        initialPrivateState: initialPrivateState ?? cfg.initialPrivateState,
      }),
    readLedger: async (providers, contractAddress) => {
      const state = await withRetry(() => providers.publicDataProvider.queryContractState(contractAddress));
      return state == null ? null : cfg.ledger(state.data);
    },
  };

  if (registry.has(cfg.name)) {
    throw new Error(`Contract "${cfg.name}" is already registered. Each defineContract() call must use a unique name.`);
  }
  registry.set(cfg.name, factory);
  return factory;
};

export const registeredContracts = (): ReadonlyArray<string> => Array.from(registry.keys());
