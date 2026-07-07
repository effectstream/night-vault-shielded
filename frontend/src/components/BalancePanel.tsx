import { useState } from 'react';
import type { Balances } from '../hooks/useShieldedNight';
import { formatAmount } from '../lib/tokens';

export function BalancePanel({
  balances,
  onRefresh,
  mintedTotal,
}: {
  balances?: Balances;
  onRefresh: () => void;
  /** wNIGHT this dApp has minted (tracked coins) - used to detect a real mismatch. */
  mintedTotal: bigint;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copyId = (label: string, id?: string) => {
    if (!id) return;
    navigator.clipboard
      ?.writeText(id)
      .then(() => {
        setCopied(label);
        setTimeout(() => setCopied((c) => (c === label ? null : c)), 1200);
      })
      .catch(() => undefined);
  };

  // Token label: dotted-underlined, hover shows the token id, click copies it.
  const TokenLabel = ({ label, id }: { label: string; id?: string }) =>
    id ? (
      <span
        className="bal-k token-id"
        title={`${id}\n(click to copy)`}
        onClick={() => copyId(label, id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && copyId(label, id)}
      >
        {copied === label ? 'copied ✓' : label}
      </span>
    ) : (
      <span className="bal-k">{label}</span>
    );

  const anomaly = mintedTotal > 0n && (!balances || !balances.wrapperMatched || balances.wrapper === 0n);

  return (
    <div className="balances">
      <div className="balances-row">
        <span className="bal">
          <TokenLabel label="NIGHT" id={balances?.nativeTokenId} />
          <span className="bal-v">{balances ? formatAmount(balances.nativeNight) : '-'}</span>
        </span>
        <span className="bal-sep">·</span>
        <span className="bal">
          <TokenLabel label="wNIGHT" id={balances?.wrapperTokenId} />
          <span className="bal-v">{balances ? formatAmount(balances.wrapper) : '-'}</span>
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
