import { useMemo, useState } from 'react';
import type { VaultState } from '../hooks/useVault';
import { errMsg } from '../hooks/useVault';
import { formatAmount, parseAmount } from '../lib/tokens';
import { type Direction, runForwardSwap, runReverseSwap, type SwapStep, trackedWrapperTotal } from '../lib/swap';

const TOKENS = {
  toShielded: { from: 'NIGHT', to: 'wNIGHT' },
  toUnshielded: { from: 'wNIGHT', to: 'NIGHT' },
} as const;

export function SwapCard({ vault }: { vault: VaultState }) {
  const [direction, setDirection] = useState<Direction>('toShielded');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<SwapStep | null>(null);
  const [stepLabel, setStepLabel] = useState('');
  const [localErr, setLocalErr] = useState<string>();

  const { from, to } = TOKENS[direction];
  const ready = vault.connected && !!vault.contractAddress;

  const trackedWrapper = useMemo(
    () => (vault.contractAddress ? trackedWrapperTotal(vault.contractAddress) : 0n),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vault.contractAddress, step, busy],
  );

  const flip = () => {
    setDirection((d) => (d === 'toShielded' ? 'toUnshielded' : 'toShielded'));
    setLocalErr(undefined);
  };

  // Max = spendable balance in the "from" token: NIGHT balance for forward,
  // tracked wNIGHT for reverse.
  const maxBase = direction === 'toShielded' ? (vault.balances?.nativeNight ?? 0n) : trackedWrapper;
  const onMax = () => {
    setLocalErr(undefined);
    setAmount(formatAmount(maxBase));
  };

  async function onSwap() {
    setLocalErr(undefined);
    if (!vault.providers || !vault.contractAddress) return;
    let amt: bigint;
    try {
      amt = parseAmount(amount);
      if (amt <= 0n) throw new Error('Enter an amount greater than zero');
    } catch (e) {
      setLocalErr(errMsg(e));
      return;
    }

    setBusy(true);
    setStep('started');
    try {
      const cb = {
        onStep: (s: SwapStep, label: string) => {
          setStep(s);
          setStepLabel(label);
        },
        onLog: vault.appendLog,
      };
      if (direction === 'toShielded') {
        await runForwardSwap(
          {
            providers: vault.providers,
            contractAddress: vault.contractAddress,
            amount: amt,
            coinPublicKey: vault.coinPublicKey!,
          },
          cb,
        );
      } else {
        await runReverseSwap(
          {
            providers: vault.providers,
            contractAddress: vault.contractAddress,
            amount: amt,
            unshieldedAddress: vault.unshieldedAddress!,
          },
          cb,
        );
      }
      await vault.refreshBalances();
      setAmount('');
    } catch (e) {
      setLocalErr(errMsg(e));
      vault.appendLog('Swap error: ' + errMsg(e));
    } finally {
      setBusy(false);
      setTimeout(() => setStep(null), 1500);
    }
  }

  return (
    <div className="card">
      <h2>Convert</h2>

      <div className="leg">
        <div>
          <div className="label">From</div>
          <div className="token">{from}</div>
        </div>
        <div className="amount-field">
          <input
            className="input amount-input"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            disabled={busy}
            onChange={(e) => setAmount(e.target.value)}
          />
          <button className="max-btn" onClick={onMax} disabled={busy || maxBase === 0n} title={`Use max (${formatAmount(maxBase)})`}>
            Max
          </button>
        </div>
      </div>

      <div className="swap-arrow">
        <button
          className={direction === 'toUnshielded' ? 'flipped' : ''}
          onClick={flip}
          disabled={busy}
          title="Switch direction"
          aria-label="Switch direction"
        >
          ↓
        </button>
      </div>

      <div className="leg">
        <div>
          <div className="label">To</div>
          <div className="token">{to}</div>
        </div>
        <div className="amt muted">{amount && isFinite(Number(amount)) ? amount : '0.0'}</div>
      </div>

      {direction === 'toUnshielded' && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          Reverse converts a whole wrapper coin minted through this dApp. Tracked wNIGHT available:{' '}
          <b>{formatAmount(trackedWrapper)}</b>.
        </p>
      )}

      {step && (
        <>
          <div className="steps">
            <div className={`step ${step === 'started' ? 'active' : 'done'}`}>
              1 · {direction === 'toShielded' ? 'Deposit NIGHT' : 'Burn wNIGHT'}
            </div>
            <div className={`step ${step === 'deposited' ? 'active' : step === 'done' ? 'done' : ''}`}>
              2 · {direction === 'toShielded' ? 'Mint wNIGHT' : 'Release NIGHT'}
            </div>
          </div>
          <div className="small muted">{stepLabel}</div>
        </>
      )}

      {localErr && <p className="err small">{localErr}</p>}

      <div className="spacer" />
      <button className="btn btn-primary btn-block" disabled={!ready || busy} onClick={onSwap}>
        {busy ? 'Swapping…' : `Swap ${from} → ${to}`}
      </button>
      {!ready && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          {vault.connected
            ? `No contract address configured for ${vault.networkKey}. Set VITE_CONTRACT_ADDRESS_${vault.networkKey.toUpperCase()} in .env.`
            : 'Connect a wallet to swap.'}
        </p>
      )}
      <p className="small muted" style={{ marginBottom: 0 }}>
        Each swap is two transactions — expect two wallet approvals.
      </p>
    </div>
  );
}
