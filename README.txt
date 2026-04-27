================================================================================
Simulated Bitcoin Exchange - Phase 2
CMP-5001-202520 - Aplicaciones Distribuidas
================================================================================

PROJECT TITLE
-------------
Simulated Bitcoin Exchange - Phase 2

This project extends the Phase 1 implementation and adds the internal trading
subsystem required for Phase 2.

Main additions in this phase:
- internal BTC and USD balances with available and reserved amounts
- limit buy and limit sell orders
- matching engine with price and time priority
- completed trades persistence
- owner 2% BTC fee accrual
- React interface for balances, orders, and trades

================================================================================

TEAM MEMBERS
------------
1. Andres Proano
2. Pablo Alvarado

CONTRIBUTIONS
-------------
ANDRES PROANO:
- Bitcoin regtest network
- miner containers and mining workflow
- Docker orchestration
- on chain deposit verification support

PABLO ALVARADO:
- internal exchange account model
- SQLite persistence
- backend API for Phase 2 trading
- React UI for orders, balances, and trades
- validation and documentation alignment

SHARED WORK:
- Docker Compose integration
- end to end testing
- validation of the boundary between blockchain deposits and internal trading
- Docker Hub publishing workflow

================================================================================

HOW TO RUN THE PROJECT
======================

OFFICIAL NORMAL USE
---------------------------------------
The primary execution path is Docker Hub.

Considerations:
- no local code changes required
- no local build required
- services are pulled from Docker Hub and then started

Files needed:
- docker-compose.yml

Recommended steps:
1. Create an empty folder
2. Copy only this file into that folder:
   - docker-compose.yml
3. Run:

  docker compose pull
  docker compose up -d

Open the frontend in the browser:

  http://localhost:3000

Check containers:

  docker compose ps

Check backend logs:

  docker compose logs -f backend

Stop the system:

  docker compose down

Important note:
This is the main execution process that should be used for evaluation.

================================================================================

HOW TO TEST THE SYSTEM AFTER STARTUP
------------------------------------
1. Open the frontend at:

  http://localhost:3000

2. Set a threshold value, for example:

  1

3. Start mining.

4. Wait until at least one miner reaches the threshold, matures enough BTC,
   and sends BTC to the exchange deposit address.

5. Verify in the accounts section that:
   - miner accounts appear inside the exchange
   - at least one miner has BTC available
   - 30 client accounts exist with USD 30000 each
   - owner account exists

6. Create a SELL order from an account with BTC available.

7. Create a BUY order from a funded USD client with the same BTC amount and a
   compatible price.

8. Verify the expected results:
   - the trade appears in Completed Trades
   - the BUY and SELL orders leave Open Orders
   - seller receives USD
   - buyer receives BTC net of fee
   - owner fee increases by 2% of the gross BTC amount

9. Create an order with no compatible opposite order and verify:
   - it stays in Open Orders
   - reserved funds are visible

10. Cancel that open order and verify:
   - reserved funds return to available funds
   - the order appears as cancelled

================================================================================

EXPECTED DEMO FLOW
------------------
A correct demo should look like this:

1. The system starts
2. Mining is started
3. BTC is mined
4. BTC matures
5. Mature BTC is transferred on chain to the exchange
6. Backend verifies deposit
7. Miner account receives internal BTC
8. A trader places a sell order
9. Another trader places a compatible buy order
10. The exchange matches them internally
11. Buyer receives net BTC
12. Seller receives USD
13. Owner accumulates 2% BTC fee
14. Tables update in the interface

================================================================================

DOCKER IMAGES
-------------
Published images:
- byandyx/btc-backend:latest
- byandyx/btc-frontend:latest
- byandyx/btc-miner:latest
- bitcoin/bitcoin:29.3

Target platforms:
- linux/amd64
- linux/arm64

================================================================================

LOCAL DEVELOPMENT MODE
----------------------
This section is only for development or if someone wants to modify the code.

If you cloned the repository and want to build locally, use:

  docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d

Open:

  http://localhost:3000

Check logs:

  docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f backend

Stop:

  docker compose -f docker-compose.yml -f docker-compose.dev.yml down

Full reset including SQLite volume:

  docker compose -f docker-compose.yml -f docker-compose.dev.yml down -v

================================================================================

NOTES
-----
- The grading path should use Docker Hub images directly.
- The local build path is only an extra for development and debugging.
- The blockchain layer and the exchange layer remain clearly separated.
- Internal Phase 2 trades do not generate blockchain transactions.

