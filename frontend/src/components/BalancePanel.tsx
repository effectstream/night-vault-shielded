import type { Balances } from '../hooks/useVault';
import { formatAmount } from '../lib/tokens';

export function BalancePanel({
  balances,
  onRefresh,
  mintedTotal,
}: {
  balances?: Balances;
  onRefresh: () => void;
  /** wNIGHT this dApp has minted (tracked coins) — used to detect a real mismatch. */
  mintedTotal: bigint;
}) {
  // Only a real anomaly warrants a warning: we minted wrapper coins in this
  // browser, yet the wallet's balance for the wrapper token reads zero or was
  // not found. Before the first swap, "not found" is the normal state.
  const anomaly = mintedTotal > 0n && (!balances || !balances.wrapperMatched || balances.wrapper === 0n);

  return (
    <div className="balances">
      <div className="balances-row">
        <span className="bal">
          <span className="bal-k">NIGHT</span>
          <span className="bal-v">{balances ? formatAmount(balances.nativeNight) : '—'}</span>
        </span>
        <span className="bal-sep">·</span>
        <span className="bal">
          <span className="bal-k">wNIGHT</span>
          <span className="bal-v">{balances ? formatAmount(balances.wrapper) : '—'}</span>
        </span>
        <button className="link-btn" onClick={onRefresh} title="Refresh balances">
          ↻
        </button>
      </div>
      {anomaly && (
        <p className="small warn" style={{ margin: '6px 0 0' }}>
          This dApp minted {formatAmount(mintedTotal)} wNIGHT but the wallet doesn't show it under the expected token
          type. If the wallet lists a new asset, set VITE_WRAPPER_TOKEN_TYPE_* in .env.
        </p>
      )}
    </div>
  );
}
