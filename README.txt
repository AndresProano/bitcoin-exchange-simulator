================================================================================
Simulated Bitcoin Exchange - Final Project (Phase 3)
CMP-5001-202520 - Aplicaciones Distribuidas
================================================================================

PROJECT TITLE
-------------
Simulated Bitcoin Exchange - Final Project

This delivery integrates all three phases:
- Phase 1: regtest blockchain, miners, maturity tracking, and verified deposits
- Phase 2: internal exchange trading with reserved balances and owner fee
- Phase 3: BTC history per client and BTC transfer-out history events

================================================================================

TEAM MEMBERS
------------
1. Andres Proano
2. Pablo Alvarado

CONTRIBUTIONS
-------------
ANDRES PROANO
- Bitcoin Core regtest network setup
- miner containers and Python mining workflow
- Docker orchestration and service integration
- on-chain transfer and deposit verification support

PABLO ALVARADO
- SQLite exchange persistence model
- Node.js / Express backend APIs
- internal trading engine for Phase 2
- client BTC history and transfer-out support for Phase 3
- React frontend for balances, trading, history, and demo flow
- README and delivery alignment

SHARED WORK
- end-to-end testing
- Docker Hub publishing workflow
- validation of blockchain system vs exchange system boundary
- final integration and demo verification

================================================================================

BIG PICTURE
-----------
This project contains two clearly separated systems:

1. Blockchain system
- Two Bitcoin Core nodes run in regtest.
- Ten miners compete by building and submitting blocks.
- BTC is created only by mining.
- Coinbase maturity is respected before BTC becomes spendable.
- Mature BTC reaches the exchange only after an on-chain transfer is verified.

2. Exchange system
- SQLite stores internal exchange accounts.
- 30 client accounts start with 30000 USD each.
- Miner accounts are created only after verified on-chain deposits to the
  exchange deposit address.
- Trading in Phase 2 and Phase 3 is internal to the exchange.
- The owner receives a 2% fee in BTC on every executed trade.
- Phase 3 adds BTC event history per account:
  - Buy BTC
  - Sell BTC
  - Transfer BTC

Important boundary:
- BTC is not inside the exchange just because a miner wallet owns BTC.
- BTC enters the exchange only after an on-chain transaction sends it to the
  exchange address and the backend verifies receipt.

================================================================================

OFFICIAL EXECUTION PATH
-----------------------
The primary grading path is Docker Hub images through docker-compose.yml.

Published images:
- byandyx/btc-backend:latest    (also tagged byandyx/btc-backend:proyecto-final)
- byandyx/btc-frontend:latest   (also tagged byandyx/btc-frontend:proyecto-final)
- byandyx/btc-miner:latest      (also tagged byandyx/btc-miner:proyecto-final)
- bitcoin/bitcoin:29.3

The :latest tag and the :proyecto-final tag point to the same Phase 3 final
delivery digest. Either tag can be pulled for grading.

Target platforms:
- linux/amd64
- linux/arm64

Files needed:
- docker-compose.yml

Commands:

  docker compose pull
  docker compose up -d

Open:

  Frontend: http://localhost:3000
  Backend API: http://localhost:3001

Useful commands:

  docker compose ps
  docker compose logs -f backend
  docker compose down

================================================================================

LOCAL BUILD / DEVELOPMENT MODE
------------------------------
If you cloned the repository and want to build the local source code instead of
using Docker Hub images, use docker-compose.yml together with
docker-compose.dev.yml.

Build and start:

  docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d

Open:

  Frontend: http://localhost:3000
  Backend API: http://localhost:3001

Useful commands:

  docker compose -f docker-compose.yml -f docker-compose.dev.yml ps
  docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f backend
  docker compose -f docker-compose.yml -f docker-compose.dev.yml down

Full reset including SQLite and node volumes:

  docker compose -f docker-compose.yml -f docker-compose.dev.yml down -v

================================================================================

