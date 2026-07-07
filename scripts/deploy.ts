/**
 * Deploy ShieldedNight from THIS repo's compiled build (src/managed), so the
 * on-chain verifier keys match the prover keys the frontend serves. Reuses the
 * same Node wallet-sdk wiring the integration tests deploy with.
 *
 * Usage (a funded, DUST-registered wallet is required for hosted envs):
 *   # from a BIP-39 mnemonic (e.g. exported from Lace) — quote it:
 *   MN_ENV=preview MN_MNEMONIC="word1 word2 … word24" bun run scripts/deploy.ts
 *
 *   # or from a raw hex seed:
 *   MN_ENV=preview MN_SEED=<hex-seed> bun run scripts/deploy.ts
 *
 *   # optional metadata overrides (default: "Wrapped NIGHT" / "wNIGHT" / 6)
 *   CV_NAME="Wrapped NIGHT" CV_SYMBOL=wNIGHT CV_DECIMALS=6 MN_ENV=preview MN_MNEMONIC="…" bun run scripts/deploy.ts
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
  console.log(`[deploy] env=${env}`);
  console.log(`[deploy] proofServer=${network.proofServer} indexer=${network.indexer}`);
  console.log(`[deploy] args: name="${name}" symbol="${symbol}" decimals=${decimals}`);

  console.log('[deploy] building + syncing wallet…');
  const raw = await buildWallet(network, seed);
  const walletCtx = await awaitWalletReady(raw, {
    // Hosted seeds are operator-funded; only block on funds for local genesis.
    requireFunds: env === 'undeployed',
    syncTimeoutMs: DEFAULT_RESTORED_SYNC_TIMEOUT_MS,
  });

  try {
    const { deployFresh, zkConfigPath } = await setupContract(factory, { network, walletCtx });
    console.log(`[deploy] proving against zk keys at: ${zkConfigPath}`);
    console.log('[deploy] deploying (this proves + submits — ~30-90s)…');
    const deployed = await deployFresh([name, symbol, decimals]);
    const address = deployed.deployTxData.public.contractAddress;

    console.log('\n✅ deployed ShieldedNight');
    console.log(`   address: ${address}`);
    console.log(`\nPaste into frontend/.env:`);
    console.log(`   VITE_CONTRACT_ADDRESS_${env.toUpperCase()}=${address}`);
  } finally {
    await walletCtx.wallet.stop().catch(() => undefined);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('[deploy] failed:', e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  },
);
