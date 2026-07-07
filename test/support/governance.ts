import { CompiledContract } from '@midnight-ntwrk/compact-js';
import {
  ContractMaintenanceAuthority,
  Intent,
  MaintenanceUpdate,
  ReplaceAuthority,
  signData,
  Transaction,
} from '@midnight-ntwrk/ledger-v8';
import { submitTx } from '@midnight-ntwrk/midnight-js/contracts';
import { getNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { asContractAddress } from '@midnight-ntwrk/midnight-js/types';
import { ShieldedNightContract } from '../../src/index.ts';
import type { ShieldedNightProviders } from './shielded-night.js';

/**
 * Governance helpers for exercising the Contract Maintenance Authority (CMA) —
 * the committee of signing keys allowed to change a contract's rules.
 *
 * The SDK's `submitReplaceAuthorityTx` only accepts a single `SigningKey`, so
 * it can only ever install a 1-of-1 committee. To install an EMPTY committee
 * (the "no maintainer, permanently static" state) we build the maintenance
 * update from the ledger primitives directly, exactly as the SDK does
 * internally (`Transaction.fromParts(... Intent.addMaintenanceUpdate(update))`),
 * but with a committee of `[]`.
 */

/** Build the contract's CompiledContract, as the contract factory does internally. */
export const buildCompiled = (zkConfigPath: string) =>
  CompiledContract.make('shielded-night', ShieldedNightContract.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );

export interface AuthoritySnapshot {
  readonly committeeSize: number;
  readonly threshold: number;
  readonly counter: bigint;
}

/** Read the on-chain maintenance authority for a contract. */
export const readAuthority = async (
  providers: ShieldedNightProviders,
  address: string,
): Promise<AuthoritySnapshot> => {
  const state = await providers.publicDataProvider.queryContractState(address);
  if (state == null) throw new Error(`no contract state on chain for ${address}`);
  const cma = state.maintenanceAuthority;
  return {
    committeeSize: cma.committee.length,
    threshold: cma.threshold,
    counter: cma.counter,
  };
};

const ttlOneHour = (): Date => new Date(Date.now() + 60 * 60 * 1000);

/**
 * Replace the contract's maintenance authority with an EMPTY committee at the
 * given threshold (default 1). With zero members and a positive threshold no
 * signature set can ever satisfy it, so no future maintenance update can be
 * authorized — the contract becomes permanently static. This is a one-way
 * door: the current authority signs the update that dissolves itself.
 *
 * @param threshold Members required to sign future updates. MUST be >= 1 — a
 *   threshold of 0 over an empty committee is trivially satisfiable (the
 *   opposite of locked).
 */
export const lockContract = async (
  providers: ShieldedNightProviders,
  address: string,
  threshold = 1,
): Promise<void> => {
  if (threshold < 1) {
    throw new Error(
      'lockContract: threshold must be >= 1; an empty committee at threshold 0 is trivially updatable',
    );
  }
  const state = await providers.publicDataProvider.queryContractState(address);
  if (state == null) throw new Error(`no contract state on chain for ${address}`);
  const currentSigningKey = await providers.privateStateProvider.getSigningKey(address);
  if (currentSigningKey == null) throw new Error(`no signing key stored for ${address}`);

  const counter = state.maintenanceAuthority.counter;
  const emptyAuthority = new ContractMaintenanceAuthority([], threshold, counter + 1n);
  const update = new MaintenanceUpdate(
    asContractAddress(address),
    [new ReplaceAuthority(emptyAuthority)],
    counter,
  );
  // The CURRENT authority must sign the update that installs the empty one.
  const signed = update.addSignature(0n, signData(currentSigningKey, update.dataToSign));

  const unprovenTx = Transaction.fromParts(
    getNetworkId(),
    undefined,
    undefined,
    Intent.new(ttlOneHour()).addMaintenanceUpdate(signed),
  );
  await submitTx(providers, { unprovenTx });
};
