import { describe, expect, test } from 'vitest';
import * as vault from '../support/convert-vault.js';
import { describeContract, describeContractWithWallets } from '../support/describe-contract.js';
import { tryCall } from '../support/smoke-helpers.js';
import {
  getCoinPublicKey,
  getNightBalance,
  getUserAddress,
  randomBytes32,
  tokenColorHex,
  waitForShieldedBalance,
} from '../support/wallet-observations.js';

/**
 * On-chain attack scenarios. These need a real ledger: the properties under
 * test are enforced by transaction balancing and the global coin-commitment
 * set, not by circuit logic — the simulator can't falsify them.
 *
 * Theft vectors: crediting yourself with a coin you never owned (forged,
 * inflated, someone else's, or already spent). Loss vectors: nonce reuse
 * destroying a mint, credits drifting from the NIGHT reserve.
 */

const N = 1_000_000n; // 1 NIGHT at 6 decimals

const attemptFails = async (fn: () => Promise<unknown>): Promise<void> => {
  const outcome = await tryCall(fn);
  expect(outcome.ok, 'expected the transaction to be rejected').toBe(false);
};

/** Sum of all credit balances in the vault's ledger map. */
const sumCredits = async (
  providers: vault.ConvertVaultProviders,
  address: string,
): Promise<bigint> => {
  const state = await vault.factory.readLedger(providers, address);
  expect(state).not.toBeNull();
  let sum = 0n;
  for (const [, balance] of state!.balances) sum += balance;
  return sum;
};

describe('convert-vault — security', () => {
  describeContract(vault.factory, (ctx) => {
    test(
      'forged wrapper coins cannot mint credit (never-minted, inflated, double-spent)',
      async () => {
        const c = ctx();
        const deployed = await c.deployFresh([...vault.DEPLOY_ARGS]);
        const address = deployed.deployTxData.public.contractAddress;
        const color = (await vault.tokenColor(deployed)).private.result;
        const colorHex = tokenColorHex(color);
        const me = await getCoinPublicKey(c.walletCtx);

        // --- Vector 1: a coin that was never minted. The circuit's
        // receiveShielded claims it, but no wallet can supply the UTXO, so the
        // transaction cannot balance.
        const thief = randomBytes32();
        await attemptFails(() =>
          vault.depositShielded(deployed, thief, { nonce: randomBytes32(), color, value: N }),
        );
        // The thief's key must not exist in the ledger at all.
        const afterForged = await vault.factory.readLedger(c.providers, address);
        expect(afterForged?.balances.isEmpty()).toBe(true);

        // Mint a real wrapper coin to set up the next two vectors.
        const owner = randomBytes32();
        await vault.depositUnshielded(deployed, owner, N);
        const coin = (
          await vault.withdrawShielded(deployed, owner, N, me, randomBytes32())
        ).private.result;
        await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b >= N);

        // --- Vector 2: the real coin's nonce with an inflated value. The
        // commitment doesn't match any owned UTXO, so it cannot balance.
        await attemptFails(() =>
          vault.depositShielded(deployed, thief, { ...coin, value: N * 2n }),
        );

        // --- Vector 3: double-burn. The genuine coin deposits once...
        await vault.depositShielded(deployed, owner, coin);
        expect((await vault.getBalance(deployed, owner)).private.result).toBe(N);
        await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b === 0n);
        // ...and the second attempt with the same (now spent) coin fails.
        await attemptFails(() => vault.depositShielded(deployed, owner, coin));
        expect((await vault.getBalance(deployed, owner)).private.result).toBe(N);

        // Nothing in the attack sequence created credit out of thin air.
        expect(await sumCredits(c.providers, address)).toBe(N);
      },
      10 * 60_000,
    );

    test(
      'nonce reuse cannot double-mint: the duplicate commitment is rejected',
      async () => {
        const c = ctx();
        const deployed = await c.deployFresh([...vault.DEPLOY_ARGS]);
        const me = await getCoinPublicKey(c.walletCtx);
        const secret = randomBytes32();
        const nonce = randomBytes32();

        await vault.depositUnshielded(deployed, secret, 2n * N);

        // First mint with `nonce` succeeds.
        await vault.withdrawShielded(deployed, secret, N, me, nonce);
        expect((await vault.getBalance(deployed, secret)).private.result).toBe(N);

        // Same (value, recipient, nonce) => identical coin commitment => the
        // ledger rejects it. The debit must not survive the failed tx.
        await attemptFails(() => vault.withdrawShielded(deployed, secret, N, me, nonce));
        expect((await vault.getBalance(deployed, secret)).private.result).toBe(N);

        // A fresh nonce withdraws the remainder normally.
        await vault.withdrawShielded(deployed, secret, N, me, randomBytes32());
        expect((await vault.getBalance(deployed, secret)).private.result).toBe(0n);
      },
      10 * 60_000,
    );

    test(
      'reserve invariant: locked NIGHT always equals credits + outstanding wrapper',
      async () => {
        const c = ctx();
        const deployed = await c.deployFresh([...vault.DEPLOY_ARGS]);
        const address = deployed.deployTxData.public.contractAddress;
        const colorHex = tokenColorHex((await vault.tokenColor(deployed)).private.result);
        const me = await getCoinPublicKey(c.walletCtx);
        const myAddr = vault.rightUserAddress(getUserAddress(c.walletCtx).bytes);
        const secret = randomBytes32();
        const night0 = await getNightBalance(c.walletCtx);

        const DEPOSIT = 10n * N;
        const MINTED = 4n * N;
        const RELEASED = 2n * N;

        // deposit 10, mint 4 as wrapper, release 2 as NIGHT.
        await vault.depositUnshielded(deployed, secret, DEPOSIT);
        await vault.withdrawShielded(deployed, secret, MINTED, me, randomBytes32());
        const wrapper = await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b >= MINTED);
        await vault.withdrawUnshielded(deployed, secret, RELEASED, myAddr);

        // Ledger credits: 10 - 4 - 2 = 4. Wrapper outstanding: 4.
        const credits = await sumCredits(c.providers, address);
        expect(credits).toBe(DEPOSIT - MINTED - RELEASED);
        expect(wrapper).toBe(MINTED);

        // The vault's NIGHT reserve backs both in full: locked == credits + wrapper.
        // Measured from the wallet side: exactly (credits + wrapper) of our
        // NIGHT is locked in the contract, no more (nothing skimmed), no less
        // (fees are DUST, never NIGHT).
        const nightNow = await getNightBalance(c.walletCtx);
        expect(night0 - nightNow).toBe(credits + wrapper);
      },
      10 * 60_000,
    );
  });
});

