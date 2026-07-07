import type { InitialAPI } from '@midnight-ntwrk/dapp-connector-api';

declare global {
  interface Window {
    // Wallets inject themselves under a keyed entry, e.g. window.midnight.mnLace
    midnight?: Record<string, InitialAPI>;
  }
}

export {};
