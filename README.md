# ConvertVault

Convert native **unshielded NIGHT** into **shielded wNIGHT** (a contract-minted wrapper token) and back, on Midnight.

Live (preview): https://convert-vault.pages.dev

## What this is

A wallet can't do a combined shielded/unshielded transfer in a single call, so ConvertVault splits each conversion into two single-domain steps against a pool. You hold a credit balance keyed by `hash(secret)`:

- **Unshielded NIGHT -> shielded wNIGHT:** `depositUnshielded(secret, amount)` locks NIGHT and credits your key, then `withdrawShielded(secret, amount, ...)` mints wNIGHT to you and debits it.
- **Shielded wNIGHT -> unshielded NIGHT:** `depositShielded(secret, coin)` burns wNIGHT and credits your key, then `withdrawUnshielded(secret, amount, to)` releases NIGHT and debits it.

`secret` is always a private circuit input; only `hash(secret)` (the balance key) is public. Locked NIGHT backs the wrapper 1:1 - the invariant `locked NIGHT == credits + outstanding wNIGHT` keeps every holder solvent.

## Layout

```
.
├── src/
│   ├── convert-vault.compact        # the Compact contract
│   ├── witnesses.ts                 # private state (none; empty)
│   ├── index.ts                     # package entry
│   └── managed/                     # compiled output: contract, keys, zkir (generated)
├── test/
│   ├── unit/                        # simulator unit tests (+ security, transient)
│   ├── integration/                 # docker-stack tests + global setup
│   └── support/                     # ported midnight-canary harness + contract factory
├── scripts/deploy.ts                # deploy from src/managed (mnemonic or seed)
├── envs/docker-compose-dynamic.yml  # local node + indexer + proof server
├── frontend/                        # Vite + React dApp
│   └── src/
│       ├── App.tsx
│       ├── components/              # WalletBar, SwapCard, BalancePanel, PendingSwaps, ActivityLog
│       ├── hooks/useVault.ts        # connect, providers, balances, state
│       └── lib/                     # connector, providers, walletAdapter, contract, swap, tokens, networks
├── .github/workflows/ci.yml         # unit + integration CI
├── TESTING.md
└── README.md
```

## How to run

The frontend is a Vite + React app that connects to any `window.midnight` wallet (e.g. Lace), reads your NIGHT/wNIGHT balances, and runs the two-step swaps. Proving is delegated to the wallet.

```bash
cd frontend
bun install
cp .env.example .env     # set VITE_CONTRACT_ADDRESS_PREVIEW to your deployed contract
bun run dev              # http://localhost:5173
```

Needs a Midnight wallet extension and the compiled artifacts in `src/managed/` (run `bun run compact` at the repo root if missing). Deploy details and the wallet-proving model are in [frontend/README.md](frontend/README.md).

Deploy a contract (needs a funded, DUST-registered wallet):

```bash
MN_ENV=preview MN_MNEMONIC="your phrase" bun run scripts/deploy.ts
```

## How to run tests

Two tiers (details and env vars in [TESTING.md](TESTING.md)):

```bash
bun run compact:fast && bun run test:unit     # simulator unit tests, no infra, seconds
bun run compact && bun run test:integration   # docker stack: node + indexer + proof server, minutes
```

Unit tests run every circuit against an in-memory context, including security and border cases. Integration tests deploy to a local stack and cover the full round trip both directions, negative paths, multi-party circulation, and the maintenance-authority lock. CI runs both tiers on every push (`.github/workflows/ci.yml`).
