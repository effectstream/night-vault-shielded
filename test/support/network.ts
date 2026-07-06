export interface NetworkConfig {
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly proofServer: string;
  readonly networkId: string;
}

export const UndeployedNetwork: NetworkConfig = {
  indexer: 'http://127.0.0.1:8088/api/v4/graphql',
  indexerWS: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
  node: 'http://127.0.0.1:9944',
  proofServer: 'http://127.0.0.1:6300',
  networkId: 'undeployed',
};

export const PreprodNetwork: NetworkConfig = {
  indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
  node: 'https://rpc.preprod.midnight.network',
  proofServer: 'http://127.0.0.1:6300',
  networkId: 'preprod',
};

export const PreviewNetwork: NetworkConfig = {
  indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  node: 'https://rpc.preview.midnight.network',
  proofServer: 'http://127.0.0.1:6300',
  networkId: 'preview',
};

export const QanetNetwork: NetworkConfig = {
  indexer: 'https://indexer.qanet.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.qanet.midnight.network/api/v4/graphql/ws',
  node: 'https://rpc.qanet.midnight.network',
  proofServer: 'http://127.0.0.1:6300',
  networkId: 'qanet',
};

/**
 * Every valid environment name — the SINGLE SOURCE OF TRUTH. `EnvName`, `isEnvName`, and all MN_ENV / `--env`
 * validation derive from this, so adding an env is a one-line change here. (Previously each call site had its own
 * hardcoded list; a missed one broke `qanet` hosted-smoke at vitest global setup.)
 */
export const ENV_NAMES = ['undeployed', 'preprod', 'preview', 'qanet'] as const;
export type EnvName = (typeof ENV_NAMES)[number];

/** Type guard for {@link EnvName}. */
export const isEnvName = (s: string): s is EnvName => (ENV_NAMES as readonly string[]).includes(s);

export const networkFor = (env: EnvName): NetworkConfig => {
  switch (env) {
    case 'undeployed':
      return UndeployedNetwork;
    case 'preprod':
      return PreprodNetwork;
    case 'preview':
      return PreviewNetwork;
    case 'qanet':
      return QanetNetwork;
  }
};

// Genesis-block-funded seed; only valid on undeployed (dev) networks.
export const GENESIS_MINT_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

/**
 * Pre-funded seeds on the local `undeployed` devnet: the genesis block mints NIGHT to the first three accounts derived
 * from these seeds, so any test that needs >1 funded wallet on undeployed can use them without an extra fund-transfer
 * step. NOT valid on hosted networks (preprod/preview).
 */
export const GENESIS_FUNDED_SEEDS = {
  alice: '0000000000000000000000000000000000000000000000000000000000000001',
  bob: '0000000000000000000000000000000000000000000000000000000000000002',
  claire: '0000000000000000000000000000000000000000000000000000000000000003',
} as const;

export type GenesisFundedSeedName = keyof typeof GENESIS_FUNDED_SEEDS;
