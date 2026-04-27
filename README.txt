================================================================================
Simulated Bitcoin Exchange - Phase 2
CMP-5001-202520 - Aplicaciones Distribuidas
================================================================================

PROJECT TITLE
-------------
Simulated Bitcoin Exchange - Phase 2

This repository extends the working Phase 1 implementation and adds the full
internal trading subsystem required in Homework 4:
- internal available/reserved balances
- limit buy / limit sell orders
- matching engine with price/time priority
- completed trades persistence
- owner 2% BTC fee accrual
- React UI for creating orders and monitoring results

================================================================================

QUICK START (NO BUILD, FROM DOCKER HUB)
---------------------------------------
If you only want to run the project for grading, run these two commands from
the repo root and open http://localhost:3000:

  docker compose -f docker-compose.yml -f docker-compose.hub.yml pull
  docker compose -f docker-compose.yml -f docker-compose.hub.yml up -d

You MUST pass BOTH `-f` files. Running plain `docker compose up` will try
to use local images (or build from source) — see the "HOW TO RUN" section
further down for the full explanation and the local-build alternative.

================================================================================

TEAM MEMBERS
------------
1. Andres Proano
2. Pablo Alvarado

CONTRIBUTIONS
-------------
ANDRES PROANO:
- Bitcoin regtest / mining workflow and miner container behavior.
- Docker orchestration and service topology.
- Blockchain transaction and deposit validation support.

PABLO ALVARADO:
- Exchange internal account model and SQLite persistence.
- Backend API evolution for Phase 2 trading.
- React UI for balances, orders, and trades.
- End-to-end validation and documentation alignment for Phase 2.

SHARED WORK:
- Integration tests with Docker Compose.
- Verification of boundary between on-chain deposits and internal exchange trades.
- Docker Hub publish/run workflow.

================================================================================

PHASE 2 BIG PICTURE
-------------------
Phase 1 remains the base for mining and verified on-chain BTC deposits.
Phase 2 adds internal market trading among exchange accounts.

Boundary is preserved:
- BTC enters the exchange only after verified on-chain deposit.
- Trades in this phase are INTERNAL ONLY (no blockchain tx per trade).

Exchange now supports:
- limit buy and limit sell
- open orders
- completed/cancelled orders
- completed trades
- owner fee account with 2% BTC fee per trade

================================================================================

TRADING DESIGN DECISIONS (DOCUMENTED)
-------------------------------------
1. No partial fills:
   - An order remains OPEN until it can be fully matched.
   - Execution happens only when a single compatible opposite order exists
     with the same BTC amount.
   - When executed, both orders are completed fully.

2. Trade execution price:
   - Trade price = maker order price (existing order in the book).

3. Fee model:
   - Owner fee = 2% of gross BTC trade amount.
   - Fee is deducted from BTC side:
       buyer receives net BTC (gross - fee)
       owner receives fee BTC
       seller receives USD for gross BTC at trade price

4. Rounding:
   - BTC rounded to 8 decimals.
   - USD rounded to 2 decimals.

================================================================================

ARCHITECTURE SUMMARY
--------------------
BLOCKCHAIN LAYER:
- 2 Bitcoin Core nodes (bitcoin/bitcoin:29.3) in regtest

MINING LAYER:
- 10 Python miner containers
- Miner APIs (Flask)
- Threshold-based verified deposit to exchange wallet

EXCHANGE / BACKEND LAYER:
- Node.js + Express + Socket.IO
- SQLite persistence (better-sqlite3)
- Account balances with available/reserved model
- Order book, matching, trade settlement, owner fee accrual

FRONTEND LAYER:
- React + Vite
- Nginx reverse proxy in container
- UI for mining controls + Phase 2 trading controls and tables

================================================================================

DATABASE (SQLITE)
-----------------
Database path:
- Container: /app/data/exchange.db
- Local backend default (without compose env): backend/exchange.db

Core tables:

accounts
- id (PK)
- name
- type: client | miner | owner
- btc_available
- btc_reserved
- usd_available
- usd_reserved
- btc_balance = btc_available + btc_reserved
- usd_balance = usd_available + usd_reserved

orders
- id (PK)
- client_id
- side: buy | sell
- type: limit
- price
- amount
- status: open | completed | cancelled
- reserved_usd
- reserved_btc
- created_at
- closed_at

trades
- id (PK)
- buy_order_id
- sell_order_id
- buyer_id
- seller_id
- price
- btc_amount_gross
- btc_fee_owner
- btc_amount_net_to_buyer
- usd_amount
- created_at

