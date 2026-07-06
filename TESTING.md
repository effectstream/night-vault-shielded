# Testing

Two tiers, modeled on the OpenZeppelin compact-contracts and midnight-canary
reference suites:

| Tier | What runs | Infrastructure | Wall clock |
| --- | --- | --- | --- |
| Unit (simulator) | Every circuit against an in-memory `CircuitContext` | none | seconds |
| Integration (docker) | Real deploys + balanced transactions via a genesis wallet | docker: node, indexer, proof server | minutes |

## Prerequisites

- Node 22+ (vitest runs under Node; bun is the package manager)
- `bun install`
- The `compact` CLI (the scripts pin compiler `0.31.1`)
- Docker running (integration tier only)

## Unit tests

```bash
bun run compact:fast   # compile contract JS only (--skip-zk, no prover keys)
bun run test:unit
```

The simulator ([test/unit/simulators/ConvertVaultSimulator.ts](test/unit/simulators/ConvertVaultSimulator.ts))
executes the compiled circuits directly: state assertions are exact and failed
calls throw the contract's `assert` messages. Token movements are recorded as
transaction effects, not balanced against a real ledger — that's the
integration tier's job.

## Integration tests

```bash
bun run compact        # full compile including prover/verifier keys
bun run test:integration
```

`test/integration/global-setup.ts` boots the docker stack
(`envs/docker-compose-dynamic.yml`: midnight-node 1.0.0, indexer-standalone
4.3.3, proof-server 8.1.0) via testcontainers, then the suite deploys the
vault with the genesis wallet and runs the full README round trip
(depositUnshielded → withdrawShielded → depositShielded → withdrawUnshielded),
the negative paths, and a two-wallet independence test.

The first run pulls the images (the proof server is multi-GB). Tests run
serially (`fileParallelism: false`) with `retry: 2` — transient wallet-sync /
DUST-funding races on a freshly booted stack are a known flaky tail.

Only the `[smoke]`-tagged subset:

```bash
bun run smoke
```

### Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `MN_ENV` | `undeployed` | `undeployed` boots the local stack; `preprod`/`preview`/`qanet` run against hosted networks (requires `MN_SEED`, boots only a local proof server) |
| `MN_SEED` | genesis seed on `undeployed` | wallet seed for hosted envs |
| `MN_TEST_RETRY` | `2` | vitest retry count |

### Provider wiring note

`test/support/provider-wiring.ts` balances transactions with
`balanceUnboundTransaction → signRecipe → finalizeRecipe` (canary's pattern).
This is required: binding first (`tx.bind()` + `balanceFinalizedTransaction`)
locks the transaction structure so the wallet can't attach the unshielded UTXO
input that `receiveUnshielded` needs — deposits would fail with
`BalanceCheckOverspend` (see README, "The balancing fix").

## CI

`.github/workflows/ci.yml`:

- **unit** — every push/PR: compile (`--skip-zk`), typecheck, unit tests.
- **integration** — every push/PR (40-min cap): full compile (cached on
  contract hash + compiler version), docker stack, full suite. If this proves
  slow or flaky on shared runners, demote PRs to `bun run smoke` and keep the
  full suite on main + a nightly schedule.

## Security suite

Both tiers carry a dedicated security/border-case suite for the
token-loss and token-theft vectors:

- **Unit** ([test/unit/convert-vault.security.unit.test.ts](test/unit/convert-vault.security.unit.test.ts)):
  value-range boundaries (max single deposit, encode-level range rejection,
  the zswap 2^64−1 coin-value cap, credit accumulation past 2^64 without
  wrapping), exact-balance withdrawal boundaries, balance-key isolation
  (zero secret, one-bit-different secrets), the zero-recipient guards, and
  state integrity after failed calls.
- **Integration** ([test/integration/convert-vault.security.test.ts](test/integration/convert-vault.security.test.ts)):
  ledger-enforced properties the simulator cannot falsify — forged
  (never-minted) coins, inflated coin values, double-burns of a spent coin,
  nonce-reuse double-mints (duplicate commitment), the reserve invariant
  (locked NIGHT == credits + outstanding wrapper), and a cross-wallet theft
  attempt (burning someone else's coin).

The contract asserts `"invalid recipient"` on all-zero withdrawal targets:
an all-zero coin public key is Midnight's burn representation, so minting to
it would irrecoverably destroy the wrapper while its backing NIGHT stayed
locked (this guard was added by this suite; see git history).

## Known sharp edges

- `getBalance(secret)` **throws** for a never-used secret (`balances.lookup`
  without a `member` guard). Off-chain callers must probe `balances.member`
  first. Pinned by tests in both tiers.
- `depositShielded` requires the wallet to spend the *exact* `coin` passed as
  the circuit argument. The round-trip test retains the coin returned by
  `withdrawShielded` and passes it back verbatim.
- The historical live e2e (pre-git, different monorepo) is documented in
  [README.md](README.md) under "Live status".
