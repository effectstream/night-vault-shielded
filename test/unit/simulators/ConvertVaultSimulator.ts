import {
  type CircuitContext,
  type CircuitResults,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract,
  type Ledger,
  ledger,
} from '../../../src/managed/contract/index.js';

/** ConvertVault has no witnesses; its private state is empty. */
export type ConvertVaultPrivateState = Record<string, never>;

/** Zswap coin public key of the simulated caller (value is irrelevant to the vault). */
const COIN_PK = '0'.repeat(64);

export interface ShieldedCoin {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
}

export type EitherContractOrUser = {
  is_left: boolean;
  left: { bytes: Uint8Array };
  right: { bytes: Uint8Array };
};

/** Builds the `Either<ContractAddress, UserAddress>` param for withdrawUnshielded. */
export const rightUserAddress = (bytes: Uint8Array): EitherContractOrUser => ({
  is_left: false,
  left: { bytes: new Uint8Array(32) },
  right: { bytes },
});

/**
 * In-memory simulator for the ConvertVault contract, following the
 * OpenZeppelin compact-contracts simulator pattern: the compiled contract's
 * impure circuits run against a locally held CircuitContext, and each
 * successful call threads the updated context back so ledger state advances
 * across calls. Failed calls throw before the context is replaced, so state
 * is untouched — matching on-chain semantics.
 */
export class ConvertVaultSimulator {
  readonly contract: Contract<ConvertVaultPrivateState>;
  readonly contractAddress: string;
  private ctx: CircuitContext<ConvertVaultPrivateState>;

  constructor(name: string, symbol: string, decimals: bigint) {
    this.contract = new Contract<ConvertVaultPrivateState>({});
    const init = this.contract.initialState(
      createConstructorContext<ConvertVaultPrivateState>({}, COIN_PK),
      name,
      symbol,
      decimals,
    );
    this.contractAddress = sampleContractAddress();
    this.ctx = createCircuitContext(
      this.contractAddress,
      COIN_PK,
      init.currentContractState,
      {},
    );
  }

  /** Read the public ledger state (balances map + sealed metadata). */
  getLedger(): Ledger {
    return ledger(this.ctx.currentQueryContext.state);
  }

  private advance<R>(res: CircuitResults<ConvertVaultPrivateState, R>): R {
    this.ctx = res.context;
    return res.result;
  }

  name(): string {
    return this.advance(this.contract.impureCircuits.name(this.ctx));
  }

  symbol(): string {
    return this.advance(this.contract.impureCircuits.symbol(this.ctx));
  }

  decimals(): bigint {
    return this.advance(this.contract.impureCircuits.decimals(this.ctx));
  }

  tokenColor(): Uint8Array {
    return this.advance(this.contract.impureCircuits.tokenColor(this.ctx));
  }

  getBalance(secret: Uint8Array): bigint {
    return this.advance(this.contract.impureCircuits.getBalance(this.ctx, secret));
  }

  depositUnshielded(secret: Uint8Array, amount: bigint): void {
    this.advance(
      this.contract.impureCircuits.depositUnshielded(this.ctx, secret, amount),
    );
  }

  depositShielded(secret: Uint8Array, coin: ShieldedCoin): void {
    this.advance(
      this.contract.impureCircuits.depositShielded(this.ctx, secret, coin),
    );
  }

  withdrawUnshielded(
    secret: Uint8Array,
    amount: bigint,
    recipient: EitherContractOrUser,
  ): void {
    this.advance(
      this.contract.impureCircuits.withdrawUnshielded(
        this.ctx,
        secret,
        amount,
        recipient,
      ),
    );
  }

  withdrawShielded(
    secret: Uint8Array,
    amount: bigint,
    recipient: { bytes: Uint8Array },
    nonce: Uint8Array,
  ): ShieldedCoin {
    return this.advance(
      this.contract.impureCircuits.withdrawShielded(
        this.ctx,
        secret,
        amount,
        recipient,
        nonce,
      ),
    );
  }
}
