import { useState } from 'react';
import type { ShieldedNightState } from '../hooks/useShieldedNight';
import { shortHex } from '../lib/connector';
import { configuredNetworks, type NetworkOption } from '../lib/networks';

export function WalletBar({ sn }: { sn: ShieldedNightState }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const networks = configuredNetworks();

  const onConnectClick = () => {
    if (sn.availableAPIs.length === 1) {
      void sn.connect(sn.availableAPIs[0]);
    } else {
      setPickerOpen((v) => !v);
    }
  };

  const addr = sn.unshieldedAddress ?? sn.coinPublicKey;

  return (
    <div className="topbar">
      <div className="brand">
        <span className="dot" />
        <div className="brand-text">
          <h1>Shielded NIGHT</h1>
          <span className="brand-sub">NIGHT ⇄ sNight</span>
        </div>
      </div>

      <div className="topbar-right">
        <select
          className="select"
          value={sn.networkKey}
          disabled={sn.connecting}
          onChange={(e) => sn.setNetworkKey(e.target.value as NetworkOption['key'])}
        >
          {networks.map((n) => (
            <option key={n.key} value={n.key}>
              {n.label}
            </option>
          ))}
        </select>

        {sn.connected ? (
          <div className="row">
            <span className="chip-connected" title={addr ?? 'connected'}>
              <span className="dot dot-ok" />
              <span className="chip-addr">{addr ? shortHex(addr, 6, 6) : 'connected'}</span>
            </span>
            <button className="btn btn-ghost" onClick={sn.disconnect}>
              Disconnect
            </button>
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <button
              className="btn btn-primary"
              disabled={sn.connecting || sn.detecting || sn.availableAPIs.length === 0}
              onClick={onConnectClick}
            >
              {sn.connecting
                ? 'Connecting…'
                : sn.detecting
                  ? 'Detecting…'
                  : sn.availableAPIs.length === 0
                    ? 'No wallet found'
                    : 'Connect wallet'}
            </button>
            {pickerOpen && sn.availableAPIs.length > 1 && (
              <div className="card" style={{ position: 'absolute', right: 0, top: 44, zIndex: 10, minWidth: 200 }}>
                {sn.availableAPIs.map((a, i) => (
                  <button
                    key={i}
                    className="btn btn-ghost btn-block"
                    style={{ marginBottom: 6 }}
                    onClick={() => {
                      setPickerOpen(false);
                      void sn.connect(a);
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
