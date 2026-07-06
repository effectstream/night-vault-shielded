import * as ledgerV8 from '@midnight-ntwrk/ledger-v8';
import { describe, expect, test } from 'vitest';
import * as vault from '../support/convert-vault.js';
import { describeContract, describeContractWithWallets } from '../support/describe-contract.js';
import { tryCall } from '../support/smoke-helpers.js';
import { smokeTest } from '../support/tags.js';
import {
  getCoinPublicKey,
  getNightBalance,
  getUserAddress,
  randomBytes32,
  tokenColorHex,
  waitForShieldedBalance,
  waitForUnshieldedBalance,
} from '../support/wallet-observations.js';

const N = 10_000_000n; // 10 NIGHT at 6 decimals

/** Hex key of native NIGHT in the wallet's unshielded balance map. */
const NIGHT_HEX = ledgerV8.unshieldedToken().raw;

/** Flatten an error chain (Effect wrappers, causes) into searchable text. */
const errText = (err: unknown): string => {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 10; depth++) {
    if (cur instanceof Error) {
      parts.push(cur.message, String(cur));
      cur = cur.cause;
    } else {
      parts.push(typeof cur === 'string' ? cur : JSON.stringify(cur));
      break;
    }
  }
  return parts.join('\n');
};

const expectFailure = async (fn: () => Promise<unknown>, messagePart: string): Promise<void> => {
  const outcome = await tryCall(fn);
  expect(outcome.ok, `expected the call to fail with "${messagePart}"`).toBe(false);
  if (!outcome.ok) {
    expect(errText(outcome.error)).toContain(messagePart);
  }
};

describe('convert-vault', () => {
  describeContract(vault.factory, (ctx) => {
    smokeTest('deploys and serves wrapper metadata', async () => {
      const c = ctx();
      const deployed = await c.deployFresh([...vault.DEPLOY_ARGS]);
      const address = deployed.deployTxData.public.contractAddress;
      expect(address.length).toBeGreaterThan(0);

      expect((await vault.name(deployed)).private.result).toBe('Wrapped NIGHT');
      expect((await vault.symbol(deployed)).private.result).toBe('wNIGHT');
      expect((await vault.decimals(deployed)).private.result).toBe(6n);

      const color1 = (await vault.tokenColor(deployed)).private.result;
      const color2 = (await vault.tokenColor(deployed)).private.result;
      expect(color1).toHaveLength(32);
      expect(tokenColorHex(color1)).toBe(tokenColorHex(color2));

      const ledgerState = await vault.factory.readLedger(c.providers, address);
      expect(ledgerState).not.toBeNull();
      expect(ledgerState?._name).toBe('Wrapped NIGHT');
      expect(ledgerState?._symbol).toBe('wNIGHT');
      expect(ledgerState?._decimals).toBe(6n);
      expect(ledgerState?.balances.isEmpty()).toBe(true);
    });

    smokeTest(
      'full round trip: unshielded -> shielded -> unshielded',
      async () => {
        const c = ctx();
        const deployed = await c.deployFresh([...vault.DEPLOY_ARGS]);
        const secret = randomBytes32();

        const night0 = await getNightBalance(c.walletCtx);
        expect(night0).toBeGreaterThanOrEqual(N);
        const colorHex = tokenColorHex((await vault.tokenColor(deployed)).private.result);

        // 1. Lock native NIGHT, credit hash(secret).
        await vault.depositUnshielded(deployed, secret, N);
        expect((await vault.getBalance(deployed, secret)).private.result).toBe(N);
        const nightAfterDeposit = await waitForUnshieldedBalance(
          c.walletCtx.wallet,
          NIGHT_HEX,
          (b) => b <= night0 - N,
        );
        expect(nightAfterDeposit).toBe(night0 - N);

        // 2. Mint the shielded wrapper against the credit.
        const coin = (
          await vault.withdrawShielded(deployed, secret, N, await getCoinPublicKey(c.walletCtx), randomBytes32())
        ).private.result;
        expect(coin.value).toBe(N);
        expect(tokenColorHex(coin.color)).toBe(colorHex);
        expect((await vault.getBalance(deployed, secret)).private.result).toBe(0n);
        const wrapped = await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b >= N);
        expect(wrapped).toBe(N);

        // 3. Burn the wrapper coin (the exact minted UTXO), credit again.
        await vault.depositShielded(deployed, secret, coin);
        expect((await vault.getBalance(deployed, secret)).private.result).toBe(N);
        await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b === 0n);

        // 4. Release the locked NIGHT back to the caller.
        await vault.withdrawUnshielded(deployed, secret, N, vault.rightUserAddress(getUserAddress(c.walletCtx).bytes));
        expect((await vault.getBalance(deployed, secret)).private.result).toBe(0n);
        const nightFinal = await waitForUnshieldedBalance(c.walletCtx.wallet, NIGHT_HEX, (b) => b >= night0);
        expect(nightFinal).toBe(night0);
      },
      10 * 60_000,
    );

    test('withdraw with the wrong secret fails', async () => {
      const c = ctx();
      const deployed = await c.deployFresh([...vault.DEPLOY_ARGS]);
      const secretA = randomBytes32();
      await vault.depositUnshielded(deployed, secretA, N);

      const me = vault.rightUserAddress(getUserAddress(c.walletCtx).bytes);
      await expectFailure(
        () => vault.withdrawUnshielded(deployed, randomBytes32(), N, me),
        'no balance for this secret',
      );
    });

    test('over-withdraw fails', async () => {
      const c = ctx();
      const deployed = await c.deployFresh([...vault.DEPLOY_ARGS]);
      const secret = randomBytes32();
      await vault.depositUnshielded(deployed, secret, N);

      await expectFailure(
        () => vault.withdrawShielded(deployed, secret, N + 1n, { bytes: randomBytes32() }, randomBytes32()),
        'insufficient pool balance',
      );
    });

    test('zero-amount deposit is rejected', async () => {
      const c = ctx();
      const deployed = await c.deployFresh([...vault.DEPLOY_ARGS]);
      await expectFailure(() => vault.depositUnshielded(deployed, randomBytes32(), 0n), 'amount must be positive');
    });

    test('a coin that is not the vault wrapper is rejected', async () => {
      const c = ctx();
      const deployed = await c.deployFresh([...vault.DEPLOY_ARGS]);
      const secret = randomBytes32();

      // Mint a real wrapper coin, then flip one color byte before depositing.
      await vault.depositUnshielded(deployed, secret, N);
      const coin = (
        await vault.withdrawShielded(deployed, secret, N, await getCoinPublicKey(c.walletCtx), randomBytes32())
      ).private.result;

      const foreign = { ...coin, color: coin.color.slice() };
      foreign.color[0] ^= 0xff;
      await expectFailure(() => vault.depositShielded(deployed, secret, foreign), "not this vault's shielded wrapper");
    });

    test('getBalance for a never-used secret fails (lookup without member guard)', async () => {
      const c = ctx();
      const deployed = await c.deployFresh([...vault.DEPLOY_ARGS]);
      // Pins current behavior: reads for unknown keys revert instead of
      // returning 0. Off-chain callers must probe `balances.member` first.
      const outcome = await tryCall(() => vault.getBalance(deployed, randomBytes32()));
      expect(outcome.ok).toBe(false);
    });
  });
});

