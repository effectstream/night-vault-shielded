import { CompiledContract, type ProvableCircuitId } from '@midnight-ntwrk/compact-js';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js/types';
// Compiled ConvertVault artifacts live in the repo root's src/managed.
import * as ConvertVault from '../../../src/managed/contract/index.js';

export type ConvertVaultContractT = ConvertVault.Contract<undefined>;
export type ConvertVaultCircuits = ProvableCircuitId<ConvertVaultContractT>;
export type ConvertVaultProviders = MidnightProviders<ConvertVaultCircuits>;
export type ConvertVaultLedger = ReturnType<typeof ConvertVault.ledger>;

export const ledger = ConvertVault.ledger;

/** Served path (see vite.config `viteStaticCopy`) for prover/verifier keys + zkir. */
export const ZK_CONFIG_CONTRACT_NAME = 'convert-vault';

/**
 * The compiled contract handle midnight-js needs for deploy/find/callTx. No
 * witnesses (the secret is a circuit argument), so vacant witnesses.
 */
export const CompiledConvertVault = CompiledContract.make<ConvertVault.Contract>(
  'ConvertVault',
  ConvertVault.Contract,
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
