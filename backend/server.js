const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const axios = require('axios');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3001;
const BITCOIN_RPC_HOST = process.env.BITCOIN_RPC_HOST || 'node1';
const BITCOIN_RPC_PORT = process.env.BITCOIN_RPC_PORT || '18443';
const BITCOIN_RPC_URL = process.env.BITCOIN_RPC_URL || `http://${BITCOIN_RPC_HOST}:${BITCOIN_RPC_PORT}`;
const BITCOIN_RPC_USER = process.env.BITCOIN_RPC_USER || 'bitcoin';
const BITCOIN_RPC_PASS = process.env.BITCOIN_RPC_PASS || 'bitcoin';
const MINER_COUNT = 10;
const MIN_CONFIRMATIONS = parseInt(process.env.MIN_CONFIRMATIONS || '1', 10);
const MINER_BROADCAST_RETRIES = 5;  // Increased from 3
const MINER_BROADCAST_TIMEOUT = 15000; // Increased from 8000
const DEBUG_MODE = false; // Set to true to see debug logs
const BITCOIN_RPC_URLS = Array.from(new Set(
  (process.env.BITCOIN_RPC_URLS || `${BITCOIN_RPC_URL},http://node2:${BITCOIN_RPC_PORT}`)
    .split(',')
    .map(url => url.trim())
    .filter(Boolean)
));

// ---------------------------------------------------------------------------
// Structured logging helpers
// ---------------------------------------------------------------------------
function logStructured(event, level, data) {
  // Skip debug logs unless DEBUG_MODE is enabled
  if (level === 'debug' && !DEBUG_MODE) {
    return;
  }
  
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({
    timestamp,
    event,
    level,
    ...data,
  }));
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
function validateBTCValue(value, fieldName = 'value') {
  if (value === undefined || value === null) {
    return { valid: false, error: `${fieldName} is required` };
  }
  if (typeof value !== 'number') {
    return { valid: false, error: `${fieldName} must be a number` };
  }
  if (value < 0 || !isFinite(value)) {
    return { valid: false, error: `${fieldName} must be a non-negative finite number` };
  }
  if (value > 21000000) {
    return { valid: false, error: `${fieldName} exceeds maximum BTC supply (21M)` };
  }
  return { valid: true };
}

