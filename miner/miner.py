#!/usr/bin/env python3
"""
Bitcoin Regtest Miner Service
Communicates with Bitcoin Core via RPC, mines blocks using getblocktemplate,
and exposes a Flask REST API for coordination.
"""

import os
import sys
import json
import time
import struct
import hashlib
import threading
import logging
import traceback
from datetime import datetime

import requests
from flask import Flask, jsonify, request

# ---------------------------------------------------------------------------
# Configuration from environment
# ---------------------------------------------------------------------------
MINER_ID = os.environ.get("MINER_ID", "miner_1")
BITCOIN_RPC_HOST = os.environ.get("BITCOIN_RPC_HOST", "bitcoin")
BITCOIN_RPC_PORT = int(os.environ.get("BITCOIN_RPC_PORT", 18443))
BITCOIN_RPC_USER = os.environ.get("BITCOIN_RPC_USER", "rpcuser")
BITCOIN_RPC_PASS = os.environ.get("BITCOIN_RPC_PASS", "rpcpassword")
BACKEND_URL = os.environ.get("BACKEND_URL", "http://backend:3001")

COINBASE_MATURITY = 100  # regtest uses 100 confirmations for maturity

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("miner")

# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__)

# ---------------------------------------------------------------------------
# Shared miner state (protected by lock)
# ---------------------------------------------------------------------------
state_lock = threading.Lock()
miner_state = {
    "mining": False,
    "blocks_mined": 0,
    "coinbase_txids": [],       # list of (txid, block_height) pairs
    "btc_gained": 0.0,
    "threshold": None,
    "miner_address": None,
    "wallet_name": None,
    "exchange_deposit_address": None,
    "treasury_address": None,
}

mining_thread = None
stop_event = threading.Event()

# ---------------------------------------------------------------------------
# Bitcoin RPC helpers
# ---------------------------------------------------------------------------

def rpc_call(method, params=None, wallet=None):
    """Make a JSON-RPC call to Bitcoin Core."""
    if params is None:
        params = []
    url = f"http://{BITCOIN_RPC_HOST}:{BITCOIN_RPC_PORT}"
    if wallet:
        url += f"/wallet/{wallet}"
    payload = {
        "jsonrpc": "1.0",
        "id": f"miner-{MINER_ID}",
        "method": method,
        "params": params,
    }
    resp = requests.post(
        url,
        json=payload,
        auth=(BITCOIN_RPC_USER, BITCOIN_RPC_PASS),
        timeout=30,
    )
    data = resp.json()
    if data.get("error"):
        raise Exception(f"RPC error ({method}): {data['error']}")
    return data["result"]


def wait_for_node():
    """Block until Bitcoin Core RPC is reachable."""
    log.info("Waiting for Bitcoin Core RPC to become available ...")
    while True:
        try:
            info = rpc_call("getblockchaininfo")
            log.info(
                "Bitcoin Core reachable  chain=%s  blocks=%s",
                info["chain"],
                info["blocks"],
            )
            return
        except Exception:
            time.sleep(2)


def setup_wallet():
    """Create (or load) a wallet for this miner and get a receiving address."""
    wallet_name = MINER_ID.replace("-", "_")

    # Check loaded wallets
    loaded = rpc_call("listwallets")
    if wallet_name in loaded:
        log.info("Wallet '%s' already loaded.", wallet_name)
    else:
        # Try to create; if it exists on disk, load it
        try:
            rpc_call("createwallet", [wallet_name])
            log.info("Created wallet '%s'.", wallet_name)
        except Exception as e:
            if "already exists" in str(e).lower():
                try:
                    rpc_call("loadwallet", [wallet_name])
                    log.info("Loaded existing wallet '%s'.", wallet_name)
                except Exception as e2:
                    if "already loaded" in str(e2).lower():
                        log.info("Wallet '%s' already loaded.", wallet_name)
                    else:
                        raise
            else:
                raise

    # Get a receiving address
    address = rpc_call("getnewaddress", ["mining_reward", "bech32"], wallet=wallet_name)
    log.info("Miner reward address: %s", address)

    with state_lock:
        miner_state["wallet_name"] = wallet_name
        miner_state["miner_address"] = address


# ---------------------------------------------------------------------------
# Utility: byte / serialization helpers
# ---------------------------------------------------------------------------

