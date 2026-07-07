import * as ledgerV8 from '@midnight-ntwrk/ledger-v8';
import { describe, expect, test } from 'vitest';
import * as contract from '../support/shielded-night.js';
import { describeContract, describeContractWithWallets } from '../support/describe-contract.js';
import { tryCall } from '../support/smoke-helpers.js';
import {
  getCoinPublicKey,
  getNightBalance,
  getUserAddress,
  randomBytes32,
  tokenColorHex,
  waitForShieldedBalance,
  waitForUnshieldedBalance,
} from '../support/wallet-observations.js';

const NIGHT_HEX = ledgerV8.unshieldedToken().raw;

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

/** Sum of all credit balances in the contract's ledger map. */
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

describe('shielded-night — security', () => {
  describeContract(contract.factory, (ctx) => {
    test(
      'forged wrapper coins cannot mint credit (never-minted, inflated, double-spent)',
      async () => {
        const c = ctx();
        const deployed = await c.deployFresh([...contract.DEPLOY_ARGS]);
        const address = deployed.deployTxData.public.contractAddress;
        const color = (await contract.tokenColor(deployed)).private.result;
        const colorHex = tokenColorHex(color);
        const me = await getCoinPublicKey(c.walletCtx);

        // --- Vector 1: a coin that was never minted. The circuit's
        // receiveShielded claims it, but no wallet can supply the UTXO, so the
        // transaction cannot balance.
        const thief = randomBytes32();
        await attemptFails(() =>
          contract.depositShielded(deployed, thief, { nonce: randomBytes32(), color, value: N }),
        );
        // The thief's key must not exist in the ledger at all.
        const afterForged = await contract.factory.readLedger(c.providers, address);
        expect(afterForged?.balances.isEmpty()).toBe(true);

        // Mint a real wrapper coin to set up the next two vectors.
        const owner = randomBytes32();
        await contract.depositUnshielded(deployed, owner, N);
        const coin = (
          await contract.withdrawShielded(deployed, owner, N, me, randomBytes32())
        ).private.result;
        await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b >= N);

        // --- Vector 2: the real coin's nonce with an inflated value. The
        // commitment doesn't match any owned UTXO, so it cannot balance.
        await attemptFails(() =>
          contract.depositShielded(deployed, thief, { ...coin, value: N * 2n }),
        );

        // --- Vector 3: double-burn. The genuine coin deposits once...
        await contract.depositShielded(deployed, owner, coin);
        expect((await contract.getBalance(deployed, owner)).private.result).toBe(N);
        await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b === 0n);
        // ...and the second attempt with the same (now spent) coin fails.
        await attemptFails(() => contract.depositShielded(deployed, owner, coin));
        expect((await contract.getBalance(deployed, owner)).private.result).toBe(N);

        // Nothing in the attack sequence created credit out of thin air.
        expect(await sumCredits(c.providers, address)).toBe(N);
      },
      10 * 60_000,
    );

    test(
      'nonce reuse cannot double-mint: the duplicate commitment is rejected',
      async () => {
        const c = ctx();
        const deployed = await c.deployFresh([...contract.DEPLOY_ARGS]);
        const me = await getCoinPublicKey(c.walletCtx);
        const secret = randomBytes32();
        const nonce = randomBytes32();

        await contract.depositUnshielded(deployed, secret, 2n * N);

        // First mint with `nonce` succeeds.
        await contract.withdrawShielded(deployed, secret, N, me, nonce);
        expect((await contract.getBalance(deployed, secret)).private.result).toBe(N);

        // Same (value, recipient, nonce) => identical coin commitment => the
        // ledger rejects it. The debit must not survive the failed tx.
        await attemptFails(() => contract.withdrawShielded(deployed, secret, N, me, nonce));
        expect((await contract.getBalance(deployed, secret)).private.result).toBe(N);

        // A fresh nonce withdraws the remainder normally.
        await contract.withdrawShielded(deployed, secret, N, me, randomBytes32());
        expect((await contract.getBalance(deployed, secret)).private.result).toBe(0n);
      },
      10 * 60_000,
    );

    test(
      'reserve invariant: locked NIGHT always equals credits + outstanding wrapper',
      async () => {
        const c = ctx();
        const deployed = await c.deployFresh([...contract.DEPLOY_ARGS]);
        const address = deployed.deployTxData.public.contractAddress;
        const colorHex = tokenColorHex((await contract.tokenColor(deployed)).private.result);
        const me = await getCoinPublicKey(c.walletCtx);
        const myAddr = contract.rightUserAddress(getUserAddress(c.walletCtx).bytes);
        const secret = randomBytes32();
        const night0 = await getNightBalance(c.walletCtx);

        const DEPOSIT = 10n * N;
        const MINTED = 4n * N;
        const RELEASED = 2n * N;

        // deposit 10, mint 4 as wrapper, release 2 as NIGHT.
        await contract.depositUnshielded(deployed, secret, DEPOSIT);
        await contract.withdrawShielded(deployed, secret, MINTED, me, randomBytes32());
        const wrapper = await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b >= MINTED);
        await contract.withdrawUnshielded(deployed, secret, RELEASED, myAddr);

        // Ledger credits: 10 - 4 - 2 = 4. Wrapper outstanding: 4.
        const credits = await sumCredits(c.providers, address);
        expect(credits).toBe(DEPOSIT - MINTED - RELEASED);
        expect(wrapper).toBe(MINTED);

        // The contract's NIGHT reserve backs both in full: locked == credits + wrapper.
        // Measured from the wallet side: exactly (credits + wrapper) of our
        // NIGHT is locked in the contract, no more (nothing skimmed), no less
        // (fees are DUST, never NIGHT).
        const nightNow = await getNightBalance(c.walletCtx);
        expect(night0 - nightNow).toBe(credits + wrapper);
      },
      10 * 60_000,
    );

    test(
      'combined circuits: forged or double-spent coins cannot drain the reserve; nonce reuse cannot re-mint',
      async () => {
        // convertToUnshielded releases NIGHT DIRECTLY from the reserve — there
        // is no credit step in between, so a forged coin accepted here would be
        // outright theft (worse than the credit-based depositShielded vectors).
        // Every acceptance decision is `receiveShielded`, enforced by the
        // ledger's coin-commitment set: only these on-chain tests can falsify it.
        const c = ctx();
        const deployed = await c.deployFresh([...contract.DEPLOY_ARGS]);
        const address = deployed.deployTxData.public.contractAddress;
        const color = (await contract.tokenColor(deployed)).private.result;
        const colorHex = tokenColorHex(color);
        const me = await getCoinPublicKey(c.walletCtx);
        const myAddr = contract.rightUserAddress(getUserAddress(c.walletCtx).bytes);
        const night0 = await getNightBalance(c.walletCtx);

        // --- Vector 1: a coin that was never minted. receiveShielded claims
        // it, but no wallet can supply the UTXO, so the tx cannot balance.
        await attemptFails(() =>
          contract.convertToUnshielded(
            deployed,
            { nonce: randomBytes32(), color, value: N },
            myAddr,
          ),
        );

        // Fund the reserve with a real atomic convert (locks N, mints N).
        const nonce = randomBytes32();
        const coin = (await contract.convertToShielded(deployed, N, me, nonce)).private.result;
        await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b >= N);

        // --- Vector 2: the real coin's nonce with an inflated value. The
        // commitment doesn't match any owned UTXO, so it cannot balance.
        await attemptFails(() =>
          contract.convertToUnshielded(deployed, { ...coin, value: 2n * N }, myAddr),
        );

        // --- Vector 3: double-spend. The genuine coin converts back once...
        await contract.convertToUnshielded(deployed, coin, myAddr);
        await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b === 0n);
        expect(await waitForUnshieldedBalance(c.walletCtx.wallet, NIGHT_HEX, (b) => b >= night0)).toBe(night0);
        // ...and a second release against the same (now spent) coin fails.
        await attemptFails(() => contract.convertToUnshielded(deployed, coin, myAddr));

        // --- Vector 4: replay-mint. Re-minting with the SAME nonce reproduces
        // the spent coin's commitment; the append-only commitment set rejects
        // it even though the original coin is long spent.
        await attemptFails(() => contract.convertToShielded(deployed, N, me, nonce));

        // The contract itself is undamaged: a fresh nonce round-trips normally.
        const coin2 = (await contract.convertToShielded(deployed, N, me, randomBytes32())).private
          .result;
        await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b >= N);
        await contract.convertToUnshielded(deployed, coin2, myAddr);
        await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b === 0n);

        // Nothing in the attack sequence created credit or skimmed the reserve.
        const state = await contract.factory.readLedger(c.providers, address);
        expect(state?.balances.isEmpty()).toBe(true);
        expect(await waitForUnshieldedBalance(c.walletCtx.wallet, NIGHT_HEX, (b) => b >= night0)).toBe(night0);
      },
      10 * 60_000,
    );
  });
});