function validateMinerId(minerId) {
  if (!minerId || typeof minerId !== 'string') {
    return { valid: false, error: 'miner_id must be a non-empty string' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------
async function retryWithBackoff(fn, maxRetries = 3, initialDelayMs = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Miner connectivity tracker
// ---------------------------------------------------------------------------
const minerStatus = {};

function initMinerStatus() {
  for (let i = 1; i <= MINER_COUNT; i++) {
    minerStatus[`miner-${i}`] = { connected: false, lastUpdate: 0 };
  }
}

function updateMinerStatus(minerId, connected = true) {
  if (minerStatus[minerId]) {
    minerStatus[minerId].connected = connected;
    minerStatus[minerId].lastUpdate = Date.now();
  }
}

function getConnectedMinersCount() {
  return Object.values(minerStatus).filter(m => m.connected).length;
}

// ---------------------------------------------------------------------------
// Express + Socket.IO setup
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// SQLite database initialization
// ---------------------------------------------------------------------------
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'exchange.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS miners (
      miner_id     TEXT PRIMARY KEY,
      blocks_mined INTEGER DEFAULT 0,
      btc_gained   REAL    DEFAULT 0,
      btc_mature   REAL    DEFAULT 0,
      btc_immature REAL    DEFAULT 0,
      btc_available REAL   DEFAULT 0,
      status       TEXT    DEFAULT 'idle',
      threshold_met INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL CHECK(type IN ('miner', 'client')),
      btc_balance REAL DEFAULT 0,
      usd_balance REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS deposits (
      txid       TEXT PRIMARY KEY,
      miner_id  TEXT NOT NULL,
      amount    REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const minerColumns = db.prepare(`PRAGMA table_info(miners)`).all().map((col) => col.name);
  const ensureMinerColumn = (name, definition) => {
    if (!minerColumns.includes(name)) {
      db.exec(`ALTER TABLE miners ADD COLUMN ${name} ${definition}`);
    }
  };

  ensureMinerColumn('btc_mature', 'REAL DEFAULT 0');
  ensureMinerColumn('btc_immature', 'REAL DEFAULT 0');
  ensureMinerColumn('btc_available', 'REAL DEFAULT 0');
  ensureMinerColumn('threshold_met', 'INTEGER DEFAULT 0');

  const accountColumns = db.prepare(`PRAGMA table_info(accounts)`).all().map((col) => col.name);
  if (!accountColumns.includes('type')) {
    db.exec(`ALTER TABLE accounts ADD COLUMN type TEXT DEFAULT 'client'`);
  }

  // Seed the 30 client accounts if they do not already exist
  const insertAccount = db.prepare(`
    INSERT OR IGNORE INTO accounts (id, name, type, btc_balance, usd_balance)
    VALUES (?, ?, 'client', 0, 30000)
  `);

  const seedClients = db.transaction(() => {
    for (let i = 1; i <= 30; i++) {
      const id = `client_${i}`;
      insertAccount.run(id, `Client ${i}`);
    }
  });
  seedClients();

  // Seed miner rows so the frontend has something to display immediately
  const insertMiner = db.prepare(`
    INSERT OR IGNORE INTO miners (miner_id, blocks_mined, btc_gained, btc_mature, btc_immature, btc_available, status, threshold_met)
    VALUES (?, 0, 0, 0, 0, 0, 'idle', 0)
  `);
  const seedMiners = db.transaction(() => {
    for (let i = 1; i <= MINER_COUNT; i++) {
      insertMiner.run(`miner-${i}`);
    }
  });
  seedMiners();

  // Default threshold (0 means "not set yet")
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('threshold', '0')`).run();
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('exchange_deposit_address', '')`).run();
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('treasury_address', '')`).run();

  console.log('[DB] Database initialized with 30 client accounts and 10 miner rows.');
}

// ---------------------------------------------------------------------------
// Prepared statements (created once, reused for speed)
// ---------------------------------------------------------------------------
let stmts = {};

function prepareStatements() {
  stmts.getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  stmts.setSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  stmts.upsertMiner = db.prepare(`
    INSERT INTO miners (miner_id, blocks_mined, btc_gained, btc_mature, btc_immature, btc_available, status, threshold_met)
    VALUES (@miner_id, @blocks_mined, @btc_gained, @btc_mature, @btc_immature, @btc_available, @status, @threshold_met)
    ON CONFLICT(miner_id) DO UPDATE SET
      blocks_mined  = @blocks_mined,
      btc_gained    = @btc_gained,
      btc_mature    = @btc_mature,
      btc_immature  = @btc_immature,
      btc_available = @btc_available,
      status        = @status,
      threshold_met = @threshold_met
  `);
  stmts.getAllMiners = db.prepare('SELECT * FROM miners ORDER BY miner_id');
  stmts.getAllAccounts = db.prepare(`
    SELECT * FROM accounts
    ORDER BY
      CASE type WHEN 'client' THEN 0 WHEN 'miner' THEN 1 ELSE 2 END,
      CAST(REPLACE(REPLACE(id, 'client_', ''), 'miner-', '') AS INTEGER),
      id
  `);
  stmts.getAccount = db.prepare('SELECT * FROM accounts WHERE id = ?');
  stmts.getDeposit = db.prepare('SELECT * FROM deposits WHERE txid = ?');
  stmts.insertDeposit = db.prepare('INSERT INTO deposits (txid, miner_id, amount) VALUES (?, ?, ?)');
  stmts.upsertMinerAccount = db.prepare(`
    INSERT INTO accounts (id, name, type, btc_balance, usd_balance)
    VALUES (?, ?, 'miner', ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      btc_balance = btc_balance + ?
  `);
}

// ---------------------------------------------------------------------------
// Bitcoin Core RPC helper
// ---------------------------------------------------------------------------
let rpcIdCounter = 0;

async function bitcoinRpcAt(baseUrl, method, params = [], wallet = null) {
  const url = wallet
    ? `${baseUrl}/wallet/${wallet}`
    : baseUrl;

  const body = {
    jsonrpc: '1.0',
    id: ++rpcIdCounter,
    method,
    params,
  };

  const response = await axios.post(url, body, {
    auth: { username: BITCOIN_RPC_USER, password: BITCOIN_RPC_PASS },
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });

  if (response.data.error) {
    throw new Error(`Bitcoin RPC error (${method}): ${JSON.stringify(response.data.error)}`);
  }
  return response.data.result;
}

async function bitcoinRpc(method, params = [], wallet = null) {
  return bitcoinRpcAt(BITCOIN_RPC_URL, method, params, wallet);
}

// ---------------------------------------------------------------------------
// Wallet / address bootstrap (runs once on startup)
// ---------------------------------------------------------------------------
async function initBitcoinWallets() {
  const maxRetries = 30;
  const retryDelay = 5000; // 5 seconds

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logStructured('bitcoin_connection_attempt', 'debug', { 
        attempt,
        max_retries: maxRetries,
      });

      // Check that the node is responding
      const info = await bitcoinRpc('getblockchaininfo');
      logStructured('bitcoin_connected', 'info', { 
        chain: info.chain,
        blocks: info.blocks,
      });

      // ----- Exchange wallet -----
      try {
        await bitcoinRpc('createwallet', ['exchange']);
        logStructured('bitcoin_wallet_created', 'debug', { wallet: 'exchange' });
      } catch (err) {
        if (err.message && err.message.includes('already exists')) {
          logStructured('bitcoin_wallet_exists', 'debug', { wallet: 'exchange' });
          try { await bitcoinRpc('loadwallet', ['exchange']); } catch (_) { /* already loaded */ }
        } else {
          throw err;
        }
      }

      // ----- Treasury wallet -----
      try {
        await bitcoinRpc('createwallet', ['treasury']);
        logStructured('bitcoin_wallet_created', 'debug', { wallet: 'treasury' });
      } catch (err) {
        if (err.message && err.message.includes('already exists')) {
          logStructured('bitcoin_wallet_exists', 'debug', { wallet: 'treasury' });
          try { await bitcoinRpc('loadwallet', ['treasury']); } catch (_) { /* already loaded */ }
        } else {
          throw err;
        }
      }

      // Generate addresses
      const exchangeAddress = await bitcoinRpc('getnewaddress', ['exchange_deposit'], 'exchange');
      const treasuryAddress = await bitcoinRpc('getnewaddress', ['treasury_main'], 'treasury');

      stmts.setSetting.run('exchange_deposit_address', exchangeAddress);
      stmts.setSetting.run('treasury_address', treasuryAddress);

      logStructured('bitcoin_addresses_generated', 'info', { 
        exchange_address: exchangeAddress,
        treasury_address: treasuryAddress,
      });
      return;

    } catch (err) {
      logStructured('bitcoin_connection_failed', 'warning', { 
        attempt,
        max_retries: maxRetries,
        error: err.message,
      });
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, retryDelay));
      } else {
        logStructured('bitcoin_connection_exhausted', 'error', { 
          error: 'Could not connect to Bitcoin Core after all retries',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Miner registration endpoint
app.post('/api/miner-register', (req, res) => {
  const { miner_id } = req.body;
  if (!miner_id) {
    return res.status(400).json({ error: 'miner_id required' });
  }
  updateMinerStatus(miner_id, true);
  logStructured('miner_registered', 'info', { miner_id });
  res.json({ status: 'registered', miner_id });
});

// Diagnostic endpoint - see real blockchain height and miner status
app.get('/api/diagnostics', async (_req, res) => {
  try {
    const blockchainInfo = await bitcoinRpc('getblockchaininfo');
    const connectedMiners = Object.values(minerStatus).filter(s => s.connected).length;
    const depRow = stmts.getSetting.get('exchange_deposit_address');
    const thresholdRow = stmts.getSetting.get('threshold');
    
    res.json({
      timestamp: new Date().toISOString(),
      bitcoin: {
        blocks: blockchainInfo.blocks,
        bestblockhash: blockchainInfo.bestblockhash,
      },
      exchange: {
        deposit_address_configured: depRow ? 'YES' : 'NO ⚠️',
        threshold_set: thresholdRow ? `YES (${thresholdRow.value} BTC)` : 'NO',
      },
      miners: {
        connected: connectedMiners,
        total: MINER_COUNT,
      },
      status: 'ok',
    });
  } catch (err) {
    console.error('Diagnostics error:', err);
    res.status(500).json({ error: err.message });
  }
});

// System status (blockchain info + node status + miners)
app.get('/api/system-status', async (_req, res) => {
  try {
    const blockchainInfo = await bitcoinRpc('getblockchaininfo');
    res.json({
      backend: 'ok',
      blockchain: {
        chain: blockchainInfo.chain,
        blocks: blockchainInfo.blocks,
        difficulty: blockchainInfo.difficulty,
        bestblockhash: blockchainInfo.bestblockhash,
      },
      miners: {
        total: MINER_COUNT,
        connected: getConnectedMinersCount(),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logStructured('system_status_fetch_failed', 'error', {
      error: err.message,
    });
    res.status(503).json({
      backend: 'ok',
      blockchain: { blocks: 0, chain: 'unknown', difficulty: 0 },
      miners: {
        total: MINER_COUNT,
        connected: getConnectedMinersCount(),
      },
      error: 'Bitcoin node unreachable',
      timestamp: new Date().toISOString(),
    });
  }
});

// ---- Threshold ----------------------------------------------------------

app.get('/api/threshold', (_req, res) => {
  const row = stmts.getSetting.get('threshold');
  res.json({ threshold: row ? parseFloat(row.value) : 0 });
});

app.post('/api/threshold', async (req, res) => {
  const threshold = parseFloat(req.body.threshold);
  
  // Validate threshold value
  if (isNaN(threshold) || threshold < 0 || !isFinite(threshold)) {
    logStructured('threshold_validation_failed', 'warning', { threshold, error: 'Invalid number' });
    return res.status(400).json({ error: 'Threshold must be a valid positive number' });
  }

  // Persist locally
  stmts.setSetting.run('threshold', String(threshold));
  logStructured('threshold_updated', 'info', { threshold, stored_as: String(threshold) });

  // Forward to all 10 miners with retry logic
  const results = [];
  const promises = [];

  for (let i = 1; i <= MINER_COUNT; i++) {
    const minerId = `miner-${i}`;
    const minerUrl = `http://${minerId}:5000/threshold`;
    
    // Get exchange addresses
    const depositRow = stmts.getSetting.get('exchange_deposit_address');
    const treasuryRow = stmts.getSetting.get('treasury_address');
    const payload = {
      threshold,
      exchange_deposit_address: depositRow ? depositRow.value : '',
      treasury_address: treasuryRow ? treasuryRow.value : '',
    };

    const promise = retryWithBackoff(
      async () => {
        await axios.post(minerUrl, payload, { 
          timeout: MINER_BROADCAST_TIMEOUT,
          validateStatus: (status) => status < 500, // Don't treat 4xx as errors
        });
        updateMinerStatus(minerId, true);
        results.push({ miner: minerId, status: 'ok' });
        logStructured('threshold_broadcast_success', 'debug', { miner: minerId });
      },
      MINER_BROADCAST_RETRIES,
      500
    ).catch(err => {
      updateMinerStatus(minerId, false);
      results.push({ miner: minerId, status: 'error', message: err.message });
      logStructured('threshold_broadcast_failed', 'warning', { 
        miner: minerId, 
        error: err.message,
        retries: MINER_BROADCAST_RETRIES,
      });
    });

    promises.push(promise);
  }

  await Promise.all(promises);

  // Notify connected frontends via socket.io
  io.emit('threshold-updated', { threshold });

  const successCount = results.filter(r => r.status === 'ok').length;
  logStructured('threshold_broadcast_complete', 'info', { 
    threshold, 
    miners_succeeded: successCount,
    miners_failed: results.length - successCount,
  });

  res.json({ threshold, miners: results });
});

// ---- Mining control (start/stop) ----------------------------------------

app.post('/api/start', async (req, res) => {
  logStructured('mining_start_request', 'info');
  
  // Check if threshold is set
  const thresholdRow = stmts.getSetting.get('threshold');
  const threshold = thresholdRow ? parseFloat(thresholdRow.value) : null;
  
  if (!threshold || threshold <= 0) {
    logStructured('mining_start_failed', 'warning', { 
      reason: 'no_threshold_set'
    });
    return res.status(400).json({ 
      error: 'Threshold must be set first', 
      miners_started: 0 
    });
  }
  
  const results = [];
  const promises = [];

  for (let i = 1; i <= MINER_COUNT; i++) {
    const minerId = `miner-${i}`;
    const minerUrl = `http://${minerId}:5000/start`;

    const promise = retryWithBackoff(
      async () => {
        try {
          const response = await axios.post(minerUrl, {}, { 
            timeout: MINER_BROADCAST_TIMEOUT,
          });
          // Accept 2xx responses as success
          if (response.status >= 200 && response.status < 300) {
            updateMinerStatus(minerId, true);
            results.push({ miner: minerId, status: 'started' });
            logStructured('miner_start_success', 'debug', { miner: minerId });
          } else {
            throw new Error(`HTTP ${response.status}`);
          }
        } catch (err) {
          throw err;
        }
      },
      MINER_BROADCAST_RETRIES,
      1000  // Increased backoff from 500ms
    ).catch(err => {
      logStructured('miner_start_error', 'warning', { 
        miner: minerId, 
        error: err.message 
      });
      updateMinerStatus(minerId, false);
      results.push({ miner: minerId, status: 'error', message: err.message });
    });

    promises.push(promise);
  }

  await Promise.all(promises);

  const successCount = results.filter(r => r.status === 'started').length;
  
  logStructured('mining_start_complete', 'info', { 
    miners_started: successCount,
    miners_total: MINER_COUNT,
  });

  // Notify frontends
  io.emit('mining-started', { miners_started: successCount });
  
  res.json({ 
    status: successCount > 0 ? 'ok' : 'partial', 
    miners_started: successCount,
    miners_total: MINER_COUNT,
    details: results
  });
});

app.post('/api/stop', async (req, res) => {
  logStructured('mining_stop_request', 'info');
  
  const results = [];
  const promises = [];

  for (let i = 1; i <= MINER_COUNT; i++) {
    const minerId = `miner-${i}`;
    const minerUrl = `http://${minerId}:5000/stop`;

    const promise = retryWithBackoff(
      async () => {
        try {
          const response = await axios.post(minerUrl, {}, { 
            timeout: MINER_BROADCAST_TIMEOUT,
          });
          // Accept 2xx responses as success
          if (response.status >= 200 && response.status < 300) {
            results.push({ miner: minerId, status: 'stopped' });
            logStructured('miner_stop_success', 'debug', { miner: minerId });
          } else {
            throw new Error(`HTTP ${response.status}`);
          }
        } catch (err) {
          throw err;
        }
      },
      MINER_BROADCAST_RETRIES,
      1000  // Increased backoff from 500ms
    ).catch(err => {
      logStructured('miner_stop_error', 'warning', { 
        miner: minerId, 
        error: err.message 
      });
      results.push({ miner: minerId, status: 'error', message: err.message });
    });

    promises.push(promise);
  }

  await Promise.all(promises);

  const successCount = results.filter(r => r.status === 'stopped').length;
  logStructured('mining_stop_complete', 'info', { 
    miners_stopped: successCount,
    miners_total: MINER_COUNT,
  });

  // Notify frontends
  io.emit('mining-stopped', { miners_stopped: successCount });
  
  res.json({ 
    status: successCount > 0 ? 'ok' : 'partial',
    miners_stopped: successCount,
    miners_total: MINER_COUNT,
    details: results
  });
});

// ---- Miner updates (called by miners) -----------------------------------

app.post('/api/miner-update', (req, res) => {
  const { miner_id, blocks_mined, btc_gained, btc_mature, btc_available, btc_immature } = req.body;

  // Validate miner_id
  const minerValidation = validateMinerId(miner_id);
  if (!minerValidation.valid) {
    logStructured('miner_update_validation_failed', 'warning', { 
      error: minerValidation.error,
    });
    return res.status(400).json({ error: minerValidation.error });
  }

  // Validate numeric fields
  const btcValidations = {
    blocks_mined: { value: blocks_mined, required: false, default: 0 },
    btc_gained: { value: btc_gained, required: false, default: 0 },
    btc_mature: { value: btc_mature, required: false, default: 0 },
    btc_available: { value: btc_available, required: false, default: 0 },
    btc_immature: { value: btc_immature, required: false, default: 0 },
  };

  for (const [field, config] of Object.entries(btcValidations)) {
    if (config.value !== undefined) {
      const validation = validateBTCValue(config.value, field);
      if (!validation.valid) {
        logStructured('miner_update_validation_failed', 'warning', { 
          miner_id,
          field,
          error: validation.error,
        });
        return res.status(400).json({ error: validation.error });
      }
    }
  }

  // Track connected miners
  updateMinerStatus(miner_id, true);

  const thresholdRow = stmts.getSetting.get('threshold');
  const threshold = thresholdRow ? parseFloat(thresholdRow.value) : 0;
  const threshold_met = (btc_mature || 0) >= threshold && threshold > 0 ? 1 : 0;

  const data = {
    miner_id,
    blocks_mined: Math.floor(blocks_mined || 0),
    btc_gained: btc_gained || 0,
    btc_mature: btc_mature || 0,
    btc_available: btc_available || 0,
    btc_immature: btc_immature || 0,
    status: 'mining',
    threshold_met,
  };

  stmts.upsertMiner.run(data);

  // Structured logging
  logStructured('miner_update_received', 'debug', {
    miner_id,
    blocks_mined: data.blocks_mined,
    btc_gained: data.btc_gained,
    btc_available: data.btc_available,
    threshold_met,
  });

  // Log when threshold is met
  if (threshold_met && !req.minerThresholdWasMetBefore) {
    logStructured('miner_threshold_met', 'info', {
      miner_id,
      btc_mature,
      threshold,
    });
  }

  // Push real-time update to all connected frontends
  io.emit('miner-update', data);

  res.json({ status: 'ok', ...data });
});

// ---- Miners list --------------------------------------------------------

app.get('/api/miners', (_req, res) => {
  const miners = stmts.getAllMiners.all();
  res.json(miners);
});

// ---- Accounts -----------------------------------------------------------

app.get('/api/accounts', (_req, res) => {
  const accounts = stmts.getAllAccounts.all();
  res.json(accounts);
});

app.get('/api/accounts/:id', (req, res) => {
  const account = stmts.getAccount.get(req.params.id);
  if (!account) {
    return res.status(404).json({ error: 'Account not found.' });
  }
  res.json(account);
});

// ---- Exchange operations ------------------------------------------------

function totalOutputToAddress(tx, expectedAddress) {
  let total = 0;

  if (Array.isArray(tx.details)) {
    for (const detail of tx.details) {
      if (detail.address === expectedAddress && detail.category === 'receive') {
        total += Number(detail.amount || 0);
      }
    }
  }

  if (Array.isArray(tx.vout)) {
    for (const vout of tx.vout) {
      const script = vout.scriptPubKey || {};
      const addresses = [
        script.address,
        ...(Array.isArray(script.addresses) ? script.addresses : []),
      ].filter(Boolean);

      if (addresses.includes(expectedAddress)) {
        total += Number(vout.value || 0);
      }
    }
  }

  return total;
}

function validateVerifiedTx(txid, tx, expectedAddress, expectedAmount, source) {
  if (!tx) {
    return { valid: false, error: 'Transaction not found' };
  }

  const confirmations = Number(tx.confirmations || 0);
  if (confirmations < MIN_CONFIRMATIONS) {
    return {
      valid: false,
      pending: true,
      error: `Insufficient confirmations. Required: ${MIN_CONFIRMATIONS}, Got: ${confirmations}`,
    };
  }

  const totalToExpected = totalOutputToAddress(tx, expectedAddress);
  if (totalToExpected <= 0) {
    return { valid: false, error: `No output found to address ${expectedAddress}` };
  }

  const amountDiff = Math.abs(totalToExpected - expectedAmount);
  if (amountDiff > 0.00000001) {
    return { valid: false, error: `Amount mismatch. Expected: ${expectedAmount}, Got: ${totalToExpected}` };
  }

  logStructured('transaction_verified', 'debug', {
    txid,
    confirmations,
    amount: totalToExpected,
    address: expectedAddress,
    source,
  });

  return { valid: true, confirmations, amount: totalToExpected, source };
}

// Helper: Verify on-chain transaction on either regtest node.
async function verifyOnChainTransaction(txid, expectedAddress, expectedAmount) {
  const errors = [];
  let pendingResult = null;

  for (const rpcUrl of BITCOIN_RPC_URLS) {
    try {
      const rawTx = await bitcoinRpcAt(rpcUrl, 'getrawtransaction', [txid, true]);
      const result = validateVerifiedTx(txid, rawTx, expectedAddress, expectedAmount, rpcUrl);
      if (result.valid) {
        return result;
      }
      if (result.pending) {
        pendingResult = result;
      }
      errors.push(`${rpcUrl}: ${result.error}`);
    } catch (err) {
      errors.push(`${rpcUrl} getrawtransaction: ${err.message}`);
    }
  }

  // Wallet fallback for the exchange wallet on the primary node. This covers
  // wallet-only transactions if txindex is unavailable.
  try {
    const walletTx = await bitcoinRpc('gettransaction', [txid], 'exchange');
    const result = validateVerifiedTx(txid, walletTx, expectedAddress, expectedAmount, `${BITCOIN_RPC_URL}/wallet/exchange`);
    if (result.valid) {
      return result;
    }
    if (result.pending) {
      pendingResult = result;
    }
    errors.push(`exchange wallet: ${result.error}`);
  } catch (err) {
    errors.push(`exchange wallet gettransaction: ${err.message}`);
  }

  if (pendingResult) {
    return pendingResult;
  }

  const error = errors.join(' | ');
  logStructured('transaction_verification_error', 'warning', {
    txid,
    error,
  });
  return { valid: false, error };
}

app.post('/api/exchange/deposit', async (req, res) => {
  const { miner_id, amount, txid } = req.body;

  // Validate miner_id
  const minerValidation = validateMinerId(miner_id);
  if (!minerValidation.valid) {
    logStructured('deposit_validation_failed', 'warning', { 
      error: minerValidation.error,
    });
    return res.status(400).json({ error: minerValidation.error });
  }

  // Validate amount
  const amountValidation = validateBTCValue(amount, 'amount');
  if (!amountValidation.valid) {
    logStructured('deposit_validation_failed', 'warning', { 
      miner_id,
      error: amountValidation.error,
    });
    return res.status(400).json({ error: amountValidation.error });
  }

  // Validate txid
  if (!txid || typeof txid !== 'string' || txid.length !== 64) {
    logStructured('deposit_validation_failed', 'warning', { 
      miner_id,
      error: 'txid must be a valid 64-character hex string',
    });
    return res.status(400).json({ error: 'txid must be a valid 64-character hex string for on-chain verification.' });
  }

  // Get exchange deposit address
  const depositRow = stmts.getSetting.get('exchange_deposit_address');
  const exchangeAddress = depositRow ? depositRow.value : '';

  if (!exchangeAddress) {
    logStructured('deposit_processing_failed', 'error', { 
      miner_id,
      error: 'Exchange deposit address not configured',
    });
    return res.status(500).json({ error: 'Exchange deposit address not configured.' });
  }

  // Verify transaction on-chain
  logStructured('deposit_verification_started', 'info', { 
    miner_id, 
    txid, 
    amount,
  });

  const verification = await verifyOnChainTransaction(txid, exchangeAddress, amount);

  if (!verification.valid) {
    logStructured('deposit_verification_failed', 'warning', { 
      miner_id, 
      txid,
      error: verification.error,
    });
    return res.status(400).json({ 
      error: `Transaction verification failed: ${verification.error}`,
      txid,
      miner_id
    });
  }

  // Verification passed - credit account
  const accountId = miner_id;
  const accountName = `Miner ${miner_id.replace('miner-', '')}`;

  const existingDeposit = stmts.getDeposit.get(txid);
  if (existingDeposit) {
    const existingAccount = stmts.getAccount.get(accountId);
    logStructured('duplicate_deposit_ignored', 'info', {
      miner_id,
      txid,
      amount,
    });
    return res.json({
      status: 'ok',
      duplicate: true,
      account: existingAccount,
      txid,
      confirmations: verification.confirmations,
    });
  }

  const creditDeposit = db.transaction(() => {
    stmts.insertDeposit.run(txid, miner_id, amount);
    stmts.upsertMinerAccount.run(accountId, accountName, amount, amount);
    return stmts.getAccount.get(accountId);
  });

  const updated = creditDeposit();

  // Get threshold for event
  const thresholdRow = stmts.getSetting.get('threshold');
  const threshold = thresholdRow ? parseFloat(thresholdRow.value) : 0;

  // Notify frontends
  io.emit('deposit', { 
    miner_id, 
    amount, 
    threshold,
    txid, 
    confirmations: verification.confirmations, 
    account: updated 
  });

  logStructured('deposit_verified_and_credited', 'info', { 
    miner_id, 
    txid,
    amount,
    confirmations: verification.confirmations,
    new_balance: updated.btc_balance,
  });

  res.json({ status: 'ok', account: updated, txid, confirmations: verification.confirmations });
});

app.get('/api/exchange/addresses', (_req, res) => {
  const depositRow = stmts.getSetting.get('exchange_deposit_address');
  const treasuryRow = stmts.getSetting.get('treasury_address');

  const addresses = {
    exchange_deposit_address: depositRow ? depositRow.value : '',
    treasury_address: treasuryRow ? treasuryRow.value : '',
  };

  // Log address retrieval for diagnostics
  const hasExchange = !!addresses.exchange_deposit_address;
  const hasTreasury = !!addresses.treasury_address;
  
  if (!hasExchange || !hasTreasury) {
    logStructured('addresses_incomplete', 'warning', {
      has_exchange: hasExchange,
      has_treasury: hasTreasury,
    });
  }

  res.json(addresses);
});

// ---------------------------------------------------------------------------
// Socket.IO connection handling
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Send current state on connect so the frontend hydrates immediately
  const miners = stmts.getAllMiners.all();
  socket.emit('initial-state', {
    miners,
    threshold: parseFloat((stmts.getSetting.get('threshold') || { value: '0' }).value),
  });

  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------
initDatabase();
prepareStatements();
initMinerStatus();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on port ${PORT}`);
  logStructured('server_started', 'info', { port: PORT });
});

// Fire-and-forget wallet init (non-blocking so the server is ready immediately)
initBitcoinWallets().catch(err => {
  logStructured('wallet_initialization_error', 'error', { error: err.message });
});
