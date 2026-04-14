================================================================================
Simulated Bitcoin Exchange - Phase 1
CMP-5001-202520 - Aplicaciones Distribuidas
================================================================================

PROJECT TITLE
-------------
Simulated Bitcoin Exchange - Phase 1

This project implements a distributed Bitcoin exchange simulation using two
Bitcoin Core regtest nodes, ten Python miner containers, a Node.js/Express
coordinator, a SQLite exchange database, and a React user interface.

================================================================================

QUICK START (DOCKER HUB)
------------------------

All application images are published on Docker Hub as multi-arch manifests
(linux/amd64 and linux/arm64). Docker will automatically pull the correct
variant for your machine (Intel/AMD, Apple Silicon, ARM servers, etc.).

Pull the images directly:

    docker pull byandyx/btc-backend:latest
    docker pull byandyx/btc-frontend:latest
    docker pull byandyx/btc-miner:latest
    docker pull bitcoin/bitcoin:29.3

Or, from the repository root, let Docker Compose do it:

    docker compose pull
    docker compose up -d

Then open the frontend at:

    http://localhost:3000

================================================================================

TEAM MEMBERS
------------

1. Andres Proano
   Role: Blockchain/mining implementation, backend coordination, Docker images

2. Pablo Alvarado
   Role: Exchange/account design, React interface, verification, documentation

================================================================================

CONTRIBUTIONS
-------------

ANDRES PROANO:
  - Designed the Docker Compose topology for the two Bitcoin Core regtest nodes,
    backend service, frontend service, and ten miner services.
  - Implemented the Python miner service and Bitcoin RPC integration:
    * getblocktemplate-based work retrieval
    * valid block assembly with coinbase transaction
    * Merkle root computation
    * nonce and extranonce proof-of-work search
    * submitblock submission to Bitcoin Core
    * stale template detection when another miner advances the chain
  - Implemented miner wallet setup and balance tracking using Bitcoin Core RPC.
  - Implemented threshold-based transfer behavior from miner wallet to exchange
    deposit address and treasury address after coinbase maturity.
  - Prepared and published the Docker Hub images used by Docker Compose:
    * byandyx/btc-miner:latest
    * byandyx/btc-backend:latest
    * byandyx/btc-frontend:latest
  - Helped validate the end-to-end mining and deposit workflow in Docker.

PABLO ALVARADO:
  - Reviewed the Phase 1 specification and aligned the implementation with the
    required separation between blockchain state and exchange state.
  - Designed and refined the exchange account model:
    * 30 pre-seeded client accounts with USD balances
    * miner exchange accounts created only after verified deposits
    * internal BTC/USD balances stored in SQLite
    * deposit idempotency using on-chain transaction IDs
  - Improved the Node.js/Express coordinator behavior:
    * threshold validation and distribution to miners
    * start/stop mining control endpoints
    * miner status tracking
    * on-chain deposit verification before crediting exchange accounts
    * duplicate deposit protection through the deposits table
  - Improved the React interface for Phase 1 grading:
    * mining control panel
    * miners table with total BTC gained and spendable BTC
    * event log focused on threshold, control, and deposit events
    * paginated client account table showing 5 clients per page
    * separate miner exchange account table
    * separate miner deposit summary
  - Updated documentation, run instructions, account access instructions, and
    requirement mapping for the final Phase 1 submission.

SHARED WORK:
  - Tested Docker Compose startup and service connectivity.
  - Verified that BTC is credited to the exchange only after an on-chain
    transaction is submitted and verified by the backend.
  - Reviewed the UI and README to make the grading path clear.

================================================================================

PROJECT DESCRIPTION
-------------------

At startup, the system creates a private Bitcoin regtest network. No Bitcoin is
preloaded into the system; BTC enters only through mining rewards. Ten miner
containers compete to mine valid blocks. Coinbase rewards remain immature until
Bitcoin Core reports them as spendable after the required coinbase maturity.

When a miner's mature balance reaches the user-configured threshold, the miner
sends an on-chain transaction to the exchange deposit address. The backend then
verifies that transaction on-chain before crediting the miner's internal
exchange account. Any mature surplus beyond the configured threshold is sent to
a separate treasury address.

The exchange system is separate from the blockchain system:

  - Blockchain system:
    Handles Bitcoin Core nodes, blocks, wallets, addresses, confirmations,
    coinbase maturity, and on-chain BTC transactions.

  - Exchange system:
    Handles internal client accounts, internal miner accounts, internal BTC
    balances, internal USD balances, and deposit records in SQLite.

