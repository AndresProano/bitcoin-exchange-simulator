import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';

// In production (Docker), use relative URLs through nginx proxy
// In development, connect directly to backend
const BACKEND_URL = window.location.hostname === 'localhost' && window.location.port === '5173'
  ? 'http://localhost:3001'
  : '';

const MAX_LOGS = 50;
const CLIENTS_PER_PAGE = 5;

function App() {
  const [threshold, setThreshold] = useState('');
  const [currentThreshold, setCurrentThreshold] = useState(null);
  const [miners, setMiners] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [status, setStatus] = useState('');
  const [backendStatus, setBackendStatus] = useState('connecting');
  const [systemStatus, setSystemStatus] = useState({ blockchain: { blocks: 0, chain: 'unknown', difficulty: 0 } });
  const [logs, setLogs] = useState([]);
  const [clientPage, setClientPage] = useState(1);
  const socketRef = useRef(null);

  const addLog = useCallback((message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [{
      id: `${Date.now()}-${Math.random()}`,
      message,
      type,
      timestamp,
    }, ...prev].slice(0, MAX_LOGS));
  }, []);

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

  const fetchSystemStatus = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/system-status`);
      if (res.ok) {
        const data = await res.json();
        setSystemStatus(data);
        setBackendStatus(data.backend === 'ok' ? 'connected' : 'error');
      } else {
        setBackendStatus('error');
      }
    } catch (err) {
      console.error('Failed to fetch system status:', err);
      setBackendStatus('disconnected');
    }
  }, []);

  useEffect(() => {
    // Connect to socket.io backend
    const socket = io(BACKEND_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      timeout: 20000,
      pingInterval: 10000,
      pingTimeout: 5000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to backend via WebSocket');
      setBackendStatus('connected');
      // Don't spam event log with connection messages
    });

    socket.on('connect_error', (error) => {
      console.warn('WebSocket connection error:', error.message);
    });

    socket.on('disconnect', (reason) => {
      console.log('Disconnected from backend:', reason);
      setBackendStatus('disconnected');
      // Don't log disconnect spam - only log on user interaction
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
        addLog(`Threshold updated to ${data.threshold} BTC`, 'info');
      }
    });

    // Backend emits 'deposit' when BTC enters the exchange
    socket.on('deposit', (data) => {
      fetchAccounts();
      if (data) {
        const amount = data.amount || '?';
        const miner = data.miner_id?.replace('miner-', 'Miner ') || 'Unknown';
        const threshold = data.threshold || '?';
        addLog(`✓ ${miner} reached threshold (${threshold} BTC) → Deposited ${amount} BTC`, 'success');
      }
    });

    // Backend emits 'mining-started' when miners start
    socket.on('mining-started', (data) => {
      if (data && data.miners_started) {
        addLog(`✓ ${data.miners_started} miner(s) started mining`, 'success');
      }
    });

    // Backend emits 'mining-stopped' when miners stop
    socket.on('mining-stopped', (data) => {
      if (data && data.miners_stopped) {
        addLog(`✓ ${data.miners_stopped} miner(s) stopped mining`, 'warning');
      }
    });

    // Don't spam logs on every reconnection - let Socket.IO handle it silently

    // Fetch initial data
    fetch(`${BACKEND_URL}/api/miners`).then(r => r.json()).then(data => setMiners(Array.isArray(data) ? data : [])).catch(() => {});
    fetchAccounts();
    fetchSystemStatus();
    fetch(`${BACKEND_URL}/api/threshold`).then(r => r.json()).then(data => { if (data.threshold !== undefined) setCurrentThreshold(data.threshold); }).catch(() => {});

    // Poll system status every 5s for real-time updates
    const systemInterval = setInterval(fetchSystemStatus, 5000);
    // Poll accounts every 5s for real-time updates
    const accountInterval = setInterval(fetchAccounts, 5000);

    return () => {
      clearInterval(systemInterval);
      clearInterval(accountInterval);
      socket.disconnect();
    };
  }, [fetchAccounts, fetchSystemStatus, addLog]);

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
        addLog(`✓ Threshold set to ${value} BTC`, 'info');
        setStatus(`Threshold set to ${value} BTC`);
        setThreshold('');
      } else {
        const errData = await res.json().catch(() => ({}));
        setStatus(`Error: ${errData.error || 'Failed to set threshold'}`);
        addLog(`❌ Failed to set threshold`, 'error');
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      addLog(`❌ Error: ${err.message}`, 'error');
    }
  };

  const handleStartAllMiners = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (res.ok) {
        addLog(`✓ Started mining on ${data.miners_started || 0} miner(s)`, 'success');
      } else {
        addLog(`⚠ ${data.error || 'Failed to start mining'}`, 'warning');
      }
    } catch (err) {
      console.error('Failed to start miners:', err);
      addLog('❌ Error: Could not start mining', 'error');
    }
  };

  const handleStopAllMiners = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (res.ok) {
        addLog(`✓ Stopped mining on ${data.miners_stopped || 0} miner(s)`, 'warning');
      } else {
        addLog(`⚠ ${data.error || 'Failed to stop mining'}`, 'warning');
      }
    } catch (err) {
      console.error('Failed to stop miners:', err);
      addLog('Error: Could not stop mining', 'error');
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

  const getStatusIndicator = (miner) => {
    if (miner.threshold_met) return 'threshold';
    if (miner.status === 'mining' || (miner.status && !miner.status.includes('idle'))) return 'active';
    return 'idle';
  };

  const getBackendStatusColor = () => {
    if (backendStatus === 'connected') return '#3fb950'; // green
    if (backendStatus === 'connecting') return '#f7931a'; // orange
    return '#da3633'; // red
  };

  const formatBtc = (value) => {
    if (value === undefined || value === null) return '0.0000';
    return Number(value).toFixed(4);
  };

  const formatUsd = (value) => {
    if (value === undefined || value === null) return '$0.00';
    return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const sortedAccounts = [...accounts].sort((a, b) => {
    const typeOrder = { client: 0, miner: 1 };
    const typeDiff = (typeOrder[a.type] ?? 2) - (typeOrder[b.type] ?? 2);
    if (typeDiff !== 0) return typeDiff;
    const numA = parseInt(String(a.id || '').replace('client_', '').replace('miner-', ''), 10) || 0;
    const numB = parseInt(String(b.id || '').replace('client_', '').replace('miner-', ''), 10) || 0;
    return numA - numB;
  });

  const minerDepositAccounts = sortedAccounts.filter(
    (a) => a.type === 'miner' && (a.btc_balance || 0) > 0
  );
  const clientAccounts = sortedAccounts.filter((a) => a.type === 'client');
  const minerAccounts = sortedAccounts.filter((a) => a.type === 'miner');
  const totalClientPages = Math.max(1, Math.ceil(clientAccounts.length / CLIENTS_PER_PAGE));
  const safeClientPage = Math.min(clientPage, totalClientPages);
  const clientPageStart = (safeClientPage - 1) * CLIENTS_PER_PAGE;
  const visibleClientAccounts = clientAccounts.slice(clientPageStart, clientPageStart + CLIENTS_PER_PAGE);

  useEffect(() => {
    setClientPage((page) => Math.min(page, Math.max(1, Math.ceil(clientAccounts.length / CLIENTS_PER_PAGE))));
  }, [clientAccounts.length]);

  return (
    <div className="app">
      <header className="header">
        <h1>Simulated Bitcoin Exchange</h1>
        <div className="header-status">
          <div className="status-indicator" style={{ backgroundColor: getBackendStatusColor() }}></div>
          <span>{backendStatus === 'connected' ? 'Connected' : backendStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}</span>
        </div>
      </header>

      {/* System Status Panel */}
      <section className="section system-status-section">
        <h2>System Status</h2>
        <div className="status-grid">
          <div className="status-card">
            <div className="status-label">Backend</div>
            <div className={`status-value status-${backendStatus}`}>{backendStatus.charAt(0).toUpperCase() + backendStatus.slice(1)}</div>
          </div>
          <div className="status-card">
            <div className="status-label">Blockchain</div>
            <div className="status-value">{systemStatus.blockchain?.chain || 'unknown'}</div>
          </div>
          <div className="status-card">
            <div className="status-label">Total Blocks</div>
            <div className="status-value">{systemStatus.blockchain?.blocks || 0}</div>
          </div>
          <div className="status-card">
            <div className="status-label">Network</div>
            <div className="status-value">{systemStatus.blockchain?.chain === 'regtest' ? 'Regtest' : 'Unknown'}</div>
          </div>
        </div>
      </section>

      {/* Mining Controls */}
      <section className="section mining-control-section">
        <h2>Mining Control</h2>
        <div className="threshold-controls">
          <input
            type="number"
            placeholder="BTC threshold (e.g., 50)"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSetThreshold()}
            min="0"
            step="any"
          />
          <button onClick={handleSetThreshold} className="btn-primary">Set Threshold</button>
          <button onClick={handleStartAllMiners} className="btn-success">Start Mining</button>
          <button onClick={handleStopAllMiners} className="btn-danger">Stop Mining</button>
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
                <th></th>
                <th>Miner #</th>
                <th>Blocks Mined</th>
                <th>BTC Gained (Total)</th>
                <th>BTC Immature</th>
                <th>BTC Available (Spendable)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {miners.length === 0 ? (
                <tr>
                  <td colSpan="7" className="empty-row">
                    No miner data available. Waiting for updates...
                  </td>
                </tr>
              ) : (
                [...miners].sort((a, b) => {
                  const numA = parseInt(a.miner_id?.replace('miner-', '') || 0);
                  const numB = parseInt(b.miner_id?.replace('miner-', '') || 0);
                  return numA - numB;
                }).map((miner, idx) => {
                  const minerId = miner.miner_id || miner.id || `miner-${idx + 1}`;
                  const num = minerId.replace('miner-', '').replace('miner_', '');
                  const statusText = miner.threshold_met ? 'threshold met' : (miner.status || 'idle');
                  const statusIndicator = getStatusIndicator(miner);
                  return (
                    <tr key={minerId} className={`miner-row status-${statusIndicator}`}>
                      <td className="indicator-cell">
                        <div className={`status-dot ${statusIndicator}`}></div>
                      </td>
                      <td>{num}</td>
                      <td>{miner.blocks_mined ?? 0}</td>
                      <td>{formatBtc(miner.btc_gained)}</td>
                      <td><span className="btc-immature">{formatBtc(miner.btc_immature)}</span></td>
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

      {/* Logs Panel */}
      <section className="section logs-section">
        <h2>Event Log ({logs.length})</h2>
        <div className="logs-container">
          {logs.length === 0 ? (
            <div className="empty-row">No events yet...</div>
          ) : (
            logs.map((log) => (
              <div key={log.id} className={`log-entry log-${log.type}`}>
                <span className="log-time">{log.timestamp}</span>
                <span className="log-message">{log.message}</span>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Miner Deposits */}
      <section className="section accounts-section">
        <h2>Miner Deposits ({minerDepositAccounts.length})</h2>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Miner</th>
                <th>BTC Received</th>
                <th>USD Value</th>
              </tr>
            </thead>
            <tbody>
              {minerDepositAccounts.length === 0 ? (
                <tr>
                  <td colSpan="3" className="empty-row">
                    No deposits yet. Mine blocks and reach threshold to see deposits here.
                  </td>
                </tr>
              ) : (
                minerDepositAccounts.map((account, idx) => (
                  <tr key={account.id || account.name || idx}>
                    <td>{account.name || `Account ${idx + 1}`}</td>
                    <td>{formatBtc(account.btc_balance)}</td>
                    <td>{formatUsd(account.usd_balance)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Client Accounts */}
      <section className="section accounts-section">
        <div className="section-heading-row">
          <h2>Client Accounts ({clientAccounts.length})</h2>
          <div className="pagination-controls">
            <button
              onClick={() => setClientPage((page) => Math.max(1, page - 1))}
              disabled={safeClientPage === 1}
            >
              Previous
            </button>
            <span>Page {safeClientPage} of {totalClientPages}</span>
            <button
              onClick={() => setClientPage((page) => Math.min(totalClientPages, page + 1))}
              disabled={safeClientPage === totalClientPages}
            >
              Next
            </button>
          </div>
        </div>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Account ID</th>
                <th>Name</th>
                <th>Type</th>
                <th>BTC Balance</th>
                <th>USD Balance</th>
              </tr>
            </thead>
            <tbody>
              {visibleClientAccounts.length === 0 ? (
                <tr>
                  <td colSpan="5" className="empty-row">
                    No client accounts loaded yet.
                  </td>
                </tr>
              ) : (
                visibleClientAccounts.map((account) => (
                  <tr key={account.id}>
                    <td>{account.id}</td>
                    <td>{account.name}</td>
                    <td>
                      <span className={`type-badge type-${account.type || 'unknown'}`}>
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

      {/* Miner Accounts */}
      <section className="section accounts-section">
        <h2>Miner Exchange Accounts ({minerAccounts.length})</h2>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Account ID</th>
                <th>Name</th>
                <th>Type</th>
                <th>BTC Balance</th>
                <th>USD Balance</th>
              </tr>
            </thead>
            <tbody>
              {minerAccounts.length === 0 ? (
                <tr>
                  <td colSpan="5" className="empty-row">
                    No miner exchange accounts yet.
                  </td>
                </tr>
              ) : (
                minerAccounts.map((account) => (
                  <tr key={account.id}>
                    <td>{account.id}</td>
                    <td>{account.name}</td>
                    <td>
                      <span className={`type-badge type-${account.type || 'unknown'}`}>
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
