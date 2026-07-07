/**
 * Supported networks. `networkId` is the string hinted to the wallet's
 * `connect(networkId)` and also fed to midnight-js `setNetworkId`. The contract
 * address and (optional) wrapper token type are read from Vite env vars per
 * network, so the same build works across preview / preprod / local.
 */
export interface NetworkOption {
  key: 'preview' | 'preprod' | 'undeployed';
  label: string;
  networkId: string;
}

export const NETWORKS: NetworkOption[] = [
  { key: 'preview', label: 'Preview', networkId: 'preview' },
  { key: 'preprod', label: 'PreProd', networkId: 'preprod' },
  { key: 'undeployed', label: 'Local (undeployed)', networkId: 'undeployed' },
];

const CONTRACT_ADDRESSES: Record<NetworkOption['key'], string | undefined> = {
  preview: import.meta.env.VITE_CONTRACT_ADDRESS_PREVIEW,
  preprod: import.meta.env.VITE_CONTRACT_ADDRESS_PREPROD,
  undeployed: import.meta.env.VITE_CONTRACT_ADDRESS_UNDEPLOYED,
};

const WRAPPER_TOKEN_TYPES: Record<NetworkOption['key'], string | undefined> = {
  preview: import.meta.env.VITE_WRAPPER_TOKEN_TYPE_PREVIEW,
  preprod: import.meta.env.VITE_WRAPPER_TOKEN_TYPE_PREPROD,
  undeployed: import.meta.env.VITE_WRAPPER_TOKEN_TYPE_UNDEPLOYED,
};

export const contractAddressFor = (key: NetworkOption['key']): string | undefined => {
  const v = CONTRACT_ADDRESSES[key];
  return v && v.trim().length > 0 ? v.trim() : undefined;
};

/**
 * Networks that actually have a deployed contract configured. The dropdown
 * shows only these, so unconfigured networks (e.g. preprod) appear the moment
 * their VITE_CONTRACT_ADDRESS_* is set — no code change needed.
 */
export const configuredNetworks = (): NetworkOption[] => {
  const live = NETWORKS.filter((n) => contractAddressFor(n.key) !== undefined);
  return live.length > 0 ? live : NETWORKS.filter((n) => n.key === 'preview');
};

export const wrapperTokenTypeOverrideFor = (key: NetworkOption['key']): string | undefined => {
  const v = WRAPPER_TOKEN_TYPES[key];
  return v && v.trim().length > 0 ? v.trim().toLowerCase() : undefined;
};
