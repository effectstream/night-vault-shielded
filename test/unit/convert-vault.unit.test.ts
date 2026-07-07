import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConvertVaultSimulator,
  rightUserAddress,
  type ShieldedCoin,
} from './simulators/ConvertVaultSimulator.js';

const NAME = 'Wrapped NIGHT';
const SYMBOL = 'wNIGHT';
const DECIMALS = 6n;
const N = 10_000_000n; // 10 NIGHT at 6 decimals

/** 32-byte value from an ASCII label (zero-padded). */
const b32 = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(label).subarray(0, 32));
  return out;
};

const SECRET_A = b32('secret-a');
const SECRET_B = b32('secret-b');
const RECIPIENT = { bytes: b32('recipient-coin-pk') };
const USER = rightUserAddress(b32('user-address'));

describe('ConvertVault (simulator)', () => {
  let vault: ConvertVaultSimulator;

  beforeEach(() => {
    vault = new ConvertVaultSimulator(NAME, SYMBOL, DECIMALS);
  });

  describe('metadata', () => {
    it('echoes constructor args through the metadata circuits', () => {
      expect(vault.name()).toBe(NAME);
      expect(vault.symbol()).toBe(SYMBOL);
      expect(vault.decimals()).toBe(DECIMALS);
    });

    it('exposes the sealed metadata directly on the ledger', () => {
      const l = vault.getLedger();
      expect(l._name).toBe(NAME);
      expect(l._symbol).toBe(SYMBOL);
      expect(l._decimals).toBe(DECIMALS);
    });

    it('starts with an empty balances map', () => {
      expect(vault.getLedger().balances.isEmpty()).toBe(true);
    });

    it('returns a stable 32-byte wrapper color', () => {
      const c1 = vault.tokenColor();
      const c2 = vault.tokenColor();
      expect(c1).toHaveLength(32);
      expect(c1).toEqual(c2);
      expect(c1.some((b) => b !== 0)).toBe(true);
    });
  });

  describe('depositUnshielded', () => {
    it('credits the balance under hash(secret)', () => {
      vault.depositUnshielded(SECRET_A, N);
      expect(vault.getBalance(SECRET_A)).toBe(N);
    });

    it('accumulates across deposits', () => {
      vault.depositUnshielded(SECRET_A, N);
      vault.depositUnshielded(SECRET_A, 5n);
      expect(vault.getBalance(SECRET_A)).toBe(N + 5n);
    });

    it('keeps balances of distinct secrets independent', () => {
      vault.depositUnshielded(SECRET_A, N);
      vault.depositUnshielded(SECRET_B, 7n);
      expect(vault.getBalance(SECRET_A)).toBe(N);
      expect(vault.getBalance(SECRET_B)).toBe(7n);
      expect(vault.getLedger().balances.size()).toBe(2n);
    });

    it('rejects a zero amount', () => {
      expect(() => vault.depositUnshielded(SECRET_A, 0n)).toThrow(
        'amount must be positive',
      );
    });
  });

  describe('withdrawShielded', () => {
    beforeEach(() => {
      vault.depositUnshielded(SECRET_A, N);
    });

    it('debits the balance and mints a wrapper coin with the given nonce', () => {
      const nonce = b32('mint-nonce');
      const coin = vault.withdrawShielded(SECRET_A, N, RECIPIENT, nonce);
      expect(coin.value).toBe(N);
      expect(coin.nonce).toEqual(nonce);
      expect(coin.color).toEqual(vault.tokenColor());
      expect(vault.getBalance(SECRET_A)).toBe(0n);
    });

    it('supports partial withdrawal', () => {
      vault.withdrawShielded(SECRET_A, N / 2n, RECIPIENT, b32('n1'));
      expect(vault.getBalance(SECRET_A)).toBe(N - N / 2n);
    });

    it('rejects a zero amount', () => {
      expect(() =>
        vault.withdrawShielded(SECRET_A, 0n, RECIPIENT, b32('n')),
      ).toThrow('amount must be positive');
    });

    it('rejects an unknown secret', () => {
      expect(() =>
        vault.withdrawShielded(SECRET_B, 1n, RECIPIENT, b32('n')),
      ).toThrow('no balance for this secret');
    });

    it('rejects withdrawing more than the balance', () => {
      expect(() =>
        vault.withdrawShielded(SECRET_A, N + 1n, RECIPIENT, b32('n')),
      ).toThrow('insufficient pool balance');
    });
  });

  describe('depositShielded', () => {
    let coin: ShieldedCoin;

    beforeEach(() => {
      vault.depositUnshielded(SECRET_A, N);
      coin = vault.withdrawShielded(SECRET_A, N, RECIPIENT, b32('n'));
    });

    it('credits the balance by the full coin value', () => {
      vault.depositShielded(SECRET_A, coin);
      expect(vault.getBalance(SECRET_A)).toBe(N);
    });

    it('credits a different secret than the one that minted', () => {
      vault.depositShielded(SECRET_B, coin);
      expect(vault.getBalance(SECRET_B)).toBe(N);
    });

    it('rejects a coin that is not the vault wrapper', () => {
      const foreign = { ...coin, color: coin.color.slice() };
      foreign.color[0] ^= 0xff;
      expect(() => vault.depositShielded(SECRET_A, foreign)).toThrow(
        "not this vault's shielded wrapper",
      );
    });

    it('rejects a zero-value coin', () => {
      expect(() =>
        vault.depositShielded(SECRET_A, { ...coin, value: 0n }),
      ).toThrow('coin value must be positive');
    });
  });

  describe('withdrawUnshielded', () => {
    beforeEach(() => {
      vault.depositUnshielded(SECRET_A, N);
    });

    it('debits the balance', () => {
      vault.withdrawUnshielded(SECRET_A, N / 2n, USER);
      expect(vault.getBalance(SECRET_A)).toBe(N - N / 2n);
    });

    it('rejects a zero amount', () => {
      expect(() => vault.withdrawUnshielded(SECRET_A, 0n, USER)).toThrow(
        'amount must be positive',
      );
    });

    it('rejects an unknown secret', () => {
      expect(() => vault.withdrawUnshielded(SECRET_B, 1n, USER)).toThrow(
        'no balance for this secret',
      );
    });

    it('rejects withdrawing more than the balance', () => {
      expect(() => vault.withdrawUnshielded(SECRET_A, N + 1n, USER)).toThrow(
        'insufficient pool balance',
      );
    });
  });

  describe('round trip', () => {
    it('unshielded -> shielded -> unshielded leaves a zero balance', () => {
      vault.depositUnshielded(SECRET_A, N);
      const coin = vault.withdrawShielded(SECRET_A, N, RECIPIENT, b32('rt'));
      expect(vault.getBalance(SECRET_A)).toBe(0n);

      vault.depositShielded(SECRET_A, coin);
      expect(vault.getBalance(SECRET_A)).toBe(N);

      vault.withdrawUnshielded(SECRET_A, N, USER);
      expect(vault.getBalance(SECRET_A)).toBe(0n);
      expect(vault.getLedger().balances.lookup(vaultKeyOf(SECRET_A))).toBe(0n);
    });
  });

  describe('getBalance', () => {
    it('throws for a never-used secret (lookup without member guard)', () => {
      // Pins current behavior: reads for unknown keys revert instead of
      // returning 0. Off-chain callers must probe `balances.member` first.
      expect(() => vault.getBalance(b32('never-used'))).toThrow();
    });
  });

  /** Recover the public balance key for `secret` from the ledger map. */
  function vaultKeyOf(secret: Uint8Array): Uint8Array {
    // The key is persistentHash([pad(32,"night-vault:balance"), secret]); rather than
    // re-deriving the hash here, find the single entry the tests created.
    for (const [key] of vault.getLedger().balances) {
      void secret;
      return key;
    }
    throw new Error('no balances entry found');
  }
});
