import { useState } from 'react';
import type { VaultState } from '../hooks/useVault';
import { shortHex } from '../lib/connector';
import { configuredNetworks, type NetworkOption } from '../lib/networks';

export function WalletBar({ vault }: { vault: VaultState }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const networks = configuredNetworks();

  const onConnectClick = () => {
    if (vault.availableAPIs.length === 1) {
      void vault.connect(vault.availableAPIs[0]);
    } else {
      setPickerOpen((v) => !v);
    }
  };

  const addr = vault.unshieldedAddress ?? vault.coinPublicKey;

  return (
    <div className="topbar">
      <div className="brand">
        <span className="dot" />
        <div className="brand-text">
          <h1>ConvertVault</h1>
          <span className="brand-sub">NIGHT ⇄ wNIGHT</span>
        </div>
      </div>

      <div className="topbar-right">
        <select
          className="select"
          value={vault.networkKey}
          disabled={vault.connecting}
          onChange={(e) => vault.setNetworkKey(e.target.value as NetworkOption['key'])}
        >
          {networks.map((n) => (
            <option key={n.key} value={n.key}>
              {n.label}
            </option>
          ))}
        </select>

        {vault.connected ? (
          <div className="row">
            <span className="chip-connected" title={addr ?? 'connected'}>
              <span className="dot dot-ok" />
              {vault.walletName ?? 'Wallet'}
              {addr ? <span className="chip-addr">·{shortHex(addr, 0, 4)}</span> : null}
            </span>
            <button className="btn btn-ghost" onClick={vault.disconnect}>
              Disconnect
            </button>
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <button
              className="btn btn-primary"
              disabled={vault.connecting || vault.detecting || vault.availableAPIs.length === 0}
              onClick={onConnectClick}
            >
              {vault.connecting
                ? 'Connecting…'
                : vault.detecting
                  ? 'Detecting…'
                  : vault.availableAPIs.length === 0
                    ? 'No wallet found'
                    : 'Connect wallet'}
            </button>
            {pickerOpen && vault.availableAPIs.length > 1 && (
              <div className="card" style={{ position: 'absolute', right: 0, top: 44, zIndex: 10, minWidth: 200 }}>
                {vault.availableAPIs.map((a, i) => (
                  <button
                    key={i}
                    className="btn btn-ghost btn-block"
                    style={{ marginBottom: 6 }}
                    onClick={() => {
                      setPickerOpen(false);
                      void vault.connect(a);
                    }}
                  >
                    {a.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
