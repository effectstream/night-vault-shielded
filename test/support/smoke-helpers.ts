import { sampleContractAddress, type ContractAddress, type ContractState } from '@midnight-ntwrk/compact-runtime';
import {
  levelPrivateStateProvider,
  type LevelPrivateStateProviderConfig,
} from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import type { PrivateStateId, PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Rx from 'rxjs';

/** Negative-path wrapper. `tryCall(() => deployed.callTx.x())` returns a tagged result. */
export type CallOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

export const tryCall = async <T>(fn: () => Promise<T>): Promise<CallOutcome<T>> => {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
};

/**
 * Subscribe to a `contractStateObservable` and resolve as soon as the decoded ledger matches a predicate. Use this to
 * block until an on-chain state change propagates through the indexer subscription stream.
 *
 * Default `timeoutMs` is 5 min — matches `wallet-observations.DEFAULT_WAIT_TIMEOUT_MS` and gives enough headroom for
 * hosted-env block times (~6s on preview).
 */
export const observeStateUntil = <LS>(
  obs: Rx.Observable<ContractState>,
  ledgerDecode: (data: ContractState['data']) => LS,
  predicate: (ledger: LS) => boolean,
  timeoutMs = 5 * 60_000,
): Promise<LS> =>
  Rx.firstValueFrom(
    obs.pipe(
      Rx.map((s) => ledgerDecode(s.data)),
      Rx.filter(predicate),
      Rx.timeout({
        each: timeoutMs,
        with: () => Rx.throwError(() => new Error(`observeStateUntil timed out after ${timeoutMs}ms`)),
      }),
    ),
  );

export interface IsolatedPrivateStateOpts {
  /** Filesystem directory that will host the leveldb store. */
  readonly tempRoot: string;
  /** Sublevel name (so multiple providers can share one `tempRoot`). */
  readonly storeName: string;
  /** Storage password — the SDK requires ≥16 chars. */
  readonly password: string;
  /** Optional override for the storage scope. Default is `smoke-test-account`. */
  readonly accountId?: string;
  /**
   * Contract address the provider operates under. The SDK scopes all private state by contract address; providers that
   * need to share data must pin the same address. Defaults to a fresh `sampleContractAddress()`.
   */
  readonly contractAddress?: ContractAddress;
}

/**
 * A fresh `levelPrivateStateProvider` writing to an isolated on-disk leveldb dir — for testing the provider in
 * isolation, with no wallet/contract wiring. Caller is responsible for cleaning up `tempRoot`. The returned provider
 * has already had `setContractAddress(...)` called on it.
 */
export const buildIsolatedPrivateStateProvider = <PSI extends PrivateStateId, PS = unknown>(
  opts: IsolatedPrivateStateOpts,
): PrivateStateProvider<PSI, PS> & ReturnType<typeof levelPrivateStateProvider<PSI, PS>> => {
  const config: Partial<LevelPrivateStateProviderConfig> &
    Pick<LevelPrivateStateProviderConfig, 'privateStoragePasswordProvider' | 'accountId'> = {
    midnightDbName: join(opts.tempRoot, 'leveldb'),
    privateStateStoreName: opts.storeName,
    accountId: opts.accountId ?? 'smoke-test-account',
    privateStoragePasswordProvider: () => opts.password,
  };
  const provider = levelPrivateStateProvider<PSI, PS>(config);
  provider.setContractAddress(opts.contractAddress ?? sampleContractAddress());
  return provider;
};

/** Create a fresh tempdir and return its path plus a cleanup callback. */
export const makeTempRoot = async (
  label: string,
): Promise<{ readonly path: string; readonly cleanup: () => Promise<void> }> => {
  const p = await mkdtemp(join(tmpdir(), `mn-smoke-${label}-`));
  return {
    path: p,
    cleanup: () => rm(p, { recursive: true, force: true }),
  };
};
