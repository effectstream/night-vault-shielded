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

/** ShieldedNight has no witnesses; its private state is empty. */
export type ShieldedNightPrivateState = Record<string, never>;

/** Zswap coin public key of the simulated caller (value is irrelevant to the contract). */
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
 * In-memory simulator for the ShieldedNight contract, following the
 * OpenZeppelin compact-contracts simulator pattern: the compiled contract's
 * impure circuits run against a locally held CircuitContext, and each
 * successful call threads the updated context back so ledger state advances
 * across calls. Failed calls throw before the context is replaced, so state
 * is untouched — matching on-chain semantics.
 */
export class ShieldedNightSimulator {
  readonly contract: Contract<ShieldedNightPrivateState>;
  readonly contractAddress: string;
  private ctx: CircuitContext<ShieldedNightPrivateState>;

  constructor(name: string, symbol: string, decimals: bigint) {
    this.contract = new Contract<ShieldedNightPrivateState>({});
    const init = this.contract.initialState(
      createConstructorContext<ShieldedNightPrivateState>({}, COIN_PK),
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

  private advance<R>(res: CircuitResults<ShieldedNightPrivateState, R>): R {
    // Each simulator call models its own transaction: keep the updated ledger
    // state but discard the accumulated Zswap local state (coin receives/sends
    // recorded by the previous call). Without this, successive deposits share
    // one transaction-level receive accumulator and large amounts trip its
    // Uint<64> overflow instead of exercising the contract's own logic.
    this.ctx = createCircuitContext(
      this.contractAddress,
      COIN_PK,
      res.context.currentQueryContext.state,
      res.context.currentPrivateState,
    );
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

  /**
   * The `sendImmediateShielded` variant: burns `amount` out of `coin` inside
   * the transaction (a transient) and refunds the remainder to `refundTo`.
   * Returns the change coin, or none on a full burn.
   */
  depositShieldedWithChange(
    secret: Uint8Array,
    coin: ShieldedCoin,
    amount: bigint,
    refundTo: { is_left: boolean; left: { bytes: Uint8Array }; right: { bytes: Uint8Array } },
  ): { is_some: boolean; value: ShieldedCoin } {
    return this.advance(
      this.contract.impureCircuits.depositShielded_notWorking(
        this.ctx,
        secret,
        coin,
        amount,
        refundTo,
      ),
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

  /** Atomic NIGHT -> wNIGHT (no secret): lock NIGHT and mint the wrapper. */
  convertToShielded(amount: bigint, recipient: { bytes: Uint8Array }, nonce: Uint8Array): ShieldedCoin {
    return this.advance(
      this.contract.impureCircuits.convertToShielded(this.ctx, amount, recipient, nonce),
    );
  }

  /** Atomic wNIGHT -> NIGHT (no secret): burn the wrapper coin and release NIGHT. */
  convertToUnshielded(coin: ShieldedCoin, recipient: EitherContractOrUser): void {
    this.advance(this.contract.impureCircuits.convertToUnshielded(this.ctx, coin, recipient));
  }
}
