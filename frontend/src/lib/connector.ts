import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';

/**
 * Enumerate the wallet APIs injected under `window.midnight[*]`. Each keyed
 * entry (e.g. `window.midnight.mnLace`) is a candidate `InitialAPI`; we
 * duck-type it to ignore anything that doesn't implement the connector shape.
 */
export function findInitialAPIs(): InitialAPI[] {
  const midnight = window.midnight;
  if (!midnight) return [];
  const apis: InitialAPI[] = [];
  for (const key of Object.keys(midnight)) {
    const c = midnight[key] as Partial<InitialAPI> | undefined;
    if (
      c &&
      typeof c === 'object' &&
      typeof c.name === 'string' &&
      typeof c.icon === 'string' &&
      typeof c.apiVersion === 'string' &&
      typeof c.connect === 'function'
    ) {
      apis.push(c as InitialAPI);
    }
  }
  return apis;
}

/** True when the wallet's apiVersion is compatible with the 4.x connector we build against. */
export function isCompatibleApiVersion(apiVersion: string): boolean {
  return /^4\./.test(apiVersion);
}

export async function connectWallet(api: InitialAPI, networkId: string): Promise<ConnectedAPI> {
  return api.connect(networkId);
}

export function shortHex(hex: string, head = 8, tail = 6): string {
  const clean = hex.replace(/^0x/, '');
  if (clean.length <= head + tail) return hex;
  return `${clean.slice(0, head)}…${clean.slice(-tail)}`;
}
