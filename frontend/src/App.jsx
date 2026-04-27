import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';

const BACKEND_URL = window.location.hostname === 'localhost' && window.location.port === '5173'
  ? 'http://localhost:3001'
  : '';

const MAX_LOGS = 80;
const CLIENTS_PER_PAGE = 6;

function App() {
  const [threshold, setThreshold] = useState('');
  const [currentThreshold, setCurrentThreshold] = useState(null);
  const [miners, setMiners] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [openOrders, setOpenOrders] = useState([]);
  const [completedOrders, setCompletedOrders] = useState([]);
  const [trades, setTrades] = useState([]);
  const [ownerFees, setOwnerFees] = useState(0);

  const [orderClientId, setOrderClientId] = useState('');
  const [orderSide, setOrderSide] = useState('buy');
  const [orderPrice, setOrderPrice] = useState('');
  const [orderAmount, setOrderAmount] = useState('');

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

  const fetchMiners = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/miners`);
      if (res.ok) {
        const data = await res.json();
        setMiners(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Failed to fetch miners:', err);
    }
  }, []);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/accounts`);
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : [];
        setAccounts(list);

        if (!orderClientId && list.length > 0) {
          const defaultTrader = list.find((a) => a.type !== 'owner');
          if (defaultTrader) setOrderClientId(defaultTrader.id);
        }
      }
    } catch (err) {
      console.error('Failed to fetch accounts:', err);
    }
  }, [orderClientId]);

  const fetchOrders = useCallback(async () => {
    try {
      const [openRes, completedRes] = await Promise.all([
        fetch(`${BACKEND_URL}/api/orders/open`),
        fetch(`${BACKEND_URL}/api/orders/completed`),
      ]);

      if (openRes.ok) {
        const data = await openRes.json();
        setOpenOrders(Array.isArray(data) ? data : []);
      }

      if (completedRes.ok) {
        const data = await completedRes.json();
        setCompletedOrders(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Failed to fetch orders:', err);
    }
  }, []);

  const fetchTrades = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/trades`);
      if (res.ok) {
        const data = await res.json();
        setTrades(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Failed to fetch trades:', err);
    }
  }, []);

  const fetchOwnerFees = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/owner/fees`);
      if (res.ok) {
        const data = await res.json();
        setOwnerFees(Number(data?.fee_btc_total || 0));
      }
    } catch (err) {
      console.error('Failed to fetch owner fees:', err);
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
      setBackendStatus('connected');
    });

    socket.on('connect_error', () => {});

    socket.on('disconnect', () => {
      setBackendStatus('disconnected');
    });

    socket.on('initial-state', (data) => {
      if (data.miners) setMiners(data.miners);
      if (data.threshold !== undefined) setCurrentThreshold(data.threshold);
    });

    socket.on('miners-updated', (data) => {
      if (Array.isArray(data)) {
        setMiners(data);
      } else {
        fetchMiners();
      }
    });

    socket.on('miner-update', (data) => {
      if (!data || !data.miner_id) return;
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

    socket.on('threshold-updated', (data) => {
      if (data && data.threshold !== undefined) {
        setCurrentThreshold(data.threshold);
        addLog(`Threshold updated to ${data.threshold} BTC`, 'info');
        fetchMiners();
      }
    });

    socket.on('deposit', (data) => {
      fetchAccounts();
      fetchMiners();
      if (data) {
        const amount = data.amount || '?';
        const miner = data.miner_id?.replace('miner-', 'Miner ') || 'Unknown';
        addLog(`Deposit verified: ${miner} -> ${amount} BTC`, 'success');
      }
    });

    socket.on('mining-started', (data) => {
      addLog(`Started mining on ${data?.miners_started || 0} miner(s)`, 'success');
      fetchMiners();
    });

    socket.on('mining-stopped', (data) => {
      addLog(`Stopped mining on ${data?.miners_stopped || 0} miner(s)`, 'warning');
      fetchMiners();
    });

    socket.on('orders-updated', () => {
      fetchAccounts();
      fetchOrders();
      fetchTrades();
      fetchOwnerFees();
    });

    socket.on('trade-executed', (trade) => {
      addLog(
        `Trade executed: buy#${trade.buy_order_id} sell#${trade.sell_order_id} ${formatBtc(trade.btc_amount_gross)} BTC @ $${Number(trade.price).toFixed(2)}`,
        'success'
      );
      fetchAccounts();
      fetchOrders();
      fetchTrades();
      fetchOwnerFees();
    });

    fetchMiners();
    fetch(`${BACKEND_URL}/api/threshold`).then(r => r.json()).then(data => {
      if (data.threshold !== undefined) setCurrentThreshold(data.threshold);
    }).catch(() => {});

    fetchSystemStatus();
    fetchAccounts();
    fetchOrders();
    fetchTrades();
    fetchOwnerFees();

    const systemInterval = setInterval(fetchSystemStatus, 5000);
    const accountInterval = setInterval(fetchAccounts, 5000);
    const ordersInterval = setInterval(fetchOrders, 5000);
    const tradesInterval = setInterval(fetchTrades, 5000);
    const feesInterval = setInterval(fetchOwnerFees, 5000);

    return () => {
      clearInterval(systemInterval);
      clearInterval(accountInterval);
      clearInterval(ordersInterval);
      clearInterval(tradesInterval);
      clearInterval(feesInterval);
      socket.disconnect();
    };
  }, [addLog, fetchAccounts, fetchMiners, fetchOrders, fetchOwnerFees, fetchSystemStatus, fetchTrades]);

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
        addLog(`Threshold set to ${value} BTC`, 'info');
        setStatus(`Threshold set to ${value} BTC`);
        setThreshold('');
        fetchMiners();
      } else {
        const errData = await res.json().catch(() => ({}));
        setStatus(`Error: ${errData.error || 'Failed to set threshold'}`);
        addLog('Failed to set threshold', 'error');
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      addLog(`Error: ${err.message}`, 'error');
    }
  };

  const handleStartAllMiners = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!res.ok) {
        addLog(data.error || 'Failed to start mining', 'warning');
      } else {
        fetchMiners();
      }
    } catch {
      addLog('Could not start mining', 'error');
    }
  };

  const handleStopAllMiners = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!res.ok) {
        addLog(data.error || 'Failed to stop mining', 'warning');
      } else {
        fetchMiners();
      }
    } catch {
      addLog('Could not stop mining', 'error');
    }
  };

  const handleCreateOrder = async () => {
    const price = Number(orderPrice);
    const amount = Number(orderAmount);

    if (!orderClientId) {
      addLog('Select a client account for the order', 'warning');
      return;
    }

    if (!Number.isFinite(price) || price <= 0) {
      addLog('Price must be positive', 'warning');
      return;
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      addLog('Amount must be positive', 'warning');
      return;
    }

    try {
      const res = await fetch(`${BACKEND_URL}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: orderClientId,
          side: orderSide,
          type: 'limit',
          price,
          amount,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        addLog(data.error || 'Order rejected', 'error');
        return;
      }

      addLog(`Order #${data.order.id} created (${orderSide.toUpperCase()})`, 'success');
      if (data.matched) {
        addLog(`Order #${data.order.id} matched immediately`, 'success');
      }
      setOrderPrice('');
      setOrderAmount('');

      fetchAccounts();
      fetchOrders();
      fetchTrades();
      fetchOwnerFees();
    } catch (err) {
      addLog(`Order error: ${err.message}`, 'error');
    }
  };

  const handleCancelOrder = async (orderId) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/orders/${orderId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) {
        addLog(data.error || `Could not cancel order #${orderId}`, 'error');
        return;
      }

      addLog(`Order #${orderId} cancelled`, 'warning');
      fetchAccounts();
      fetchOrders();
      fetchTrades();
      fetchOwnerFees();
    } catch (err) {
      addLog(`Cancel error: ${err.message}`, 'error');
    }
  };

  const getStatusClass = (minerStatus) => {
    if (!minerStatus) return '';
    const s = minerStatus.toLowerCase();
    if (s.includes('ready')) return 'status-threshold';
    if (s.includes('mining')) return 'status-mining';
    if (s.includes('stopped')) return 'status-stopped';
    if (s.includes('threshold')) return 'status-threshold';
    return '';
  };

  const getMinerStatusText = (miner) => {
    if (miner.threshold_met) return 'ready to transfer';
    if (miner.status === 'mining') return 'mining';
    return miner.status || 'idle';
  };

  const getStatusIndicator = (miner) => {
    if (miner.threshold_met) return 'threshold';
    if (miner.status === 'mining' || (miner.status && !miner.status.includes('idle'))) return 'active';
    return 'idle';
  };

  const getBackendStatusColor = () => {
    if (backendStatus === 'connected') return '#3fb950';
    if (backendStatus === 'connecting') return '#f7931a';
    return '#da3633';
  };

  const traderAccounts = [...accounts]
    .filter((a) => a.type !== 'owner')
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const sortedAccounts = [...accounts].sort((a, b) => {
    const typeOrder = { client: 0, miner: 1, owner: 2 };
    const typeDiff = (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3);
    if (typeDiff !== 0) return typeDiff;

    const numA = parseInt(String(a.id || '').replace('client_', '').replace('miner-', ''), 10) || 0;
    const numB = parseInt(String(b.id || '').replace('client_', '').replace('miner-', ''), 10) || 0;
    return numA - numB;
  });

  const clientAccounts = sortedAccounts.filter((a) => a.type === 'client');
  const minerAccounts = sortedAccounts.filter((a) => a.type === 'miner');
  const ownerAccount = sortedAccounts.find((a) => a.type === 'owner');

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
        <h1>Simulated Bitcoin Exchange - Phase 2</h1>
        <div className="header-status">
          <div className="status-indicator" style={{ backgroundColor: getBackendStatusColor() }}></div>
          <span>{backendStatus === 'connected' ? 'Connected' : backendStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}</span>
        </div>
      </header>

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
            <div className="status-label">Owner Fees (BTC)</div>
            <div className="status-value">{formatBtc(ownerFees)}</div>
          </div>
        </div>
      </section>

      <section className="section mining-control-section">
        <h2>Mining Control (Phase 1 Base)</h2>
        <div className="threshold-controls">
          <input
            type="number"
            placeholder="BTC threshold (e.g., 1)"
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

      <section className="section trading-section">
        <h2>Trading Panel (Phase 2)</h2>
        <div className="trading-grid">
          <div className="order-form">
            <label>Client / Trader</label>
            <select value={orderClientId} onChange={(e) => setOrderClientId(e.target.value)}>
              <option value="">Select account</option>
              {traderAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.id} - {a.name}</option>
              ))}
            </select>

            <label>Side</label>
            <select value={orderSide} onChange={(e) => setOrderSide(e.target.value)}>
              <option value="buy">Limit Buy</option>
              <option value="sell">Limit Sell</option>
            </select>

            <label>Price (USD per BTC)</label>
            <input type="number" min="0" step="0.01" value={orderPrice} onChange={(e) => setOrderPrice(e.target.value)} placeholder="e.g. 50000" />

            <label>Amount (BTC)</label>
            <input type="number" min="0" step="0.00000001" value={orderAmount} onChange={(e) => setOrderAmount(e.target.value)} placeholder="e.g. 0.25" />

            <button className="btn-primary" onClick={handleCreateOrder}>Create Limit Order</button>
          </div>

          <div className="owner-fee-card">
            <h3>Exchange Owner Fee</h3>
            <p className="owner-fee-value">{formatBtc(ownerFees)} BTC</p>
            {ownerAccount && (
              <p className="owner-meta">
                Account: {ownerAccount.id} | Available BTC: {formatBtc(ownerAccount.btc_available)}
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="section orders-section">
        <h2>Open Orders ({openOrders.length})</h2>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Client</th>
                <th>Side</th>
                <th>Type</th>
                <th>Price</th>
                <th>Amount BTC</th>
                <th>Reserved USD</th>
                <th>Reserved BTC</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {openOrders.length === 0 ? (
                <tr><td colSpan="10" className="empty-row">No open orders.</td></tr>
              ) : (
                openOrders.map((order) => (
                  <tr key={order.id}>
                    <td>{order.id}</td>
                    <td>{order.client_id}</td>
                    <td>{order.side.toUpperCase()}</td>
                    <td>{order.type}</td>
                    <td>{formatUsd(order.price)}</td>
                    <td>{formatBtc(order.amount)}</td>
                    <td>{formatUsd(order.reserved_usd)}</td>
                    <td>{formatBtc(order.reserved_btc)}</td>
                    <td>{formatDate(order.created_at)}</td>
                    <td>
                      <button className="btn-inline-cancel" onClick={() => handleCancelOrder(order.id)}>Cancel</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section trades-section">
        <h2>Completed Trades ({trades.length})</h2>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Buy Order</th>
                <th>Sell Order</th>
                <th>Buyer</th>
                <th>Seller</th>
                <th>Price</th>
                <th>Gross BTC</th>
                <th>Owner Fee BTC</th>
                <th>Buyer Net BTC</th>
                <th>USD Amount</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 ? (
                <tr><td colSpan="11" className="empty-row">No completed trades yet.</td></tr>
              ) : (
                trades.map((trade) => (
                  <tr key={trade.id}>
                    <td>{trade.id}</td>
                    <td>{trade.buy_order_id}</td>
                    <td>{trade.sell_order_id}</td>
                    <td>{trade.buyer_id}</td>
                    <td>{trade.seller_id}</td>
                    <td>{formatUsd(trade.price)}</td>
                    <td>{formatBtc(trade.btc_amount_gross)}</td>
                    <td>{formatBtc(trade.btc_fee_owner)}</td>
                    <td>{formatBtc(trade.btc_amount_net_to_buyer)}</td>
                    <td>{formatUsd(trade.usd_amount)}</td>
                    <td>{formatDate(trade.created_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section completed-orders-section">
        <h2>Completed / Cancelled Orders ({completedOrders.length})</h2>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Client</th>
                <th>Side</th>
                <th>Price</th>
                <th>Amount BTC</th>
                <th>Status</th>
                <th>Created</th>
                <th>Closed</th>
              </tr>
            </thead>
            <tbody>
              {completedOrders.length === 0 ? (
                <tr><td colSpan="8" className="empty-row">No completed or cancelled orders yet.</td></tr>
              ) : (
                completedOrders.map((order) => (
                  <tr key={order.id}>
                    <td>{order.id}</td>
                    <td>{order.client_id}</td>
                    <td>{order.side.toUpperCase()}</td>
                    <td>{formatUsd(order.price)}</td>
                    <td>{formatBtc(order.amount)}</td>
                    <td>{order.status}</td>
                    <td>{formatDate(order.created_at)}</td>
                    <td>{formatDate(order.closed_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section miners-section">
        <h2>Miners ({miners.length})</h2>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Miner #</th>
                <th>Blocks</th>
                <th>BTC Mined (Accum.)</th>
                <th>BTC Matured (Accum.)</th>
                <th>BTC Sent to Exchange (Accum.)</th>
                <th>BTC Sent to Treasury/Fee (Accum.)</th>
                <th>BTC Matured Remaining</th>
                <th>BTC Immature</th>
                <th>Threshold</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {miners.length === 0 ? (
                <tr>
                  <td colSpan="11" className="empty-row">No miner data available.</td>
                </tr>
              ) : (
                [...miners].sort((a, b) => {
                  const numA = parseInt(a.miner_id?.replace('miner-', '') || 0, 10);
                  const numB = parseInt(b.miner_id?.replace('miner-', '') || 0, 10);
                  return numA - numB;
                }).map((miner, idx) => {
                  const minerId = miner.miner_id || miner.id || `miner-${idx + 1}`;
                  const num = minerId.replace('miner-', '').replace('miner_', '');
                  const statusText = getMinerStatusText(miner);
                  const statusIndicator = getStatusIndicator(miner);
                  return (
                    <tr key={minerId} className={`miner-row status-${statusIndicator}`}>
                      <td className="indicator-cell"><div className={`status-dot ${statusIndicator}`}></div></td>
                      <td>{num}</td>
                      <td>{miner.blocks_mined ?? 0}</td>
                      <td><span className="btc-mined">{formatBtc(miner.btc_mined_total ?? miner.btc_gained)}</span></td>
                      <td>{formatBtc(miner.btc_matured_total)}</td>
                      <td><span className="btc-transfer">{formatBtc(miner.btc_transferred_exchange_total)}</span></td>
                      <td>{formatBtc(miner.btc_spent_elsewhere_total)}</td>
                      <td><span className="btc-remaining">{formatBtc(miner.btc_matured_remaining ?? miner.btc_available)}</span></td>
                      <td><span className="btc-immature">{formatBtc(miner.btc_immature)}</span></td>
                      <td>{formatBtc(miner.threshold ?? currentThreshold ?? 0)}</td>
                      <td><span className={`status-badge ${getStatusClass(statusText)}`}>{statusText}</span></td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <p className="miner-balance-note">
          Equation: <strong>Matured Accumulated = Sent to Exchange + Sent to Treasury/Fee + Matured Remaining</strong>.
        </p>
      </section>

      <section className="section accounts-section">
        <div className="section-heading-row">
          <h2>Client Accounts ({clientAccounts.length})</h2>
          <div className="pagination-controls">
            <button onClick={() => setClientPage((page) => Math.max(1, page - 1))} disabled={safeClientPage === 1}>Previous</button>
            <span>Page {safeClientPage} of {totalClientPages}</span>
            <button onClick={() => setClientPage((page) => Math.min(totalClientPages, page + 1))} disabled={safeClientPage === totalClientPages}>Next</button>
          </div>
        </div>
        <AccountsTable rows={visibleClientAccounts} />
      </section>

      <section className="section accounts-section">
        <h2>Miner Exchange Accounts ({minerAccounts.length})</h2>
        <AccountsTable rows={minerAccounts} />
      </section>

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
    </div>
  );
}

function AccountsTable({ rows }) {
  return (
    <div className="table-container">
      <table>
        <thead>
          <tr>
            <th>Account ID</th>
            <th>Name</th>
            <th>Type</th>
            <th>BTC Available</th>
            <th>BTC Reserved</th>
            <th>BTC Total</th>
            <th>USD Available</th>
            <th>USD Reserved</th>
            <th>USD Total</th>
            <th>Open Orders</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan="10" className="empty-row">No accounts loaded.</td>
            </tr>
          ) : (
            rows.map((account) => (
              <tr key={account.id}>
                <td>{account.id}</td>
                <td>{account.name}</td>
                <td>
                  <span className={`type-badge type-${account.type || 'unknown'}`}>
                    {account.type || 'unknown'}
                  </span>
                </td>
                <td>{formatBtc(account.btc_available)}</td>
                <td>{formatBtc(account.btc_reserved)}</td>
                <td>{formatBtc(account.btc_balance)}</td>
                <td>{formatUsd(account.usd_available)}</td>
                <td>{formatUsd(account.usd_reserved)}</td>
                <td>{formatUsd(account.usd_balance)}</td>
                <td>
                  <span className={`open-orders-badge ${account.has_open_orders ? 'yes' : 'no'}`}>
                    {account.open_orders_count || 0}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function formatBtc(value) {
  if (value === undefined || value === null) return '0.00000000';
  return Number(value).toFixed(8);
}

function formatUsd(value) {
  if (value === undefined || value === null) return '$0.00';
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString();
}

export default App;
