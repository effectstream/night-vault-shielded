import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { findInitialAPIs, isCompatibleApiVersion } from '../lib/connector';
import { buildProviders } from '../lib/providers';
import type { ConvertVaultProviders } from '../lib/contract';
import {
  contractAddressFor,
  NETWORKS,
  type NetworkOption,
  wrapperTokenTypeOverrideFor,
} from '../lib/networks';
import { deriveWrapperColorHex, nativeNightKeys, pickBalance } from '../lib/tokens';

export interface Balances {
  nativeNight: bigint;
  wrapper: bigint;
  wrapperMatched: boolean;
  allShielded: Record<string, bigint>;
  allUnshielded: Record<string, bigint>;
}

export interface VaultState {
  networkKey: NetworkOption['key'];
  setNetworkKey: (k: NetworkOption['key']) => void;
  contractAddress: string | undefined;

  availableAPIs: InitialAPI[];
  detecting: boolean;

  connecting: boolean;
  connected: boolean;
  walletName?: string;
  connectedAPI?: ConnectedAPI;
  providers?: ConvertVaultProviders;
  coinPublicKey?: string;
  unshieldedAddress?: string;
  networkIdConnected?: string;

  balances?: Balances;
  refreshBalances: () => Promise<void>;

  connect: (api: InitialAPI) => Promise<void>;
  disconnect: () => void;

  logs: string[];
  appendLog: (msg: string) => void;
  error?: string;
}

export function useVault(): VaultState {
  const [networkKey, setNetworkKeyState] = useState<NetworkOption['key']>('preview');
  const [availableAPIs, setAvailableAPIs] = useState<InitialAPI[]>([]);
  const [detecting, setDetecting] = useState(true);

  const [connecting, setConnecting] = useState(false);
  const [connectedAPI, setConnectedAPI] = useState<ConnectedAPI>();
  const [providers, setProviders] = useState<ConvertVaultProviders>();
  const [coinPublicKey, setCoinPublicKey] = useState<string>();
  const [unshieldedAddress, setUnshieldedAddress] = useState<string>();
  const [networkIdConnected, setNetworkIdConnected] = useState<string>();
  const [walletName, setWalletName] = useState<string>();
  const [balances, setBalances] = useState<Balances>();
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string>();

  const appendLog = useCallback((msg: string) => {
    const line = `${new Date().toLocaleTimeString()}  ${msg}`;
    setLogs((prev) => [line, ...prev].slice(0, 200));
  }, []);

  const network = NETWORKS.find((n) => n.key === networkKey)!;
  const contractAddress = contractAddressFor(networkKey);

  // Poll window.midnight for injected wallets.
  useEffect(() => {
    let attempts = 0;
    const id = setInterval(() => {
      const apis = findInitialAPIs();
      if (apis.length > 0) {
        setAvailableAPIs(apis);
        setDetecting(false);
        clearInterval(id);
      } else if (++attempts > 40) {
        setDetecting(false);
        clearInterval(id);
      }
    }, 500);
    return () => clearInterval(id);
  }, []);

  const apiRef = useRef<ConnectedAPI>();
  apiRef.current = connectedAPI;

  const refreshBalances = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    try {
      const [shielded, unshielded] = await Promise.all([api.getShieldedBalances(), api.getUnshieldedBalances()]);
      const native = pickBalance(unshielded, nativeNightKeys());
      const override = wrapperTokenTypeOverrideFor(networkKey);
      const derived = contractAddress ? deriveWrapperColorHex(contractAddress) : null;
      const wrap = pickBalance(shielded, override ? [override] : [], override ?? derived);
      setBalances({
        nativeNight: native?.value ?? 0n,
        wrapper: wrap?.value ?? 0n,
        wrapperMatched: wrap != null,
        allShielded: shielded,
        allUnshielded: unshielded,
      });
    } catch (e) {
      appendLog('Failed to fetch balances: ' + errMsg(e));
    }
  }, [appendLog, contractAddress, networkKey]);

  const setNetworkKey = useCallback((k: NetworkOption['key']) => {
    setNetworkKeyState(k);
    // Reset any existing connection; the wallet must reconnect on the new net.
    setConnectedAPI(undefined);
    setProviders(undefined);
    setBalances(undefined);
    setError(undefined);
  }, []);

  const connect = useCallback(
    async (api: InitialAPI) => {
      setConnecting(true);
      setError(undefined);
      try {
        if (!isCompatibleApiVersion(api.apiVersion)) {
          appendLog(`Warning: wallet API v${api.apiVersion} may be incompatible (built for 4.x).`);
        }
        setNetworkId(network.networkId as never);
        appendLog(`Connecting to ${api.name} on ${network.networkId}…`);
        const connectedApi = await api.connect(network.networkId);
        const config = await connectedApi.getConfiguration();
        setNetworkId(config.networkId as never);
        setNetworkIdConnected(config.networkId);
        appendLog(`Connected. Network ${config.networkId}, indexer ${config.indexerUri}`);

        const [shieldedAddr, unshieldedAddr] = await Promise.all([
          connectedApi.getShieldedAddresses(),
          connectedApi.getUnshieldedAddress(),
        ]);
        const built = await buildProviders(connectedApi);

        setConnectedAPI(connectedApi);
        apiRef.current = connectedApi;
        setProviders(built);
        setCoinPublicKey(shieldedAddr.shieldedCoinPublicKey);
        setUnshieldedAddress(unshieldedAddr.unshieldedAddress);
        setWalletName(api.name);
        await refreshBalances();
      } catch (e) {
        setError(errMsg(e));
        appendLog('Connect failed: ' + errMsg(e));
      } finally {
        setConnecting(false);
      }
    },
    [appendLog, network.networkId, refreshBalances],
  );

  const disconnect = useCallback(() => {
    setConnectedAPI(undefined);
    setProviders(undefined);
    setBalances(undefined);
    setCoinPublicKey(undefined);
    setUnshieldedAddress(undefined);
    setWalletName(undefined);
    appendLog('Disconnected.');
  }, [appendLog]);

  return {
    networkKey,
    setNetworkKey,
    contractAddress,
    availableAPIs,
    detecting,
    connecting,
    connected: !!connectedAPI && !!providers,
    walletName,
    connectedAPI,
    providers,
    coinPublicKey,
    unshieldedAddress,
    networkIdConnected,
    balances,
    refreshBalances,
    connect,
    disconnect,
    logs,
    appendLog,
    error,
  };
}

/**
 * Deep error extraction: walks the `cause` chain and surfaces the connector's
 * DAppConnectorAPIError fields (`code`, `reason`), which often ship with an
 * empty `message` — midnight-js's String(err) wrapper reduces those to a bare
 * "Error" unless unpacked here.
 */
export function errMsg(e: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = e;
  for (let depth = 0; cur != null && depth < 10 && !seen.has(cur); depth++) {
    seen.add(cur);
    if (typeof cur === 'object') {
      const o = cur as { message?: unknown; code?: unknown; reason?: unknown; type?: unknown; cause?: unknown };
      const bits: string[] = [];
      if (typeof o.message === 'string' && o.message && o.message !== 'Error') bits.push(o.message);
      if (typeof o.code === 'string') bits.push(`code=${o.code}`);
      if (typeof o.reason === 'string' && o.reason) bits.push(`reason=${o.reason}`);
      if (bits.length > 0) parts.push(bits.join(' '));
      cur = o.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  if (parts.length === 0) {
    try {
      return e instanceof Error ? e.message : JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  // Innermost causes are the most informative; show the chain outer→inner.
  return parts.join(' ← ');
}
