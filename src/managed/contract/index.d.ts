import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  symbol(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  decimals(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  tokenColor(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, Uint8Array>;
  depositUnshielded(context: __compactRuntime.CircuitContext<PS>,
                    secret_0: Uint8Array,
                    amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  depositShielded_notWorking(context: __compactRuntime.CircuitContext<PS>,
                             secret_0: Uint8Array,
                             coin_0: { nonce: Uint8Array,
                                       color: Uint8Array,
                                       value: bigint
                                     },
                             amount_0: bigint,
                             refundTo_0: { is_left: boolean,
                                           left: { bytes: Uint8Array },
                                           right: { bytes: Uint8Array }
                                         }): __compactRuntime.CircuitResults<PS, { is_some: boolean,
                                                                                   value: { nonce: Uint8Array,
                                                                                            color: Uint8Array,
                                                                                            value: bigint
                                                                                          }
                                                                                 }>;
  depositShielded(context: __compactRuntime.CircuitContext<PS>,
                  secret_0: Uint8Array,
                  coin_0: { nonce: Uint8Array, color: Uint8Array, value: bigint
                          }): __compactRuntime.CircuitResults<PS, { is_some: boolean,
                                                                    value: { nonce: Uint8Array,
                                                                             color: Uint8Array,
                                                                             value: bigint
                                                                           }
                                                                  }>;
  withdrawUnshielded(context: __compactRuntime.CircuitContext<PS>,
                     secret_0: Uint8Array,
                     amount_0: bigint,
                     recipient_0: { is_left: boolean,
                                    left: { bytes: Uint8Array },
                                    right: { bytes: Uint8Array }
                                  }): __compactRuntime.CircuitResults<PS, []>;
  withdrawShielded(context: __compactRuntime.CircuitContext<PS>,
                   secret_0: Uint8Array,
                   amount_0: bigint,
                   recipient_0: { bytes: Uint8Array },
                   nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                               color: Uint8Array,
                                                                               value: bigint
                                                                             }>;
  getBalance(context: __compactRuntime.CircuitContext<PS>, secret_0: Uint8Array): __compactRuntime.CircuitResults<PS, bigint>;
}

export type ProvableCircuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  symbol(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  decimals(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  tokenColor(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, Uint8Array>;
  depositUnshielded(context: __compactRuntime.CircuitContext<PS>,
                    secret_0: Uint8Array,
                    amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  depositShielded_notWorking(context: __compactRuntime.CircuitContext<PS>,
                             secret_0: Uint8Array,
                             coin_0: { nonce: Uint8Array,
                                       color: Uint8Array,
                                       value: bigint
                                     },
                             amount_0: bigint,
                             refundTo_0: { is_left: boolean,
                                           left: { bytes: Uint8Array },
                                           right: { bytes: Uint8Array }
                                         }): __compactRuntime.CircuitResults<PS, { is_some: boolean,
                                                                                   value: { nonce: Uint8Array,
                                                                                            color: Uint8Array,
                                                                                            value: bigint
                                                                                          }
                                                                                 }>;
  depositShielded(context: __compactRuntime.CircuitContext<PS>,
                  secret_0: Uint8Array,
                  coin_0: { nonce: Uint8Array, color: Uint8Array, value: bigint
                          }): __compactRuntime.CircuitResults<PS, { is_some: boolean,
                                                                    value: { nonce: Uint8Array,
                                                                             color: Uint8Array,
                                                                             value: bigint
                                                                           }
                                                                  }>;
  withdrawUnshielded(context: __compactRuntime.CircuitContext<PS>,
                     secret_0: Uint8Array,
                     amount_0: bigint,
                     recipient_0: { is_left: boolean,
                                    left: { bytes: Uint8Array },
                                    right: { bytes: Uint8Array }
                                  }): __compactRuntime.CircuitResults<PS, []>;
  withdrawShielded(context: __compactRuntime.CircuitContext<PS>,
                   secret_0: Uint8Array,
                   amount_0: bigint,
                   recipient_0: { bytes: Uint8Array },
                   nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                               color: Uint8Array,
                                                                               value: bigint
                                                                             }>;
  getBalance(context: __compactRuntime.CircuitContext<PS>, secret_0: Uint8Array): __compactRuntime.CircuitResults<PS, bigint>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  symbol(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  decimals(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  tokenColor(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, Uint8Array>;
  depositUnshielded(context: __compactRuntime.CircuitContext<PS>,
                    secret_0: Uint8Array,
                    amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  depositShielded_notWorking(context: __compactRuntime.CircuitContext<PS>,
                             secret_0: Uint8Array,
                             coin_0: { nonce: Uint8Array,
                                       color: Uint8Array,
                                       value: bigint
                                     },
                             amount_0: bigint,
                             refundTo_0: { is_left: boolean,
                                           left: { bytes: Uint8Array },
                                           right: { bytes: Uint8Array }
                                         }): __compactRuntime.CircuitResults<PS, { is_some: boolean,
                                                                                   value: { nonce: Uint8Array,
                                                                                            color: Uint8Array,
                                                                                            value: bigint
                                                                                          }
                                                                                 }>;
  depositShielded(context: __compactRuntime.CircuitContext<PS>,
                  secret_0: Uint8Array,
                  coin_0: { nonce: Uint8Array, color: Uint8Array, value: bigint
                          }): __compactRuntime.CircuitResults<PS, { is_some: boolean,
                                                                    value: { nonce: Uint8Array,
                                                                             color: Uint8Array,
                                                                             value: bigint
                                                                           }
                                                                  }>;
  withdrawUnshielded(context: __compactRuntime.CircuitContext<PS>,
                     secret_0: Uint8Array,
                     amount_0: bigint,
                     recipient_0: { is_left: boolean,
                                    left: { bytes: Uint8Array },
                                    right: { bytes: Uint8Array }
                                  }): __compactRuntime.CircuitResults<PS, []>;
  withdrawShielded(context: __compactRuntime.CircuitContext<PS>,
                   secret_0: Uint8Array,
                   amount_0: bigint,
                   recipient_0: { bytes: Uint8Array },
                   nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                               color: Uint8Array,
                                                                               value: bigint
                                                                             }>;
  getBalance(context: __compactRuntime.CircuitContext<PS>, secret_0: Uint8Array): __compactRuntime.CircuitResults<PS, bigint>;
}

export type Ledger = {
  balances: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  readonly _name: string;
  readonly _symbol: string;
  readonly _decimals: bigint;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               name__0: string,
               symbol__0: string,
               decimals__0: bigint): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
