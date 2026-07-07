import { type UnboundTransaction, type WalletProvider } from '@midnight-ntwrk/midnight-js/types';
import {
  type Binding,
  type CoinPublicKey,
  type EncPublicKey,
  type FinalizedTransaction,
  type Proof,
  type SignatureEnabled,
  Transaction,
} from '@midnight-ntwrk/ledger-v8';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { Cause } from 'effect';
import type { ShieldedAddress } from './providers';

export function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToUint8Array(hex: string): Uint8Array {
  const cleaned = hex.replace(/^0x/, '');
  const matches = cleaned.match(/.{1,2}/g);
  if (!matches) return new Uint8Array();
  return new Uint8Array(matches.map((byte) => parseInt(byte, 16)));
}

/**
 * Rebuild a connector failure into an Error whose message carries the
 * DAppConnectorAPIError diagnostics (`code`, `reason`) — those fields often
 * ship with an empty `message`, which upstream wrappers reduce to "Error".
 */
function describeConnectorError(stage: string, e: unknown): Error {
  const o = (e ?? {}) as { message?: unknown; code?: unknown; reason?: unknown };
  const bits = [
    typeof o.message === 'string' && o.message ? o.message : null,
    typeof o.code === 'string' ? `code=${o.code}` : null,
    typeof o.reason === 'string' && o.reason ? `reason=${o.reason}` : null,
  ].filter(Boolean);
  // A bare `Error` with no fields stringifies uselessly — dump its own props.
  const detail = bits.length ? bits.join(' ') : dumpError(e);
  return new Error(`${stage} failed: ${detail}`, { cause: e });
}

/**
 * Wire the connected wallet as midnight-js's `walletProvider` + `midnightProvider`:
 * transaction balancing is delegated to `balanceUnsealedTransaction` and
 * submission to `submitTransaction`. This is the browser equivalent of the
 * test harness's balanceUnbound→sign→finalize wiring.
 */
export function createWalletProvidersFromConnectedAPI(
  connectedAPI: ConnectedAPI,
  shieldedAddress: ShieldedAddress,
) {
  // The exact hex the wallet returned from balancing. Submission sends THIS
  // string, not a re-serialization of the deserialized tx: if the
  // deserialize→serialize round trip is not byte-identical, signatures over
  // the original bytes would no longer verify and the node/wallet rejects.
  let lastBalancedHex: string | undefined;

  const walletProvider: WalletProvider = {
    getCoinPublicKey(): CoinPublicKey {
      return shieldedAddress.shieldedCoinPublicKey;
    },
    getEncryptionPublicKey(): EncPublicKey {
      return shieldedAddress.shieldedEncryptionPublicKey;
    },
    async balanceTx(tx: UnboundTransaction): Promise<FinalizedTransaction> {
      const serialized = uint8ArrayToHex(tx.serialize());
      let result: { tx: string };
      try {
        result = await connectedAPI.balanceUnsealedTransaction(serialized);
      } catch (e) {
        console.error('[walletAdapter] balanceUnsealedTransaction failed:', e);
        throw describeConnectorError('wallet balancing (balanceUnsealedTransaction)', e);
      }
      lastBalancedHex = result.tx.replace(/^0x/, '');
      const bytes = hexToUint8Array(result.tx);
      return Transaction.deserialize('signature', 'proof', 'binding', bytes) as Transaction<
        SignatureEnabled,
        Proof,
        Binding
      >;
    },
  };

  const midnightProvider = {
    async submitTx(tx: FinalizedTransaction): Promise<string> {
      const reserialized = uint8ArrayToHex(tx.serialize());
      let submitHex = reserialized;
      if (lastBalancedHex) {
        if (lastBalancedHex !== reserialized) {
          console.warn(
            `[walletAdapter] deserialize→serialize round trip NOT byte-identical ` +
              `(balanced ${lastBalancedHex.length / 2}B vs reserialized ${reserialized.length / 2}B); ` +
              `submitting the wallet's original bytes`,
          );
        }
        submitHex = lastBalancedHex;
      }
      // Stash the exact balanced bytes so a failed submission can be replayed
      // directly against the node (bypassing the wallet) to surface the node's
      // own rejection reason, which the connector does not propagate.
      (globalThis as Record<string, unknown>).__cvLastTx = submitHex;
      try {
        await connectedAPI.submitTransaction(submitHex);
      } catch (e) {
        console.error('[walletAdapter] submitTransaction failed:', e, 'dump:', dumpError(e));
        // Dev diagnostic: ship the exact balanced bytes to the dev server so
        // they can be replayed against the node to surface its real reason.
        if (import.meta.env.DEV) {
          void fetch('/debug/last-tx', { method: 'POST', body: submitHex }).catch(() => undefined);
        }
        throw describeConnectorError('wallet submission (submitTransaction)', e);
      } finally {
        lastBalancedHex = undefined;
      }
      return tx.identifiers()[0];
    },
  };

  return { walletProvider, midnightProvider };
}

/**
 * Serialize an unknown error-like object. Understands Effect `FiberFailure`s
 * (what Lace's in-page connector throws): the real failure hides in a
 * symbol-keyed `Cause`, which `Cause.pretty` can render — Effect registers its
 * type IDs via `Symbol.for`, so this works across bundle copies.
 */
function dumpError(e: unknown): string {
  try {
    if (e != null && typeof e === 'object') {
      const causeSym = Object.getOwnPropertySymbols(e).find((s) =>
        String(s.description ?? '').includes('FiberFailure/Cause'),
      );
      if (causeSym) {
        const cause = (e as Record<symbol, unknown>)[causeSym];
        try {
          if (Cause.isCause(cause)) return `FiberFailure: ${Cause.pretty(cause, { renderErrorCause: true })}`;
        } catch {
          /* fall through to deep dump */
        }
        return `FiberFailure cause: ${deepDump(cause)}`;
      }
    }
  } catch {
    /* fall through */
  }
  return deepDump(e);
}

/** Skip huge byte-array-like objects (e.g. serialized txData) — pure noise. */
function isByteBag(v: object): boolean {
  const keys = Object.getOwnPropertyNames(v);
  if (keys.length < 64) return false;
  // Numeric string keys mapping to 0..255 → a serialized buffer, not a message.
  let numeric = 0;
  for (const k of keys.slice(0, 16)) if (/^\d+$/.test(k)) numeric++;
  return numeric >= 12;
}

/** Depth-limited recursive dump including non-enumerable and symbol props. */
function deepDump(v: unknown, depth = 0, seen = new Set<unknown>()): string {
  if (v == null || typeof v !== 'object') return String(v);
  if (seen.has(v) || depth > 4) return '[…]';
  if (isByteBag(v)) return `[${Object.getOwnPropertyNames(v).length} bytes]`;
  seen.add(v);
  const parts: string[] = [];
  for (const k of Object.getOwnPropertyNames(v)) {
    try {
      const val = (v as Record<string, unknown>)[k];
      if (typeof val === 'function') continue;
      parts.push(`${k}: ${typeof val === 'object' ? deepDump(val, depth + 1, seen) : String(val)}`);
    } catch {
      /* skip unreadable */
    }
  }
  for (const s of Object.getOwnPropertySymbols(v)) {
    try {
      const val = (v as Record<symbol, unknown>)[s];
      if (typeof val === 'function') continue;
      parts.push(`[${s.description}]: ${typeof val === 'object' ? deepDump(val, depth + 1, seen) : String(val)}`);
    } catch {
      /* skip unreadable */
    }
  }
  return `{ ${parts.join(', ')} }`;
}
