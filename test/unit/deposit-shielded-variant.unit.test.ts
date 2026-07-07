import { beforeEach, describe, expect, it } from 'vitest';
import {
  ShieldedNightSimulator,
  type ShieldedCoin,
} from './simulators/ShieldedNightSimulator.js';

/**
 * Circuit-logic verification of `depositShielded_notWorking` — the
 * `sendImmediateShielded` variant that burns `amount` out of `coin` as a
 * same-transaction transient and refunds the remainder.
 *
 * The known field issue is browser wallets mis-listing the transient
 * (spent UTXOs still shown). This suite establishes whether the CONTRACT
 * side is correct: credits, burn accounting, change value/color, and the
 * guard asserts. The wallet-view question is measured on a real stack in
 * test/integration/shielded-night.transient.test.ts.
 */

const N = 1_000_000n;

const b32 = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(label).subarray(0, 32));
  return out;
};

const SECRET = b32('secret');
const REFUND_TO = {
  is_left: true,
  left: { bytes: b32('refund-coin-pk') },
  right: { bytes: new Uint8Array(32) },
};

describe('depositShielded_notWorking (sendImmediateShielded variant, simulator)', () => {
  let contract: ShieldedNightSimulator;
  let coin: ShieldedCoin;

  beforeEach(() => {
    contract = new ShieldedNightSimulator('Wrapped NIGHT', 'wNIGHT', 6n);
    // Mint a real wrapper coin to burn from.
    contract.depositUnshielded(SECRET, N);
    coin = contract.withdrawShielded(SECRET, N, { bytes: b32('me') }, b32('mint-nonce'));
    expect(contract.getBalance(SECRET)).toBe(0n);
  });

  it('full burn: credits the whole coin value and returns no change', () => {
    const res = contract.depositShieldedWithChange(SECRET, coin, N, REFUND_TO);
    expect(res.is_some).toBe(false);
    expect(contract.getBalance(SECRET)).toBe(N);
  });

  it('partial burn: credits only the burned amount and returns the exact change', () => {
    const burn = N / 4n;
    const res = contract.depositShieldedWithChange(SECRET, coin, burn, REFUND_TO);
    expect(res.is_some).toBe(true);
    expect(res.value.value).toBe(N - burn);
    expect(res.value.color).toEqual(contract.tokenColor());
    expect(contract.getBalance(SECRET)).toBe(burn);
    // credit + change == original coin: nothing minted, nothing lost.
    expect(contract.getBalance(SECRET) + res.value.value).toBe(coin.value);
  });

  it('rejects amount exceeding the coin value', () => {
    expect(() =>
      contract.depositShieldedWithChange(SECRET, coin, N + 1n, REFUND_TO),
    ).toThrow('amount exceeds coin value');
  });

  it('rejects a zero amount', () => {
    expect(() =>
      contract.depositShieldedWithChange(SECRET, coin, 0n, REFUND_TO),
    ).toThrow('amount must be positive');
  });

  it('rejects a zero-value coin', () => {
    expect(() =>
      contract.depositShieldedWithChange(SECRET, { ...coin, value: 0n }, 1n, REFUND_TO),
    ).toThrow('coin value must be positive');
  });

  it('rejects a coin that is not the contract wrapper', () => {
    const foreign = { ...coin, color: coin.color.slice() };
    foreign.color[0] ^= 0xff;
    expect(() =>
      contract.depositShieldedWithChange(SECRET, foreign, N, REFUND_TO),
    ).toThrow("not this contract's shielded wrapper");
  });

  it('leaves the balance untouched after a rejected burn', () => {
    expect(() =>
      contract.depositShieldedWithChange(SECRET, coin, N + 1n, REFUND_TO),
    ).toThrow();
    expect(contract.getBalance(SECRET)).toBe(0n);
  });
});
