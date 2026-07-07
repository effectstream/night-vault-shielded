import * as ledger from '@midnight-ntwrk/ledger-v8';

export const DECIMALS = 6;
const SCALE = 10n ** BigInt(DECIMALS);

/** Format a base-unit bigint (Stars) as a decimal NIGHT string. */
export function formatAmount(v: bigint, decimals = DECIMALS): string {
  const scale = 10n ** BigInt(decimals);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${frac ? '.' + frac : ''}`;
}

/** Parse a decimal NIGHT string into base units (Stars). Throws on malformed input. */
export function parseAmount(input: string, decimals = DECIMALS): bigint {
  const s = input.trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') {
    throw new Error(`Invalid amount: "${input}"`);
  }
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole || '0') * scale + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Candidate map keys for native NIGHT in getUnshieldedBalances(). */
export function nativeNightKeys(): string[] {
  const keys = new Set<string>();
  try {
    keys.add(ledger.nativeToken().raw.toLowerCase());
  } catch {
    /* ignore */
  }
  try {
    keys.add(ledger.unshieldedToken().raw.toLowerCase());
  } catch {
    /* ignore */
  }
  return [...keys];
}

/**
 * Best-effort derivation of the wrapper (wNIGHT) shielded token color from the
 * contract address, matching the contract's `tokenType(pad(32,"mip12:shielded-wrapper"), self())`.
 * Returns the raw hex, or null if the SDK shape prevents derivation (the UI
 * falls back to showing the full shielded-balance map).
 */
export function deriveWrapperColorHex(contractAddress: string): string | null {
  try {
    const domain = new Uint8Array(32);
    domain.set(new TextEncoder().encode('mip12:shielded-wrapper'));
    // rawTokenType(domainSep, contract) mirrors the contract's tokenType(...).
    const raw = (ledger as unknown as {
      rawTokenType: (d: Uint8Array, c: string) => string;
    }).rawTokenType(domain, contractAddress);
    return typeof raw === 'string' ? raw.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Find the balance for a token given a set of exact candidate keys and an
 * optional substring to match (handles the connector's token-type prefixing).
 */
export function pickBalance(
  balances: Record<string, bigint>,
  exactKeys: string[],
  substring?: string | null,
): { key: string; value: bigint } | null {
  const lowerMap = new Map<string, bigint>();
  for (const [k, v] of Object.entries(balances)) lowerMap.set(k.toLowerCase(), v);
  for (const k of exactKeys) {
    const hit = lowerMap.get(k.toLowerCase());
    if (hit !== undefined) return { key: k, value: hit };
  }
  if (substring) {
    const sub = substring.toLowerCase().replace(/^0x/, '');
    for (const [k, v] of lowerMap) {
      if (k.replace(/^0x/, '').includes(sub) || sub.includes(k.replace(/^0x/, ''))) {
        return { key: k, value: v };
      }
    }
  }
  return null;
}

export { SCALE };
