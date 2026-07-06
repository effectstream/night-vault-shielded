import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerComposeEnvironment, type StartedDockerComposeEnvironment, Wait } from 'testcontainers';

const ENVS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'envs');
const STARTUP_TIMEOUT_MS = 5 * 60 * 1000;

export interface UndeployedStack {
  readonly proofServer: string;
  readonly node: string;
  readonly indexer: string;
  readonly indexerWS: string;
  readonly stop: () => Promise<void>;
}

export interface RemoteProofServer {
  readonly proofServer: string;
  readonly stop: () => Promise<void>;
}

// Compose auto-names containers `<service>-1` when no explicit container_name is set.
// testcontainers' getContainer/withWaitStrategy both key by that docker container name.
const containerName = (service: string): string => `${service}-1`;

// proof-server's image is distroless (no curl/sh) so its YAML healthcheck would
// always fail; we wait on the listening port instead. indexer/node ship working
// healthchecks, so we wait on those.
type WaitMode = 'healthcheck' | 'listening';

const waitStrategyFor = (mode: WaitMode) => (mode === 'healthcheck' ? Wait.forHealthCheck() : Wait.forListeningPorts());

// Image tags in the compose files use `${NODE_TAG:-default}` etc. so the version canary can float one infra image at a
// time. Pass through whichever of these are set so compose substitutes them; an unset one falls back to the compose
// default. version-manifest.ts resolves the same defaults, so the captured manifest records the tag that actually ran.
const INFRA_TAG_VARS = ['NODE_TAG', 'INDEXER_TAG', 'PROOF_TAG'] as const;

const infraImageEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of INFRA_TAG_VARS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
};

const startCompose = (
  composeFile: string,
  services: ReadonlyArray<readonly [service: string, wait: WaitMode]>,
): Promise<StartedDockerComposeEnvironment> => {
  let env = new DockerComposeEnvironment(ENVS_DIR, composeFile)
    .withEnvironment(infraImageEnv())
    .withStartupTimeout(STARTUP_TIMEOUT_MS);
  for (const [service, mode] of services) {
    env = env.withWaitStrategy(containerName(service), waitStrategyFor(mode));
  }
  return env.up();
};

const stopper = (env: StartedDockerComposeEnvironment) => async (): Promise<void> => {
  await env.down().catch(() => undefined);
};

/** Spin up proof-server + indexer + node for an `undeployed` local devnet run. */
export const startUndeployedStack = async (): Promise<UndeployedStack> => {
  const env = await startCompose('docker-compose-dynamic.yml', [
    ['proof-server', 'listening'],
    ['indexer', 'healthcheck'],
    ['node', 'healthcheck'],
  ]);

  const proofPort = env.getContainer(containerName('proof-server')).getMappedPort(6300);
  const indexerPort = env.getContainer(containerName('indexer')).getMappedPort(8088);
  const nodePort = env.getContainer(containerName('node')).getMappedPort(9944);

  return {
    proofServer: `http://127.0.0.1:${proofPort}`,
    node: `http://127.0.0.1:${nodePort}`,
    indexer: `http://127.0.0.1:${indexerPort}/api/v4/graphql`,
    indexerWS: `ws://127.0.0.1:${indexerPort}/api/v4/graphql/ws`,
    stop: stopper(env),
  };
};

/** Spin up a proof-server only — for runs against a hosted network (preprod/preview). */
export const startProofServerOnly = async (): Promise<RemoteProofServer> => {
  const env = await startCompose('docker-compose-remote-dynamic.yml', [['proof-server', 'listening']]);
  const proofPort = env.getContainer(containerName('proof-server')).getMappedPort(6300);
  return {
    proofServer: `http://127.0.0.1:${proofPort}`,
    stop: stopper(env),
  };
};
