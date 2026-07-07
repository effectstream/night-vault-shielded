import { useVault } from './hooks/useVault';
import { trackedWrapperTotal } from './lib/swap';
import { WalletBar } from './components/WalletBar';
import { BalancePanel } from './components/BalancePanel';
import { SwapCard } from './components/SwapCard';
import { PendingSwaps } from './components/PendingSwaps';
import { ActivityLog } from './components/ActivityLog';

export default function App() {
  const vault = useVault();

  return (
    <div className="app">
      <WalletBar vault={vault} />

      {vault.error && (
        <div className="card">
          <p className="err" style={{ margin: 0 }}>
            {vault.error}
          </p>
        </div>
      )}

      {vault.connected && (
        <BalancePanel
          balances={vault.balances}
          onRefresh={() => void vault.refreshBalances()}
          mintedTotal={vault.contractAddress ? trackedWrapperTotal(vault.contractAddress) : 0n}
        />
      )}

      <SwapCard vault={vault} />

      <PendingSwaps vault={vault} />

      <ActivityLog logs={vault.logs} />

      <footer className="footer small muted">
        <span>
          {vault.networkIdConnected ? `Connected to ${vault.networkIdConnected}` : `Network: ${vault.networkKey}`}
          {vault.contractAddress ? ` · vault ${vault.contractAddress.slice(0, 10)}…` : ' · no contract configured'}
        </span>
        <a
          className="footer-link"
          href="https://github.com/effectstream/night-vault-shielded"
          target="_blank"
          rel="noreferrer noopener"
        >
          ↗ github.com/effectstream/night-vault-shielded
        </a>
      </footer>
    </div>
  );
}