describe.skipIf((process.env.MN_ENV ?? 'undeployed') !== 'undeployed')('convert-vault — multi-wallet', () => {
  describeContractWithWallets(vault.factory, ['alice', 'bob'] as const, (ctx) => {
    smokeTest(
      'two users hold independent balances keyed by secret',
      async () => {
        const { alice, bob } = ctx();
        const Na = 5_000_000n;
        const Nb = 3_000_000n;
        const secretA = randomBytes32();
        const secretB = randomBytes32();

        const deployed = await alice.deployFresh([...vault.DEPLOY_ARGS]);
        const address = deployed.deployTxData.public.contractAddress;
        const bobView = await bob.connect(address);

        const bobNight0 = await getNightBalance(bob.walletCtx);

        await vault.depositUnshielded(deployed, secretA, Na);
        await vault.depositUnshielded(bobView, secretB, Nb);

        // Balances are keyed by secret, not caller: either wallet reads both.
        expect((await vault.getBalance(deployed, secretA)).private.result).toBe(Na);
        expect((await vault.getBalance(deployed, secretB)).private.result).toBe(Nb);
        expect((await vault.getBalance(bobView, secretA)).private.result).toBe(Na);

        const ledgerState = await vault.factory.readLedger(alice.providers, address);
        expect(ledgerState?.balances.size()).toBe(2n);

        // Bob cannot withdraw Alice's credit without her secret.
        const bobAddr = vault.rightUserAddress(getUserAddress(bob.walletCtx).bytes);
        await expectFailure(
          () => vault.withdrawUnshielded(bobView, randomBytes32(), Na, bobAddr),
          'no balance for this secret',
        );

        // Bob recovers his own deposit in full.
        await vault.withdrawUnshielded(bobView, secretB, Nb, bobAddr);
        const bobNightFinal = await waitForUnshieldedBalance(bob.walletCtx.wallet, NIGHT_HEX, (b) => b >= bobNight0);
        expect(bobNightFinal).toBe(bobNight0);
      },
      10 * 60_000,
    );
  });
});