def uint32_le(n):
    return struct.pack("<I", n)


def uint64_le(n):
    return struct.pack("<Q", n)


def int32_le(n):
    return struct.pack("<i", n)


def compact_size(n):
    """Bitcoin variable-length integer encoding."""
    if n < 0xFD:
        return struct.pack("<B", n)
    elif n <= 0xFFFF:
        return b"\xfd" + struct.pack("<H", n)
    elif n <= 0xFFFFFFFF:
        return b"\xfe" + struct.pack("<I", n)
    else:
        return b"\xff" + struct.pack("<Q", n)


def double_sha256(data):
    return hashlib.sha256(hashlib.sha256(data).digest()).digest()


def hex_to_bytes_le(hex_str):
    """Convert a hex string to bytes and reverse (for internal byte-order)."""
    return bytes.fromhex(hex_str)[::-1]


def bytes_to_hex_le(b):
    """Reverse bytes and return hex (internal -> display order)."""
    return b[::-1].hex()


def encode_script_height(height):
    """
    BIP34: encode block height as minimally-encoded CScriptNum for the
    coinbase scriptSig.  Returns the bytes to embed (length-prefix + LE int).
    """
    if height == 0:
        return b"\x01\x00"
    # Determine the number of bytes needed
    n = height
    data = bytearray()
    while n > 0:
        data.append(n & 0xFF)
        n >>= 8
    # If the top bit is set, append a 0x00 byte so it is not interpreted as negative
    if data[-1] & 0x80:
        data.append(0)
    return bytes([len(data)]) + bytes(data)


def make_coinbase_tx(height, miner_address, reward_satoshis, witness_commitment=None, extra_nonce=0):
    """
    Build a full coinbase transaction (with witness if needed).
    Returns the serialised transaction bytes.
    """
    # --- scriptSig: BIP34 height + extra nonce + tag ---
    height_bytes = encode_script_height(height)
    extra_nonce_bytes = struct.pack("<Q", extra_nonce)
    tag = b"/python-miner/"
    script_sig = height_bytes + extra_nonce_bytes + tag

    # --- Output script (pay to miner_address via P2WPKH/P2WSH) ---
    # We ask Bitcoin Core to decode the address for us, or build manually.
    # For bech32 addresses (bc1q...), the scriptPubKey is OP_0 <20-byte-hash>.
    # We'll use validateaddress / getaddressinfo to get the scriptPubKey.
    addr_info = rpc_call("getaddressinfo", [miner_address],
                         wallet=miner_state["wallet_name"])
    script_pub_key_hex = addr_info["scriptPubKey"]
    script_pub_key = bytes.fromhex(script_pub_key_hex)

    # --- Build transaction ---
    tx = bytearray()

    has_witness = witness_commitment is not None

    # Version
    tx += uint32_le(1)

    if has_witness:
        # Segwit marker + flag
        tx += b"\x00\x01"

    # --- Inputs (1: coinbase) ---
    tx += compact_size(1)
    # Previous output (null for coinbase)
    tx += b"\x00" * 32  # prev txid
    tx += b"\xff\xff\xff\xff"  # prev vout
    # scriptSig
    tx += compact_size(len(script_sig))
    tx += script_sig
    # Sequence
    tx += b"\xff\xff\xff\xff"

    # --- Outputs ---
    num_outputs = 1
    if has_witness:
        num_outputs = 2
    tx += compact_size(num_outputs)

    # Output 0: block reward to miner
    tx += uint64_le(reward_satoshis)
    tx += compact_size(len(script_pub_key))
    tx += script_pub_key

    if has_witness:
        # Output 1: witness commitment (OP_RETURN)
        commitment_script = bytes.fromhex("6a24aa21a9ed") + witness_commitment
        tx += uint64_le(0)
        tx += compact_size(len(commitment_script))
        tx += commitment_script

    if has_witness:
        # Witness for input 0: single stack item = 32 zero bytes
        tx += compact_size(1)  # number of witness items
        tx += compact_size(32)
        tx += b"\x00" * 32

    # Locktime
    tx += uint32_le(0)

    return bytes(tx)


