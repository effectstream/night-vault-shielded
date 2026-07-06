import { test } from 'vitest';

/**
 * Cross-cutting smoke tag.
 *
 * Tests that are smokes ("fail fast on a fundamental regression") get declared via `smokeTest(...)` instead of
 * `test(...)`. This adds the `[smoke]` prefix to the test name, which lets Vitest's `-t` filter select the smoke subset
 * without changing file organisation:
 *
 * Yarn vitest run # everything yarn vitest run -t '[smoke]' # smokes only yarn smoke # alias for the above
 *
 * Why a name prefix and not a custom annotation: Vitest's collection-time filter is name-regex based (the `-t` flag).
 * Annotations are runtime metadata that can't gate which tests Vitest even decides to run. Prefixing the visible name
 * is the only mechanism that actually skips non-smoke tests at collection.
 *
 * Pick a smoke when ALL of:
 *
 * - It exercises a load-bearing SDK / contract / indexer / wallet path
 * - It would catch a class of regression you'd want to know about on every PR (not just exhaustive coverage of one path)
 * - It runs in well under a minute against the local stack
 *
 * Skip the tag when the test is doing parameter-matrix coverage, exhaustive negative-input cases, or anything that's
 * slow + duplicative with a tagged test.
 */
const SMOKE_PREFIX = '[smoke]';
const CANARY_PREFIX = '[canary]';

export const smokeTest = (name: string, fn: () => void | Promise<void>, timeout?: number): void => {
  test(`${SMOKE_PREFIX} ${name}`, fn, timeout);
};

/**
 * A smoke test that is ALSO part of the version-compatibility canary's fast subset. Tagged `[smoke] [canary]`, so it
 * runs in the full smoke suite (`yarn smoke`, hosted-smoke) AND can be selected alone via `-t '[canary]'` (`yarn
 * smoke:canary`, used by version-diff.yml). The full per-cell smoke grew past the canary's 30-min cell timeout; this
 * subset keeps the canary ~15 min while hosted-smoke stays exhaustive.
 *
 * Pick a test for the canary subset when it exercises a DISTINCT load-bearing surface (deploy, circuit call,
 * findDeployedContract, indexer observable, typed/fallible error, token/zswap path, private-state provider, witness
 * gating) — one representative per surface. Exhaustive / duplicative / matrix cases stay plain `smokeTest`.
 */
export const canarySmokeTest = (name: string, fn: () => void | Promise<void>, timeout?: number): void => {
  test(`${SMOKE_PREFIX} ${CANARY_PREFIX} ${name}`, fn, timeout);
};
