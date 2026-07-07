/**
 * Deploy ShieldedNight from THIS repo's compiled build (src/managed), then LOCK
 * it: dissolve the maintenance committee so the contract can never be upgraded
 * again. This is a ONE-WAY door — a locked contract's circuits still run, but
 * no verifier key or rule can ever be changed. Use for an immutable release.
 *
 * Usage (a funded, DUST-registered wallet is required for hosted envs):
 *   MN_ENV=preview MN_MNEMONIC="word1 word2 … word24" bun run scripts/deploy-and-lock.ts
 *   MN_ENV=preview MN_SEED=<hex-seed> bun run scripts/deploy-and-lock.ts
 *
 *   # optional metadata overrides (default: "Wrapped NIGHT" / "wNIGHT" / 6)
 *   CV_NAME="Wrapped NIGHT" CV_SYMBOL=wNIGHT CV_DECIMALS=6 MN_ENV=preview MN_MNEMONIC="…" bun run scripts/deploy-and-lock.ts
 *
 * Env:
 *   MN_ENV       preview | preprod | undeployed | qanet   (default: preview)
 *   MN_MNEMONIC  BIP-39 phrase; derived to a seed exactly as Lace does
 *   MN_SEED      raw hex seed (alternative to MN_MNEMONIC)
 */
import { validateMnemonic } from '@midnightntwrk/wallet-sdk';
import { mnemonicToSeedSync } from '@scure/bip39';
import { isEnvName, networkFor, type EnvName, GENESIS_MINT_SEED } from '../test/support/network.js';
import { awaitWalletReady, buildWallet, DEFAULT_RESTORED_SYNC_TIMEOUT_MS } from '../test/support/wallet-builder.js';
import { setupContract } from '../test/support/setup-contract.js';
import { DEPLOY_ARGS, factory } from '../test/support/shielded-night.js';
import { lockContract, readAuthority } from '../test/support/governance.js';

/**
 * Resolve the wallet seed from MN_MNEMONIC (BIP-39, derived as Lace does) or a
 * raw MN_SEED hex, falling back to the local genesis seed on `undeployed`.
 */
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
    throw new Error(`Set MN_MNEMONIC or MN_SEED for MN_ENV=${env} (a funded, DUST-registered wallet).`);
  }
  return seed;
}

async function main() {
  const rawEnv = process.env.MN_ENV ?? 'preview';
  if (!isEnvName(rawEnv)) throw new Error(`Invalid MN_ENV "${rawEnv}"`);
  const env: EnvName = rawEnv;

  const seed = resolveSeed(env);
  const name = process.env.CV_NAME ?? DEPLOY_ARGS[0];
  const symbol = process.env.CV_SYMBOL ?? DEPLOY_ARGS[1];
  const decimals = BigInt(process.env.CV_DECIMALS ?? String(DEPLOY_ARGS[2]));

  const network = networkFor(env);
  console.log(`[deploy+lock] env=${env}`);
  console.log(`[deploy+lock] proofServer=${network.proofServer} indexer=${network.indexer}`);
  console.log(`[deploy+lock] args: name="${name}" symbol="${symbol}" decimals=${decimals}`);

  console.log('[deploy+lock] building + syncing wallet…');
  const raw = await buildWallet(network, seed);
  const walletCtx = await awaitWalletReady(raw, {
    requireFunds: env === 'undeployed',
    syncTimeoutMs: DEFAULT_RESTORED_SYNC_TIMEOUT_MS,
  });

  try {
    const { deployFresh, providers, zkConfigPath } = await setupContract(factory, { network, walletCtx });
    console.log(`[deploy+lock] proving against zk keys at: ${zkConfigPath}`);
    console.log('[deploy+lock] deploying (proves + submits — ~30-90s)…');
    const deployed = await deployFresh([name, symbol, decimals]);
    const address = deployed.deployTxData.public.contractAddress;

    const before = await readAuthority(providers, address);
    console.log(`[deploy+lock] deployed ${address}`);
    console.log(`[deploy+lock] authority at deploy: committee=${before.committeeSize} threshold=${before.threshold}`);

    console.log('[deploy+lock] locking (dissolving the committee — one-way)…');
    await lockContract(providers, address, 1);

    const after = await readAuthority(providers, address);
    if (after.committeeSize !== 0 || after.threshold < 1) {
      throw new Error(
        `lock did not take: committee=${after.committeeSize} threshold=${after.threshold} (expected 0 / >=1)`,
      );
    }

    console.log('\n✅ deployed + LOCKED ShieldedNight (permanently non-upgradeable)');
    console.log(`   address: ${address}`);
    console.log(`   authority: committee=${after.committeeSize} threshold=${after.threshold} counter=${after.counter}`);
    console.log(`\nPaste into frontend/.env:`);
    console.log(`   VITE_CONTRACT_ADDRESS_${env.toUpperCase()}=${address}`);
  } finally {
    await walletCtx.wallet.stop().catch(() => undefined);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('[deploy+lock] failed:', e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  },
);
