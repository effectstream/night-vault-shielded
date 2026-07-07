import { ProvableCircuitId } from '@midnight-ntwrk/compact-js';
import {
  submitInsertVerifierKeyTx,
  submitRemoveVerifierKeyTx,
} from '@midnight-ntwrk/midnight-js/contracts';
import { describe, expect, test } from 'vitest';
import { ShieldedNightContract } from '../../src/index.ts';
import * as contract from '../support/shielded-night.js';
import { describeContract } from '../support/describe-contract.js';
import { buildCompiled, lockContract, readAuthority } from '../support/governance.js';
import { tryCall } from '../support/smoke-helpers.js';

/**
 * Proves the "remove the committee → permanently static contract" lifecycle
 * end to end on a real node. A lock is only credible if a maintenance update
 * SUCCEEDS while the authority is live and then FAILS once it is dissolved, so
 * the test does exactly that:
 *
 *   1. deploy               → authority is a 1-of-1 committee (the deployer)
 *   2. update a circuit     → succeeds (verifier-key remove + re-insert)
 *   3. update the maintainer → replace the committee with an EMPTY one
 *   4. update a circuit again → REJECTED (no committee can ever sign)
 *
 * A circuit "update" here removes a circuit's verifier key and re-inserts it: a
 * round-trip of two genuine maintenance transactions the authority must sign,
 * leaving the contract functionally unchanged. (A bare insert is rejected
 * because the circuit already exists, so a real update round-trips through
 * remove.)
 */

// Branded circuit id (the SDK's ProvableCircuitId brand) parametrized by the
// concrete contract contract type, so it carries the literal circuit-id union the
// governance calls expect. Re-inserting an existing circuit's verifier key is a
// real maintenance update with no semantic change.
type ContractInstance = InstanceType<typeof ShieldedNightContract.Contract>;
const CIRCUIT = ProvableCircuitId<ContractInstance>('getBalance');

describe('shielded-night — maintenance authority lock', () => {
  describeContract(contract.factory, (ctx) => {
    test(
      'a contract can be frozen by dissolving its maintenance committee',
      async () => {
        const c = ctx();
        const deployed = await c.deployFresh([...contract.DEPLOY_ARGS]);
        const address = deployed.deployTxData.public.contractAddress;
        const compiled = buildCompiled(c.zkConfigPath);
        const vk = await c.providers.zkConfigProvider.getVerifierKey(CIRCUIT);

        // 1. Fresh deploy: a 1-of-1 committee (the deployer holds the key).
        const initial = await readAuthority(c.providers, address);
        expect(initial.committeeSize).toBe(1);
        expect(initial.threshold).toBe(1);
        expect(initial.counter).toBe(0n);

        // 2. Update a circuit while the authority is live — must succeed.
        // Remove the verifier key, then re-insert it: two authorized
        // maintenance updates that leave the contract functionally whole.
        await submitRemoveVerifierKeyTx(c.providers, compiled, address, CIRCUIT);
        await submitInsertVerifierKeyTx(c.providers, compiled, address, CIRCUIT, vk);
        const afterUpdate = await readAuthority(c.providers, address);
        expect(afterUpdate.counter).toBe(2n); // two maintenance updates advanced the counter

        // 3. Update the maintainer: dissolve the committee (empty, threshold 1).
        await lockContract(c.providers, address, 1);
        const locked = await readAuthority(c.providers, address);
        expect(locked.committeeSize).toBe(0);
        expect(locked.threshold).toBe(1); // 0 members, threshold 1 => unsatisfiable
        expect(locked.counter).toBe(3n);

        // 4. Try to update again — the node must reject it: the deployer's key
        // is no longer in the committee, and no signature set can satisfy an
        // empty committee.
        const afterLock = await tryCall(() =>
          submitRemoveVerifierKeyTx(c.providers, compiled, address, CIRCUIT),
        );
        expect(afterLock.ok, 'maintenance update after lock must be rejected').toBe(false);

        // The contract is unchanged by the rejected attempt: still frozen.
        const final = await readAuthority(c.providers, address);
        expect(final.committeeSize).toBe(0);
        expect(final.counter).toBe(3n); // rejected update did not advance the counter

        // And the contract's circuits still work — frozen means un-upgradeable,
        // not disabled.
        const secret = new Uint8Array(32).fill(7);
        await contract.depositUnshielded(deployed, secret, 1_000n);
        expect((await contract.getBalance(deployed, secret)).private.result).toBe(1_000n);
      },
      10 * 60_000,
    );
  });
});