Important boundary:
  BTC is not considered to be inside the exchange just because a miner wallet
  holds BTC. BTC enters the exchange only after a verified on-chain transaction
  sends funds to the exchange deposit address and the backend credits the
  miner's exchange account.

================================================================================

ARCHITECTURE SUMMARY
--------------------

BLOCKCHAIN LAYER:
  - 2 Bitcoin Core nodes using the required image bitcoin/bitcoin:29.3
  - Both nodes run in regtest mode
  - Nodes are connected to each other on the Docker network
  - RPC is used for wallet, template, block, transaction, and chain operations

MINING LAYER:
  - 10 Python miner containers
  - Each miner exposes a Flask REST API
  - Each miner receives the threshold from the Node.js coordinator
  - Each miner communicates with an assigned Bitcoin Core node through RPC
  - Miners report mining and balance updates to the backend

COORDINATION LAYER:
  - Node.js/Express backend
  - Stores threshold, miners, accounts, settings, and deposits in SQLite
  - Relays threshold changes to all miner containers
  - Starts and stops miners through their REST APIs
  - Verifies deposits on-chain before crediting exchange accounts
  - Pushes live updates to the React frontend using Socket.IO

FRONTEND LAYER:
  - React 18 frontend
  - Served by Nginx inside the frontend container
  - Lets the user set the threshold and control mining
  - Shows miners, deposits, client accounts, and miner exchange accounts
  - Polls system status and accounts every 5 seconds

================================================================================

EXACT RUN INSTRUCTIONS
----------------------

OPTION 1: Using Docker Hub images (recommended for grading)

  From the repository root:

    docker compose pull
    docker compose up -d

  This uses the published images referenced in docker-compose.yml. All
  application images are multi-arch (linux/amd64 + linux/arm64), so the same
  commands work on Intel/AMD hosts and on Apple Silicon / ARM hosts:

    bitcoin/bitcoin:29.3            (official Bitcoin Core image)
    byandyx/btc-backend:latest      amd64 + arm64
    byandyx/btc-frontend:latest     amd64 + arm64
    byandyx/btc-miner:latest        amd64 + arm64

  If you prefer to pull the images manually before starting:

    docker pull byandyx/btc-backend:latest
    docker pull byandyx/btc-frontend:latest
    docker pull byandyx/btc-miner:latest
    docker pull bitcoin/bitcoin:29.3

  Monitor startup:

    docker compose logs -f

  Check container status:

    docker compose ps

  Expected services:

    node1
    node2
    backend
    frontend
    miner-1
    miner-2
    miner-3
    miner-4
    miner-5
    miner-6
    miner-7
    miner-8
    miner-9
    miner-10

OPTION 2: Building from source

  From the repository root:

    docker compose up -d --build

  This rebuilds the local backend, frontend, and miner images before running
  the system.

OPTION 3: Publishing your own multi-arch images (maintainers only)

  This is how the byandyx/btc-* images above were built and pushed. Log in
  to Docker Hub first, then create a multi-arch builder (only needed once):

    docker login
    docker buildx create --name multi --use --bootstrap

  From the repository root, build and push each image for amd64 and arm64
  in a single step:

    docker buildx build \
      --platform linux/amd64,linux/arm64 \
      -t <your-namespace>/btc-backend:latest \
      --push ./backend

    docker buildx build \
      --platform linux/amd64,linux/arm64 \
      -t <your-namespace>/btc-frontend:latest \
      --push ./frontend

    docker buildx build \
      --platform linux/amd64,linux/arm64 \
      -t <your-namespace>/btc-miner:latest \
      --push ./miner

  Verify the published manifest lists both architectures:

    docker buildx imagetools inspect <your-namespace>/btc-backend:latest

  Note: `docker build` by itself only produces a single-arch image for the
  host machine. Use `docker buildx build --platform ... --push` to publish
  a true multi-arch manifest.

================================================================================

USING THE SYSTEM
----------------

Open the frontend:

  http://localhost:3000

Recommended demo flow:

1. Wait 5-10 seconds after Docker Compose starts so the Bitcoin nodes and
   backend can initialize.

2. Open http://localhost:3000.

3. Enter a threshold value, for example:

     1

4. Click "Set Threshold".

5. Click "Start Mining".

6. Watch the "Miners" table:

   - Miner # identifies the miner container.
   - Blocks Mined shows how many blocks that miner found.
   - BTC Gained (Total) includes immature and mature mining rewards.
   - BTC Immature is coinbase reward that cannot be spent yet.
   - BTC Available (Spendable) is mature BTC that Bitcoin Core reports as
     spendable.

