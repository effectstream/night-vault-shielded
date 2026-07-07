import { submitCallTx } from '@midnight-ntwrk/midnight-js/contracts';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import {
  CompiledShieldedNight,
  type ShieldedNightProviders,
  rightUserAddress,
  type ShieldedCoinInfo,
} from './contract';
import { bytesToHex } from './tokens';

/**
 * The wallet connector returns addresses/keys as bech32m strings (e.g.
 * `mn_shield-cpk_preview1…`), but the circuits take raw 32-byte values. Parse
 * the bech32m payload to bytes, with a hex fallback for already-raw inputs.
 * (Using ledger's encodeCoinPublicKey/encodeUserAddress here fails on bech32m -
 * "Invalid character 'm' at position 0".)
 */
function addressToBytes(s: string): Uint8Array {
  const t = s.trim();
  const hex = t.replace(/^0x/, '');
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
    return hexToBytes(hex);
  }
  return Uint8Array.from(MidnightBech32m.parse(t).data);
}

export type Direction = 'toShielded' | 'toUnshielded';
export type SwapStep = 'started' | 'deposited' | 'done';

/** A wrapper coin this dApp minted, persisted so it can be burned back later. */
export interface StoredCoin {
  nonceHex: string;
  colorHex: string;
  value: string; // bigint as decimal string
}

/** A swap in progress or interrupted, persisted for recovery. */
export interface PendingSwap {
  id: string;
  direction: Direction;
  secretHex: string;
  amount: string; // bigint as decimal string
  step: SwapStep;
  createdAt: number;
  coin?: StoredCoin; // for reverse swaps
}

export interface SwapCallbacks {
  onStep?: (step: SwapStep, label: string) => void;
  onLog?: (msg: string) => void;
}

const PENDING_KEY = (addr: string) => `cv:pending:${addr}`;
const COINS_KEY = (addr: string) => `cv:coins:${addr}`;

// ---------- crypto / hex ----------

export function randomBytes32(): Uint8Array {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  const m = clean.match(/.{1,2}/g);
  return m ? new Uint8Array(m.map((x) => parseInt(x, 16))) : new Uint8Array();
}

// ---------- localStorage ----------

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export function loadPending(addr: string): PendingSwap[] {
  return readJson<PendingSwap[]>(PENDING_KEY(addr), []);
}

function upsertPending(addr: string, swap: PendingSwap): void {
  const list = loadPending(addr).filter((s) => s.id !== swap.id);
  list.push(swap);
  writeJson(PENDING_KEY(addr), list);
}

export function removePending(addr: string, id: string): void {
  writeJson(
    PENDING_KEY(addr),
    loadPending(addr).filter((s) => s.id !== id),
  );
}

export function loadCoins(addr: string): StoredCoin[] {
  return readJson<StoredCoin[]>(COINS_KEY(addr), []);
}

function addCoin(addr: string, coin: StoredCoin): void {
  const list = loadCoins(addr);
  list.push(coin);
  writeJson(COINS_KEY(addr), list);
}

/** Total wNIGHT (base units) this dApp has tracked as spendable coins. */
export function trackedWrapperTotal(addr: string): bigint {
  return loadCoins(addr).reduce((sum, c) => sum + BigInt(c.value), 0n);
}

// ---------- circuit calls ----------

type Providers = ShieldedNightProviders;

