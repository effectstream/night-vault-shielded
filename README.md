# Shielded NIGHT

Convert native **unshielded NIGHT** into **shielded wNIGHT** (a contract-minted wrapper token) and back, on Midnight.

Live (preview): https://shielded-night.pages.dev

## What this is

Two ways to convert, both backed by the same pool of locked NIGHT.

**Atomic - one transaction, one wallet approval (what the live app uses):**

- **Unshielded NIGHT -> shielded wNIGHT:** `convertToShielded(amount, recipient, nonce)` locks NIGHT and mints wNIGHT to you, in a single transaction.
- **Shielded wNIGHT -> unshielded NIGHT:** `convertToUnshielded(coin, recipient)` burns wNIGHT and releases NIGHT to you, in a single transaction.

No secret and no intermediate credit: both value domains net inside one circuit (one ledger segment), which is the only way to combine a shielded and an unshielded move in one transaction. Merging two separate calls can't do it - their intents land in different segments.

**Two-step pool - credit-bridged (the original model, still on-chain):**

You hold a credit balance keyed by `hash(secret)`; deposit in one domain, withdraw in the other:

- `depositUnshielded(secret, amount)` locks NIGHT and credits your key, then `withdrawShielded(secret, amount, ...)` mints wNIGHT and debits it.
- `depositShielded(secret, coin)` burns wNIGHT and credits your key, then `withdrawUnshielded(secret, amount, to)` releases NIGHT and debits it.

`secret` is always a private circuit input; only `hash(secret)` (the balance key) is public. Splitting a conversion into two half-steps decouples them - useful when deposit and withdrawal happen at different times, or the recipient differs from the depositor.

Locked NIGHT backs the wrapper 1:1 across both models - the invariant `locked NIGHT == credits + outstanding wNIGHT` keeps every holder solvent.

## Layout

```
.
├── src/
│   ├── shielded-night.compact        # the Compact contract
│   ├── witnesses.ts                 # private state (none; empty)
│   ├── index.ts                     # package entry
│   └── managed/                     # compiled output: contract, keys, zkir (generated)
├── test/
│   ├── unit/                        # simulator unit tests (+ security, transient)
│   ├── integration/                 # docker-stack tests + global setup
│   └── support/                     # ported midnight-canary harness + contract factory
├── scripts/
│   ├── deploy.ts                    # deploy from src/managed (mnemonic or seed)
│   ├── deploy-and-lock.ts           # deploy, then lock (one-way, non-upgradeable)
│   └── lock.ts                      # lock an already-deployed contract (has DRY_RUN)
├── envs/docker-compose-dynamic.yml  # local node + indexer + proof server
├── frontend/                        # Vite + React dApp
│   └── src/
│       ├── App.tsx
│       ├── components/              # WalletBar, SwapCard, BalancePanel, PendingSwaps, ActivityLog
│       ├── hooks/useShieldedNight.ts        # connect, providers, balances, state
│       └── lib/                     # connector, providers, walletAdapter, contract, swap, tokens, networks
├── .github/workflows/ci.yml         # unit + integration CI
├── TESTING.md
└── README.md
```

## How to run

The frontend is a Vite + React app that connects to any `window.midnight` wallet (e.g. Lace), reads your NIGHT/wNIGHT balances, and runs the atomic one-transaction swaps (one wallet approval each way). Proving is delegated to the wallet.

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

# or deploy and immediately lock it (dissolve the maintenance committee -
# permanently non-upgradeable, one-way):
MN_ENV=preview MN_MNEMONIC="your phrase" bun run scripts/deploy-and-lock.ts
```

## Locking the contract

Every Midnight contract has a **maintenance authority** - a committee of keys allowed to change its rules (e.g. swap out a circuit's verifier key). On a fresh deploy that committee is just the deployer (1-of-1), so the deployer can still alter the contract after the fact. For a trustless release you remove that power.

Locking installs an **empty committee at threshold 1**. No signature set can ever satisfy an empty committee, so no future maintenance update can be authorized - the contract is permanently frozen. Both scripts re-read the on-chain authority and verify `committee=0` before reporting success.

- `scripts/deploy-and-lock.ts` - deploy and lock in one shot.
- `scripts/lock.ts` - lock a contract that's already deployed (e.g. one you deployed and tested live first). Run it with `DRY_RUN=1` first to confirm the maintenance signing key is present and the contract is lockable without submitting anything:

  ```bash
  DRY_RUN=1 MN_ENV=preview MN_MNEMONIC="your phrase" CV_ADDRESS=<hex> bun run scripts/lock.ts
  MN_ENV=preview MN_MNEMONIC="your phrase" CV_ADDRESS=<hex> bun run scripts/lock.ts
  ```

  Locking needs the maintenance signing key generated at deploy time, so run it with the **same wallet you deployed with** (the key lives in this machine's `midnight-level-db`).

- **Locked = un-upgradeable, not disabled.** All circuits keep working; only the rules can never change. Users can rely on the code (and the solvency invariant) never shifting under them.
- **It is a one-way door.** A locked contract can't be unlocked. To change anything, deploy a fresh instance and point `frontend/.env` at the new address.

The live preview contract is locked. To iterate, deploy a fresh instance and repoint the frontend.

## How to run tests

Two tiers (details and env vars in [TESTING.md](TESTING.md)):

```bash
bun run compact:fast && bun run test:unit     # simulator unit tests, no infra, seconds
bun run compact && bun run test:integration   # docker stack: node + indexer + proof server, minutes
```

Unit tests run every circuit against an in-memory context, including security and border cases for both the atomic and two-step paths. Integration tests deploy to a local stack and cover the full round trip both directions (atomic and two-step), negative paths, on-chain attack vectors (forged, inflated, and double-spent coins; nonce-replay minting; the solvency invariant), multi-party circulation, and the maintenance-authority lock. CI runs both tiers on every push (`.github/workflows/ci.yml`).