7. Wait for coinbase maturity. Once a miner has enough mature BTC to meet the
   threshold, it sends an on-chain transaction to the exchange deposit address.

8. Watch the "Event Log". The log records deposit events and control events.
   Block discovery messages are intentionally not logged in the UI to keep the
   log focused on exchange-level events.

9. Check account tables:

   - "Client Accounts" shows the 30 exchange clients, 5 per page.
   - "Miner Exchange Accounts" shows all miner accounts created after deposits.
   - "Miner Deposits" summarizes miner accounts with BTC credited.

================================================================================

ACCOUNT MODEL
-------------

CLIENT ACCOUNTS:
  - Created when the backend initializes the SQLite database.
  - There are 30 accounts named client_1 through client_30.
  - Each client starts with:
      BTC balance: 0
      USD balance: 30000
  - These are internal exchange accounts, not Bitcoin Core wallets.
  - They are visible in the React UI under "Client Accounts".
  - The UI paginates client accounts 5 per page.

MINER EXCHANGE ACCOUNTS:
  - These are also internal exchange accounts.
  - A miner exchange account is created only after the backend verifies an
    on-chain deposit transaction sent to the exchange deposit address.
  - Miner exchange accounts start with BTC from deposits and USD balance 0.
  - They are visible in the React UI under "Miner Exchange Accounts".
  - Miner accounts are not paginated because there are at most 10.

MINER BITCOIN WALLETS:
  - These are separate from exchange accounts.
  - They exist inside Bitcoin Core and receive mining rewards from coinbase
    transactions.
  - BTC in a miner wallet is not counted as exchange BTC until an on-chain
    deposit to the exchange address is verified.

TREASURY:
  - Mature BTC above the threshold is sent to a treasury address.
  - The treasury is part of the system payout model, not a client trading
    account for Phase 1.

================================================================================

ACCESSING ALL ACCOUNTS
----------------------

VIA WEB UI:

  1. Open http://localhost:3000.
  2. Scroll to "Client Accounts" to view all 30 client accounts, 5 per page.
  3. Scroll to "Miner Exchange Accounts" to view miner accounts created after
     deposits.
  4. Scroll to "Miner Deposits" to view the miner accounts that currently hold
     BTC in the exchange.

VIA BACKEND API:

  All exchange accounts:

    GET http://localhost:3001/api/accounts

  Specific account:

    GET http://localhost:3001/api/accounts/client_1
    GET http://localhost:3001/api/accounts/miner-1

  Miner status:

    GET http://localhost:3001/api/miners

  System status:

    GET http://localhost:3001/api/system-status

Recommended account access for grading:

  Use the React UI or the backend API. The backend image stores data in SQLite,
  but the container is intentionally minimal and does not require the sqlite3
  command-line client.

================================================================================

BACKEND API ENDPOINTS
---------------------

Core REST API runs on:

  http://localhost:3001

THRESHOLD MANAGEMENT:

  GET  /api/threshold
  POST /api/threshold

  POST body:

    {"threshold": 1}

MINING CONTROL:

  POST /api/start
  POST /api/stop

MONITORING:

  GET /api/health
  GET /api/system-status
  GET /api/diagnostics
  GET /api/miners

ACCOUNTS:

  GET /api/accounts
  GET /api/accounts/:id

EXCHANGE:

  GET  /api/exchange/addresses
  POST /api/exchange/deposit

  The deposit endpoint is called internally by miners after an on-chain
  transaction is sent. It requires:

    {"miner_id": "miner-1", "amount": 1, "txid": "..."}

MINER-TO-BACKEND:

  POST /api/miner-register
  POST /api/miner-update

SOCKET.IO EVENTS:

  initial-state
  miner-update
  threshold-updated
  mining-started
  mining-stopped
  deposit

MINER API:

  Each miner exposes a Flask API on port 5000 inside the Docker network:

    GET  /status
    POST /threshold
    POST /start
    POST /stop

================================================================================

DATABASE SCHEMA
---------------

SQLite database:

  exchange.db

miners TABLE:

  miner_id          Primary key, miner-1 through miner-10
  blocks_mined      Total blocks found by this miner
  btc_gained        Total BTC earned by this miner wallet
  btc_mature        BTC spendable after coinbase maturity
  btc_immature      BTC from recent coinbase rewards not yet spendable
  btc_available     Spendable BTC reported to the UI
  status            Current miner status
  threshold_met     Flag indicating mature BTC has reached threshold