def compute_witness_commitment(wtxids):
    """
    Compute the witness commitment hash to embed in coinbase OP_RETURN.
    wtxids[0] must be 0x00*32 for the coinbase.
    """
    root = compute_merkle_root(wtxids)
    # Commitment = SHA256d(witness_root || witness_nonce)
    # witness_nonce is 32 zero bytes for default
    witness_nonce = b"\x00" * 32
    return double_sha256(root + witness_nonce)


def compute_merkle_root(hashes):
    """Compute the merkle root from a list of hashes (bytes, internal order)."""
    if len(hashes) == 0:
        return b"\x00" * 32
    level = list(hashes)
    while len(level) > 1:
        if len(level) % 2 != 0:
            level.append(level[-1])
        next_level = []
        for i in range(0, len(level), 2):
            next_level.append(double_sha256(level[i] + level[i + 1]))
        level = next_level
    return level[0]


def build_block(template, miner_address, extra_nonce=0):
    """
    Given a getblocktemplate result, build a candidate block.
    Returns (header_bytes, full_block_hex).
    """
    version = template["version"]
    prev_block_hash = hex_to_bytes_le(template["previousblockhash"])
    curtime = template["curtime"]
    bits_hex = template["bits"]
    bits = int(bits_hex, 16)
    height = template["height"]

    # Decode template transactions
    tx_list = template.get("transactions", [])

    # Compute coinbase reward (subsidy + fees)
    coinbase_value = template["coinbasevalue"]  # already in satoshis

    # Compute witness commitment if segwit transactions present
    # The wtxid for coinbase is always 32 zero bytes
    wtxids = [b"\x00" * 32]
    for tx in tx_list:
        wtxid_hex = tx.get("hash", tx["txid"])  # "hash" is the wtxid
        wtxids.append(bytes.fromhex(wtxid_hex)[::-1])  # to internal byte order

    witness_commitment = compute_witness_commitment(wtxids)

    # Build coinbase transaction
    coinbase_tx = make_coinbase_tx(
        height, miner_address, coinbase_value,
        witness_commitment=witness_commitment,
        extra_nonce=extra_nonce,
    )

    # txid of coinbase (without witness data for merkle tree)
    coinbase_txid_bytes = double_sha256(strip_witness(coinbase_tx))

    # Gather txids for merkle root (use txid, not wtxid)
    txids = [coinbase_txid_bytes]
    for tx in tx_list:
        txids.append(bytes.fromhex(tx["txid"])[::-1])

    merkle_root = compute_merkle_root(txids)

    # Build block header (80 bytes, nonce=0 initially)
    header = bytearray()
    header += int32_le(version)
    header += prev_block_hash
    header += merkle_root
    header += uint32_le(curtime)
    header += uint32_le(bits)
    header += uint32_le(0)  # nonce placeholder

    # Serialise transactions
    tx_data = bytearray()
    tx_count = 1 + len(tx_list)
    tx_data += compact_size(tx_count)
    tx_data += coinbase_tx
    for tx in tx_list:
        tx_data += bytes.fromhex(tx["data"])

    return bytes(header), bytes(tx_data)


def strip_witness(raw_tx):
    """
    Strip segwit witness data from a raw transaction so we can compute the
    legacy txid used in the merkle tree.
    """
    if len(raw_tx) < 6:
        return raw_tx

    # Check for segwit marker (0x00) + flag (0x01) after version
    if raw_tx[4] == 0x00 and raw_tx[5] == 0x01:
        result = bytearray()
        result += raw_tx[:4]  # version

        offset = 6  # skip marker + flag

        # Read input count
        vin_count, size = read_compact_size(raw_tx, offset)
        result += compact_size(vin_count)
        offset += size

        # Copy inputs
        for _ in range(vin_count):
            result += raw_tx[offset:offset + 32]  # prev txid
            offset += 32
            result += raw_tx[offset:offset + 4]  # prev vout
            offset += 4
            script_len, size = read_compact_size(raw_tx, offset)
            result += compact_size(script_len)
            offset += size
            result += raw_tx[offset:offset + script_len]
            offset += script_len
            result += raw_tx[offset:offset + 4]  # sequence
            offset += 4

        # Read output count
        vout_count, size = read_compact_size(raw_tx, offset)
        result += compact_size(vout_count)
        offset += size

        # Copy outputs
        for _ in range(vout_count):
            result += raw_tx[offset:offset + 8]  # value
            offset += 8
            script_len, size = read_compact_size(raw_tx, offset)
            result += compact_size(script_len)
            offset += size
            result += raw_tx[offset:offset + script_len]
            offset += script_len

        # Skip witness data for each input
        for _ in range(vin_count):
            wit_count, size = read_compact_size(raw_tx, offset)
            offset += size
            for _ in range(wit_count):
                item_len, size = read_compact_size(raw_tx, offset)
                offset += size
                offset += item_len

        # Locktime (last 4 bytes of original)
        result += raw_tx[offset:offset + 4]

        return bytes(result)
    else:
        return raw_tx