================================================================================

================================================================================

BIG PICTURE
-----------
Phase 1 remains the foundation:
- BTC is created by mining in regtest
- mined rewards must mature before spending
- once threshold is reached, BTC is sent on chain to the exchange deposit address
- after backend verification, BTC is credited internally to the corresponding
  miner account inside the exchange

Phase 2 adds internal exchange trading:
- clients can place limit buy and limit sell orders
- the exchange matches compatible orders
- balances are updated internally
- the owner receives a 2% fee in BTC on each executed trade

Important boundary:
- BTC enters the exchange only after a verified on chain deposit
- trades in this phase are INTERNAL ONLY
- no blockchain transaction is created for each internal trade

================================================================================

TRADING DESIGN DECISIONS
------------------------
1. No partial fills
   - An order stays OPEN until it can be fully matched
   - Execution happens only when a compatible opposite order exists with the
     same BTC amount
   - When matched, both orders are completed fully

2. Trade price
   - Trade price is the maker price
   - In other words, the trade uses the price of the order that was already
     open in the order book

3. Owner fee
   - Owner fee is 2% of the gross BTC trade amount
   - The fee is taken from the BTC side
   - Buyer receives net BTC
   - Owner receives fee BTC
   - Seller receives USD for the full gross BTC amount at trade price

4. Rounding
   - BTC uses 8 decimals
   - USD uses 2 decimals

================================================================================

ARCHITECTURE SUMMARY
--------------------
BLOCKCHAIN LAYER
- 2 Bitcoin Core nodes in regtest using bitcoin/bitcoin:29.3

MINING LAYER
- 10 Python miner containers
- threshold based deposit flow to the exchange wallet

BACKEND
- Node.js
- Express
- Socket.IO
- SQLite with better-sqlite3

FRONTEND
- React
- Vite
- served in container

================================================================================

ACCOUNTS AND BALANCES
---------------------
Each account inside the exchange keeps internal balances:

- btc_available
- btc_reserved
- usd_available
- usd_reserved

Meaning:
- available BTC can be used for new sell orders
- reserved BTC is locked by open sell orders
- available USD can be used for new buy orders
- reserved USD is locked by open buy orders

The owner also has an internal account where BTC fees are accumulated.

================================================================================

ORDERING AND MATCHING RULES
---------------------------
Buy priority:
- higher price first
- if same price, earlier order first

Sell priority:
- lower price first
- if same price, earlier order first

Compatibility:
- buy can match sell if buy.price >= sell.price
- sell can match buy if sell.price <= buy.price

================================================================================

BALANCE MOVEMENT RULES
----------------------
On sell order creation:
- btc_available decreases
- btc_reserved increases

On buy order creation:
- usd_available decreases
- usd_reserved increases

On trade execution:
- seller loses reserved BTC gross amount
- buyer pays USD based on trade price
- seller receives USD
- buyer receives BTC net of fee
- owner receives 2% BTC fee

On order cancellation:
- reserved funds return to available funds

================================================================================

PHASE 2 USER INTERFACE
----------------------
The interface includes:

- mining controls from Phase 1
- miners table
- trading panel
- accounts table
- open orders table
- completed trades table
- completed and cancelled orders table
- owner fee card

Mining table metrics are separated to make Phase 1 behavior clearer:
- BTC mined accumulated
- BTC matured accumulated
- BTC sent to exchange accumulated
- BTC sent elsewhere accumulated if applicable
- BTC matured remaining

This makes it easier to understand the difference between mined BTC,
matured BTC, transferred BTC, and currently remaining spendable BTC.

================================================================================

BACKEND API
-----------
Health and status:
- GET /api/health
- GET /api/system-status
- GET /api/diagnostics

Phase 1:
- GET  /api/threshold
- POST /api/threshold
- POST /api/start
- POST /api/stop
- POST /api/miner-register
- POST /api/miner-update
- POST /api/exchange/deposit
- GET  /api/exchange/addresses
- GET  /api/miners

Accounts:
- GET /api/accounts
- GET /api/accounts/:id

Orders:
- POST   /api/orders
- GET    /api/orders/open
- GET    /api/orders/completed
- DELETE /api/orders/completed
- POST   /api/orders/:id/cancel

Trades and fees:
- GET /api/trades
- GET /api/owner/fees
