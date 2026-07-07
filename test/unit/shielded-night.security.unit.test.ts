import { beforeEach, describe, expect, it } from 'vitest';
import {
  ShieldedNightSimulator,
  rightUserAddress,
} from './simulators/ShieldedNightSimulator.js';

/**
 * Security / border-case suite. Every case here maps to a way a depositor
 * could lose tokens or an attacker could steal them:
 *
 * - value-range boundaries (overflow, truncation, encode-level ranges)
 * - balance-key isolation (secrets differing by one bit, the zero secret)
 * - loss guards (zero recipients == Midnight burn address)
 * - state integrity after failed calls
 *
 * On-chain-only vectors (forged/unowned coins, double-burns, nonce reuse,
 * the reserve invariant) live in test/integration/shielded-night.security.test.ts —
 * they need a real ledger to reject unbalanced transactions.
 */

const NAME = 'Wrapped NIGHT';
const SYMBOL = 'wNIGHT';
const DECIMALS = 6n;

const MAX64 = (1n << 64n) - 1n;

const b32 = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(label).subarray(0, 32));
  return out;
};

const SECRET = b32('secret');
const RECIPIENT = { bytes: b32('recipient') };
const USER = rightUserAddress(b32('user'));
const ZERO32 = new Uint8Array(32);