def read_compact_size(data, offset):
    """Read a Bitcoin compact size uint. Returns (value, bytes_consumed)."""
    first = data[offset]
    if first < 0xFD:
        return first, 1
    elif first == 0xFD:
        return struct.unpack_from("<H", data, offset + 1)[0], 3
    elif first == 0xFE:
        return struct.unpack_from("<I", data, offset + 1)[0], 5
    else:
        return struct.unpack_from("<Q", data, offset + 1)[0], 9


def target_from_bits(bits_hex):
    """Convert compact 'bits' representation to a 256-bit target integer."""
    bits_int = int(bits_hex, 16)
    exponent = bits_int >> 24
    mantissa = bits_int & 0x7FFFFF
    if exponent <= 3:
        target = mantissa >> (8 * (3 - exponent))
    else:
        target = mantissa << (8 * (exponent - 3))
    return target


# ---------------------------------------------------------------------------
# Mining loop
# ---------------------------------------------------------------------------

def mining_loop():
    """Main mining loop running in a background thread."""
    log.info("Mining loop started for %s", MINER_ID)

    with state_lock:
        address = miner_state["miner_address"]

    while not stop_event.is_set():
        try:
            mine_one_block(address)
        except Exception as e:
            log.error("Mining error: %s", e)
            log.debug(traceback.format_exc())
            if stop_event.wait(timeout=2):
                break

    log.info("Mining loop stopped.")


def mine_one_block(address):
    """Attempt to mine one block."""
    # Get block template
    template = rpc_call("getblocktemplate", [{"rules": ["segwit"]}])
    target = target_from_bits(template["bits"])
    height = template["height"]
    prev_hash = template["previousblockhash"]

    log.info(
        "Got template: height=%d  prev=%s...  txns=%d  target=%064x",
        height, prev_hash[:16], len(template.get("transactions", [])),
        target,
    )

    extra_nonce = 0
    max_nonce = 0xFFFFFFFF

    while not stop_event.is_set():
        # Build candidate block for this extra_nonce
        header_bytes, tx_data = build_block(template, address, extra_nonce)
        header_array = bytearray(header_bytes)

        # Iterate nonce space
        for nonce in range(0, max_nonce + 1):
            if stop_event.is_set():
                return

            # Check for stale block every 50000 nonces
            if nonce > 0 and nonce % 50000 == 0:
                try:
                    tip = rpc_call("getbestblockhash")
                    if tip != prev_hash:
                        log.info(
                            "Stale block detected (tip changed). Restarting template."
                        )
                        return  # will re-enter mine_one_block with fresh template
                except Exception:
                    pass

            # Set nonce in header (bytes 76-80)
            struct.pack_into("<I", header_array, 76, nonce)

            # Hash the header
            block_hash = double_sha256(bytes(header_array))
            hash_int = int.from_bytes(block_hash, byteorder="little")

            if hash_int <= target:
                # Found a valid block!
                block_hex = bytes(header_array).hex() + tx_data.hex()
                block_hash_display = block_hash[::-1].hex()
                log.info(
                    "*** BLOCK FOUND ***  height=%d  hash=%s  nonce=%d  extra=%d",
                    height, block_hash_display, nonce, extra_nonce,
                )

                # Submit block
                try:
                    result = rpc_call("submitblock", [block_hex])
                    if result is None or result == "":
                        log.info("Block accepted by node!")
                        on_block_mined(height, template["coinbasevalue"])
                    else:
                        log.warning("Block rejected: %s", result)
                except Exception as e:
                    log.error("submitblock error: %s", e)

                return  # move on to next block

        # Exhausted nonce space for this extra_nonce; bump extra_nonce
        extra_nonce += 1
        log.debug("Exhausted nonce space, extra_nonce now %d", extra_nonce)


