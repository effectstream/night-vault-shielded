import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startProofServerOnly, startUndeployedStack } from '../support/local-stack.js';
import { ENV_NAMES, isEnvName, networkFor, type EnvName, type NetworkConfig } from '../support/network.js';

export default async function setup(): Promise<() => Promise<void>> {
  const raw = process.env.MN_ENV ?? 'undeployed';
  if (!isEnvName(raw)) throw new Error(`Invalid MN_ENV "${raw}". Use ${ENV_NAMES.join(' | ')}.`);
  const env: EnvName = raw;

  // Load .env.<env> like the CLI does (cli/src/index.ts) so `yarn smoke` against
  // a hosted env picks up MN_SEED without it being exported. loadEnvFile does NOT
  // override vars already in the environment, so an inline/exported MN_SEED wins.
  const envFile = resolve(process.cwd(), `.env.${env}`);
  if (env !== 'undeployed' && existsSync(envFile)) process.loadEnvFile(envFile);

  if (env !== 'undeployed' && !process.env.MN_SEED) {
    throw new Error(`MN_SEED is required for MN_ENV=${env}.`);
  }

  const base = networkFor(env);
  let stop: () => Promise<void>;
  let network: NetworkConfig;

  if (env === 'undeployed') {
    console.log('[vitest] starting undeployed stack (proof + indexer + node)…');
    const stack = await startUndeployedStack();
    network = {
      ...base,
      proofServer: stack.proofServer,
      node: stack.node,
      indexer: stack.indexer,
      indexerWS: stack.indexerWS,
    };
    stop = stack.stop;
  } else {
    console.log(`[vitest] starting local proof-server for ${env}…`);
    const ps = await startProofServerOnly();
    network = { ...base, proofServer: ps.proofServer };
    stop = ps.stop;
  }

  console.log(`[vitest] network ready: proof=${network.proofServer} indexer=${network.indexer}`);

  process.env.__MN_ENV__ = env;
  process.env.__MN_CFG__ = JSON.stringify(network);

  return async () => {
    console.log('[vitest] tearing down stack…');
    await stop().catch((e) => console.warn('[vitest] stop failed:', e));
  };
}
