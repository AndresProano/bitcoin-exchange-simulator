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

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

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
    INSERT OR IGNORE INTO miners (miner_id, blocks_mined, btc_gained, btc_mature, btc_available, status, threshold_met)
    VALUES (?, 0, 0, 0, 0, 'idle', 0)
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
    INSERT INTO miners (miner_id, blocks_mined, btc_gained, btc_mature, btc_available, status, threshold_met)
    VALUES (@miner_id, @blocks_mined, @btc_gained, @btc_mature, @btc_available, @status, @threshold_met)
    ON CONFLICT(miner_id) DO UPDATE SET
      blocks_mined  = @blocks_mined,
      btc_gained    = @btc_gained,
      btc_mature    = @btc_mature,
      btc_available = @btc_available,
      status        = @status,
      threshold_met = @threshold_met
  `);
  stmts.getAllMiners = db.prepare('SELECT * FROM miners ORDER BY miner_id');
  stmts.getAllAccounts = db.prepare('SELECT * FROM accounts ORDER BY type, id');
  stmts.getAccount = db.prepare('SELECT * FROM accounts WHERE id = ?');
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

async function bitcoinRpc(method, params = [], wallet = null) {
  const url = wallet
    ? `${BITCOIN_RPC_URL}/wallet/${wallet}`
    : BITCOIN_RPC_URL;

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

// ---------------------------------------------------------------------------
// Wallet / address bootstrap (runs once on startup)
// ---------------------------------------------------------------------------
async function initBitcoinWallets() {
  const maxRetries = 30;
  const retryDelay = 5000; // 5 seconds

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[BTC] Attempting to connect to Bitcoin Core (attempt ${attempt}/${maxRetries})...`);

      // Check that the node is responding
      const info = await bitcoinRpc('getblockchaininfo');
      console.log(`[BTC] Connected. Chain: ${info.chain}, Blocks: ${info.blocks}`);

      // ----- Exchange wallet -----
      try {
        await bitcoinRpc('createwallet', ['exchange']);
        console.log('[BTC] Created "exchange" wallet.');
      } catch (err) {
        if (err.message && err.message.includes('already exists')) {
          console.log('[BTC] "exchange" wallet already exists, loading...');
          try { await bitcoinRpc('loadwallet', ['exchange']); } catch (_) { /* already loaded */ }
        } else {
          throw err;
        }
      }

      // ----- Treasury wallet -----
      try {
        await bitcoinRpc('createwallet', ['treasury']);
        console.log('[BTC] Created "treasury" wallet.');
      } catch (err) {
        if (err.message && err.message.includes('already exists')) {
          console.log('[BTC] "treasury" wallet already exists, loading...');
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

      console.log(`[BTC] Exchange deposit address: ${exchangeAddress}`);
      console.log(`[BTC] Treasury address:         ${treasuryAddress}`);
      return;

    } catch (err) {
      console.error(`[BTC] Connection attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, retryDelay));
      } else {
        console.error('[BTC] Could not connect to Bitcoin Core after all retries. Continuing without wallet setup.');
        console.error('[BTC] Addresses can be configured later via the API or by restarting once the node is available.');
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

// ---- Threshold ----------------------------------------------------------

app.get('/api/threshold', (_req, res) => {
  const row = stmts.getSetting.get('threshold');
  res.json({ threshold: row ? parseFloat(row.value) : 0 });
});

app.post('/api/threshold', async (req, res) => {
  const { threshold } = req.body;
  if (threshold === undefined || typeof threshold !== 'number' || threshold < 0) {
    return res.status(400).json({ error: 'Invalid threshold. Must be a non-negative number.' });
  }

  // Persist locally
  stmts.setSetting.run('threshold', String(threshold));
  console.log(`[Threshold] Set to ${threshold} BTC`);

  // Forward to all 10 miners concurrently
  const results = [];
  const promises = [];

  for (let i = 1; i <= MINER_COUNT; i++) {
    const minerUrl = `http://miner-${i}:5000/threshold`;
    // Also send exchange addresses so miners know where to deposit
    const depositRow = stmts.getSetting.get('exchange_deposit_address');
    const treasuryRow = stmts.getSetting.get('treasury_address');
    const payload = {
      threshold,
      exchange_deposit_address: depositRow ? depositRow.value : '',
      treasury_address: treasuryRow ? treasuryRow.value : '',
    };
    const promise = axios
      .post(minerUrl, payload, { timeout: 5000 })
      .then(() => {
        results.push({ miner: `miner-${i}`, status: 'ok' });
      })
      .catch(err => {
        console.error(`[Threshold] Failed to reach miner-${i}: ${err.message}`);
        results.push({ miner: `miner-${i}`, status: 'error', message: err.message });
      });
    promises.push(promise);
  }

  await Promise.all(promises);

  // Notify connected frontends via socket.io
  io.emit('threshold-updated', { threshold });

  res.json({ threshold, miners: results });
});

// ---- Miner updates (called by miners) -----------------------------------

app.post('/api/miner-update', (req, res) => {
  const { miner_id, blocks_mined, btc_gained, btc_mature, btc_available } = req.body;

  if (!miner_id) {
    return res.status(400).json({ error: 'miner_id is required.' });
  }

  const thresholdRow = stmts.getSetting.get('threshold');
  const threshold = thresholdRow ? parseFloat(thresholdRow.value) : 0;
  const threshold_met = (btc_mature || 0) >= threshold && threshold > 0 ? 1 : 0;

  const data = {
    miner_id,
    blocks_mined: blocks_mined || 0,
    btc_gained: btc_gained || 0,
    btc_mature: btc_mature || 0,
    btc_available: btc_available || 0,
    status: 'mining',
    threshold_met,
  };

  stmts.upsertMiner.run(data);

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

app.post('/api/exchange/deposit', (req, res) => {
  const { miner_id, amount } = req.body;

  if (!miner_id || amount === undefined || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'miner_id and a positive amount are required.' });
  }

  const accountId = miner_id;
  const accountName = `Miner ${miner_id.replace('miner-', '')}`;

  // Create account if it does not exist, otherwise credit
  stmts.upsertMinerAccount.run(accountId, accountName, amount, amount);

  const updated = stmts.getAccount.get(accountId);

  // Notify frontends
  io.emit('deposit', { miner_id, amount, account: updated });

  console.log(`[Exchange] Deposit: ${amount} BTC from ${miner_id}. New balance: ${updated.btc_balance} BTC`);

  res.json({ status: 'ok', account: updated });
});

app.get('/api/exchange/addresses', (_req, res) => {
  const depositRow = stmts.getSetting.get('exchange_deposit_address');
  const treasuryRow = stmts.getSetting.get('treasury_address');

  res.json({
    exchange_deposit_address: depositRow ? depositRow.value : '',
    treasury_address: treasuryRow ? treasuryRow.value : '',
  });
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on port ${PORT}`);
});

// Fire-and-forget wallet init (non-blocking so the server is ready immediately)
initBitcoinWallets().catch(err => {
  console.error('[BTC] Wallet initialization error:', err.message);
});