def on_block_mined(height, reward_satoshis):
    """Update state after successfully mining a block."""
    reward_btc = reward_satoshis / 1e8

    with state_lock:
        miner_state["blocks_mined"] += 1
        miner_state["btc_gained"] += reward_btc
        miner_state["coinbase_txids"].append({
            "height": height,
            "reward_btc": reward_btc,
            "timestamp": time.time(),
        })

    # Report to backend
    report_to_backend()

    # Check if we should perform a transfer
    check_and_transfer()


def report_to_backend():
    """Send mining status update to the Node.js backend."""
    try:
        status = get_full_status()
        url = f"{BACKEND_URL}/api/miner-update"
        resp = requests.post(url, json=status, timeout=10)
        log.info("Reported to backend: %s", resp.status_code)
    except Exception as e:
        log.warning("Failed to report to backend: %s", e)


def get_full_status():
    """Build the full status dict."""
    with state_lock:
        blocks_mined = miner_state["blocks_mined"]
        btc_gained = miner_state["btc_gained"]
        wallet_name = miner_state["wallet_name"]
        threshold = miner_state["threshold"]

    # Calculate mature / immature balances
    btc_mature = 0.0
    btc_immature = 0.0
    try:
        balances = rpc_call("getbalances", wallet=wallet_name)
        # "mine" contains trusted, untrusted_pending, immature
        mine_bal = balances.get("mine", {})
        btc_mature = float(mine_bal.get("trusted", 0))
        btc_immature = float(mine_bal.get("immature", 0))
    except Exception as e:
        log.warning("Could not fetch wallet balances: %s", e)

    btc_available = btc_mature  # trusted balance is spendable

    return {
        "miner_id": MINER_ID,
        "blocks_mined": blocks_mined,
        "btc_gained": round(btc_gained, 8),
        "btc_mature": round(btc_mature, 8),
        "btc_immature": round(btc_immature, 8),
        "btc_available": round(btc_available, 8),
        "threshold": threshold,
        "mining": not stop_event.is_set() and miner_state["mining"],
    }


# ---------------------------------------------------------------------------
# Transfer logic
# ---------------------------------------------------------------------------

def fetch_addresses_from_backend():
    """Poll the backend for exchange_deposit_address and treasury_address."""
    try:
        url = f"{BACKEND_URL}/api/exchange/addresses"
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            with state_lock:
                if data.get("exchange_deposit_address"):
                    miner_state["exchange_deposit_address"] = data["exchange_deposit_address"]
                if data.get("treasury_address"):
                    miner_state["treasury_address"] = data["treasury_address"]
            return True
    except Exception as e:
        log.warning("Failed to fetch addresses from backend: %s", e)
    return False


def check_and_transfer():
    """If mature balance >= threshold, transfer funds."""
    with state_lock:
        threshold = miner_state["threshold"]
        wallet_name = miner_state["wallet_name"]
        exchange_addr = miner_state["exchange_deposit_address"]
        treasury_addr = miner_state["treasury_address"]

    if threshold is None or threshold <= 0:
        return

    # Get current mature balance
    try:
        balances = rpc_call("getbalances", wallet=wallet_name)
        mature = float(balances.get("mine", {}).get("trusted", 0))
    except Exception as e:
        log.warning("Could not get balance for transfer check: %s", e)
        return

    if mature < threshold:
        return

    # Fetch latest addresses from backend if we don't have them
    if not exchange_addr or not treasury_addr:
        fetch_addresses_from_backend()
        with state_lock:
            exchange_addr = miner_state["exchange_deposit_address"]
            treasury_addr = miner_state["treasury_address"]

    if not exchange_addr:
        log.warning("No exchange deposit address available, skipping transfer.")
        return

    log.info(
        "Mature balance %.8f >= threshold %.8f, initiating transfer.",
        mature, threshold,
    )

    try:
        # Build the outputs: threshold to exchange, surplus to treasury
        outputs = {}
        surplus = round(mature - threshold, 8)

        # Reserve a small amount for fees
        fee_reserve = 0.0001
        if surplus < fee_reserve:
            # Send (threshold - fee_reserve) to exchange, nothing to treasury
            send_amount = round(threshold - fee_reserve, 8)
            if send_amount <= 0:
                log.warning("Threshold too small to cover fees.")
                return
            outputs[exchange_addr] = send_amount
        else:
            outputs[exchange_addr] = round(threshold, 8)
            if treasury_addr:
                treasury_amount = round(surplus - fee_reserve, 8)
                if treasury_amount > 0:
                    outputs[treasury_addr] = treasury_amount

        log.info("Transfer outputs: %s", outputs)

        # Use sendmany for atomic multi-output transaction
        txid = rpc_call(
            "sendmany",
            ["", outputs],
            wallet=wallet_name,
        )
        log.info("Transfer sent, txid=%s", txid)

        # Notify backend about the deposit to the exchange
        try:
            exchange_amount = outputs.get(exchange_addr, 0)
            if exchange_amount > 0:
                requests.post(
                    f"{BACKEND_URL}/api/exchange/deposit",
                    json={"miner_id": MINER_ID, "amount": exchange_amount},
                    timeout=10,
                )
                log.info("Reported deposit of %.8f BTC to exchange", exchange_amount)
        except Exception as e:
            log.warning("Failed to report deposit to backend: %s", e)

    except Exception as e:
        log.error("Transfer failed: %s", e)
        log.debug(traceback.format_exc())


