import { type ContractAddress } from '@midnight-ntwrk/compact-runtime';
import { ConvertVaultContract, type ConvertVaultPrivateState } from '../../src/index.ts';
import {
  type ContractCircuits,
  type ContractDeployed,
  type ContractProviders,
  defineContract,
} from './contract-factory.js';

const CONVERT_VAULT_PRIVATE_STATE_ID = 'convertVaultPrivateState' as const;

/**
 * ConvertVault factory. The contract has no witnesses (the secret is a circuit
 * argument), so `witnesses` is omitted and the factory takes the
 * vacant-witnesses path.
 */
export const factory = defineContract({
  name: 'convert-vault',
  contractCtor: ConvertVaultContract.Contract,
  ledger: ConvertVaultContract.ledger,
  privateStateId: CONVERT_VAULT_PRIVATE_STATE_ID,
  initialPrivateState: {} as ConvertVaultPrivateState,
});

export type ConvertVaultCircuits = ContractCircuits<typeof factory>;
export type ConvertVaultProviders = ContractProviders<typeof factory>;
export type DeployedConvertVault = ContractDeployed<typeof factory>;

/** Constructor args used by every test deploy: 6 decimals to match native NIGHT. */
export const DEPLOY_ARGS = ['Wrapped NIGHT', 'wNIGHT', 6n] as const;

export const deploy = (providers: ConvertVaultProviders, zkConfigPath: string): Promise<DeployedConvertVault> =>
  factory.deploy(providers, zkConfigPath, [...DEPLOY_ARGS]);

export const connect = (
  providers: ConvertVaultProviders,
  zkConfigPath: string,
  contractAddress: ContractAddress,
): Promise<DeployedConvertVault> => factory.connect(providers, zkConfigPath, contractAddress);

/** `Either<ContractAddress, UserAddress>` with the user (right) branch populated. */
export const rightUserAddress = (bytes: Uint8Array) => ({
  is_left: false,
  left: { bytes: new Uint8Array(32) },
  right: { bytes },
});

export const getBalance = (deployed: DeployedConvertVault, secret: Uint8Array) =>
  deployed.callTx.getBalance(secret);

export const depositUnshielded = (deployed: DeployedConvertVault, secret: Uint8Array, amount: bigint) =>
  deployed.callTx.depositUnshielded(secret, amount);

export const depositShielded = (
  deployed: DeployedConvertVault,
  secret: Uint8Array,
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint },
) => deployed.callTx.depositShielded(secret, coin);

export const withdrawUnshielded = (
  deployed: DeployedConvertVault,
  secret: Uint8Array,
  amount: bigint,
  recipient: ReturnType<typeof rightUserAddress>,
) => deployed.callTx.withdrawUnshielded(secret, amount, recipient);

export const withdrawShielded = (
  deployed: DeployedConvertVault,
  secret: Uint8Array,
  amount: bigint,
  recipient: { bytes: Uint8Array },
  nonce: Uint8Array,
) => deployed.callTx.withdrawShielded(secret, amount, recipient, nonce);

export const tokenColor = (deployed: DeployedConvertVault) => deployed.callTx.tokenColor();
export const name = (deployed: DeployedConvertVault) => deployed.callTx.name();
export const symbol = (deployed: DeployedConvertVault) => deployed.callTx.symbol();
export const decimals = (deployed: DeployedConvertVault) => deployed.callTx.decimals();
