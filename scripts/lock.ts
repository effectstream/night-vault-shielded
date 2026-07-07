/**
 * LOCK an already-deployed ShieldedNight: dissolve its maintenance committee so
 * the contract can never be upgraded again (empty committee, threshold 1). This
 * is a ONE-WAY door — the circuits keep running, but no verifier key or rule can
 * ever change. Unlike scripts/deploy-and-lock.ts this does NOT deploy; it locks
 * a contract that already exists on chain (e.g. one you deployed + tested live).
 *
 * The current maintenance authority must sign the update that dissolves itself,
 * so the maintenance SIGNING KEY generated at deploy time must still be in this
 * machine's private-state DB (midnight-level-db / <factory>-private-state). That
 * key is decrypted with a password derived from the deploying wallet's account,
 * so you must run this with the SAME MN_MNEMONIC / MN_SEED you deployed with.
 *
 * Usage:
 *   # 1) DRY RUN first — confirms the signing key is present and the contract is
 *   #    lockable, WITHOUT submitting anything:
 *   DRY_RUN=1 MN_ENV=preview MN_MNEMONIC="word1 … word24" \
 *     CV_ADDRESS=<hex-address> bun run scripts/lock.ts
 *
 *   # 2) then, for real (irreversible):
 *   MN_ENV=preview MN_MNEMONIC="word1 … word24" \
 *     CV_ADDRESS=<hex-address> bun run scripts/lock.ts
 *
 * Env:
 *   MN_ENV       preview | preprod | undeployed | qanet   (default: preview)
 *   MN_MNEMONIC  BIP-39 phrase; derived to a seed exactly as Lace does
 *   MN_SEED      raw hex seed (alternative to MN_MNEMONIC)
 *   CV_ADDRESS   contract address to lock (hex, required)
 *   DRY_RUN      when set, verify lockability and exit without submitting
 */
import { validateMnemonic } from '@midnightntwrk/wallet-sdk';
import { mnemonicToSeedSync } from '@scure/bip39';
import { isEnvName, networkFor, type EnvName, GENESIS_MINT_SEED } from '../test/support/network.js';
import { awaitWalletReady, buildWallet, DEFAULT_RESTORED_SYNC_TIMEOUT_MS } from '../test/support/wallet-builder.js';
import { setupContract } from '../test/support/setup-contract.js';
import { factory } from '../test/support/shielded-night.js';
import { lockContract, readAuthority } from '../test/support/governance.js';

function resolveSeed(env: EnvName): string {
  const mnemonic = process.env.MN_MNEMONIC?.trim().replace(/\s+/g, ' ');
  if (mnemonic) {
    if (!validateMnemonic(mnemonic)) {
      throw new Error('MN_MNEMONIC is not a valid BIP-39 phrase (bad word or checksum).');
    }
    return Buffer.from(mnemonicToSeedSync(mnemonic)).toString('hex');
  }
  const seed = process.env.MN_SEED ?? (env === 'undeployed' ? GENESIS_MINT_SEED : '');
  if (!seed) {
    throw new Error(`Set MN_MNEMONIC or MN_SEED for MN_ENV=${env} (the SAME wallet you deployed with).`);
  }
  return seed;
}

async function main() {
  const rawEnv = process.env.MN_ENV ?? 'preview';
  if (!isEnvName(rawEnv)) throw new Error(`Invalid MN_ENV "${rawEnv}"`);
  const env: EnvName = rawEnv;

  const address = process.env.CV_ADDRESS?.trim();
  if (!address) throw new Error('Set CV_ADDRESS to the contract address to lock (hex).');

  const dryRun = !!process.env.DRY_RUN;
  const seed = resolveSeed(env);
  const network = networkFor(env);

  console.log(`[lock] env=${env} address=${address} ${dryRun ? '(DRY RUN)' : ''}`);
  console.log(`[lock] indexer=${network.indexer}`);
  console.log('[lock] building + syncing wallet…');
  const raw = await buildWallet(network, seed);
  const walletCtx = await awaitWalletReady(raw, {
    requireFunds: env === 'undeployed',
    syncTimeoutMs: DEFAULT_RESTORED_SYNC_TIMEOUT_MS,
  });

  try {
    const { providers } = await setupContract(factory, { network, walletCtx });

    const before = await readAuthority(providers, address);
    console.log(`[lock] authority now: committee=${before.committeeSize} threshold=${before.threshold} counter=${before.counter}`);
    if (before.committeeSize === 0) {
      console.log('[lock] contract is already locked (empty committee). Nothing to do.');
      return;
    }

    // The maintenance signing key must be in this machine's private-state DB.
    const signingKey = await providers.privateStateProvider.getSigningKey(address);
    if (signingKey == null) {
      throw new Error(
        `No maintenance signing key stored for ${address}. This machine did not deploy it, ` +
          `or the private-state DB (midnight-level-db) is gone — it CANNOT be locked from here. ` +
          `Deploy a fresh contract with scripts/deploy-and-lock.ts instead.`,
      );
    }
    console.log('[lock] maintenance signing key present ✓ — contract is lockable.');

    if (dryRun) {
      console.log('\n✅ DRY RUN: lockable. Re-run without DRY_RUN to lock (IRREVERSIBLE).');
      return;
    }

    console.log('[lock] locking (dissolving the committee — one-way, ~30-90s)…');
    await lockContract(providers, address, 1);

    const after = await readAuthority(providers, address);
    if (after.committeeSize !== 0 || after.threshold < 1) {
      throw new Error(`lock did not take: committee=${after.committeeSize} threshold=${after.threshold} (expected 0 / >=1)`);
    }
    console.log('\n✅ LOCKED — permanently non-upgradeable.');
    console.log(`   address: ${address}`);
    console.log(`   authority: committee=${after.committeeSize} threshold=${after.threshold} counter=${after.counter}`);
  } finally {
    await walletCtx.wallet.stop().catch(() => undefined);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('[lock] failed:', e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  },
);
