import { type ContractAddress } from '@midnight-ntwrk/compact-runtime';
import { ShieldedNightContract, type ShieldedNightPrivateState } from '../../src/index.ts';
import {
  type ContractCircuits,
  type ContractDeployed,
  type ContractProviders,
  defineContract,
} from './contract-factory.js';

const SHIELDED_NIGHT_PRIVATE_STATE_ID = 'shieldedNightPrivateState' as const;

/**
 * ShieldedNight factory. The contract has no witnesses (the secret is a circuit
 * argument), so `witnesses` is omitted and the factory takes the
 * vacant-witnesses path.
 */
export const factory = defineContract({
  name: 'shielded-night',
  contractCtor: ShieldedNightContract.Contract,
  ledger: ShieldedNightContract.ledger,
  privateStateId: SHIELDED_NIGHT_PRIVATE_STATE_ID,
  initialPrivateState: {} as ShieldedNightPrivateState,
});

export type ShieldedNightCircuits = ContractCircuits<typeof factory>;
export type ShieldedNightProviders = ContractProviders<typeof factory>;
export type DeployedShieldedNight = ContractDeployed<typeof factory>;

/** Constructor args used by every test deploy: 6 decimals to match native NIGHT. */
export const DEPLOY_ARGS = ['Wrapped NIGHT', 'wNIGHT', 6n] as const;

export const deploy = (providers: ShieldedNightProviders, zkConfigPath: string): Promise<DeployedShieldedNight> =>
  factory.deploy(providers, zkConfigPath, [...DEPLOY_ARGS]);

export const connect = (
  providers: ShieldedNightProviders,
  zkConfigPath: string,
  contractAddress: ContractAddress,
): Promise<DeployedShieldedNight> => factory.connect(providers, zkConfigPath, contractAddress);

/** `Either<ContractAddress, UserAddress>` with the user (right) branch populated. */
export const rightUserAddress = (bytes: Uint8Array) => ({
  is_left: false,
  left: { bytes: new Uint8Array(32) },
  right: { bytes },
});

export const getBalance = (deployed: DeployedShieldedNight, secret: Uint8Array) =>
  deployed.callTx.getBalance(secret);

export const depositUnshielded = (deployed: DeployedShieldedNight, secret: Uint8Array, amount: bigint) =>
  deployed.callTx.depositUnshielded(secret, amount);

export const depositShielded = (
  deployed: DeployedShieldedNight,
  secret: Uint8Array,
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint },
) => deployed.callTx.depositShielded(secret, coin);

/** `Either<ZswapCoinPublicKey, ContractAddress>` with the user key (left) populated. */
export const leftCoinPublicKey = (bytes: Uint8Array) => ({
  is_left: true,
  left: { bytes },
  right: { bytes: new Uint8Array(32) },
});

/** The sendImmediateShielded variant: burn `amount` of `coin`, refund the rest. */
export const depositShieldedWithChange = (
  deployed: DeployedShieldedNight,
  secret: Uint8Array,
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint },
  amount: bigint,
  refundTo: ReturnType<typeof leftCoinPublicKey>,
) => deployed.callTx.depositShielded_notWorking(secret, coin, amount, refundTo);

export const withdrawUnshielded = (
  deployed: DeployedShieldedNight,
  secret: Uint8Array,
  amount: bigint,
  recipient: ReturnType<typeof rightUserAddress>,
) => deployed.callTx.withdrawUnshielded(secret, amount, recipient);

export const withdrawShielded = (
  deployed: DeployedShieldedNight,
  secret: Uint8Array,
  amount: bigint,
  recipient: { bytes: Uint8Array },
  nonce: Uint8Array,
) => deployed.callTx.withdrawShielded(secret, amount, recipient, nonce);

/** Atomic NIGHT -> wNIGHT in one tx (no secret). */
export const convertToShielded = (
  deployed: DeployedShieldedNight,
  amount: bigint,
  recipient: { bytes: Uint8Array },
  nonce: Uint8Array,
) => deployed.callTx.convertToShielded(amount, recipient, nonce);

/** Atomic wNIGHT -> NIGHT in one tx (no secret). */
export const convertToUnshielded = (
  deployed: DeployedShieldedNight,
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint },
  recipient: ReturnType<typeof rightUserAddress>,
) => deployed.callTx.convertToUnshielded(coin, recipient);

export const tokenColor = (deployed: DeployedShieldedNight) => deployed.callTx.tokenColor();
export const name = (deployed: DeployedShieldedNight) => deployed.callTx.name();
export const symbol = (deployed: DeployedShieldedNight) => deployed.callTx.symbol();
export const decimals = (deployed: DeployedShieldedNight) => deployed.callTx.decimals();
