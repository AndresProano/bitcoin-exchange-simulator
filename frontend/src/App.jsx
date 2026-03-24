import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';

// In production (Docker), use relative URLs through nginx proxy
// In development, connect directly to backend
const BACKEND_URL = window.location.hostname === 'localhost' && window.location.port === '5173'
  ? 'http://localhost:3001'
  : '';

function App() {
  const [threshold, setThreshold] = useState('');
  const [currentThreshold, setCurrentThreshold] = useState(null);
  const [miners, setMiners] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [status, setStatus] = useState('');
  const socketRef = useRef(null);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/accounts`);
      if (res.ok) {
        const data = await res.json();
        setAccounts(Array.isArray(data) ? data : data.accounts || []);
      }
    } catch (err) {
      console.error('Failed to fetch accounts:', err);
    }
  }, []);

  useEffect(() => {
    // Connect to socket.io backend
    const socket = io(BACKEND_URL, {
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to backend via WebSocket');
    });

    // Backend emits 'initial-state' on connect
    socket.on('initial-state', (data) => {
      if (data.miners) setMiners(data.miners);
      if (data.threshold !== undefined) setCurrentThreshold(data.threshold);
    });

    // Backend emits 'miner-update' when a single miner reports
    socket.on('miner-update', (data) => {
      setMiners((prev) => {
        const idx = prev.findIndex((m) => m.miner_id === data.miner_id);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], ...data };
          return updated;
        }
        return [...prev, data];
      });
    });

    // Backend emits 'threshold-updated'
    socket.on('threshold-updated', (data) => {
      if (data && data.threshold !== undefined) {
        setCurrentThreshold(data.threshold);
      }
    });

    // Backend emits 'deposit' when BTC enters the exchange
    socket.on('deposit', () => {
      fetchAccounts();
    });

    socket.on('disconnect', () => {
      console.log('Disconnected from backend');
    });

    // Fetch initial data
    fetch(`${BACKEND_URL}/api/miners`).then(r => r.json()).then(data => setMiners(Array.isArray(data) ? data : [])).catch(() => {});
    fetchAccounts();
    fetch(`${BACKEND_URL}/api/threshold`).then(r => r.json()).then(data => { if (data.threshold !== undefined) setCurrentThreshold(data.threshold); }).catch(() => {});

    // Poll accounts every 10s to stay current
    const interval = setInterval(fetchAccounts, 10000);

    return () => {
      clearInterval(interval);
      socket.disconnect();
    };
  }, [fetchAccounts]);

  const handleSetThreshold = async () => {
    const value = parseFloat(threshold);
    if (isNaN(value) || value <= 0) {
      setStatus('Please enter a valid positive number for the threshold.');
      return;
    }

    try {
      const res = await fetch(`${BACKEND_URL}/api/threshold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold: value }),
      });

      if (res.ok) {
        const data = await res.json();
        setCurrentThreshold(data.threshold ?? value);
        setStatus(`Threshold set to ${value} BTC`);
        setThreshold('');
      } else {
        const errData = await res.json().catch(() => ({}));
        setStatus(`Error: ${errData.error || 'Failed to set threshold'}`);
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleSetThreshold();
    }
  };

  const getStatusClass = (minerStatus) => {
    if (!minerStatus) return '';
    const s = minerStatus.toLowerCase();
    if (s.includes('mining')) return 'status-mining';
    if (s.includes('stopped')) return 'status-stopped';
    if (s.includes('threshold')) return 'status-threshold';
    return '';
  };

  const formatBtc = (value) => {
    if (value === undefined || value === null) return '0.0000';
    return Number(value).toFixed(4);
  };

  const formatUsd = (value) => {
    if (value === undefined || value === null) return '$0.00';
    return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  // Separate miner accounts and client accounts
  const minerAccounts = accounts.filter(
    (a) => a.type === 'miner' || (a.name && a.name.toLowerCase().includes('miner'))
  );
  const clientAccounts = accounts.filter(
    (a) => a.type === 'client' || (a.name && a.name.toLowerCase().includes('client'))
  );
  const otherAccounts = accounts.filter(
    (a) =>
      !minerAccounts.includes(a) && !clientAccounts.includes(a)
  );

  return (
    <div className="app">
      <header className="header">
        <h1>Simulated Bitcoin Exchange</h1>
      </header>

      {/* Threshold Control */}
      <section className="section threshold-section">
        <h2>Threshold Control</h2>
        <div className="threshold-controls">
          <input
            type="number"
            placeholder="BTC threshold (e.g., 50)"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            onKeyDown={handleKeyDown}
            min="0"
            step="any"
          />
          <button onClick={handleSetThreshold}>Set Threshold</button>
        </div>
        {currentThreshold !== null && (
          <p className="current-threshold">
            Current threshold: <strong>{currentThreshold} BTC</strong>
          </p>
        )}
        {status && <p className="status-message">{status}</p>}
      </section>

      {/* Miners Table */}
      <section className="section miners-section">
        <h2>Miners ({miners.length})</h2>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Miner #</th>
                <th>Blocks Mined</th>
                <th>BTC Gained (Total)</th>
                <th>BTC Available (Spendable)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {miners.length === 0 ? (
                <tr>
                  <td colSpan="5" className="empty-row">
                    No miner data available. Waiting for updates...
                  </td>
                </tr>
              ) : (
                miners.map((miner, idx) => {
                  const minerId = miner.miner_id || miner.id || `miner-${idx + 1}`;
                  const num = minerId.replace('miner-', '').replace('miner_', '');
                  const statusText = miner.threshold_met ? 'threshold met' : (miner.status || 'idle');
                  return (
                    <tr key={minerId}>
                      <td>{num}</td>
                      <td>{miner.blocks_mined ?? 0}</td>
                      <td>{formatBtc(miner.btc_gained)}</td>
                      <td>{formatBtc(miner.btc_available)}</td>
                      <td>
                        <span className={`status-badge ${getStatusClass(statusText)}`}>
                          {statusText}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Exchange Accounts */}
      <section className="section accounts-section">
        <h2>Exchange Accounts ({accounts.length})</h2>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Account Name</th>
                <th>Type</th>
                <th>BTC Balance</th>
                <th>USD Balance</th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 ? (
                <tr>
                  <td colSpan="4" className="empty-row">
                    No account data available. Waiting for updates...
                  </td>
                </tr>
              ) : (
                [...minerAccounts, ...clientAccounts, ...otherAccounts].map((account, idx) => (
                  <tr key={account.id || account.name || idx}>
                    <td>{account.name || `Account ${idx + 1}`}</td>
                    <td>
                      <span className={`type-badge type-${(account.type || 'unknown').toLowerCase()}`}>
                        {account.type || 'unknown'}
                      </span>
                    </td>
                    <td>{formatBtc(account.btc_balance)}</td>
                    <td>{formatUsd(account.usd_balance)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default App;
