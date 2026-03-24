================================================================================
Simulated Bitcoin Exchange - Phase 1
CMP-5001-202520 - Aplicaciones Distribuidas
================================================================================

TEAM MEMBERS
------------
1. Andres Proano - Full-stack development, Docker configuration, system
   architecture, Bitcoin Core integration, miner implementation, backend
   API development, frontend UI, and Docker Hub publishing.

2. Pablo Alvarado - System design, testing, documentation, and quality
   assurance.

================================================================================

PROJECT DESCRIPTION
-------------------
A simulated Bitcoin exchange running on a private regtest network. The system
includes two Bitcoin Core nodes, ten competing Python miners, a Node.js/Express
backend coordinator, and a React frontend dashboard.

================================================================================

ARCHITECTURE
------------
- 2x Bitcoin Core nodes (bitcoin/bitcoin:29.3) in regtest mode
- 10x Python miner containers (Flask REST API + mining logic)
- 1x Node.js/Express backend (coordinator, SQLite database, WebSocket)
- 1x React frontend (Vite build, served via Nginx)
- All orchestrated via Docker Compose

================================================================================

HOW TO RUN
----------

OPTION 1: Using published Docker Hub images (recommended for grading)

  docker compose up -d

  This pulls all images from Docker Hub (byandyx/btc-miner, byandyx/btc-backend,
  byandyx/btc-frontend) and bitcoin/bitcoin:29.3.

OPTION 2: Building from source

  docker compose up -d --build

ACCESSING THE APPLICATION
-------------------------
1. Open your browser and go to: http://localhost:3000

2. SET THE THRESHOLD:
   - In the "Mining Control" section at the top, enter a BTC threshold value
     (e.g., 50) and click "Set Threshold"
   - This threshold determines how much mature BTC each miner needs before
     depositing to the exchange

3. MONITOR MINERS:
   - The "Miners Status" table updates in real-time showing:
     * Miner Number (1-10)
     * Blocks Mined
     * BTC Gained (total from mining)
     * BTC Available (mature, spendable after 100 confirmations)
     * Status (mining / stopped / threshold met)

4. VIEW EXCHANGE ACCOUNTS:
   - Scroll down to the "Exchange Accounts" section
   - This shows ALL accounts:
     * Miner accounts (created when a miner deposits BTC to the exchange)
     * 30 Client accounts (client_1 through client_30, each with $30,000 USD)
   - Each account displays: Name, Type, BTC Balance, USD Balance

HOW TO ACCESS ANY SPECIFIC ACCOUNT
-----------------------------------
Via the web UI:
  - All accounts are listed in the "Exchange Accounts" table at the bottom
    of the page

Via the API:
  - All accounts: GET http://localhost:3001/api/accounts
  - Specific account: GET http://localhost:3001/api/accounts/{id}
    Example: http://localhost:3001/api/accounts/1

STOPPING THE SYSTEM
--------------------
  docker compose down

To also remove volumes (blockchain data):
  docker compose down -v

================================================================================

API ENDPOINTS
-------------
Backend runs on port 3001:

  GET  /api/health             - Health check
  GET  /api/threshold          - Get current threshold
  POST /api/threshold          - Set threshold {threshold: number}
  GET  /api/miners             - Get all miner statuses
  POST /api/miner-update       - Miner reports status update
  GET  /api/accounts           - Get all exchange accounts
  GET  /api/accounts/:id       - Get specific account
  POST /api/exchange/deposit   - Miner deposits BTC to exchange
  GET  /api/exchange/addresses - Get exchange and treasury addresses

Each miner runs on port 5000 (internal):
  GET  /status                 - Miner status
  POST /threshold              - Set miner threshold
  POST /start                  - Start mining
  POST /stop                   - Stop mining

================================================================================

DOCKER HUB IMAGES
-----------------
All images support amd64 and arm64 architectures:

  - byandyx/btc-miner:latest
  - byandyx/btc-backend:latest
  - byandyx/btc-frontend:latest
  - bitcoin/bitcoin:29.3 (official)

================================================================================

TECHNOLOGY STACK
----------------
  Frontend:      React 18 + Vite (served by Nginx)
  Backend:       Node.js 20 + Express
  Miner:         Python 3.11 + Flask
  Database:      SQLite (via better-sqlite3)
  Bitcoin Nodes: bitcoin/bitcoin:29.3 (regtest)
  Orchestration: Docker Compose
  Publishing:    Docker Hub (multi-arch amd64/arm64)

================================================================================