Existing Phase 1 tables kept:
- miners
- deposits
- settings

Migration behavior:
- Existing accounts table is safely migrated to include new balance fields.
- Existing miner/client data is preserved.
- Owner account is created if missing.

================================================================================

ORDERING AND MATCHING RULES
---------------------------
Buy-side priority:
- higher price first
- tie: earlier created_at first (FIFO)

Sell-side priority:
- lower price first
- tie: earlier created_at first (FIFO)

Compatibility:
- Buy can match Sell if buy.price >= sell.price
- Sell can match Buy if sell.price <= buy.price

No partial fills rule in this implementation:
- Match occurs only if an opposite open order exists with compatible price and
  exactly equal BTC amount.

================================================================================

VALIDATIONS IMPLEMENTED
-----------------------
- Reject order if insufficient available funds.
- Reject price <= 0.
- Reject amount <= 0.
- Prevent double use of funds by moving funds to reserved balances on open order.
- Reject owner account as trader.
- Miners (type='miner') are eligible traders once they have deposited BTC
  to the exchange wallet (they can both BUY and SELL).

================================================================================

BALANCE MOVEMENT RULES
----------------------
On limit sell creation:
- btc_available -= amount
- btc_reserved += amount

On limit buy creation:
- usd_available -= (price * amount)
- usd_reserved += (price * amount)

On trade execution:
- seller btc_reserved -= gross_btc
- buyer usd_reserved consumed; extra reserved USD refunded to buyer usd_available
  if trade executes below buyer limit price
- seller usd_available += gross_btc * trade_price
- buyer btc_available += gross_btc - fee_btc
- owner btc_available += fee_btc (2%)

On order cancellation:
- release reserved funds back to available funds

================================================================================

BACKEND API (PHASE 2)
---------------------
Core:
- GET  /api/health
- GET  /api/system-status
- GET  /api/diagnostics

Accounts:
- GET  /api/accounts
- GET  /api/accounts/:id

Orders:
- POST   /api/orders
  body: { clientId, side, type, price, amount }
- GET    /api/orders/open
- GET    /api/orders/completed
- DELETE /api/orders/completed
  Clears the completed/cancelled orders history table (trades are preserved).
- POST   /api/orders/:id/cancel

Trades / fees:
- GET  /api/trades
- GET  /api/owner/fees

Phase 1 endpoints still available:
- GET/POST /api/threshold
- POST /api/start
- POST /api/stop
- POST /api/miner-register
- POST /api/miner-update
- POST /api/exchange/deposit
- GET  /api/exchange/addresses
- GET  /api/miners

================================================================================