async function call(providers: Providers, contractAddress: string, circuitId: string, args: unknown[]) {
  return submitCallTx(providers as never, {
    compiledContract: CompiledShieldedNight,
    contractAddress,
    circuitId,
    args,
  } as never) as Promise<{ private: { result: unknown } }>;
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3, delayMs = 4000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

const idOf = () => `${Date.now().toString(36)}-${bytesToHex(randomBytes32()).slice(0, 8)}`;

// ---------- flows ----------

export interface ForwardInput {
  providers: Providers;
  contractAddress: string;
  amount: bigint;
  /** Wallet's shielded coin public key string (from getShieldedAddresses). */
  coinPublicKey: string;
}

/**
 * ONE-TX convert NIGHT -> wNIGHT via the atomic `convertToShielded` circuit:
 * one contract call, one wallet approval, no secret/credit. Proven end-to-end
 * on-chain (integration test).
 */
export async function runConvertToShielded(input: ForwardInput, cb: SwapCallbacks = {}): Promise<void> {
  const { providers, contractAddress, amount, coinPublicKey } = input;
  const recipient = { bytes: addressToBytes(coinPublicKey) };
  cb.onStep?.('started', 'Converting NIGHT -> wNIGHT in one transaction…');
  cb.onLog?.('convertToShielded - approve in wallet');
  await call(providers, contractAddress, 'convertToShielded', [amount, recipient, randomBytes32()]);
  cb.onStep?.('done', 'Converted in one transaction ✓');
  cb.onLog?.(`Minted ${amount} wNIGHT (single tx)`);
}

export interface ConvertToUnshieldedInput {
  providers: Providers;
  contractAddress: string;
  amount: bigint;
  unshieldedAddress: string;
  wrapperColorHex: string;
}

/**
 * ONE-TX convert wNIGHT -> NIGHT via the atomic `convertToUnshielded` circuit.
 * The contract receives `amount` wNIGHT (wallet funds + change) and releases
 * `amount` NIGHT to the caller, in a single call/approval.
 */
export async function runConvertToUnshielded(input: ConvertToUnshieldedInput, cb: SwapCallbacks = {}): Promise<void> {
  const { providers, contractAddress, amount, unshieldedAddress, wrapperColorHex } = input;
  if (!wrapperColorHex) throw new Error('Wrapper token color unknown; connect and load balances first.');
  const coin: ShieldedCoinInfo = { nonce: randomBytes32(), color: hexToBytes(wrapperColorHex), value: amount };
  const recipient = rightUserAddress(addressToBytes(unshieldedAddress));
  cb.onStep?.('started', 'Converting wNIGHT -> NIGHT in one transaction…');
  cb.onLog?.('convertToUnshielded - approve in wallet');
  await call(providers, contractAddress, 'convertToUnshielded', [coin, recipient]);
  cb.onStep?.('done', 'Converted in one transaction ✓');
  cb.onLog?.(`Released ${amount} NIGHT (single tx)`);
}

/**
 * NIGHT → wNIGHT: depositUnshielded(secret, amount) then
 * withdrawShielded(secret, amount, myCoinPublicKey, nonce). The minted coin is
 * persisted so it can be converted back later.
 */
export async function runForwardSwap(input: ForwardInput, cb: SwapCallbacks = {}): Promise<StoredCoin> {
  const { providers, contractAddress, amount, coinPublicKey } = input;
  const secret = randomBytes32();
  const secretHex = bytesToHex(secret);
  const swap: PendingSwap = {
    id: idOf(),
    direction: 'toShielded',
    secretHex,
    amount: amount.toString(),
    step: 'started',
    createdAt: Date.now(),
  };
  upsertPending(contractAddress, swap);

  cb.onStep?.('started', 'Locking NIGHT (depositUnshielded)…');
  cb.onLog?.(`depositUnshielded ${amount} - approve in wallet`);
  await call(providers, contractAddress, 'depositUnshielded', [secret, amount]);
  swap.step = 'deposited';
  upsertPending(contractAddress, swap);
  cb.onStep?.('deposited', 'Minting wNIGHT (withdrawShielded)…');

  const nonce = randomBytes32();
  const recipient = { bytes: addressToBytes(coinPublicKey) };
  cb.onLog?.('withdrawShielded - approve in wallet');
  const res = await withRetry(() =>
    call(providers, contractAddress, 'withdrawShielded', [secret, amount, recipient, nonce]),
  );
  const coinInfo = res.private.result as ShieldedCoinInfo;
  const stored: StoredCoin = {
    nonceHex: bytesToHex(coinInfo.nonce),
    colorHex: bytesToHex(coinInfo.color),
    value: coinInfo.value.toString(),
  };
  addCoin(contractAddress, stored);
  removePending(contractAddress, swap.id);
  cb.onStep?.('done', 'Swap complete');
  cb.onLog?.(`Minted ${stored.value} wNIGHT`);
  return stored;
}

export interface ReverseInput {
  providers: Providers;
  contractAddress: string;
  amount: bigint;
  /** Wallet's unshielded address string (from getUnshieldedAddress). */
  unshieldedAddress: string;
  /** The wrapper (wNIGHT) 32-byte token color, hex. */
  wrapperColorHex: string;
}

/**
 * wNIGHT → NIGHT: depositShielded(secret, coin) then
 * withdrawUnshielded(secret, amount, myAddress).
 *
 * `coin.value` is the exact amount to convert. `receiveShielded` makes the
 * contract receive that much wNIGHT; the wallet funds it from the caller's
 * wNIGHT balance and produces the change output during balancing (just like an
 * ordinary shielded send). So any amount up to the wallet's wNIGHT balance
 * works - no coin tracking, no whole-coin rounding.
 */
export async function runReverseSwap(input: ReverseInput, cb: SwapCallbacks = {}): Promise<bigint> {
  const { providers, contractAddress, amount, unshieldedAddress, wrapperColorHex } = input;
  if (!wrapperColorHex) throw new Error('Wrapper token color unknown; connect and load balances first.');

  const secret = randomBytes32();
  const swap: PendingSwap = {
    id: idOf(),
    direction: 'toUnshielded',
    secretHex: bytesToHex(secret),
    amount: amount.toString(),
    step: 'started',
    createdAt: Date.now(),
  };
  upsertPending(contractAddress, swap);

  // The contract receives `amount` wNIGHT; the wallet selects wrapper inputs
  // and makes change. Fresh nonce for the contract's received coin.
  const coin: ShieldedCoinInfo = {
    nonce: randomBytes32(),
    color: hexToBytes(wrapperColorHex),
    value: amount,
  };

  cb.onStep?.('started', 'Sending wNIGHT (depositShielded)…');
  cb.onLog?.('depositShielded - approve in wallet');
  await call(providers, contractAddress, 'depositShielded', [secret, coin]);
  swap.step = 'deposited';
  upsertPending(contractAddress, swap);
  cb.onStep?.('deposited', 'Releasing NIGHT (withdrawUnshielded)…');

  const recipient = rightUserAddress(addressToBytes(unshieldedAddress));
  cb.onLog?.('withdrawUnshielded - approve in wallet');
  await withRetry(() => call(providers, contractAddress, 'withdrawUnshielded', [secret, amount, recipient]));
  removePending(contractAddress, swap.id);
  cb.onStep?.('done', 'Swap complete');
  cb.onLog?.(`Released ${amount} NIGHT`);
  return amount;
}

/**
 * Resume an interrupted swap from its persisted `step`. Only the second leg can
 * be resumed automatically (the first leg's on-chain effect is what we recover).
 */
export async function resumeSwap(
  providers: Providers,
  contractAddress: string,
  swap: PendingSwap,
  coinPublicKey: string,
  unshieldedAddress: string,
  cb: SwapCallbacks = {},
): Promise<void> {
  const secret = hexToBytes(swap.secretHex);
  const amount = BigInt(swap.amount);
  if (swap.direction === 'toShielded') {
    if (swap.step === 'deposited') {
      cb.onStep?.('deposited', 'Resuming: minting wNIGHT…');
      const nonce = randomBytes32();
      const recipient = { bytes: addressToBytes(coinPublicKey) };
      const res = await withRetry(() =>
        call(providers, contractAddress, 'withdrawShielded', [secret, amount, recipient, nonce]),
      );
      const coinInfo = res.private.result as ShieldedCoinInfo;
      addCoin(contractAddress, {
        nonceHex: bytesToHex(coinInfo.nonce),
        colorHex: bytesToHex(coinInfo.color),
        value: coinInfo.value.toString(),
      });
    }
  } else {
    if (swap.step === 'deposited') {
      cb.onStep?.('deposited', 'Resuming: releasing NIGHT…');
      const recipient = rightUserAddress(addressToBytes(unshieldedAddress));
      await withRetry(() => call(providers, contractAddress, 'withdrawUnshielded', [secret, amount, recipient]));
    }
  }
  removePending(contractAddress, swap.id);
  cb.onStep?.('done', 'Resume complete');
}
