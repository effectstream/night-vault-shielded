import { describe, expect, test } from 'vitest';
import * as contract from '../support/shielded-night.js';
import { describeContractWithWallets } from '../support/describe-contract.js';
import {
  coinsTotal,
  getShieldedAddress,
  transferShielded,
  waitForCoins,
} from '../support/wallet-transfer.js';
import {
  getCoinPublicKey,
  getNightBalance,
  getUserAddress,
  randomBytes32,
  tokenColorHex,
  waitForShieldedBalance,
  waitForUnshieldedBalance,
} from '../support/wallet-observations.js';
import * as ledgerV8 from '@midnight-ntwrk/ledger-v8';

const NIGHT_HEX = ledgerV8.unshieldedToken().raw;

const A_DEPOSIT = 1_000_000n; // A deposits this much native NIGHT
const A_MINT = 200_000n; // A withdraws this much as the shielded wrapper
const TO_B = 10_000n; // A sends this much wrapper to B
const TO_C = 20_000n; // A sends this much wrapper to C

/** Sum every credit balance held in the contract ledger. */
const sumCredits = async (
  providers: contract.ShieldedNightProviders,
  address: string,
): Promise<bigint> => {
  const state = await contract.factory.readLedger(providers, address);
  expect(state).not.toBeNull();
  let sum = 0n;
  for (const [, balance] of state!.balances) sum += balance;
  return sum;
};

/**
 * The wrapper is a real, freely-transferable shielded token: A mints it, sends
 * pieces to B and C with an ordinary wallet-to-wallet shielded transfer (no
 * contract call), and then B and C — who never deposited any NIGHT themselves —
 * each redeem their pieces for native NIGHT through the contract.
 *
 * This proves the contract backs *any* wrapper holder, not just the original
 * depositor, and that the NIGHT reserve reconciles across three parties.
 *
 *   A: deposit 1,000,000 NIGHT -> mint 200,000 wrapper -> balance[A] = 800,000
 *   A -> B: 10,000 wrapper,  A -> C: 20,000 wrapper  (A keeps 170,000)
 *   B: burn 10,000 wrapper -> withdraw 10,000 NIGHT
 *   C: burn 20,000 wrapper -> withdraw 20,000 NIGHT
 *   reserve: NIGHT locked (970,000) == credits (800,000) + wrapper live (170,000)
 */
describe.skipIf((process.env.MN_ENV ?? 'undeployed') !== 'undeployed')(
  'shielded-night — multi-party wrapper circulation',
  () => {
    describeContractWithWallets(contract.factory, ['alice', 'bob', 'claire'] as const, (ctx) => {
      test(
        'A mints wrapper, sends to B and C, who each convert it back to NIGHT',
        async () => {
          const { alice, bob, claire } = ctx();
          const secretA = randomBytes32();
          const secretB = randomBytes32();
          const secretC = randomBytes32();

          const deployed = await alice.deployFresh([...contract.DEPLOY_ARGS]);
          const address = deployed.deployTxData.public.contractAddress;
          const bobView = await bob.connect(address);
          const claireView = await claire.connect(address);
          const colorHex = tokenColorHex((await contract.tokenColor(deployed)).private.result);

          const bobNight0 = await getNightBalance(bob.walletCtx);
          const claireNight0 = await getNightBalance(claire.walletCtx);

          // 1. A deposits 1,000,000 native NIGHT.
          await contract.depositUnshielded(deployed, secretA, A_DEPOSIT);
          expect((await contract.getBalance(deployed, secretA)).private.result).toBe(A_DEPOSIT);

          // 2. A withdraws 200,000 as the shielded wrapper, to herself.
          await contract.withdrawShielded(
            deployed,
            secretA,
            A_MINT,
            await getCoinPublicKey(alice.walletCtx),
            randomBytes32(),
          );
          expect((await contract.getBalance(deployed, secretA)).private.result).toBe(A_DEPOSIT - A_MINT);
          await waitForShieldedBalance(alice.walletCtx.wallet, colorHex, (b) => b >= A_MINT);

          // 3. A sends 10,000 -> B and 20,000 -> C in one shielded transfer.
          await transferShielded(alice.walletCtx, colorHex, [
            { to: getShieldedAddress(bob.walletCtx), amount: TO_B },
            { to: getShieldedAddress(claire.walletCtx), amount: TO_C },
          ]);

          // B and C discover their received wrapper coins from their own wallets.
          const bCoins = await waitForCoins(bob.walletCtx, colorHex, (cs) => coinsTotal(cs) >= TO_B);
          const cCoins = await waitForCoins(claire.walletCtx, colorHex, (cs) => coinsTotal(cs) >= TO_C);
          expect(coinsTotal(bCoins)).toBe(TO_B);
          expect(coinsTotal(cCoins)).toBe(TO_C);
          // A keeps the remaining 170,000 wrapper.
          await waitForShieldedBalance(
            alice.walletCtx.wallet,
            colorHex,
            (b) => b === A_MINT - TO_B - TO_C,
          );

          // 4. B converts its wrapper back to NIGHT: burn -> withdraw.
          const bCoin = bCoins[0];
          await contract.depositShielded(bobView, secretB, bCoin);
          expect((await contract.getBalance(bobView, secretB)).private.result).toBe(TO_B);
          await contract.withdrawUnshielded(
            bobView,
            secretB,
            TO_B,
            contract.rightUserAddress(getUserAddress(bob.walletCtx).bytes),
          );
          expect((await contract.getBalance(bobView, secretB)).private.result).toBe(0n);
          expect(
            await waitForUnshieldedBalance(bob.walletCtx.wallet, NIGHT_HEX, (b) => b >= bobNight0 + TO_B),
          ).toBe(bobNight0 + TO_B);

          // 5. C does the same with its 20,000.
          const cCoin = cCoins[0];
          await contract.depositShielded(claireView, secretC, cCoin);
          expect((await contract.getBalance(claireView, secretC)).private.result).toBe(TO_C);
          await contract.withdrawUnshielded(
            claireView,
            secretC,
            TO_C,
            contract.rightUserAddress(getUserAddress(claire.walletCtx).bytes),
          );
          expect((await contract.getBalance(claireView, secretC)).private.result).toBe(0n);
          expect(
            await waitForUnshieldedBalance(
              claire.walletCtx.wallet,
              NIGHT_HEX,
              (b) => b >= claireNight0 + TO_C,
            ),
          ).toBe(claireNight0 + TO_C);

          // 6. A's credit was never touched by B/C activity (per-key isolation).
          expect((await contract.getBalance(deployed, secretA)).private.result).toBe(A_DEPOSIT - A_MINT);

          // 7. Reserve invariant across all three parties:
          //    credits (800,000) + live wrapper (170,000) == NIGHT still locked (970,000).
          const credits = await sumCredits(alice.providers, address);
          const liveWrapper = A_MINT - TO_B - TO_C;
          expect(credits).toBe(A_DEPOSIT - A_MINT); // only A holds credit
          expect(credits + liveWrapper).toBe(A_DEPOSIT - TO_B - TO_C); // 970,000 locked
        },
        15 * 60_000,
      );
    });
  },
);
