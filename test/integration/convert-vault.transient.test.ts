import { describe, expect, test } from 'vitest';
import * as vault from '../support/convert-vault.js';
import { describeContract } from '../support/describe-contract.js';
import type { WalletContext } from '../support/wallet-builder.js';
import {
  getCoinPublicKey,
  randomBytes32,
  tokenColorHex,
  waitForShieldedBalance,
} from '../support/wallet-observations.js';

/**
 * `depositShielded_notWorking` investigation: the variant burns part of the
 * received coin via `sendImmediateShielded` (a same-transaction transient) and
 * refunds the remainder. Browser wallets reportedly mis-list the result (spent
 * UTXOs still shown). These tests separate three independent questions:
 *
 * 1. Does the transaction build, balance, and apply on the current stack?
 * 2. Is the CONTRACT accounting correct on-chain (credit, change value,
 *    change spendability — i.e. can funds ever be lost)?
 * 3. Does the wallet SDK's own view converge to the truth (measured and
 *    logged, asserted only as a bounded wait)?
 *
 * If 1+2 hold but wallets still list wrong, the field bug is purely a
 * wallet-display issue, not a funds-safety issue.
 */

const N = 1_000_000n;

/** Bounded wallet-view probe: resolves to the converged balance or a report string. */
const probeWalletView = async (
  walletCtx: WalletContext,
  colorHex: string,
  expected: bigint,
): Promise<string> => {
  try {
    const v = await waitForShieldedBalance(walletCtx.wallet, colorHex, (b) => b === expected, {
      timeoutMs: 120_000,
    });
    return `converged to ${v} (expected ${expected})`;
  } catch {
    const stale = await waitForShieldedBalance(walletCtx.wallet, colorHex, () => true, {
      timeoutMs: 30_000,
    }).catch(() => 'unreadable');
    return `DID NOT converge within 120s: wallet shows ${stale}, expected ${expected}`;
  }
};

describe('convert-vault — sendImmediateShielded transient variant', () => {
  describeContract(vault.factory, (ctx) => {
    test(
      'full burn: transaction applies, credit is exact, wallet view measured',
      async () => {
        const c = ctx();
        const deployed = await c.deployFresh([...vault.DEPLOY_ARGS]);
        const colorHex = tokenColorHex((await vault.tokenColor(deployed)).private.result);
        const me = await getCoinPublicKey(c.walletCtx);
        const mintSecret = randomBytes32();
        const burnSecret = randomBytes32();

        // Mint a wrapper coin the normal way.
        await vault.depositUnshielded(deployed, mintSecret, N);
        const coin = (
          await vault.withdrawShielded(deployed, mintSecret, N, me, randomBytes32())
        ).private.result;
        await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b >= N);

        // Q1+Q2: full burn through the transient path.
        const res = (
          await vault.depositShieldedWithChange(deployed, burnSecret, coin, N, vault.leftCoinPublicKey(me.bytes))
        ).private.result;
        expect(res.is_some).toBe(false); // no change on a full burn
        expect((await vault.getBalance(deployed, burnSecret)).private.result).toBe(N);

        // Q3: does the SDK wallet see the coin as spent?
        const view = await probeWalletView(c.walletCtx, colorHex, 0n);
        console.log(`[transient/full-burn] wallet view: ${view}`);
        expect(view, `wallet view after full transient burn: ${view}`).toContain('converged');
      },
      10 * 60_000,
    );

    test(
      'partial burn: exact change is returned, spendable, and nothing is lost',
      async () => {
        const c = ctx();
        const deployed = await c.deployFresh([...vault.DEPLOY_ARGS]);
        const colorHex = tokenColorHex((await vault.tokenColor(deployed)).private.result);
        const me = await getCoinPublicKey(c.walletCtx);
        const mintSecret = randomBytes32();
        const burnSecret = randomBytes32();
        const changeSecret = randomBytes32();
        const BURN = N / 4n;

        await vault.depositUnshielded(deployed, mintSecret, N);
        const coin = (
          await vault.withdrawShielded(deployed, mintSecret, N, me, randomBytes32())
        ).private.result;
        await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b >= N);

        // Partial burn: credit BURN, change N - BURN refunded to us.
        const res = (
          await vault.depositShieldedWithChange(deployed, burnSecret, coin, BURN, vault.leftCoinPublicKey(me.bytes))
        ).private.result;
        expect(res.is_some).toBe(true);
        const change = res.value;
        expect(change.value).toBe(N - BURN);
        expect(tokenColorHex(change.color)).toBe(colorHex);
        expect((await vault.getBalance(deployed, burnSecret)).private.result).toBe(BURN);

        // The change coin is REAL: spend it through the plain deposit path.
        // (Contract-sent coins carry no ciphertext — this returned struct is
        // the only recoverable copy, so spendability is the loss-safety proof.)
        await vault.depositShielded(deployed, changeSecret, change);
        expect((await vault.getBalance(deployed, changeSecret)).private.result).toBe(N - BURN);

        // Conservation: BURN + (N - BURN) credited, original N debited once.
        const total =
          (await vault.getBalance(deployed, burnSecret)).private.result +
          (await vault.getBalance(deployed, changeSecret)).private.result;
        expect(total).toBe(N);

        // Q3: wallet should end at zero wrapper (coin spent, change also spent).
        const view = await probeWalletView(c.walletCtx, colorHex, 0n);
        console.log(`[transient/partial-burn] wallet view: ${view}`);
        expect(view, `wallet view after change spend: ${view}`).toContain('converged');
      },
      10 * 60_000,
    );
  });
});
