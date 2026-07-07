# ConvertVault Frontend — NIGHT ⇄ wNIGHT DEX

A browser dApp for the ConvertVault contract: convert native unshielded **NIGHT**
into the shielded wrapper **wNIGHT** and back. Connects to any `window.midnight[*]`
wallet, reads shielded + unshielded balances, and targets preview / preprod
(mainnet later) via a network dropdown.

Vite + React 18 + TypeScript. Adapted from the `midnight-wallet-dapp` reference.

## Setup

```bash
cd frontend
bun install
cp .env.example .env      # then fill in the deployed contract address(es)
bun run dev               # http://localhost:5173
```

Requires the contract's compiled artifacts at `../src/managed` (run `bun run compact`
in the repo root if missing). Vite serves them at `/contract/compiled/convert-vault`
so the browser proof step can fetch prover/verifier keys.

## Configuration (`.env`)

| Var | Purpose |
| --- | --- |
| `VITE_CONTRACT_ADDRESS_PREVIEW` / `_PREPROD` / `_UNDEPLOYED` | Deployed vault address per network (the dropdown picks which is used). |
| `VITE_WRAPPER_TOKEN_TYPE_*` | Optional. Override the wNIGHT shielded token-type key if the app can't auto-identify it in the wallet's balances. |
| `VITE_PROOF_SERVER_URI` | Optional. Override the proof server; defaults to the `proverServerUri` the connected wallet reports. |

The wallet supplies the indexer / node / proof-server URLs (`getConfiguration()`); the
dApp only needs the contract address per network.

## How it works

Each conversion is **two transactions** with a pool credit keyed by a
client-generated secret held between them. One **Swap** click orchestrates both
legs (two wallet approvals) with a step indicator:

- **NIGHT → wNIGHT**: `depositUnshielded(secret, amount)` → `withdrawShielded(secret, amount, myCoinPublicKey, nonce)`.
- **wNIGHT → NIGHT**: `depositShielded(secret, coin)` → `withdrawUnshielded(secret, coin.value, myAddress)`.

The secret and any minted wrapper coin are persisted to `localStorage`, so an
interrupted swap can be resumed (see the "Unfinished swaps" panel) and minted
wNIGHT can be converted back later.

### Reverse-direction limitation (read this)

The `window.midnight` connector exposes only **aggregate** shielded balances — it
does not reveal individual coins or their nonces. `depositShielded` needs the
exact `ShieldedCoinInfo{nonce, color, value}`. So **wNIGHT → NIGHT works only for
wrapper coins this dApp minted in this browser** (tracked in `localStorage`). The
reverse UI is enabled regardless; if there is no tracked coin it surfaces a clear
error rather than failing silently. Converting arbitrary/received wNIGHT would
require a coin-level wallet API that does not exist today. The reverse swap
converts a whole tracked coin at a time (remainder-free).

## Verify end-to-end (needs a deployed contract + a Midnight wallet)

1. `bun run dev`; install a Midnight wallet extension set to **preview**.
2. Put the preview contract address in `.env`, reload.
3. Click **Connect wallet** (top-right) → approve. Balances panel shows NIGHT + wNIGHT.
4. Enter an amount, **Swap NIGHT → wNIGHT**, approve both prompts → wNIGHT balance rises.
5. Flip direction, **Swap wNIGHT → NIGHT** (converts a dApp-minted coin) → NIGHT rises.

## Build

```bash
bun run typecheck   # tsc --noEmit
bun run build       # vite build → dist/
```

The build bundles the ledger/runtime WASM and copies the contract artifacts. The
ledger WASM is ~10 MB and prover keys are multi-MB — expect a large first load,
cached by the browser afterward.