describe.skipIf((process.env.MN_ENV ?? 'undeployed') !== 'undeployed')(
  'shielded-night — security, multi-wallet',
  () => {
    describeContractWithWallets(contract.factory, ['alice', 'bob'] as const, (ctx) => {
      test(
        "bob cannot burn alice's wrapper coin to credit himself",
        async () => {
          const { alice, bob } = ctx();
          const secretA = randomBytes32();
          const secretB = randomBytes32();

          const deployed = await alice.deployFresh([...contract.DEPLOY_ARGS]);
          const address = deployed.deployTxData.public.contractAddress;
          const bobView = await bob.connect(address);
          const colorHex = tokenColorHex((await contract.tokenColor(deployed)).private.result);

          // Alice converts N into the wrapper; the coin belongs to her wallet.
          await contract.depositUnshielded(deployed, secretA, N);
          const aliceCoin = (
            await contract.withdrawShielded(
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
          await attemptFails(() => contract.depositShielded(bobView, secretB, aliceCoin));
          const state = await contract.factory.readLedger(bob.providers, address);
          expect(state?.balances.member(new Uint8Array(32))).toBe(false);
          await attemptFails(() => contract.getBalance(bobView, secretB)); // no credit key created

          // Alice's coin is untouched by bob's attempt: she burns it herself.
          await contract.depositShielded(deployed, secretA, aliceCoin);
          expect((await contract.getBalance(deployed, secretA)).private.result).toBe(N);
        },
        10 * 60_000,
      );
    });
  },
);
