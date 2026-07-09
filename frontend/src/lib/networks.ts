/**
 * Supported networks. `networkId` is the string hinted to the wallet's
 * `connect(networkId)` and also fed to midnight-js `setNetworkId`. The contract
 * address is read from one env var per network (`<NETWORK>_ADDRESS`, exposed
 * via vite.config's `envPrefix`), so the same build works across networks.
 * The wrapper (sNight) token type is always derived from the address.
 */
export interface NetworkOption {
  key: 'preview' | 'preprod' | 'mainnet' | 'undeployed';
  label: string;
  networkId: string;
}

export const NETWORKS: NetworkOption[] = [
  { key: 'preview', label: 'Preview', networkId: 'preview' },
  { key: 'preprod', label: 'PreProd', networkId: 'preprod' },
  { key: 'mainnet', label: 'Mainnet', networkId: 'mainnet' },
  { key: 'undeployed', label: 'Local (undeployed)', networkId: 'undeployed' },
];

const CONTRACT_ADDRESSES: Record<NetworkOption['key'], string | undefined> = {
  preview: import.meta.env.PREVIEW_ADDRESS,
  preprod: import.meta.env.PREPROD_ADDRESS,
  mainnet: import.meta.env.MAINNET_ADDRESS,
  undeployed: import.meta.env.UNDEPLOYED_ADDRESS,
};

export const contractAddressFor = (key: NetworkOption['key']): string | undefined => {
  const v = CONTRACT_ADDRESSES[key];
  return v && v.trim().length > 0 ? v.trim() : undefined;
};

/** Midnight explorer base per network (only where known; undeployed has none). */
const EXPLORER_BASE: Record<NetworkOption['key'], string | undefined> = {
  preview: 'https://preview.midnightexplorer.com',
  preprod: undefined,
  mainnet: undefined,
  undeployed: undefined,
};

/** Explorer URL for a contract, or undefined if that network has no explorer. */
export const explorerContractUrl = (key: NetworkOption['key'], address: string): string | undefined => {
  const base = EXPLORER_BASE[key];
  return base ? `${base}/contracts/0x${address.replace(/^0x/, '')}` : undefined;
};

/**
 * Networks that actually have a deployed contract configured. The dropdown
 * shows only these, so unconfigured networks (e.g. preprod, mainnet) appear
 * the moment their <NETWORK>_ADDRESS env var is set - no code change needed.
 */
export const configuredNetworks = (): NetworkOption[] => {
  const live = NETWORKS.filter((n) => contractAddressFor(n.key) !== undefined);
  return live.length > 0 ? live : NETWORKS.filter((n) => n.key === 'preview');
};