describe.skipIf((process.env.MN_ENV ?? 'undeployed') !== 'undeployed')(
  'convert-vault — security, multi-wallet',
  () => {
    describeContractWithWallets(vault.factory, ['alice', 'bob'] as const, (ctx) => {
      test(
        "bob cannot burn alice's wrapper coin to credit himself",
        async () => {
          const { alice, bob } = ctx();
          const secretA = randomBytes32();
          const secretB = randomBytes32();

          const deployed = await alice.deployFresh([...vault.DEPLOY_ARGS]);
          const address = deployed.deployTxData.public.contractAddress;
          const bobView = await bob.connect(address);
          const colorHex = tokenColorHex((await vault.tokenColor(deployed)).private.result);

          // Alice converts N into the wrapper; the coin belongs to her wallet.
          await vault.depositUnshielded(deployed, secretA, N);
          const aliceCoin = (
            await vault.withdrawShielded(
              deployed,
              secretA,
              N,
              await getCoinPublicKey(alice.walletCtx),
              randomBytes32(),
            )
          ).private.result;
          await waitForShieldedBalance(alice.walletCtx.wallet, colorHex, (b) => b >= N);

          // Bob knows the coin's public info but does not own the UTXO: his
          // wallet cannot supply it, so the deposit cannot balance.
          await attemptFails(() => vault.depositShielded(bobView, secretB, aliceCoin));
          const state = await vault.factory.readLedger(bob.providers, address);
          expect(state?.balances.member(new Uint8Array(32))).toBe(false);
          await attemptFails(() => vault.getBalance(bobView, secretB)); // no credit key created

          // Alice's coin is untouched by bob's attempt: she burns it herself.
          await vault.depositShielded(deployed, secretA, aliceCoin);
          expect((await vault.getBalance(deployed, secretA)).private.result).toBe(N);
        },
        10 * 60_000,
      );
    });
  },
);