# ---------------------------------------------------------------------------
# Background tasks
# ---------------------------------------------------------------------------

def address_poller():
    """Periodically fetch addresses from the backend."""
    while not stop_event.is_set():
        fetch_addresses_from_backend()
        if stop_event.wait(timeout=30):
            break


def balance_checker():
    """Periodically check balance and trigger transfers."""
    while not stop_event.is_set():
        if stop_event.wait(timeout=60):
            break
        check_and_transfer()


# ---------------------------------------------------------------------------
# Flask REST API
# ---------------------------------------------------------------------------

@app.route("/status", methods=["GET"])
def api_status():
    """Return current miner status."""
    return jsonify(get_full_status())


@app.route("/threshold", methods=["POST"])
def api_threshold():
    """Receive threshold from the coordinator."""
    data = request.get_json(force=True)
    new_threshold = float(data.get("threshold", 0))

    with state_lock:
        miner_state["threshold"] = new_threshold

    log.info("Threshold set to %.8f BTC", new_threshold)

    # Also accept optional addresses
    if data.get("exchange_deposit_address"):
        with state_lock:
            miner_state["exchange_deposit_address"] = data["exchange_deposit_address"]
    if data.get("treasury_address"):
        with state_lock:
            miner_state["treasury_address"] = data["treasury_address"]

    return jsonify({"status": "ok", "threshold": new_threshold})


@app.route("/start", methods=["POST"])
def api_start():
    """Start the mining loop."""
    global mining_thread

    with state_lock:
        if miner_state["mining"]:
            return jsonify({"status": "already_mining"}), 200
        miner_state["mining"] = True

    stop_event.clear()
    mining_thread = threading.Thread(target=mining_loop, daemon=True)
    mining_thread.start()
    log.info("Mining started via API.")
    return jsonify({"status": "mining_started"})


@app.route("/stop", methods=["POST"])
def api_stop():
    """Stop the mining loop."""
    global mining_thread

    with state_lock:
        if not miner_state["mining"]:
            return jsonify({"status": "not_mining"}), 200
        miner_state["mining"] = False

    stop_event.set()
    if mining_thread is not None:
        mining_thread.join(timeout=10)
        mining_thread = None
    log.info("Mining stopped via API.")
    return jsonify({"status": "mining_stopped"})


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

def main():
    log.info("=== Bitcoin Miner Service [%s] starting ===", MINER_ID)

    # Wait for Bitcoin Core
    wait_for_node()

    # Setup wallet
    setup_wallet()

    # Start background pollers
    poller_thread = threading.Thread(target=address_poller, daemon=True)
    poller_thread.start()

    checker_thread = threading.Thread(target=balance_checker, daemon=True)
    checker_thread.start()

    # Auto-start mining
    log.info("Auto-starting mining loop ...")
    with state_lock:
        miner_state["mining"] = True
    stop_event.clear()
    global mining_thread
    mining_thread = threading.Thread(target=mining_loop, daemon=True)
    mining_thread.start()

    # Run Flask
    log.info("Starting Flask API on port 5000 ...")
    app.run(host="0.0.0.0", port=5000, threaded=True)


if __name__ == "__main__":
    main()
