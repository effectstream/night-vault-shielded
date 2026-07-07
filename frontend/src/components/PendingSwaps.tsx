import { useEffect, useState } from 'react';
import type { VaultState } from '../hooks/useVault';
import { errMsg } from '../hooks/useVault';
import { formatAmount } from '../lib/tokens';
import { loadPending, type PendingSwap, removePending, resumeSwap } from '../lib/swap';

export function PendingSwaps({ vault }: { vault: VaultState }) {
  const [pending, setPending] = useState<PendingSwap[]>([]);
  const [busyId, setBusyId] = useState<string>();

  const addr = vault.contractAddress;

  const reload = () => setPending(addr ? loadPending(addr) : []);
  useEffect(reload, [addr, vault.connected]);

  // Only the second leg (step === 'deposited') is safely resumable.
  const resumable = pending.filter((s) => s.step === 'deposited');
  if (!addr || resumable.length === 0) return null;

  async function onResume(s: PendingSwap) {
    if (!vault.providers || !addr) return;
    setBusyId(s.id);
    try {
      await resumeSwap(vault.providers, addr, s, vault.coinPublicKey ?? '', vault.unshieldedAddress ?? '', {
        onLog: vault.appendLog,
      });
      await vault.refreshBalances();
    } catch (e) {
      vault.appendLog('Resume failed: ' + errMsg(e));
    } finally {
      setBusyId(undefined);
      reload();
    }
  }

  function onDiscard(s: PendingSwap) {
    if (!addr) return;
    removePending(addr, s.id);
    reload();
  }

  return (
    <div className="card pending">
      <h2 className="warn">Unfinished swaps</h2>
      <p className="small muted">
        These deposited into the pool but didn't complete the second step. Resume to finish, or discard to forget
        (the credit stays claimable under its secret on-chain).
      </p>
      {resumable.map((s) => (
        <div key={s.id} className="leg" style={{ marginBottom: 8 }}>
          <div>
            <div className="token small">
              {s.direction === 'toShielded' ? 'NIGHT → wNIGHT' : 'wNIGHT → NIGHT'} · {formatAmount(BigInt(s.amount))}
            </div>
            <div className="mono small muted">secret {s.secretHex.slice(0, 12)}…</div>
          </div>
          <div className="row">
            <button className="btn btn-primary small" disabled={!!busyId} onClick={() => onResume(s)}>
              {busyId === s.id ? 'Resuming…' : 'Resume'}
            </button>
            <button className="btn btn-ghost small" disabled={!!busyId} onClick={() => onDiscard(s)}>
              Discard
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