describe('ShieldedNight security / border cases (simulator)', () => {
  let contract: ShieldedNightSimulator;

  beforeEach(() => {
    contract = new ShieldedNightSimulator(NAME, SYMBOL, DECIMALS);
  });

  describe('value ranges and overflow', () => {
    it('accepts the maximum single unshielded deposit (2^64 - 1)', () => {
      contract.depositUnshielded(SECRET, MAX64);
      expect(contract.getBalance(SECRET)).toBe(MAX64);
    });

    it('rejects out-of-range circuit arguments at the encoding layer', () => {
      // Uint<64> args: negative and > 2^64-1 never reach the circuit body.
      expect(() => contract.depositUnshielded(SECRET, -1n)).toThrow(/expected value of type/);
      expect(() => contract.depositUnshielded(SECRET, MAX64 + 1n)).toThrow(/expected value of type/);
      expect(() =>
        contract.withdrawShielded(SECRET, MAX64 + 1n, RECIPIENT, b32('n')),
      ).toThrow(/expected value of type/);
    });

    it('caps shielded coin values at 2^64 - 1 (zswap layer), despite the Uint<128> field', () => {
      const color = contract.tokenColor();
      // At the cap: accepted and credited in full.
      contract.depositShielded(SECRET, { nonce: b32('n1'), color, value: MAX64 });
      expect(contract.getBalance(SECRET)).toBe(MAX64);
      // One past the cap: rejected before any state change.
      expect(() =>
        contract.depositShielded(SECRET, { nonce: b32('n2'), color, value: MAX64 + 1n }),
      ).toThrow();
      expect(contract.getBalance(SECRET)).toBe(MAX64);
    });

    it('accumulates a credit balance beyond 2^64 without wrapping', () => {
      // The Uint<128> balance must keep counting where a 64-bit field would
      // wrap to zero (which would silently erase deposits).
      const color = contract.tokenColor();
      contract.depositShielded(SECRET, { nonce: b32('n1'), color, value: MAX64 });
      contract.depositShielded(SECRET, { nonce: b32('n2'), color, value: MAX64 });
      expect(contract.getBalance(SECRET)).toBe(2n * MAX64);
      // Note: overflowing the Uint<128> credit itself would take ~2^64
      // max-value operations — unreachable given the zswap 2^64 coin cap.
    });
  });

  describe('withdrawal boundaries', () => {
    beforeEach(() => {
      contract.depositUnshielded(SECRET, 100n);
    });

    it('allows withdrawing the exact balance, then nothing more', () => {
      contract.withdrawUnshielded(SECRET, 100n, USER);
      expect(contract.getBalance(SECRET)).toBe(0n);
      expect(() => contract.withdrawUnshielded(SECRET, 1n, USER)).toThrow(
        'insufficient pool balance',
      );
    });

    it('rejects overdrawing by exactly one unit', () => {
      expect(() => contract.withdrawUnshielded(SECRET, 101n, USER)).toThrow(
        'insufficient pool balance',
      );
    });

    it('keeps a drained key readable as zero (distinct from never-used)', () => {
      contract.withdrawUnshielded(SECRET, 100n, USER);
      expect(contract.getBalance(SECRET)).toBe(0n); // drained: entry exists at 0
      expect(() => contract.getBalance(b32('never-used'))).toThrow(); // never-used: reverts
    });

    it('leaves the balance untouched after a failed withdrawal', () => {
      expect(() => contract.withdrawUnshielded(SECRET, 101n, USER)).toThrow();
      expect(() =>
        contract.withdrawShielded(SECRET, 101n, RECIPIENT, b32('n')),
      ).toThrow();
      expect(contract.getBalance(SECRET)).toBe(100n);
    });
  });

  describe('balance-key isolation', () => {
    it('treats the all-zero secret as a valid, independent key', () => {
      contract.depositUnshielded(ZERO32, 7n);
      contract.depositUnshielded(SECRET, 9n);
      expect(contract.getBalance(ZERO32)).toBe(7n);
      expect(contract.getBalance(SECRET)).toBe(9n);
    });

    it('separates secrets that differ by a single bit', () => {
      const a = b32('twin');
      const b = a.slice();
      b[31] ^= 0x01;
      contract.depositUnshielded(a, 11n);
      expect(contract.getBalance(a)).toBe(11n);
      expect(() => contract.getBalance(b)).toThrow(); // sibling key never credited
      expect(() => contract.withdrawUnshielded(b, 11n, USER)).toThrow(
        'no balance for this secret',
      );
    });
  });

  describe('loss guards: zero recipients (Midnight burn address)', () => {
    beforeEach(() => {
      contract.depositUnshielded(SECRET, 100n);
    });

    it('refuses to mint the wrapper to the zero coin public key', () => {
      expect(() =>
        contract.withdrawShielded(SECRET, 50n, { bytes: ZERO32 }, b32('n')),
      ).toThrow('invalid recipient');
      expect(contract.getBalance(SECRET)).toBe(100n);
    });

    it('refuses to release NIGHT to the zero user address', () => {
      expect(() =>
        contract.withdrawUnshielded(SECRET, 50n, rightUserAddress(ZERO32)),
      ).toThrow('invalid recipient');
      expect(contract.getBalance(SECRET)).toBe(100n);
    });

    it('refuses to release NIGHT to the zero contract address', () => {
      expect(() =>
        contract.withdrawUnshielded(SECRET, 50n, {
          is_left: true,
          left: { bytes: ZERO32 },
          right: { bytes: ZERO32 },
        }),
      ).toThrow('invalid recipient');
    });

    it('still allows non-zero contract recipients', () => {
      contract.withdrawUnshielded(SECRET, 50n, {
        is_left: true,
        left: { bytes: b32('some-contract') },
        right: { bytes: ZERO32 },
      });
      expect(contract.getBalance(SECRET)).toBe(50n);
    });
  });

  describe('deposit guards', () => {
    it('rejects a shielded coin whose color differs from the wrapper in one byte', () => {
      const color = contract.tokenColor().slice();
      color[31] ^= 0x01;
      expect(() =>
        contract.depositShielded(SECRET, { nonce: b32('n'), color, value: 5n }),
      ).toThrow("not this contract's shielded wrapper");
    });

    it('keeps metadata immutable across state-changing calls', () => {
      contract.depositUnshielded(SECRET, 5n);
      const l = contract.getLedger();
      expect(l._name).toBe(NAME);
      expect(l._symbol).toBe(SYMBOL);
      expect(l._decimals).toBe(DECIMALS);
    });
  });

  describe('combined circuits: value ranges', () => {
    it('convertToShielded mints the maximum single amount (2^64 - 1)', () => {
      const coin = contract.convertToShielded(MAX64, RECIPIENT, b32('n'));
      expect(coin.value).toBe(MAX64);
      expect(coin.color).toEqual(contract.tokenColor());
    });

    it('convertToShielded rejects out-of-range amounts at the encoding layer', () => {
      expect(() => contract.convertToShielded(-1n, RECIPIENT, b32('n'))).toThrow(
        /expected value of type/,
      );
      expect(() => contract.convertToShielded(MAX64 + 1n, RECIPIENT, b32('n'))).toThrow(
        /expected value of type/,
      );
    });

    it('convertToUnshielded releases the maximum coin value and rejects one past the zswap cap', () => {
      const color = contract.tokenColor();
      // At the cap: accepted (the Uint<128> field notwithstanding, zswap coins top out at 2^64-1).
      contract.convertToUnshielded({ nonce: b32('n1'), color, value: MAX64 }, USER);
      // One past the cap: rejected before any state change.
      expect(() =>
        contract.convertToUnshielded({ nonce: b32('n2'), color, value: MAX64 + 1n }, USER),
      ).toThrow();
    });
  });

  describe('combined circuits: loss guards (zero recipients)', () => {
    // The combined suite covers the zero USER address; these pin the other
    // Either branch — releasing NIGHT to the zero CONTRACT address would
    // strand it just as irrecoverably.
    it('convertToUnshielded refuses the zero contract recipient (left branch)', () => {
      const coin = contract.convertToShielded(100n, RECIPIENT, b32('n'));
      expect(() =>
        contract.convertToUnshielded(coin, {
          is_left: true,
          left: { bytes: ZERO32 },
          right: { bytes: ZERO32 },
        }),
      ).toThrow('invalid recipient');
    });

    it('convertToUnshielded still allows non-zero contract recipients', () => {
      const coin = contract.convertToShielded(100n, RECIPIENT, b32('n'));
      contract.convertToUnshielded(coin, {
        is_left: true,
        left: { bytes: b32('some-contract') },
        right: { bytes: ZERO32 },
      });
    });
  });

  describe('combined circuits: interop with the two-step model', () => {
    // Both models mint the SAME wrapper color, so coins are interchangeable
    // across them. Users will mix frontends/flows; a color split between the
    // mint paths would strand one side's coins.
    it('redeems a two-step-minted coin through the atomic path', () => {
      contract.depositUnshielded(SECRET, 100n);
      const twoStep = contract.withdrawShielded(SECRET, 100n, RECIPIENT, b32('n1'));
      const atomic = contract.convertToShielded(100n, RECIPIENT, b32('n2'));
      expect(atomic.color).toEqual(twoStep.color); // one color across both mint paths
      contract.convertToUnshielded(twoStep, USER);
      expect(contract.getBalance(SECRET)).toBe(0n); // drained credit untouched by the convert
    });

    it('burns an atomically-minted coin through the two-step credit path', () => {
      const coin = contract.convertToShielded(100n, RECIPIENT, b32('n'));
      contract.depositShielded(SECRET, coin);
      expect(contract.getBalance(SECRET)).toBe(100n);
      contract.withdrawUnshielded(SECRET, 100n, USER);
      expect(contract.getBalance(SECRET)).toBe(0n);
    });

    it('failed converts leave existing credits untouched', () => {
      contract.depositUnshielded(SECRET, 100n);
      expect(() =>
        contract.convertToUnshielded({ nonce: b32('n'), color: b32('foreign'), value: 5n }, USER),
      ).toThrow("not this contract's shielded wrapper");
      expect(() => contract.convertToShielded(0n, RECIPIENT, b32('n'))).toThrow(
        'amount must be positive',
      );
      expect(contract.getBalance(SECRET)).toBe(100n);
      expect(contract.getLedger().balances.size()).toBe(1n);
    });
  });
});
