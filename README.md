# ConvertVault — two-step convertible-balance pool (hash-keyed)

A convertible-balance pool that sidesteps the wallet SDK's "no combined
shielded↔unshielded call" limitation by making **every circuit single-domain**.
A user holds a credit balance keyed by `hash(secret)`; they deposit in either
domain to add credit and withdraw in either domain to remove it.

```
balance[hash(secret)] = (deposited unshielded + deposited shielded, burnt)
                      -  (withdrawn unshielded   + withdrawn shielded, minted)
```

| Circuit | Domain | Effect |
| --- | --- | --- |
| `depositUnshielded(secret, amount)` | unshielded only | lock native NIGHT → credit `balance` |
| `withdrawShielded(secret, amount)` | shielded only | mint wrapper to caller ← debit `balance` |
| `depositShielded(secret, coin)` | shielded only | burn wrapper → credit `balance` |
| `withdrawUnshielded(secret, amount, to)` | unshielded only | release native NIGHT ← debit `balance` |

- **Convert unshielded → shielded** = `depositUnshielded` then `withdrawShielded` (two calls).
- **Convert shielded → unshielded** = `depositShielded` then `withdrawUnshielded` (two calls).
- The `secret` is always a private circuit input; only `hash(secret)` is public
  (the balance key). Deposits and withdrawals to the same key are on-chain
  linkable — a first, simple privacy model (a nullifier scheme would unlink them).

The underlying is native NIGHT (created outside the contract); the shielded side is
a contract-minted wrapper, color `tokenType("night-vault:shielded-wrapper", self())`. Locked NIGHT
backs unshielded withdrawals; the wrapper is elastic (mint on withdraw, burn on
deposit). A single-user A-then-B round trip is self-funding: the NIGHT locked by
`depositUnshielded` is the reserve `withdrawUnshielded` later draws from.

## Build

```bash
bun run --filter @zswap-da/contract-convert-vault compact
# → managed/{contract,keys,zkir} for all 4 circuits
```

Compiles with `compactc` 0.30.0 (language ≥ 0.20).

## Testing

Two tiers — see [TESTING.md](TESTING.md) for details and environment variables:

```bash
bun run compact:fast && bun run test:unit   # 23 simulator tests, no infrastructure, <1s
bun run compact && bun run test:integration # 8 tests against a real docker stack (~12 min)
```

The integration suite (midnight-canary harness: midnight-node 1.0.0, indexer
4.3.3, proof-server 8.1.0, genesis wallets) covers the full round trip in both
directions, the negative paths, and two-wallet independence. CI runs both
tiers on every push/PR (`.github/workflows/ci.yml`).

## Live status (undeployed network, node 0.22.5) — ✅ FULL ROUND TRIP PASSES

Run (force the genesis wallet — the repo `.env` sets a non-genesis mnemonic):

```bash
MIDNIGHT_NETWORK_ID=undeployed \
MIDNIGHT_WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001 \
MIDNIGHT_STORAGE_PASSWORD=YourPasswordMy1! \
  bun packages/contracts-midnight/convert-vault-e2e.ts
```

Verified live, every check green:

```
✅ deploy; initial balance == 0, wrapper == 0
✅ depositUnshielded(N)  → balance == N,  wrapper == 0
✅ withdrawShielded(N)   → coin value N, balance == 0, wrapper == N
✅ depositShielded(coin) → balance == N, wrapper == 0
✅ withdrawUnshielded(N) → balance == 0, wrapper == 0
✅ FULL TWO-STEP ROUND TRIP PASSED (unshielded↔shielded, both directions)
```

### The balancing fix

The earlier `Custom error: 138` (`BalanceCheckOverspend`) on `depositUnshielded`
was **provider wiring, not the contract**. effectstream's default
`WalletProvider.balanceTx` did `tx.bind()` and then `balanceFinalizedTransaction`
— binding locks the transaction structure, so the wallet can't attach the
unshielded UTXO input the contract's `receiveUnshielded` needs. The e2e overrides
`balanceTx` with canary's pattern (`balanceUnboundTransaction` → `signRecipe` →
`finalizeRecipe`), which balances the **unbound** tx so unshielded inputs are
scanned, attached, and signed before binding. (Pure-shielded calls worked either
way, which is why `withdrawShielded` never hit this.)

This two-step, single-domain design is why it works end-to-end: each circuit
touches only one value domain, so the atomic **combined** shielded↔unshielded call
(which the wallet SDK still rejects — see `contract-shield-vault`) is never needed.
