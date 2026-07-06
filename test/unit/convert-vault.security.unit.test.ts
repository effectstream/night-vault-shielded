import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConvertVaultSimulator,
  rightUserAddress,
} from './simulators/ConvertVaultSimulator.js';

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
 * the reserve invariant) live in test/integration/convert-vault.security.test.ts —
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

describe('ConvertVault security / border cases (simulator)', () => {
  let vault: ConvertVaultSimulator;

  beforeEach(() => {
    vault = new ConvertVaultSimulator(NAME, SYMBOL, DECIMALS);
  });

  describe('value ranges and overflow', () => {
    it('accepts the maximum single unshielded deposit (2^64 - 1)', () => {
      vault.depositUnshielded(SECRET, MAX64);
      expect(vault.getBalance(SECRET)).toBe(MAX64);
    });

    it('rejects out-of-range circuit arguments at the encoding layer', () => {
      // Uint<64> args: negative and > 2^64-1 never reach the circuit body.
      expect(() => vault.depositUnshielded(SECRET, -1n)).toThrow(/expected value of type/);
      expect(() => vault.depositUnshielded(SECRET, MAX64 + 1n)).toThrow(/expected value of type/);
      expect(() =>
        vault.withdrawShielded(SECRET, MAX64 + 1n, RECIPIENT, b32('n')),
      ).toThrow(/expected value of type/);
    });

    it('caps shielded coin values at 2^64 - 1 (zswap layer), despite the Uint<128> field', () => {
      const color = vault.tokenColor();
      // At the cap: accepted and credited in full.
      vault.depositShielded(SECRET, { nonce: b32('n1'), color, value: MAX64 });
      expect(vault.getBalance(SECRET)).toBe(MAX64);
      // One past the cap: rejected before any state change.
      expect(() =>
        vault.depositShielded(SECRET, { nonce: b32('n2'), color, value: MAX64 + 1n }),
      ).toThrow();
      expect(vault.getBalance(SECRET)).toBe(MAX64);
    });

    it('accumulates a credit balance beyond 2^64 without wrapping', () => {
      // The Uint<128> balance must keep counting where a 64-bit field would
      // wrap to zero (which would silently erase deposits).
      const color = vault.tokenColor();
      vault.depositShielded(SECRET, { nonce: b32('n1'), color, value: MAX64 });
      vault.depositShielded(SECRET, { nonce: b32('n2'), color, value: MAX64 });
      expect(vault.getBalance(SECRET)).toBe(2n * MAX64);
      // Note: overflowing the Uint<128> credit itself would take ~2^64
      // max-value operations — unreachable given the zswap 2^64 coin cap.
    });
  });

  describe('withdrawal boundaries', () => {
    beforeEach(() => {
      vault.depositUnshielded(SECRET, 100n);
    });

    it('allows withdrawing the exact balance, then nothing more', () => {
      vault.withdrawUnshielded(SECRET, 100n, USER);
      expect(vault.getBalance(SECRET)).toBe(0n);
      expect(() => vault.withdrawUnshielded(SECRET, 1n, USER)).toThrow(
        'insufficient pool balance',
      );
    });

    it('rejects overdrawing by exactly one unit', () => {
      expect(() => vault.withdrawUnshielded(SECRET, 101n, USER)).toThrow(
        'insufficient pool balance',
      );
    });

    it('keeps a drained key readable as zero (distinct from never-used)', () => {
      vault.withdrawUnshielded(SECRET, 100n, USER);
      expect(vault.getBalance(SECRET)).toBe(0n); // drained: entry exists at 0
      expect(() => vault.getBalance(b32('never-used'))).toThrow(); // never-used: reverts
    });

    it('leaves the balance untouched after a failed withdrawal', () => {
      expect(() => vault.withdrawUnshielded(SECRET, 101n, USER)).toThrow();
      expect(() =>
        vault.withdrawShielded(SECRET, 101n, RECIPIENT, b32('n')),
      ).toThrow();
      expect(vault.getBalance(SECRET)).toBe(100n);
    });
  });

  describe('balance-key isolation', () => {
    it('treats the all-zero secret as a valid, independent key', () => {
      vault.depositUnshielded(ZERO32, 7n);
      vault.depositUnshielded(SECRET, 9n);
      expect(vault.getBalance(ZERO32)).toBe(7n);
      expect(vault.getBalance(SECRET)).toBe(9n);
    });

    it('separates secrets that differ by a single bit', () => {
      const a = b32('twin');
      const b = a.slice();
      b[31] ^= 0x01;
      vault.depositUnshielded(a, 11n);
      expect(vault.getBalance(a)).toBe(11n);
      expect(() => vault.getBalance(b)).toThrow(); // sibling key never credited
      expect(() => vault.withdrawUnshielded(b, 11n, USER)).toThrow(
        'no balance for this secret',
      );
    });
  });

  describe('loss guards: zero recipients (Midnight burn address)', () => {
    beforeEach(() => {
      vault.depositUnshielded(SECRET, 100n);
    });

    it('refuses to mint the wrapper to the zero coin public key', () => {
      expect(() =>
        vault.withdrawShielded(SECRET, 50n, { bytes: ZERO32 }, b32('n')),
      ).toThrow('invalid recipient');
      expect(vault.getBalance(SECRET)).toBe(100n);
    });

    it('refuses to release NIGHT to the zero user address', () => {
      expect(() =>
        vault.withdrawUnshielded(SECRET, 50n, rightUserAddress(ZERO32)),
      ).toThrow('invalid recipient');
      expect(vault.getBalance(SECRET)).toBe(100n);
    });

    it('refuses to release NIGHT to the zero contract address', () => {
      expect(() =>
        vault.withdrawUnshielded(SECRET, 50n, {
          is_left: true,
          left: { bytes: ZERO32 },
          right: { bytes: ZERO32 },
        }),
      ).toThrow('invalid recipient');
    });

    it('still allows non-zero contract recipients', () => {
      vault.withdrawUnshielded(SECRET, 50n, {
        is_left: true,
        left: { bytes: b32('some-contract') },
        right: { bytes: ZERO32 },
      });
      expect(vault.getBalance(SECRET)).toBe(50n);
    });
  });

  describe('deposit guards', () => {
    it('rejects a shielded coin whose color differs from the wrapper in one byte', () => {
      const color = vault.tokenColor().slice();
      color[31] ^= 0x01;
      expect(() =>
        vault.depositShielded(SECRET, { nonce: b32('n'), color, value: 5n }),
      ).toThrow("not this vault's shielded wrapper");
    });

    it('keeps metadata immutable across state-changing calls', () => {
      vault.depositUnshielded(SECRET, 5n);
      const l = vault.getLedger();
      expect(l._name).toBe(NAME);
      expect(l._symbol).toBe(SYMBOL);
      expect(l._decimals).toBe(DECIMALS);
    });
  });
});
