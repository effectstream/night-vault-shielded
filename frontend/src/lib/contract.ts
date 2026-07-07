import { CompiledContract, type ProvableCircuitId } from '@midnight-ntwrk/compact-js';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js/types';
// Compiled ShieldedNight artifacts live in the repo root's src/managed.
import * as ShieldedNight from '../../../src/managed/contract/index.js';

export type ShieldedNightContractT = ShieldedNight.Contract<undefined>;
export type ShieldedNightCircuits = ProvableCircuitId<ShieldedNightContractT>;
export type ShieldedNightProviders = MidnightProviders<ShieldedNightCircuits>;
export type ShieldedNightLedger = ReturnType<typeof ShieldedNight.ledger>;

export const ledger = ShieldedNight.ledger;

/** Served path (see vite.config `viteStaticCopy`) for prover/verifier keys + zkir. */
export const ZK_CONFIG_CONTRACT_NAME = 'shielded-night';

/**
 * The compiled contract handle midnight-js needs for deploy/find/callTx. No
 * witnesses (the secret is a circuit argument), so vacant witnesses.
 */
export const CompiledShieldedNight = CompiledContract.make<ShieldedNight.Contract>(
  'ShieldedNight',
  ShieldedNight.Contract,
).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(`./contract/compiled/${ZK_CONFIG_CONTRACT_NAME}`),
);

/** ShieldedCoinInfo shape as it appears in the contract ABI. */
export interface ShieldedCoinInfo {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
}

/** `Either<ContractAddress, UserAddress>` with the user (right) branch set. */
export const rightUserAddress = (bytes: Uint8Array) => ({
  is_left: false,
  left: { bytes: new Uint8Array(32) },
  right: { bytes },
});
