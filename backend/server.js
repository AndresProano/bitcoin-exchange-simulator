const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

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
const MINER_BROADCAST_RETRIES = 5;
const MINER_BROADCAST_TIMEOUT = 15000;
const DEBUG_MODE = false;
const OWNER_FEE_RATE = 0.02;
const BTC_EPSILON = 1e-8;

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
  if (level === 'debug' && !DEBUG_MODE) return;

  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({
    timestamp,
    event,
    level,
    ...data,
  }));
}

function nowIso() {
  return new Date().toISOString();
}

function roundBTC(value) {
  return Number((Number(value) || 0).toFixed(8));
}

function roundUSD(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function formatBtcForDetails(value) {
  return roundBTC(value).toFixed(8);
}

function formatUsdForDetails(value) {
  return roundUSD(value).toFixed(2);
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nearEqualBTC(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= BTC_EPSILON;
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

function validateOrderInput({ side, type, price, amount }) {
  if (!['buy', 'sell'].includes(side)) {
    return { valid: false, error: 'side must be buy or sell' };
  }

  if (type !== 'limit') {
    return { valid: false, error: 'Only limit orders are supported in this phase' };
  }

  if (!isPositiveNumber(price)) {
    return { valid: false, error: 'price must be a positive number' };
  }

  if (!isPositiveNumber(amount)) {
    return { valid: false, error: 'amount must be a positive number' };
  }

  return { valid: true };
}

function validateTransferInput({ amount, destinationAddress }) {
  if (!isPositiveNumber(amount)) {
    return { valid: false, error: 'amount must be a positive number' };
  }

  if (!destinationAddress || typeof destinationAddress !== 'string') {
    return { valid: false, error: 'destinationAddress is required' };
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
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

let stmts = {};

function tableExists(tableName) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
}

function migrateAccountsTable() {
  const exists = tableExists('accounts');

  if (!exists) {
    db.exec(`
      CREATE TABLE accounts (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        type          TEXT NOT NULL CHECK(type IN ('miner', 'client', 'owner')),
        btc_balance   REAL DEFAULT 0,
        usd_balance   REAL DEFAULT 0,
        btc_available REAL DEFAULT 0,
        btc_reserved  REAL DEFAULT 0,
        usd_available REAL DEFAULT 0,
        usd_reserved  REAL DEFAULT 0
      );
    `);
    return;
  }

  const oldCols = db.prepare(`PRAGMA table_info(accounts)`).all().map((c) => c.name);
  const createSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='accounts'`).get();
  const sqlText = (createSql && createSql.sql) || '';
  const hasOwnerInCheck = sqlText.includes("'owner'") || sqlText.includes('"owner"');

  const hasAllColumns = [
    'btc_available',
    'btc_reserved',
    'usd_available',
    'usd_reserved',
  ].every((name) => oldCols.includes(name));

  if (hasOwnerInCheck && hasAllColumns) {
    db.exec(`
      UPDATE accounts
      SET
        btc_available = ROUND(COALESCE(btc_available, 0), 8),
        btc_reserved = ROUND(COALESCE(btc_reserved, 0), 8),
        usd_available = ROUND(COALESCE(usd_available, 0), 2),
        usd_reserved = ROUND(COALESCE(usd_reserved, 0), 2),
        btc_balance = ROUND(COALESCE(btc_available, 0) + COALESCE(btc_reserved, 0), 8),
        usd_balance = ROUND(COALESCE(usd_available, 0) + COALESCE(usd_reserved, 0), 2)
    `);
    return;
  }

  const colExpr = (col, fallbackExpr) => (oldCols.includes(col) ? `COALESCE(${col}, ${fallbackExpr})` : fallbackExpr);

  const btcReservedExpr = colExpr('btc_reserved', '0');
  const usdReservedExpr = colExpr('usd_reserved', '0');

  const btcAvailFallback = `MAX(0, COALESCE(btc_balance, 0) - (${btcReservedExpr}))`;
  const usdAvailFallback = `MAX(0, COALESCE(usd_balance, 0) - (${usdReservedExpr}))`;

  const btcAvailableExpr = colExpr('btc_available', btcAvailFallback);
  const usdAvailableExpr = colExpr('usd_available', usdAvailFallback);

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE accounts_v2 (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        type          TEXT NOT NULL CHECK(type IN ('miner', 'client', 'owner')),
        btc_balance   REAL DEFAULT 0,
        usd_balance   REAL DEFAULT 0,
        btc_available REAL DEFAULT 0,
        btc_reserved  REAL DEFAULT 0,
        usd_available REAL DEFAULT 0,
        usd_reserved  REAL DEFAULT 0
      );
    `);

    db.exec(`
      INSERT INTO accounts_v2 (
        id,
        name,
        type,
        btc_balance,
        usd_balance,
        btc_available,
        btc_reserved,
        usd_available,
        usd_reserved
      )
      SELECT
        id,
        name,
        CASE
          WHEN type IN ('miner', 'client', 'owner') THEN type
          ELSE 'client'
        END,
        ROUND(COALESCE(btc_balance, 0), 8),
        ROUND(COALESCE(usd_balance, 0), 2),
        ROUND(${btcAvailableExpr}, 8),
        ROUND(${btcReservedExpr}, 8),
        ROUND(${usdAvailableExpr}, 2),
        ROUND(${usdReservedExpr}, 2)
      FROM accounts
    `);

    db.exec(`
      UPDATE accounts_v2
      SET
        btc_balance = ROUND(COALESCE(btc_available, 0) + COALESCE(btc_reserved, 0), 8),
        usd_balance = ROUND(COALESCE(usd_available, 0) + COALESCE(usd_reserved, 0), 2)
    `);

    db.exec('DROP TABLE accounts');
    db.exec('ALTER TABLE accounts_v2 RENAME TO accounts');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS miners (
      miner_id      TEXT PRIMARY KEY,
      blocks_mined  INTEGER DEFAULT 0,
      btc_gained    REAL    DEFAULT 0,
      btc_mature    REAL    DEFAULT 0,
      btc_immature  REAL    DEFAULT 0,
      btc_available REAL    DEFAULT 0,
      status        TEXT    DEFAULT 'idle',
      threshold_met INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS deposits (
      txid        TEXT PRIMARY KEY,
      miner_id    TEXT NOT NULL,
      amount      REAL NOT NULL,
      created_at  TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id     TEXT NOT NULL,
      side          TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
      type          TEXT NOT NULL CHECK(type IN ('limit')),
      price         REAL NOT NULL,
      amount        REAL NOT NULL,
      status        TEXT NOT NULL CHECK(status IN ('open', 'completed', 'cancelled')) DEFAULT 'open',
      reserved_usd  REAL DEFAULT 0,
      reserved_btc  REAL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS trades (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      buy_order_id             INTEGER NOT NULL,
      sell_order_id            INTEGER NOT NULL,
      buyer_id                 TEXT NOT NULL,
      seller_id                TEXT NOT NULL,
      price                    REAL NOT NULL,
      btc_amount_gross         REAL NOT NULL,
      btc_fee_owner            REAL NOT NULL,
      btc_amount_net_to_buyer  REAL NOT NULL,
      usd_amount               REAL NOT NULL,
      created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status_side_price_time
      ON orders(status, side, price, created_at, id);

    CREATE INDEX IF NOT EXISTS idx_orders_client_status
      ON orders(client_id, status, created_at, id);

    CREATE INDEX IF NOT EXISTS idx_trades_created_at
      ON trades(created_at, id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS client_btc_history (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id           TEXT NOT NULL,
      account_identifier  TEXT NOT NULL,
      client_name_snapshot TEXT NOT NULL,
      event_type          TEXT NOT NULL CHECK(event_type IN ('BUY_BTC', 'SELL_BTC', 'TRANSFER_BTC')),
      btc_amount          REAL NOT NULL,
      price_per_btc       REAL,
      details_text        TEXT NOT NULL,
      related_trade_id    INTEGER,
      related_txid        TEXT,
      created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_client_btc_history_client_time
      ON client_btc_history(client_id, created_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_client_btc_history_created_at
      ON client_btc_history(created_at DESC, id DESC);
  `);

  migrateAccountsTable();

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

  // Seed the 30 client accounts if they do not already exist
  const insertAccount = db.prepare(`
    INSERT OR IGNORE INTO accounts (
      id,
      name,
      type,
      btc_balance,
      usd_balance,
      btc_available,
      btc_reserved,
      usd_available,
      usd_reserved
    )
    VALUES (?, ?, 'client', 0, 30000, 0, 0, 30000, 0)
  `);

  const seedClients = db.transaction(() => {
    for (let i = 1; i <= 30; i++) {
      const id = `client_${i}`;
      insertAccount.run(id, `Client ${i}`);
    }
  });
  seedClients();

  // Seed owner account for fee accrual
  db.prepare(`
    INSERT OR IGNORE INTO accounts (
      id,
      name,
      type,
      btc_balance,
      usd_balance,
      btc_available,
      btc_reserved,
      usd_available,
      usd_reserved
    )
    VALUES ('owner', 'Exchange Owner', 'owner', 0, 0, 0, 0, 0, 0)
  `).run();

  // Seed miner rows
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

  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('threshold', '0')`).run();
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('exchange_deposit_address', '')`).run();
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('treasury_address', '')`).run();

  // Keep totals consistent (legacy data compatibility)
  db.exec(`
    UPDATE accounts
    SET
      btc_available = ROUND(COALESCE(btc_available, 0), 8),
      btc_reserved = ROUND(COALESCE(btc_reserved, 0), 8),
      usd_available = ROUND(COALESCE(usd_available, 0), 2),
      usd_reserved = ROUND(COALESCE(usd_reserved, 0), 2),
      btc_balance = ROUND(COALESCE(btc_available, 0) + COALESCE(btc_reserved, 0), 8),
      usd_balance = ROUND(COALESCE(usd_available, 0) + COALESCE(usd_reserved, 0), 2)
  `);

  logStructured('db_initialized', 'info', { db_path: DB_PATH });
}

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
  stmts.getMinerById = db.prepare('SELECT * FROM miners WHERE miner_id = ?');
  stmts.getMinerDepositTotal = db.prepare('SELECT ROUND(COALESCE(SUM(amount), 0), 8) AS total FROM deposits WHERE miner_id = ?');

  stmts.getAllAccounts = db.prepare(`
    SELECT
      a.*,
      COALESCE(oo.open_orders_count, 0) AS open_orders_count
    FROM accounts a
    LEFT JOIN (
      SELECT client_id, COUNT(*) AS open_orders_count
      FROM orders
      WHERE status = 'open'
      GROUP BY client_id
    ) oo ON oo.client_id = a.id
    ORDER BY
      CASE a.type WHEN 'client' THEN 0 WHEN 'miner' THEN 1 WHEN 'owner' THEN 2 ELSE 3 END,
      CASE
        WHEN a.id LIKE 'client_%' THEN CAST(SUBSTR(a.id, 8) AS INTEGER)
        WHEN a.id LIKE 'miner-%' THEN CAST(SUBSTR(a.id, 7) AS INTEGER)
        ELSE 999999
      END,
      a.id
  `);

  stmts.getAccount = db.prepare('SELECT * FROM accounts WHERE id = ?');
  stmts.getAccountWithOpenOrders = db.prepare(`
    SELECT
      a.*,
      COALESCE(oo.open_orders_count, 0) AS open_orders_count
    FROM accounts a
    LEFT JOIN (
      SELECT client_id, COUNT(*) AS open_orders_count
      FROM orders
      WHERE status = 'open'
      GROUP BY client_id
    ) oo ON oo.client_id = a.id
    WHERE a.id = ?
  `);

  stmts.updateAccountBalances = db.prepare(`
    UPDATE accounts
    SET
      btc_available = @btc_available,
      btc_reserved = @btc_reserved,
      usd_available = @usd_available,
      usd_reserved = @usd_reserved,
      btc_balance = @btc_balance,
      usd_balance = @usd_balance
    WHERE id = @id
  `);

  stmts.getDeposit = db.prepare('SELECT * FROM deposits WHERE txid = ?');
  stmts.insertDeposit = db.prepare('INSERT INTO deposits (txid, miner_id, amount) VALUES (?, ?, ?)');
  stmts.upsertMinerAccount = db.prepare(`
    INSERT INTO accounts (
      id,
      name,
      type,
      btc_balance,
      usd_balance,
      btc_available,
      btc_reserved,
      usd_available,
      usd_reserved
    )
    VALUES (?, ?, 'miner', ?, 0, ?, 0, 0, 0)
    ON CONFLICT(id) DO UPDATE SET
      btc_available = ROUND(COALESCE(btc_available, 0) + ?, 8),
      btc_balance = ROUND(COALESCE(btc_balance, 0) + ?, 8)
  `);

  stmts.insertOrder = db.prepare(`
    INSERT INTO orders (
      client_id,
      side,
      type,
      price,
      amount,
      status,
      reserved_usd,
      reserved_btc,
      created_at
    )
    VALUES (@client_id, @side, @type, @price, @amount, 'open', @reserved_usd, @reserved_btc, @created_at)
  `);

  stmts.getOrderById = db.prepare('SELECT * FROM orders WHERE id = ?');
  stmts.getOpenOrderById = db.prepare('SELECT * FROM orders WHERE id = ? AND status = \'open\'');
  stmts.completeOrder = db.prepare('UPDATE orders SET status = \'completed\', closed_at = ? WHERE id = ?');
  stmts.cancelOrder = db.prepare('UPDATE orders SET status = \'cancelled\', closed_at = ? WHERE id = ?');

  stmts.findSellCandidatesForBuy = db.prepare(`
    SELECT *
    FROM orders
    WHERE status = 'open'
      AND side = 'sell'
      AND id != @order_id
      AND price <= @price
    ORDER BY price ASC, created_at ASC, id ASC
  `);

  stmts.findBuyCandidatesForSell = db.prepare(`
    SELECT *
    FROM orders
    WHERE status = 'open'
      AND side = 'buy'
      AND id != @order_id
      AND price >= @price
    ORDER BY price DESC, created_at ASC, id ASC
  `);

  stmts.insertTrade = db.prepare(`
    INSERT INTO trades (
      buy_order_id,
      sell_order_id,
      buyer_id,
      seller_id,
      price,
      btc_amount_gross,
      btc_fee_owner,
      btc_amount_net_to_buyer,
      usd_amount,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmts.getOpenOrders = db.prepare(`
    SELECT o.*,
           b.name AS client_name
    FROM orders o
    JOIN accounts b ON b.id = o.client_id
    WHERE o.status = 'open'
    ORDER BY o.created_at ASC, o.id ASC
  `);

  stmts.getCompletedOrders = db.prepare(`
    SELECT o.*,
           b.name AS client_name
    FROM orders o
    JOIN accounts b ON b.id = o.client_id
    WHERE o.status IN ('completed', 'cancelled')
    ORDER BY COALESCE(o.closed_at, o.created_at) DESC, o.id DESC
    LIMIT 200
  `);

  stmts.getTrades = db.prepare(`
    SELECT *
    FROM trades
    ORDER BY created_at DESC, id DESC
    LIMIT 200
  `);

  stmts.getOwnerAccount = db.prepare(`SELECT * FROM accounts WHERE id = 'owner'`);
  stmts.insertHistoryEvent = db.prepare(`
    INSERT INTO client_btc_history (
      client_id,
      account_identifier,
      client_name_snapshot,
      event_type,
      btc_amount,
      price_per_btc,
      details_text,
      related_trade_id,
      related_txid,
      created_at
    )
    VALUES (
      @client_id,
      @account_identifier,
      @client_name_snapshot,
      @event_type,
      @btc_amount,
      @price_per_btc,
      @details_text,
      @related_trade_id,
      @related_txid,
      @created_at
    )
  `);
  stmts.getAccountHistory = db.prepare(`
    SELECT
      id,
      client_id,
      account_identifier,
      client_name_snapshot,
      event_type,
      btc_amount,
      price_per_btc,
      details_text,
      related_trade_id,
      related_txid,
      created_at
    FROM client_btc_history
    WHERE client_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 500
  `);
}

function normalizeAccount(account) {
  return {
    ...account,
    btc_available: roundBTC(account.btc_available),
    btc_reserved: roundBTC(account.btc_reserved),
    usd_available: roundUSD(account.usd_available),
    usd_reserved: roundUSD(account.usd_reserved),
    btc_balance: roundBTC(account.btc_available + account.btc_reserved),
    usd_balance: roundUSD(account.usd_available + account.usd_reserved),
  };
}

function saveAccount(account) {
  const normalized = normalizeAccount(account);
  stmts.updateAccountBalances.run({
    id: normalized.id,
    btc_available: normalized.btc_available,
    btc_reserved: normalized.btc_reserved,
    usd_available: normalized.usd_available,
    usd_reserved: normalized.usd_reserved,
    btc_balance: normalized.btc_balance,
    usd_balance: normalized.usd_balance,
  });
  return normalized;
}

function buildHistoryDetails(eventType, { btcAmount, pricePerBtc, destinationAddress, txid }) {
  if (eventType === 'BUY_BTC') {
    return `Received ${formatBtcForDetails(btcAmount)} BTC at $${formatUsdForDetails(pricePerBtc)} per BTC`;
  }

  if (eventType === 'SELL_BTC') {
    return `Sold ${formatBtcForDetails(btcAmount)} BTC at $${formatUsdForDetails(pricePerBtc)} per BTC`;
  }

  if (eventType === 'TRANSFER_BTC') {
    let details = `Transferred ${formatBtcForDetails(btcAmount)} BTC out of the exchange`;
    if (destinationAddress) {
      details += ` to ${destinationAddress}`;
    }
    if (txid) {
      details += ` (txid: ${txid})`;
    }
    return details;
  }

  return `BTC event: ${formatBtcForDetails(btcAmount)} BTC`;
}

function insertHistoryEvent({
  clientId,
  clientName,
  eventType,
  btcAmount,
  pricePerBtc = null,
  detailsText,
  relatedTradeId = null,
  relatedTxid = null,
  createdAt = nowIso(),
}) {
  stmts.insertHistoryEvent.run({
    client_id: clientId,
    account_identifier: clientId,
    client_name_snapshot: clientName,
    event_type: eventType,
    btc_amount: roundBTC(btcAmount),
    price_per_btc: pricePerBtc === null ? null : roundUSD(pricePerBtc),
    details_text: detailsText,
    related_trade_id: relatedTradeId,
    related_txid: relatedTxid,
    created_at: createdAt,
  });
}

function mapHistoryEvent(row) {
  return {
    id: row.id,
    accountIdentifier: row.account_identifier,
    clientId: row.client_id,
    clientName: row.client_name_snapshot,
    timestamp: row.created_at,
    eventType: row.event_type,
    eventDetails: row.details_text,
    btcAmount: roundBTC(row.btc_amount),
    pricePerBtc: row.price_per_btc === null ? null : roundUSD(row.price_per_btc),
    relatedTradeId: row.related_trade_id,
    relatedTxid: row.related_txid,
  };
}

function getCurrentThreshold() {
  const thresholdRow = stmts.getSetting.get('threshold');
  return thresholdRow ? Number(thresholdRow.value || 0) : 0;
}

function normalizeMinerSnapshot(miner, threshold = getCurrentThreshold()) {
  const minedTotal = roundBTC(miner.btc_gained || 0);
  const immatureNow = roundBTC(miner.btc_immature || 0);
  const matureAvailableNow = roundBTC(miner.btc_available || 0);
  const maturedTotal = roundBTC(Math.max(0, minedTotal - immatureNow));

  const transferRow = stmts.getMinerDepositTotal.get(miner.miner_id);
  const transferredExchangeTotal = roundBTC(transferRow ? transferRow.total : 0);

  // Matured BTC can leave the miner wallet in two directions:
  // 1) Exchange deposit address (counted in deposits table)
  // 2) Treasury / network fees (tracked as "spent elsewhere")
  const maturedSpentTotal = roundBTC(Math.max(0, maturedTotal - matureAvailableNow));
  const spentElsewhereTotal = roundBTC(Math.max(0, maturedSpentTotal - transferredExchangeTotal));
  const maturedRemaining = roundBTC(Math.max(0, maturedTotal - transferredExchangeTotal - spentElsewhereTotal));

  return {
    ...miner,
    btc_gained: minedTotal,
    btc_immature: immatureNow,
    btc_available: matureAvailableNow,
    btc_mined_total: minedTotal,
    btc_matured_total: maturedTotal,
    btc_transferred_exchange_total: transferredExchangeTotal,
    btc_spent_elsewhere_total: spentElsewhereTotal,
    btc_matured_remaining: maturedRemaining,
    threshold: roundBTC(threshold),
    threshold_met: threshold > 0 && matureAvailableNow + BTC_EPSILON >= threshold ? 1 : 0,
  };
}

function getMinerSnapshots() {
  const threshold = getCurrentThreshold();
  return stmts.getAllMiners.all().map((miner) => normalizeMinerSnapshot(miner, threshold));
}

function getMinerSnapshot(minerId) {
  const miner = stmts.getMinerById.get(minerId);
  if (!miner) return null;
  return normalizeMinerSnapshot(miner, getCurrentThreshold());
}

function getTradingEligibleAccountOrThrow(clientId) {
  const account = stmts.getAccount.get(clientId);
  if (!account) {
    throw new Error('Account not found');
  }
  if (account.type === 'owner') {
    throw new Error('Owner account cannot place orders');
  }
  return account;
}

function getTransferEligibleAccountOrThrow(clientId) {
  const account = stmts.getAccount.get(clientId);
  if (!account) {
    throw new Error('Account not found');
  }
  if (account.type === 'owner') {
    throw new Error('Owner account cannot transfer BTC');
  }
  return account;
}

function reserveFundsForOrder(account, side, price, amount) {
  const updated = { ...account };

  if (side === 'sell') {
    const needed = roundBTC(amount);
    if (roundBTC(updated.btc_available) + BTC_EPSILON < needed) {
      throw new Error('Insufficient available BTC');
    }
    updated.btc_available = roundBTC(updated.btc_available - needed);
    updated.btc_reserved = roundBTC(updated.btc_reserved + needed);
    return {
      account: saveAccount(updated),
      reserved_btc: needed,
      reserved_usd: 0,
    };
  }

  const neededUsd = roundUSD(price * amount);
  if (roundUSD(updated.usd_available) + 0.0001 < neededUsd) {
    throw new Error('Insufficient available USD');
  }
  updated.usd_available = roundUSD(updated.usd_available - neededUsd);
  updated.usd_reserved = roundUSD(updated.usd_reserved + neededUsd);

  return {
    account: saveAccount(updated),
    reserved_btc: 0,
    reserved_usd: neededUsd,
  };
}

function pickMatchingCandidate(order) {
  const candidates = order.side === 'buy'
    ? stmts.findSellCandidatesForBuy.all({ order_id: order.id, price: order.price })
    : stmts.findBuyCandidatesForSell.all({ order_id: order.id, price: order.price });

  // Phase 2 decision: no partial fills. Match only with a single opposite order of equal amount.
  return candidates.find((candidate) => nearEqualBTC(candidate.amount, order.amount)) || null;
}

function settleTradeNoPartial(takerOrder, makerOrder) {
  const buyOrder = takerOrder.side === 'buy' ? takerOrder : makerOrder;
  const sellOrder = takerOrder.side === 'sell' ? takerOrder : makerOrder;

  const buyer = stmts.getAccount.get(buyOrder.client_id);
  const seller = stmts.getAccount.get(sellOrder.client_id);
  const owner = stmts.getOwnerAccount.get();

  if (!buyer || !seller || !owner) {
    throw new Error('Trade settlement account missing');
  }

  const amount = roundBTC(takerOrder.amount);
  const tradePrice = roundUSD(makerOrder.price);
  const usdAmount = roundUSD(tradePrice * amount);
  const btcFee = roundBTC(amount * OWNER_FEE_RATE);
  const btcNetToBuyer = roundBTC(amount - btcFee);

  if (roundBTC(seller.btc_reserved) + BTC_EPSILON < amount) {
    throw new Error('Seller reserved BTC is insufficient for settlement');
  }

  if (roundUSD(buyOrder.reserved_usd) + 0.0001 < usdAmount) {
    throw new Error('Buyer reserved USD is insufficient for settlement');
  }

  const buyerUpdated = { ...buyer };
  const sellerUpdated = { ...seller };
  const ownerUpdated = { ...owner };

  // Buyer: consume all reservation for the order, pay executed USD, return any extra reservation.
  buyerUpdated.usd_reserved = roundUSD(buyerUpdated.usd_reserved - buyOrder.reserved_usd);
  const buyRefund = roundUSD(buyOrder.reserved_usd - usdAmount);
  buyerUpdated.usd_available = roundUSD(buyerUpdated.usd_available + buyRefund);
  buyerUpdated.btc_available = roundBTC(buyerUpdated.btc_available + btcNetToBuyer);

  // Seller: consume reserved BTC and credit USD proceeds.
  sellerUpdated.btc_reserved = roundBTC(sellerUpdated.btc_reserved - sellOrder.reserved_btc);
  sellerUpdated.usd_available = roundUSD(sellerUpdated.usd_available + usdAmount);

  // Owner: fee in BTC.
  ownerUpdated.btc_available = roundBTC(ownerUpdated.btc_available + btcFee);

  saveAccount(buyerUpdated);
  saveAccount(sellerUpdated);
  saveAccount(ownerUpdated);

  const closedAt = nowIso();
  stmts.completeOrder.run(closedAt, buyOrder.id);
  stmts.completeOrder.run(closedAt, sellOrder.id);

  const tradeAt = nowIso();
  const insertResult = stmts.insertTrade.run(
    buyOrder.id,
    sellOrder.id,
    buyOrder.client_id,
    sellOrder.client_id,
    tradePrice,
    amount,
    btcFee,
    btcNetToBuyer,
    usdAmount,
    tradeAt,
  );

  insertHistoryEvent({
    clientId: buyOrder.client_id,
    clientName: buyer.name,
    eventType: 'BUY_BTC',
    btcAmount: btcNetToBuyer,
    pricePerBtc: tradePrice,
    detailsText: buildHistoryDetails('BUY_BTC', { btcAmount: btcNetToBuyer, pricePerBtc: tradePrice }),
    relatedTradeId: insertResult.lastInsertRowid,
    createdAt: tradeAt,
  });

  insertHistoryEvent({
    clientId: sellOrder.client_id,
    clientName: seller.name,
    eventType: 'SELL_BTC',
    btcAmount: amount,
    pricePerBtc: tradePrice,
    detailsText: buildHistoryDetails('SELL_BTC', { btcAmount: amount, pricePerBtc: tradePrice }),
    relatedTradeId: insertResult.lastInsertRowid,
    createdAt: tradeAt,
  });

  return {
    id: insertResult.lastInsertRowid,
    buy_order_id: buyOrder.id,
    sell_order_id: sellOrder.id,
    buyer_id: buyOrder.client_id,
    seller_id: sellOrder.client_id,
    price: tradePrice,
    btc_amount_gross: amount,
    btc_fee_owner: btcFee,
    btc_amount_net_to_buyer: btcNetToBuyer,
    usd_amount: usdAmount,
    created_at: tradeAt,
    maker_order_id: makerOrder.id,
    taker_order_id: takerOrder.id,
  };
}

const createOrderWithMatchingTx = db.transaction((payload) => {
  const account = getTradingEligibleAccountOrThrow(payload.clientId);

  const { reserved_btc, reserved_usd } = reserveFundsForOrder(
    account,
    payload.side,
    payload.price,
    payload.amount,
  );

  const insert = stmts.insertOrder.run({
    client_id: payload.clientId,
    side: payload.side,
    type: payload.type,
    price: roundUSD(payload.price),
    amount: roundBTC(payload.amount),
    reserved_usd,
    reserved_btc,
    created_at: nowIso(),
  });

  const newOrder = stmts.getOrderById.get(insert.lastInsertRowid);
  const candidate = pickMatchingCandidate(newOrder);

  let trade = null;
  if (candidate) {
    trade = settleTradeNoPartial(newOrder, candidate);
  }

  const orderAfter = stmts.getOrderById.get(newOrder.id);

  return {
    order: orderAfter,
    trade,
  };
});

const cancelOrderTx = db.transaction((orderId) => {
  const order = stmts.getOpenOrderById.get(orderId);
  if (!order) {
    throw new Error('Open order not found');
  }

  const account = stmts.getAccount.get(order.client_id);
  if (!account) {
    throw new Error('Order account not found');
  }

  const updated = { ...account };

  if (order.side === 'buy') {
    if (roundUSD(updated.usd_reserved) + 0.0001 < roundUSD(order.reserved_usd)) {
      throw new Error('Reserved USD inconsistency during cancel');
    }
    updated.usd_reserved = roundUSD(updated.usd_reserved - order.reserved_usd);
    updated.usd_available = roundUSD(updated.usd_available + order.reserved_usd);
  } else {
    if (roundBTC(updated.btc_reserved) + BTC_EPSILON < roundBTC(order.reserved_btc)) {
      throw new Error('Reserved BTC inconsistency during cancel');
    }
    updated.btc_reserved = roundBTC(updated.btc_reserved - order.reserved_btc);
    updated.btc_available = roundBTC(updated.btc_available + order.reserved_btc);
  }

  saveAccount(updated);
  stmts.cancelOrder.run(nowIso(), orderId);

  return stmts.getOrderById.get(orderId);
});

const recordTransferTx = db.transaction(({ clientId, amount, txid, destinationAddress }) => {
  const account = getTransferEligibleAccountOrThrow(clientId);
  const updated = { ...account };
  const needed = roundBTC(amount);

  if (roundBTC(updated.btc_available) + BTC_EPSILON < needed) {
    throw new Error('Insufficient available BTC');
  }

  updated.btc_available = roundBTC(updated.btc_available - needed);
  const saved = saveAccount(updated);
  const createdAt = nowIso();

  insertHistoryEvent({
    clientId: saved.id,
    clientName: saved.name,
    eventType: 'TRANSFER_BTC',
    btcAmount: needed,
    detailsText: buildHistoryDetails('TRANSFER_BTC', {
      btcAmount: needed,
      destinationAddress,
      txid,
    }),
    relatedTxid: txid,
    createdAt,
  });

  return {
    account: saved,
    createdAt,
  };
});

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
// Wallet / address bootstrap
// ---------------------------------------------------------------------------
async function initBitcoinWallets() {
  const maxRetries = 30;
  const retryDelay = 5000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const info = await bitcoinRpc('getblockchaininfo');
      logStructured('bitcoin_connected', 'info', {
        chain: info.chain,
        blocks: info.blocks,
      });

      try {
        await bitcoinRpc('createwallet', ['exchange']);
      } catch (err) {
        if (err.message && err.message.includes('already exists')) {
          try { await bitcoinRpc('loadwallet', ['exchange']); } catch (_) {}
        } else {
          throw err;
        }
      }

      try {
        await bitcoinRpc('createwallet', ['treasury']);
      } catch (err) {
        if (err.message && err.message.includes('already exists')) {
          try { await bitcoinRpc('loadwallet', ['treasury']); } catch (_) {}
        } else {
          throw err;
        }
      }

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
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Exchange operations helpers (on-chain deposit verification)
// ---------------------------------------------------------------------------
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
  if (amountDiff > BTC_EPSILON) {
    return { valid: false, error: `Amount mismatch. Expected: ${expectedAmount}, Got: ${totalToExpected}` };
  }

  return { valid: true, confirmations, amount: totalToExpected, source };
}

async function verifyOnChainTransaction(txid, expectedAddress, expectedAmount) {
  const errors = [];
  let pendingResult = null;

  for (const rpcUrl of BITCOIN_RPC_URLS) {
    try {
      const rawTx = await bitcoinRpcAt(rpcUrl, 'getrawtransaction', [txid, true]);
      const result = validateVerifiedTx(txid, rawTx, expectedAddress, expectedAmount, rpcUrl);
      if (result.valid) return result;
      if (result.pending) pendingResult = result;
      errors.push(`${rpcUrl}: ${result.error}`);
    } catch (err) {
      errors.push(`${rpcUrl} getrawtransaction: ${err.message}`);
    }
  }

  try {
    const walletTx = await bitcoinRpc('gettransaction', [txid], 'exchange');
    const result = validateVerifiedTx(txid, walletTx, expectedAddress, expectedAmount, `${BITCOIN_RPC_URL}/wallet/exchange`);
    if (result.valid) return result;
    if (result.pending) pendingResult = result;
    errors.push(`exchange wallet: ${result.error}`);
  } catch (err) {
    errors.push(`exchange wallet gettransaction: ${err.message}`);
  }

  if (pendingResult) return pendingResult;
  return { valid: false, error: errors.join(' | ') };
}

async function validateDestinationAddress(destinationAddress) {
  try {
    const validation = await bitcoinRpc('validateaddress', [destinationAddress]);
    if (!validation || !validation.isvalid) {
      return { valid: false, error: 'Destination address is not a valid regtest address' };
    }
    return { valid: true, validation };
  } catch (err) {
    return { valid: false, error: 'Could not validate destination address' };
  }
}

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: nowIso() });
});

app.post('/api/miner-register', (req, res) => {
  const { miner_id } = req.body;
  if (!miner_id) return res.status(400).json({ error: 'miner_id required' });
  updateMinerStatus(miner_id, true);
  res.json({ status: 'registered', miner_id });
});

app.get('/api/diagnostics', async (_req, res) => {
  try {
    const blockchainInfo = await bitcoinRpc('getblockchaininfo');
    const connectedMiners = Object.values(minerStatus).filter(s => s.connected).length;
    const depRow = stmts.getSetting.get('exchange_deposit_address');
    const thresholdRow = stmts.getSetting.get('threshold');

    res.json({
      timestamp: nowIso(),
      bitcoin: {
        blocks: blockchainInfo.blocks,
        bestblockhash: blockchainInfo.bestblockhash,
      },
      exchange: {
        deposit_address_configured: depRow && depRow.value ? 'YES' : 'NO',
        threshold_set: thresholdRow ? `YES (${thresholdRow.value} BTC)` : 'NO',
      },
      miners: {
        connected: connectedMiners,
        total: MINER_COUNT,
      },
      status: 'ok',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
      timestamp: nowIso(),
    });
  } catch (err) {
    res.status(503).json({
      backend: 'ok',
      blockchain: { blocks: 0, chain: 'unknown', difficulty: 0 },
      miners: {
        total: MINER_COUNT,
        connected: getConnectedMinersCount(),
      },
      error: 'Bitcoin node unreachable',
      timestamp: nowIso(),
    });
  }
});

app.get('/api/threshold', (_req, res) => {
  res.json({ threshold: getCurrentThreshold() });
});

app.post('/api/threshold', async (req, res) => {
  const threshold = parseFloat(req.body.threshold);

  if (isNaN(threshold) || threshold < 0 || !isFinite(threshold)) {
    return res.status(400).json({ error: 'Threshold must be a valid positive number' });
  }

  stmts.setSetting.run('threshold', String(threshold));

  const results = [];
  const promises = [];

  for (let i = 1; i <= MINER_COUNT; i++) {
    const minerId = `miner-${i}`;
    const minerUrl = `http://${minerId}:5000/threshold`;

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
          validateStatus: (status) => status < 500,
        });
        updateMinerStatus(minerId, true);
        results.push({ miner: minerId, status: 'ok' });
      },
      MINER_BROADCAST_RETRIES,
      500
    ).catch(err => {
      updateMinerStatus(minerId, false);
      results.push({ miner: minerId, status: 'error', message: err.message });
    });

    promises.push(promise);
  }

  await Promise.all(promises);
  io.emit('threshold-updated', { threshold });
  io.emit('miners-updated', getMinerSnapshots());

  res.json({ threshold, miners: results });
});

app.post('/api/start', async (_req, res) => {
  const thresholdRow = stmts.getSetting.get('threshold');
  const threshold = thresholdRow ? parseFloat(thresholdRow.value) : null;

  if (!threshold || threshold <= 0) {
    return res.status(400).json({ error: 'Threshold must be set first', miners_started: 0 });
  }

  const results = [];
  const promises = [];

  for (let i = 1; i <= MINER_COUNT; i++) {
    const minerId = `miner-${i}`;
    const minerUrl = `http://${minerId}:5000/start`;

    const promise = retryWithBackoff(
      async () => {
        const response = await axios.post(minerUrl, {}, { timeout: MINER_BROADCAST_TIMEOUT });
        if (response.status >= 200 && response.status < 300) {
          updateMinerStatus(minerId, true);
          results.push({ miner: minerId, status: 'started' });
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      },
      MINER_BROADCAST_RETRIES,
      1000
    ).catch(err => {
      updateMinerStatus(minerId, false);
      results.push({ miner: minerId, status: 'error', message: err.message });
    });

    promises.push(promise);
  }

  await Promise.all(promises);
  const successCount = results.filter(r => r.status === 'started').length;

  io.emit('mining-started', { miners_started: successCount });

  res.json({
    status: successCount > 0 ? 'ok' : 'partial',
    miners_started: successCount,
    miners_total: MINER_COUNT,
    details: results,
  });
});

app.post('/api/stop', async (_req, res) => {
  const results = [];
  const promises = [];

  for (let i = 1; i <= MINER_COUNT; i++) {
    const minerId = `miner-${i}`;
    const minerUrl = `http://${minerId}:5000/stop`;

    const promise = retryWithBackoff(
      async () => {
        const response = await axios.post(minerUrl, {}, { timeout: MINER_BROADCAST_TIMEOUT });
        if (response.status >= 200 && response.status < 300) {
          results.push({ miner: minerId, status: 'stopped' });
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      },
      MINER_BROADCAST_RETRIES,
      1000
    ).catch(err => {
      results.push({ miner: minerId, status: 'error', message: err.message });
    });

    promises.push(promise);
  }

  await Promise.all(promises);
  const successCount = results.filter(r => r.status === 'stopped').length;

  io.emit('mining-stopped', { miners_stopped: successCount });

  res.json({
    status: successCount > 0 ? 'ok' : 'partial',
    miners_stopped: successCount,
    miners_total: MINER_COUNT,
    details: results,
  });
});

app.post('/api/miner-update', (req, res) => {
  const { miner_id, blocks_mined, btc_gained, btc_mature, btc_available, btc_immature } = req.body;

  const minerValidation = validateMinerId(miner_id);
  if (!minerValidation.valid) {
    return res.status(400).json({ error: minerValidation.error });
  }

  const btcValidations = {
    blocks_mined: { value: blocks_mined },
    btc_gained: { value: btc_gained },
    btc_mature: { value: btc_mature },
    btc_available: { value: btc_available },
    btc_immature: { value: btc_immature },
  };

  for (const [field, config] of Object.entries(btcValidations)) {
    if (config.value !== undefined) {
      const validation = validateBTCValue(config.value, field);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
    }
  }

  updateMinerStatus(miner_id, true);

  const threshold = getCurrentThreshold();
  const existing = stmts.getMinerById.get(miner_id);
  const currentMature = roundBTC(btc_available || btc_mature || 0);
  const threshold_met = threshold > 0 && currentMature + BTC_EPSILON >= threshold ? 1 : 0;

  const data = {
    miner_id,
    // Keep these counters monotonic to avoid regressions after miner restarts.
    blocks_mined: Math.max(Math.floor(blocks_mined || 0), Math.floor(existing?.blocks_mined || 0)),
    btc_gained: Math.max(roundBTC(btc_gained || 0), roundBTC(existing?.btc_gained || 0)),
    btc_mature: currentMature,
    btc_available: currentMature,
    btc_immature: roundBTC(btc_immature || 0),
    status: 'mining',
    threshold_met,
  };

  stmts.upsertMiner.run(data);
  const snapshot = getMinerSnapshot(miner_id);
  io.emit('miner-update', snapshot || data);

  res.json({ status: 'ok', ...(snapshot || data) });
});

app.get('/api/miners', (_req, res) => {
  res.json(getMinerSnapshots());
});

app.get('/api/accounts', (_req, res) => {
  const accounts = stmts.getAllAccounts.all().map((a) => ({
    ...a,
    btc_available: roundBTC(a.btc_available),
    btc_reserved: roundBTC(a.btc_reserved),
    usd_available: roundUSD(a.usd_available),
    usd_reserved: roundUSD(a.usd_reserved),
    btc_balance: roundBTC(a.btc_balance),
    usd_balance: roundUSD(a.usd_balance),
    has_open_orders: Number(a.open_orders_count || 0) > 0,
  }));
  res.json(accounts);
});

app.get('/api/accounts/:id', (req, res) => {
  const account = stmts.getAccountWithOpenOrders.get(req.params.id);
  if (!account) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  res.json({
    ...account,
    has_open_orders: Number(account.open_orders_count || 0) > 0,
  });
});

app.get('/api/clients/:clientId/history', (req, res) => {
  const account = stmts.getAccount.get(req.params.clientId);
  if (!account) {
    return res.status(404).json({ error: 'Client account not found.' });
  }

  const events = stmts.getAccountHistory.all(req.params.clientId).map(mapHistoryEvent);
  res.json({
    clientId: account.id,
    clientName: account.name,
    order: 'desc',
    events,
  });
});

app.get('/api/owner/fees', (_req, res) => {
  const owner = stmts.getOwnerAccount.get();
  if (!owner) {
    return res.status(500).json({ error: 'Owner account not found' });
  }

  res.json({
    owner_id: owner.id,
    owner_name: owner.name,
    fee_btc_total: roundBTC(owner.btc_available),
    owner_account: {
      ...owner,
      btc_balance: roundBTC(owner.btc_balance),
      btc_available: roundBTC(owner.btc_available),
      btc_reserved: roundBTC(owner.btc_reserved),
      usd_balance: roundUSD(owner.usd_balance),
      usd_available: roundUSD(owner.usd_available),
      usd_reserved: roundUSD(owner.usd_reserved),
    },
  });
});

app.post('/api/orders', (req, res) => {
  const side = String(req.body.side || '').toLowerCase();
  const type = String(req.body.type || 'limit').toLowerCase();
  const clientId = req.body.clientId || req.body.client_id;
  const price = Number(req.body.price);
  const amount = Number(req.body.amount);

  const validation = validateOrderInput({ side, type, price, amount });
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  if (!clientId || typeof clientId !== 'string') {
    return res.status(400).json({ error: 'clientId is required' });
  }

  try {
    const result = createOrderWithMatchingTx({
      clientId,
      side,
      type,
      price,
      amount,
    });

    io.emit('orders-updated', { timestamp: nowIso() });
    if (result.trade) {
      io.emit('trade-executed', result.trade);
    }

    res.status(201).json({
      status: 'ok',
      order: result.order,
      trade: result.trade,
      matched: !!result.trade,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/orders/open', (_req, res) => {
  const orders = stmts.getOpenOrders.all().map((o) => ({
    ...o,
    price: roundUSD(o.price),
    amount: roundBTC(o.amount),
    reserved_usd: roundUSD(o.reserved_usd),
    reserved_btc: roundBTC(o.reserved_btc),
  }));
  res.json(orders);
});

app.get('/api/orders/completed', (_req, res) => {
  const orders = stmts.getCompletedOrders.all().map((o) => ({
    ...o,
    price: roundUSD(o.price),
    amount: roundBTC(o.amount),
    reserved_usd: roundUSD(o.reserved_usd),
    reserved_btc: roundBTC(o.reserved_btc),
  }));
  res.json(orders);
});

app.delete('/api/orders/completed', (_req, res) => {
  const result = db.prepare(`DELETE FROM orders WHERE status IN ('completed', 'cancelled')`).run();
  io.emit('orders-updated', { timestamp: nowIso() });
  res.json({ status: 'ok', deleted: result.changes });
});

app.post('/api/orders/:id/cancel', (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ error: 'Invalid order id' });
  }

  try {
    const cancelledOrder = cancelOrderTx(orderId);
    io.emit('orders-updated', { timestamp: nowIso() });
    res.json({ status: 'ok', order: cancelledOrder });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/trades', (_req, res) => {
  const trades = stmts.getTrades.all().map((t) => ({
    ...t,
    price: roundUSD(t.price),
    btc_amount_gross: roundBTC(t.btc_amount_gross),
    btc_fee_owner: roundBTC(t.btc_fee_owner),
    btc_amount_net_to_buyer: roundBTC(t.btc_amount_net_to_buyer),
    usd_amount: roundUSD(t.usd_amount),
  }));
  res.json(trades);
});

app.post('/api/clients/:clientId/transfer-btc', async (req, res) => {
  const clientId = req.params.clientId;
  const amount = Number(req.body.amount);
  const destinationAddress = String(req.body.destinationAddress || '').trim();

  const validation = validateTransferInput({ amount, destinationAddress });
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  try {
    const account = getTransferEligibleAccountOrThrow(clientId);
    const addressValidation = await validateDestinationAddress(destinationAddress);
    if (!addressValidation.valid) {
      return res.status(400).json({ error: addressValidation.error });
    }

    if (roundBTC(account.btc_available) + BTC_EPSILON < roundBTC(amount)) {
      return res.status(400).json({ error: 'Insufficient available BTC' });
    }

    const walletBalances = await bitcoinRpc('getbalances', [], 'exchange');
    const exchangeTrustedBtc = Number(walletBalances?.mine?.trusted || 0);
    if (exchangeTrustedBtc + BTC_EPSILON < roundBTC(amount)) {
      return res.status(400).json({ error: 'Exchange wallet does not have enough spendable BTC for this transfer' });
    }

    const txid = await bitcoinRpc('sendtoaddress', [destinationAddress, roundBTC(amount)], 'exchange');
    const result = recordTransferTx({
      clientId,
      amount,
      txid,
      destinationAddress,
    });

    const events = stmts.getAccountHistory.all(clientId).map(mapHistoryEvent);
    io.emit('orders-updated', { timestamp: nowIso() });
    io.emit('history-updated', { clientId, timestamp: result.createdAt });

    res.status(201).json({
      status: 'ok',
      txid,
      account: result.account,
      history: {
        clientId,
        order: 'desc',
        events,
      },
    });
  } catch (err) {
    logStructured('btc_transfer_failed', 'warning', {
      client_id: clientId,
      error: err.message,
    });

    const status = err.message === 'Account not found' ? 404 : 400;
    res.status(status).json({ error: err.message || 'BTC transfer failed' });
  }
});

app.post('/api/exchange/deposit', async (req, res) => {
  const { miner_id, amount, txid } = req.body;

  const minerValidation = validateMinerId(miner_id);
  if (!minerValidation.valid) {
    return res.status(400).json({ error: minerValidation.error });
  }

  const amountValidation = validateBTCValue(amount, 'amount');
  if (!amountValidation.valid) {
    return res.status(400).json({ error: amountValidation.error });
  }

  if (!txid || typeof txid !== 'string' || txid.length !== 64) {
    return res.status(400).json({ error: 'txid must be a valid 64-character hex string for on-chain verification.' });
  }

  const depositRow = stmts.getSetting.get('exchange_deposit_address');
  const exchangeAddress = depositRow ? depositRow.value : '';

  if (!exchangeAddress) {
    return res.status(500).json({ error: 'Exchange deposit address not configured.' });
  }

  const verification = await verifyOnChainTransaction(txid, exchangeAddress, amount);
  if (!verification.valid) {
    return res.status(400).json({
      error: `Transaction verification failed: ${verification.error}`,
      txid,
      miner_id,
    });
  }

  const accountId = miner_id;
  const accountName = `Miner ${miner_id.replace('miner-', '')}`;

  const existingDeposit = stmts.getDeposit.get(txid);
  if (existingDeposit) {
    const existingAccount = stmts.getAccount.get(accountId);
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
    stmts.upsertMinerAccount.run(accountId, accountName, amount, amount, amount, amount);
    return stmts.getAccount.get(accountId);
  });

  const updated = creditDeposit();
  const thresholdRow = stmts.getSetting.get('threshold');
  const threshold = thresholdRow ? parseFloat(thresholdRow.value) : 0;

  io.emit('deposit', {
    miner_id,
    amount,
    threshold,
    txid,
    confirmations: verification.confirmations,
    account: updated,
  });
  const snapshot = getMinerSnapshot(miner_id);
  if (snapshot) {
    io.emit('miner-update', snapshot);
  }

  res.json({ status: 'ok', account: updated, txid, confirmations: verification.confirmations });
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
  const miners = getMinerSnapshots();
  socket.emit('initial-state', {
    miners,
    threshold: getCurrentThreshold(),
  });

  socket.on('disconnect', () => {});
});

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------
initDatabase();
prepareStatements();
initMinerStatus();

server.listen(PORT, '0.0.0.0', () => {
  logStructured('server_started', 'info', { port: PORT, db_path: DB_PATH });
});

initBitcoinWallets().catch(err => {
  logStructured('wallet_initialization_error', 'error', { error: err.message });
});