HOW TO RUN THE DEMO
-------------------
1. Start the system with one of the two modes above.
2. Open http://localhost:3000
3. In Mining Control, set threshold to:

  1

4. Click Start Mining.
5. Wait until at least one miner transfers mature BTC to the exchange.
6. Verify:
- miner exchange accounts appear
- at least one miner has BTC available
- 30 client accounts exist with 30000 USD each
- owner account exists

================================================================================

FINAL DEMO FLOW FOR THE PROFESSOR
---------------------------------
1. Start with docker compose.
2. Open the frontend.
3. Set threshold to 1 BTC.
4. Start mining.
5. Wait for a miner deposit to be verified by the backend.
6. Open the accounts tables and verify miner BTC and client USD balances.
7. Create a SELL order from a miner account with BTC.
8. Create a compatible BUY order from a client with USD.
9. Verify:
- trade appears in Completed Trades
- balances update
- owner fee increases by 2% of gross BTC traded
- completed/cancelled orders table updates
10. Open BTC History.
11. Select the buyer account and verify a Buy BTC event.
12. Select the seller account and verify a Sell BTC event.
13. Use Transfer BTC Out from an account with BTC.
14. Enter a valid regtest destination address and BTC amount.
15. Verify:
- BTC balance decreases internally
- a Transfer BTC event appears in the account history
- the event includes amount and transaction information

================================================================================

PHASE 1 CHECKLIST
-----------------
- 2 Bitcoin Core nodes in regtest
- 10 miners in separate containers
- configurable threshold from React
- mined BTC and mature BTC reporting
- mature BTC transferred on-chain to the exchange
- miner accounts created after verified deposit
- 30 client accounts seeded with 30000 USD each
- blockchain and exchange systems kept separate

PHASE 2 CHECKLIST
-----------------
- client selector
- available and reserved BTC/USD balances
- limit buy and limit sell orders
- validation of funds, price, and amount
- reserved-funds protection
- price-time priority matching
- full match or no match policy
- internal trade execution
- owner 2% BTC fee
- open orders table
- completed orders / completed trades tables

PHASE 3 CHECKLIST
-----------------
- BTC history per client account
- Buy BTC events
- Sell BTC events
- Transfer BTC events
- history UI table
- minimal BTC transfer-out operation from the exchange wallet

================================================================================

API NOTES
---------
Main relevant endpoints:
- GET /api/miners
- GET /api/accounts
- POST /api/orders
- POST /api/orders/:id/cancel
- GET /api/trades
- GET /api/owner/fees
- GET /api/clients/:clientId/history
- POST /api/clients/:clientId/transfer-btc

================================================================================

DOCKER HUB PUBLISHING NOTES
---------------------------
If images need to be republished manually, a standard multi-architecture flow is:

  docker buildx build --platform linux/amd64,linux/arm64 \
    -t byandyx/btc-backend:latest -t byandyx/btc-backend:proyecto-final \
    --push ./backend

  docker buildx build --platform linux/amd64,linux/arm64 \
    -t byandyx/btc-frontend:latest -t byandyx/btc-frontend:proyecto-final \
    --push ./frontend

  docker buildx build --platform linux/amd64,linux/arm64 \
    -t byandyx/btc-miner:latest -t byandyx/btc-miner:proyecto-final \
    --push ./miner

Use this only when updating the published images. The grading path itself should
run directly from docker-compose.yml with the published images.

================================================================================

NOTES
-----
- The official evaluation path should not require rebuilding code locally.
- The local build path exists only for development, debugging, and validation.
- Internal exchange trades do not generate blockchain transactions.
- BTC history in Phase 3 is generated for new events executed by this final
  version of the system.

================================================================================

Transfer OUT BTC

1. docker compose exec node1 bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin createwallet "receiver"

# Para extraer el address tenemos:
2. docker compose exec node1 bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin -rpcwallet=receiver getnewaddress "btc-out-demo" bech32