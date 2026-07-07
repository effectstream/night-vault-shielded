import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { createProofProvider } from '@midnight-ntwrk/midnight-js/types';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import type { BlockHashConfig, BlockHeightConfig } from '@midnight-ntwrk/midnight-js/types';
import type { ContractAddress } from '@midnight-ntwrk/ledger-v8';

import { createWalletProvidersFromConnectedAPI } from './walletAdapter';
import { type ShieldedNightCircuits, type ShieldedNightProviders, ZK_CONFIG_CONTRACT_NAME } from './contract';

export type ShieldedAddress = {
  shieldedAddress: string;
  shieldedCoinPublicKey: string;
  shieldedEncryptionPublicKey: string;
};

/**
 * Assemble the midnight-js provider suite from a connected wallet:
 * - zkConfig: fetched from the served /contract/compiled/shielded-night path
 * - publicData: the wallet's indexer (with a post-block zswap-state refresh)
 * - proof: the WALLET's proving provider - the frontend never names a proof
 *   server (proverServerUri is deprecated in favor of getProvingProvider), so
 *   the wallet owns proving and this works on any deployment.
 * - wallet/midnight: the connected wallet (balance + submit)
 * - privateState: browser leveldb (empty for ShieldedNight, but required)
 */
export async function buildProviders(connectedAPI: ConnectedAPI): Promise<ShieldedNightProviders> {
  const zkConfigBase = window.location.origin + '/contract/compiled/' + ZK_CONFIG_CONTRACT_NAME;
  const zkConfigProvider = new FetchZkConfigProvider<ShieldedNightCircuits>(zkConfigBase, fetch.bind(window));

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

  // Proving is entirely the wallet's domain. The dApp hands over the contract's
  // ZK key material and the WALLET proves, in its own trust boundary - the dApp
  // never names or reaches a proof server (doing so could leak the private
  // witness to a dApp-chosen prover). If a wallet doesn't implement this yet,
  // that's a wallet gap; we surface it rather than working around it.
  if (typeof (connectedAPI as { getProvingProvider?: unknown }).getProvingProvider !== 'function') {
    throw new Error(
      'This wallet does not support dApp proving yet (no getProvingProvider). ' +
        'Proving is wallet-owned by design - update to a wallet build that implements getProvingProvider.',
    );
  }
  const provingProvider = await connectedAPI.getProvingProvider(zkConfigProvider.asKeyMaterialProvider());
  const proofProvider = createProofProvider(provingProvider);

  const shieldedAddress: ShieldedAddress = await connectedAPI.getShieldedAddresses();
  const { walletProvider, midnightProvider } = createWalletProvidersFromConnectedAPI(connectedAPI, shieldedAddress);

  const privateStateProvider = levelPrivateStateProvider({
    privateStoragePasswordProvider: () => 'shielded-night-dapp-storage-password!',
    accountId: shieldedAddress.shieldedAddress,
  });

  return {
    privateStateProvider,
    publicDataProvider,
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider,
  } as unknown as ShieldedNightProviders;
}
