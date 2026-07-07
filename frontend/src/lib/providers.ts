import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { createProofProvider } from '@midnight-ntwrk/midnight-js/types';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import type { BlockHashConfig, BlockHeightConfig } from '@midnight-ntwrk/midnight-js/types';
import type { ContractAddress } from '@midnight-ntwrk/ledger-v8';

import { createWalletProvidersFromConnectedAPI } from './walletAdapter';
import { type ConvertVaultCircuits, type ConvertVaultProviders, ZK_CONFIG_CONTRACT_NAME } from './contract';

export type ShieldedAddress = {
  shieldedAddress: string;
  shieldedCoinPublicKey: string;
  shieldedEncryptionPublicKey: string;
};

/**
 * Assemble the midnight-js provider suite from a connected wallet:
 * - zkConfig: fetched from the served /contract/compiled/convert-vault path
 * - publicData: the wallet's indexer (with a post-block zswap-state refresh)
 * - proof: the WALLET's proving provider - the frontend never names a proof
 *   server (proverServerUri is deprecated in favor of getProvingProvider), so
 *   the wallet owns proving and this works on any deployment.
 * - wallet/midnight: the connected wallet (balance + submit)
 * - privateState: browser leveldb (empty for ConvertVault, but required)
 */
export async function buildProviders(connectedAPI: ConnectedAPI): Promise<ConvertVaultProviders> {
  const zkConfigBase = window.location.origin + '/contract/compiled/' + ZK_CONFIG_CONTRACT_NAME;
  const zkConfigProvider = new FetchZkConfigProvider<ConvertVaultCircuits>(zkConfigBase, fetch.bind(window));

  const config = await connectedAPI.getConfiguration();

  const rawPublicDataProvider = indexerPublicDataProvider(config.indexerUri, config.indexerWsUri);
  const publicDataProvider = {
    ...rawPublicDataProvider,
    async queryZSwapAndContractState(addr: ContractAddress, q?: BlockHeightConfig | BlockHashConfig) {
      const result = await rawPublicDataProvider.queryZSwapAndContractState(addr, q);
      if (!result) return result;
      const [zswapChainState, contractState, ledgerParameters] = result;
      return [zswapChainState.postBlockUpdate(new Date()), contractState, ledgerParameters] as typeof result;
    },
  };

  // Proving is delegated entirely to the wallet: hand it the ZK key material
  // and it produces proofs against whatever proof server IT is configured with.
  const provingProvider = await connectedAPI.getProvingProvider(zkConfigProvider.asKeyMaterialProvider());
  const proofProvider = createProofProvider(provingProvider);

  const shieldedAddress: ShieldedAddress = await connectedAPI.getShieldedAddresses();
  const { walletProvider, midnightProvider } = createWalletProvidersFromConnectedAPI(connectedAPI, shieldedAddress);

  const privateStateProvider = levelPrivateStateProvider({
    privateStoragePasswordProvider: () => 'convert-vault-dapp-storage-password!',
    accountId: shieldedAddress.shieldedAddress,
  });

  return {
    privateStateProvider,
    publicDataProvider,
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider,
  } as unknown as ConvertVaultProviders;
}
