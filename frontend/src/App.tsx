import { useShieldedNight } from './hooks/useShieldedNight';
import { trackedWrapperTotal } from './lib/swap';
import { explorerContractUrl } from './lib/networks';
import { WalletBar } from './components/WalletBar';
import { BalancePanel } from './components/BalancePanel';
import { SwapCard } from './components/SwapCard';
import { PendingSwaps } from './components/PendingSwaps';
import { ActivityLog } from './components/ActivityLog';

export default function App() {
  const sn = useShieldedNight();

  return (
    <div className="app">
      <WalletBar sn={sn} />

      {sn.error && (
        <div className="card">
          <p className="err" style={{ margin: 0 }}>
            {sn.error}
          </p>
        </div>
      )}

      {sn.connected && (
        <BalancePanel
          balances={sn.balances}
          onRefresh={() => void sn.refreshBalances()}
          mintedTotal={sn.contractAddress ? trackedWrapperTotal(sn.contractAddress) : 0n}
        />
      )}

      <SwapCard sn={sn} />

      <PendingSwaps sn={sn} />

      <ActivityLog logs={sn.logs} />

      <footer className="footer small muted">
        <span>
          {sn.networkIdConnected ? `Connected to ${sn.networkIdConnected}` : `Network: ${sn.networkKey}`}
        </span>
        {sn.contractAddress ? (
          <span className="footer-contract">
            contract{' '}
            {(() => {
              const url = explorerContractUrl(sn.networkKey, sn.contractAddress);
              return url ? (
                <a className="footer-link mono addr" href={url} target="_blank" rel="noreferrer noopener">
                  {sn.contractAddress}
                </a>
              ) : (
                <span className="mono addr">{sn.contractAddress}</span>
              );
            })()}
          </span>
        ) : (
          <span>no contract configured</span>
        )}
        {sn.wrapperColorHex && (
          <span className="footer-token">
            {sn.tokenSymbol ?? 'sNight'} ({sn.tokenName ?? 'Shielded Night'}){' '}
            <span className="mono addr">{sn.wrapperColorHex}</span>
          </span>
        )}
        <a
          className="footer-link"
          href="https://github.com/effectstream/shielded-night"
          target="_blank"
          rel="noreferrer noopener"
        >
          ↗ github.com/effectstream/shielded-night
        </a>
      </footer>
    </div>
  );
}