FRONTEND (PHASE 2)
------------------
Main additions in UI:
- Trading panel (client selector, side, price, amount)
- Open orders table (with cancel action)
- Completed trades table
- Completed/cancelled orders table with "Clear History" button
  (deletes the order history per Phase 2 §8 "viewable until the user
  deletes it"; trades record is preserved)
- Detailed account balances (available/reserved BTC/USD)
- Open-orders indicator per account
- Owner fee total card (shows accumulated 2% BTC fee)

Phase 1 UI remains:
- threshold controls
- start/stop mining controls
- miners table with separated metrics:
  - BTC mined accumulated
  - BTC matured accumulated
  - BTC sent to exchange accumulated
  - BTC sent to treasury/fees accumulated
  - BTC matured remaining (current spendable wallet amount)
- event log

================================================================================

HOW TO RUN
==========

There are TWO ways to run this project. Pick ONE.

--------------------------------------------------------------------------------
OPTION A (RECOMMENDED FOR GRADING) — RUN FROM DOCKER HUB, NO BUILD
--------------------------------------------------------------------------------
Use this path if you do NOT want to build anything locally. All app images
(backend, frontend, miners) are pulled from Docker Hub.

REQUIREMENT: you MUST pass BOTH compose files (-f docker-compose.yml AND
-f docker-compose.hub.yml). The hub file overrides `pull_policy: never`
with `pull_policy: always` for the app services, so Docker pulls the
published images instead of trying to build them.

From repo root:

  # 1. Pull the published images (no build step at all)
  docker compose -f docker-compose.yml -f docker-compose.hub.yml pull

  # 2. Start the full stack
  docker compose -f docker-compose.yml -f docker-compose.hub.yml up -d

Open frontend:

  http://localhost:3000

Stop:

  docker compose -f docker-compose.yml -f docker-compose.hub.yml down

Full reset (also wipes SQLite + bitcoin regtest data):

  docker compose -f docker-compose.yml -f docker-compose.hub.yml down -v

IMPORTANT — DO NOT run `docker compose up` (without -f docker-compose.hub.yml)
on a machine that has never built the images. The default file sets
`pull_policy: never` for backend/frontend/miners, which means Docker will
try to use a LOCAL image and, if none exists, fall back to building from
source. To skip the build, you MUST include docker-compose.hub.yml.

Published images (multi-arch: linux/amd64 + linux/arm64):
- byandyx/btc-backend:latest
- byandyx/btc-frontend:latest
- byandyx/btc-miner:latest
- bitcoin/bitcoin:29.3   (official, pulled automatically)

--------------------------------------------------------------------------------
OPTION B — LOCAL BUILD (FOR DEVELOPMENT)
--------------------------------------------------------------------------------
Use this only if you are modifying source code and want to rebuild the
images from this repo.

From repo root:

  docker compose build
  docker compose up -d

Open frontend:

  http://localhost:3000

Stop:

  docker compose down

Full reset (including DB data):

  docker compose down -v

Why two compose files exist:
- `docker-compose.yml` is the canonical stack and defaults to LOCAL BUILD
  (`pull_policy: never`) so that local code changes are honored during
  development.
- `docker-compose.hub.yml` is an override that flips `pull_policy: always`
  on backend/frontend/miners, which is what enables the no-build Docker
  Hub path in OPTION A.

================================================================================

COMMON COMMANDS
---------------
Check status:

  docker compose ps
  docker compose logs -f backend

Persistence:
- backend SQLite is persisted via volume `backend-data` mounted at /app/data.

================================================================================

PUBLISHING NEW IMAGES (MAINTAINERS ONLY)
----------------------------------------
Note on the backend image:
- backend/Dockerfile installs python3, make and g++ on Alpine so that
  better-sqlite3 can fall back to a node-gyp source build if the
  prebuilt binary cannot be downloaded. This makes multi-arch builds
  reliable on slow networks and on linux/arm64.

Build and publish your own multi-arch images:

  docker login
  docker buildx create --name multi --use --bootstrap

  docker buildx build --platform linux/amd64,linux/arm64 -t <your-namespace>/btc-backend:latest --push ./backend
  docker buildx build --platform linux/amd64,linux/arm64 -t <your-namespace>/btc-frontend:latest --push ./frontend
  docker buildx build --platform linux/amd64,linux/arm64 -t <your-namespace>/btc-miner:latest --push ./miner

Verify manifest:

  docker buildx imagetools inspect <your-namespace>/btc-backend:latest

After publishing, end users can run the stack without building by following
OPTION A above (docker compose -f docker-compose.yml -f docker-compose.hub.yml
pull && up -d).

================================================================================

PHASE 2 MANUAL DEMO / CHECKLIST
--------------------------------
1. Start the stack using OPTION A (no build) — see "HOW TO RUN" above:
     docker compose -f docker-compose.yml -f docker-compose.hub.yml pull
     docker compose -f docker-compose.yml -f docker-compose.hub.yml up -d
   Then open http://localhost:3000.
2. In UI, set threshold (example: 1), then Start Mining.
3. Wait for at least one verified miner deposit.
4. Create a SELL order from an account with BTC available (typically miner-*).
5. Create a BUY order from a funded USD client with matching amount and
   compatible price.
6. Verify trade appears in Completed Trades.
7. Verify buyer net BTC and seller USD updates in accounts table.
8. Verify owner fee increases by 2% of gross BTC trade amount.
9. Create an order that cannot match and confirm it stays in Open Orders.
10. Cancel the open order and verify reserved funds are released.
11. Click "Clear History" in the Completed / Cancelled Orders section to
    delete the order history (confirms Phase 2 §8 deletion requirement).
12. Optional: place a SELL order from a miner account to verify miners
    can also trade once they hold internal BTC.

================================================================================

NOTES FOR GRADING
-----------------
- This implementation keeps the Phase 1 blockchain flow intact.
- Trading in Phase 2 is internal to exchange accounts only.
- The expected run path for grading is OPTION A (Docker Hub, no build) —
  the two `docker compose -f docker-compose.yml -f docker-compose.hub.yml`
  commands shown in QUICK START at the top of this README.
- README includes explicit run, validation, and architecture decisions for
  reproducible grading.

================================================================================