accounts TABLE:

  id                client_1 through client_30, plus miner IDs after deposits
  name              Human-readable account name
  type              client or miner
  btc_balance       Internal exchange BTC balance
  usd_balance       Internal exchange USD balance

deposits TABLE:

  txid              On-chain Bitcoin transaction ID
  miner_id          Miner that reported the deposit
  amount            BTC amount credited to the miner exchange account
  created_at        Timestamp when the deposit was recorded

settings TABLE:

  key               Setting name
  value             Setting value, including threshold and deposit addresses

================================================================================

PHASE 1 REQUIREMENT MAPPING
---------------------------

Required: React frontend
Implemented: React 18 frontend served by Nginx.

Required: Express / Node.js backend
Implemented: Node.js backend using Express and Socket.IO.

Required: Python miner service
Implemented: Python miners running in ten separate containers.

Required: Miner API using Flask or FastAPI
Implemented: Flask API in each miner container.

Required: bitcoin/bitcoin in regtest
Implemented: node1 and node2 use bitcoin/bitcoin:29.3 in regtest mode.

Required: SQLite database
Implemented: exchange.db using better-sqlite3.

Required: Docker Compose
Implemented: docker-compose.yml starts the full system.

Required: Ten miner containers
Implemented: miner-1 through miner-10.

Required: Two Bitcoin Core nodes
Implemented: node1 and node2.

Required: threshold set through React and sent to backend/miners
Implemented: UI sends threshold to backend; backend relays it to all miners.

Required: miners report results to backend and React table
Implemented: miners post updates to /api/miner-update; React table updates
through Socket.IO.

Required: table includes miner number, BTC gained, and BTC available
Implemented: Miners table shows Miner #, BTC Gained (Total), and BTC Available.

Required: coinbase maturity separation
Implemented: UI and backend track mature, immature, and available BTC.

Required: deposit after mature BTC reaches threshold
Implemented: miner transfers threshold amount to exchange deposit address and
reports txid to backend for verification.

Required: exchange credits miner after receipt verification
Implemented: backend verifies the transaction in the exchange wallet before
crediting the miner exchange account.

Required: 30 client accounts with $30,000 USD each
Implemented: backend seeds client_1 through client_30 with $30,000 USD.

Required: all exchange client accounts viewable
Implemented: React UI shows client accounts with pagination, and API exposes
/api/accounts and /api/accounts/:id.

================================================================================

NOTES FOR GRADING
-----------------

The easiest grading path is:

1. Run:

     docker compose pull
     docker compose up -d

2. Open:

     http://localhost:3000

3. Set threshold to 1 BTC.

4. Click "Start Mining".

5. Wait until a miner has mature BTC and a deposit appears in the event log.

6. Verify:

   - Miners table shows BTC gained and BTC available.
   - Client Accounts shows client_1 through client_30 with $30,000 USD.
   - Miner Exchange Accounts shows miner accounts after deposits.
   - Miner Deposits shows credited BTC.
   - GET http://localhost:3001/api/accounts returns both client and miner
     exchange accounts.

KNOWN LIMITATIONS:

  - Miner runtime state is in memory; if a miner container restarts, it reloads
    wallet balances from Bitcoin Core but not every local runtime flag.
  - Very small thresholds can fail because Bitcoin transactions require fees.
  - The backend prevents duplicate exchange credits by recording deposit txids.
  - The exchange models account balances only; trading between clients is for
    later project phases.

================================================================================

TECHNOLOGY STACK
----------------

Bitcoin Core:      bitcoin/bitcoin:29.3
Backend:           Node.js 20, Express, Socket.IO
Database:          SQLite using better-sqlite3
Frontend:          React 18, Vite, Nginx
Miner service:     Python 3.11, Flask, requests
Orchestration:     Docker Compose

DOCKER HUB IMAGES:

  bitcoin/bitcoin:29.3
  byandyx/btc-miner:latest        amd64 and arm64
  byandyx/btc-backend:latest      amd64 and arm64
  byandyx/btc-frontend:latest     amd64 and arm64

================================================================================

CLEANUP
-------

Stop containers:

  docker compose down

Stop containers and remove volumes:

  docker compose down -v

Restart from scratch:

  docker compose down -v
  docker compose up -d

View logs:

  docker compose logs -f
  docker compose logs -f backend
  docker compose logs -f miner-1

================================================================================
