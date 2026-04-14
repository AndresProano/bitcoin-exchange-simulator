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

# RPC configuration
RPC_TIMEOUT = 30
RPC_RETRIES = 3
RPC_INITIAL_BACKOFF_MS = 500
DEBUG_MODE = False  # Set to True to see debug logs

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO if not DEBUG_MODE else logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("miner")

# ---------------------------------------------------------------------------
# Structured logging helper
# ---------------------------------------------------------------------------
def log_structured(event, level, **data):
    """Output structured JSON logs with miner_id."""
    # Skip debug logs unless DEBUG_MODE is enabled
    if level == "debug" and not DEBUG_MODE:
        return
    
    timestamp = datetime.now().isoformat()
    message = json.dumps({
        "timestamp": timestamp,
        "miner_id": MINER_ID,
        "event": event,
        "level": level,
        **data,
    })
    
    if level == "debug":
        log.debug(message)
    elif level == "info":
        log.info(message)
    elif level == "warning":
        log.warning(message)
    elif level == "error":
        log.error(message)
    else:
        log.info(message)

# ---------------------------------------------------------------------------
# Retry helper with exponential backoff
# ---------------------------------------------------------------------------
def rpc_call_with_retry(method, params=None, wallet=None, max_retries=RPC_RETRIES):
    """Make RPC call with exponential backoff retry."""
    if params is None:
        params = []
    
    last_error = None
    for attempt in range(1, max_retries + 1):
        try:
            return rpc_call(method, params, wallet)
        except Exception as e:
            last_error = e
            if attempt < max_retries:
                backoff_ms = RPC_INITIAL_BACKOFF_MS * (2 ** (attempt - 1))
                log_structured("rpc_retry", "warning", 
                    method=method,
                    attempt=attempt,
                    max_retries=max_retries,
                    error_msg=str(e),
                    backoff_ms=backoff_ms,
                )
                time.sleep(backoff_ms / 1000.0)
            else:
                log_structured("rpc_max_retries_exceeded", "error",
                    method=method,
                    max_retries=max_retries,
                    error_msg=str(e),
                )
    
    raise last_error

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
    "transfer_in_progress": False,     # Prevent concurrent transfers
    "pending_deposits": [],             # Track deposits waiting for confirmation
    "successful_txids": [],             # Track successful transfers to prevent re-sending
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
    log_structured("waiting_for_node", "info")
    attempt = 0
    while True:
        attempt += 1
        try:
            info = rpc_call("getblockchaininfo")
            log_structured("node_connected", "info",
                chain=info["chain"],
                blocks=info["blocks"],
                attempt=attempt,
            )
            return
        except Exception:
            if attempt % 5 == 0:  # Log every 5 attempts
                log_structured("node_connection_attempt", "debug",
                    attempt=attempt,
                )
            time.sleep(2)


def setup_wallet():
    """Create (or load) a wallet for this miner and get a receiving address."""
    wallet_name = MINER_ID.replace("-", "_")

    # Check loaded wallets
    try:
        loaded = rpc_call("listwallets")
    except Exception as e:
        log_structured("listwallets_failed", "error", error=str(e))
        raise

    if wallet_name in loaded:
        log_structured("wallet_already_loaded", "debug", wallet_name=wallet_name)
    else:
        # Try to create; if it exists on disk, load it
        try:
            rpc_call("createwallet", [wallet_name])
            log_structured("wallet_created", "info", wallet_name=wallet_name)
        except Exception as e:
            if "already exists" in str(e).lower():
                try:
                    rpc_call("loadwallet", [wallet_name])
                    log_structured("wallet_loaded", "info", wallet_name=wallet_name)
                except Exception as e2:
                    if "already loaded" in str(e2).lower():
                        log_structured("wallet_already_loaded", "debug", wallet_name=wallet_name)
                    else:
                        log_structured("wallet_load_failed", "error",
                            wallet_name=wallet_name,
                            error=str(e2),
                        )
                        raise
            else:
                log_structured("wallet_create_failed", "error",
                    wallet_name=wallet_name,
                    error=str(e),
                )
                raise

    # Get a receiving address
    try:
        address = rpc_call("getnewaddress", ["mining_reward", "bech32"], wallet=wallet_name)
    except Exception as e:
        log_structured("getnewaddress_failed", "error",
            wallet_name=wallet_name,
            error=str(e),
        )
        raise

    log_structured("wallet_setup_complete", "info",
        wallet_name=wallet_name,
        address=address,
    )

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
    coinbase scriptSig. Returns the bytes to embed (length-prefix + LE int).
    This must match Bitcoin Core's exact CScript integer encoding.
    """
    if height == 0:
        return b"\x00"  # Empty for height 0
    
    # For small heights (1-16), Bitcoin uses direct opcodes
    if height <= 16:
        # OP_1 through OP_16 are 0x51 through 0x60
        return bytes([0x50 + height])
    
    # For larger heights, encode as minimally-encoded little-endian integer
    n = height
    data = bytearray()
    
    # Build little-endian representation
    while n > 0:
        data.append(n & 0xFF)
        n >>= 8
    
    # If MSB is set, add a sign byte to avoid misinterpretation as negative
    if data[-1] & 0x80:
        data.append(0x00)
    
    # Return: length-prefixed encoding (CScript format)
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
    log_structured("mining_loop_started", "info")

    with state_lock:
        address = miner_state["miner_address"]

    while not stop_event.is_set():
        try:
            mine_one_block(address)
        except Exception as e:
            log_structured("mining_error", "error",
                error=str(e),
                traceback=traceback.format_exc(),
            )
            if stop_event.wait(timeout=2):
                break

    log_structured("mining_loop_stopped", "info")


def mine_one_block(address):
    """Attempt to mine one block."""
    # Get block template with retry logic
    try:
        template = rpc_call_with_retry("getblocktemplate", [{"rules": ["segwit"]}], max_retries=3)
    except Exception as e:
        log_structured("getblocktemplate_failed", "error",
            error=str(e),
        )
        return
    
    try:
        target = target_from_bits(template["bits"])
        height = template["height"]
        prev_hash = template["previousblockhash"]
    except (KeyError, ValueError) as e:
        log_structured("template_parse_error", "error",
            error=str(e),
        )
        return

    log_structured("block_template_received", "info",
        height=height,
        prev_hash=prev_hash[:16],
        transactions=len(template.get("transactions", [])),
        bits=template["bits"],
    )

    extra_nonce = 0
    max_nonce = 0xFFFFFFFF

    while not stop_event.is_set():
        # Build candidate block for this extra_nonce
        try:
            header_bytes, tx_data = build_block(template, address, extra_nonce)
        except Exception as e:
            log_structured("block_build_error", "error",
                extra_nonce=extra_nonce,
                error=str(e),
            )
            return
        
        header_array = bytearray(header_bytes)

        # Iterate nonce space
        for nonce in range(0, max_nonce + 1):
            if stop_event.is_set():
                return

            # Check for stale block every 50000 nonces
            if nonce > 0 and nonce % 50000 == 0:
                try:
                    tip = rpc_call_with_retry("getbestblockhash", max_retries=2)
                    if tip != prev_hash:
                        log_structured("stale_template_detected", "info",
                            current_tip=tip[:16],
                            template_prev=prev_hash[:16],
                        )
                        return  # will re-enter mine_one_block with fresh template
                except Exception as e:
                    log_structured("stale_check_failed", "warning",
                        error=str(e),
                    )
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
                log_structured("block_found", "info",
                    height=height,
                    hash=block_hash_display,
                    nonce=nonce,
                    extra_nonce=extra_nonce,
                )

                # Submit block with retry logic
                try:
                    result = rpc_call_with_retry("submitblock", [block_hex], max_retries=3)
                    if result is None or result == "":
                        log_structured("block_accepted", "info",
                            height=height,
                            hash=block_hash_display,
                        )
                        on_block_mined(height, template["coinbasevalue"])
                    else:
                        log_structured("block_rejected", "warning",
                            height=height,
                            hash=block_hash_display,
                            reason=result,
                        )
                except Exception as e:
                    log_structured("submitblock_error", "error",
                        height=height,
                        error=str(e),
                    )

                return  # move on to next block

        # Exhausted nonce space for this extra_nonce; bump extra_nonce
        extra_nonce += 1
        log_structured("nonce_space_exhausted", "debug",
            extra_nonce=extra_nonce,
        )


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

    log_structured("block_mined_updated_state", "info",
        height=height,
        blocks_total=miner_state["blocks_mined"],
        reward_btc=reward_btc,
        total_btc_gained=miner_state["btc_gained"],
    )

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
        log_structured("backend_update_sent", "debug",
            status_code=resp.status_code,
        )
    except Exception as e:
        log_structured("backend_update_failed", "warning",
            error=str(e),
        )


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
        balances = rpc_call_with_retry("getbalances", wallet=wallet_name, max_retries=2)
        # "mine" contains trusted, untrusted_pending, immature
        mine_bal = balances.get("mine", {})
        btc_mature = float(mine_bal.get("trusted", 0))
        btc_immature = float(mine_bal.get("immature", 0))
        
        # Log balance details every time
        if btc_immature > 0 and btc_mature > 0:
            log_structured("balance_calculation", "debug",
                blocks=blocks_mined,
                mature=btc_mature,
                immature=btc_immature,
                total=btc_mature + btc_immature,
                threshold=threshold,
            )
    except Exception as e:
        log_structured("wallet_balance_fetch_failed", "warning",
            error=str(e),
        )

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
            addresses_updated = False
            with state_lock:
                if data.get("exchange_deposit_address"):
                    miner_state["exchange_deposit_address"] = data["exchange_deposit_address"]
                    addresses_updated = True
                if data.get("treasury_address"):
                    miner_state["treasury_address"] = data["treasury_address"]
                    addresses_updated = True
            
            if addresses_updated:
                log_structured("addresses_updated", "debug",
                    exchange_addr=data.get("exchange_deposit_address", "")[:12],
                    treasury_addr=data.get("treasury_address", "")[:12],
                )
            return True
    except Exception as e:
        log_structured("addresses_fetch_failed", "warning",
            error=str(e),
        )
    return False


def fetch_threshold_from_backend():
    """Recover the persisted threshold from the backend after restarts."""
    try:
        url = f"{BACKEND_URL}/api/threshold"
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            threshold = float(data.get("threshold", 0))
            with state_lock:
                previous_threshold = miner_state["threshold"]
                miner_state["threshold"] = threshold

            if previous_threshold != threshold:
                log_structured("threshold_recovered", "info", threshold=threshold)
            return True
    except Exception as e:
        log_structured("threshold_fetch_failed", "warning",
            error=str(e),
        )
    return False


def add_pending_deposit(txid, amount):
    """Track a sent deposit transaction until the backend verifies it."""
    with state_lock:
        for deposit in miner_state["pending_deposits"]:
            if deposit["txid"] == txid:
                deposit["timestamp"] = time.time()
                return
        miner_state["pending_deposits"].append({
            "txid": txid,
            "amount": amount,
            "timestamp": time.time(),
            "retry_count": 0,
        })


def check_and_transfer():
    """If mature balance >= threshold, transfer funds (once per threshold event)."""
    with state_lock:
        threshold = miner_state["threshold"]
        wallet_name = miner_state["wallet_name"]
        exchange_addr = miner_state["exchange_deposit_address"]
        treasury_addr = miner_state["treasury_address"]
        transfer_in_progress = miner_state["transfer_in_progress"]
        pending_deposits = list(miner_state["pending_deposits"])

    if threshold is None or threshold <= 0:
        return
    
    if transfer_in_progress:
        return

    if pending_deposits:
        log_structured("transfer_waiting_for_pending_deposit", "debug",
            pending_count=len(pending_deposits),
        )
        return

    # Get current mature balance
    try:
        balances = rpc_call_with_retry("getbalances", wallet=wallet_name, max_retries=2)
        mature = float(balances.get("mine", {}).get("trusted", 0))
    except Exception as e:
        log_structured("balance_fetch_failed", "warning", error=str(e))
        return

    if mature < threshold:
        return

    # Log when balance meets threshold
    log_structured("threshold_reached", "info", 
        mature_btc=round(mature, 8),
        threshold=threshold,
        exchange_addr_set=bool(exchange_addr),
        treasury_addr_set=bool(treasury_addr),
    )

    # Fetch latest addresses from backend if we don't have them
    if not exchange_addr or not treasury_addr:
        log_structured("addresses_not_set", "warning",
            exchange_addr_set=bool(exchange_addr),
            treasury_addr_set=bool(treasury_addr),
        )
        fetch_addresses_from_backend()
        with state_lock:
            exchange_addr = miner_state["exchange_deposit_address"]
            treasury_addr = miner_state["treasury_address"]

    if not exchange_addr or not treasury_addr:
        log_structured("missing_exchange_addresses", "error",
            threshold=threshold,
            mature_btc=mature,
            exchange_addr_set=bool(exchange_addr),
            treasury_addr_set=bool(treasury_addr),
        )
        return

    log_structured("initiating_transfer", "info",
        mature_btc=mature,
        threshold=threshold,
        exchange_addr=exchange_addr[:12] + "..." if exchange_addr else "NONE",
        treasury_addr=treasury_addr[:12] + "..." if treasury_addr else "NONE",
    )

    # Mark transfer as in progress to prevent duplicate concurrent transfers
    with state_lock:
        miner_state["transfer_in_progress"] = True

    try:
        # Build the outputs: exact threshold to exchange, surplus to treasury.
        # Bitcoin Core will subtract the transaction fee from the treasury output.
        outputs = {}
        surplus = round(mature - threshold, 8)

        min_treasury_output = 0.0001
        if surplus <= min_treasury_output:
            log_structured("waiting_for_fee_surplus", "info",
                mature_btc=round(mature, 8),
                threshold=threshold,
                min_treasury_output=min_treasury_output,
            )
            return

        outputs[exchange_addr] = round(threshold, 8)
        outputs[treasury_addr] = surplus

        log_structured("transfer_outputs_calculated", "debug",
            outputs={k: v for k, v in outputs.items()},
        )

        # Use sendmany for atomic multi-output transaction (with retry)
        try:
            txid = rpc_call_with_retry(
                "sendmany",
                ["", outputs, 1, "", [treasury_addr]],
                wallet=wallet_name,
                max_retries=3,
            )
            log_structured("transfer_sent", "info",
                txid=txid,
            )
        except Exception as e:
            log_structured("sendmany_failed", "error",
                error=str(e),
            )
            return

        # Notify backend about the deposit to the exchange (include txid for on-chain verification)
        exchange_amount = outputs.get(exchange_addr, 0)
        if exchange_amount > 0:
            try:
                response = requests.post(
                    f"{BACKEND_URL}/api/exchange/deposit",
                    json={"miner_id": MINER_ID, "amount": exchange_amount, "txid": txid},
                    timeout=10,
                )
                
                if response.status_code == 200:
                    log_structured("deposit_reported", "info",
                        amount=exchange_amount,
                        txid=txid,
                    )
                    # Mark transfer as successful
                    with state_lock:
                        miner_state["successful_txids"].append(txid)
                        if txid in [d["txid"] for d in miner_state["pending_deposits"]]:
                            miner_state["pending_deposits"] = [
                                d for d in miner_state["pending_deposits"] if d["txid"] != txid
                            ]
                else:
                    log_structured("deposit_verification_pending", "info",
                        txid=txid,
                        status_code=response.status_code,
                        amount=exchange_amount,
                    )
                    add_pending_deposit(txid, exchange_amount)
            except Exception as e:
                log_structured("deposit_report_failed", "warning",
                    error=str(e),
                    txid=txid,
                )
                add_pending_deposit(txid, exchange_amount)

        report_to_backend()

    finally:
        # Always mark transfer as complete
        with state_lock:
            miner_state["transfer_in_progress"] = False


# ---------------------------------------------------------------------------
# Background tasks
# ---------------------------------------------------------------------------

def address_poller():
    """Periodically fetch coordinator settings from the backend."""
    log_structured("address_poller_started", "debug")
    while not stop_event.is_set():
        fetch_addresses_from_backend()
        fetch_threshold_from_backend()
        if stop_event.wait(timeout=30):
            break
    log_structured("address_poller_stopped", "debug")


def balance_checker():
    """Periodically check balance and trigger transfers."""
    log_structured("balance_checker_started", "debug")
    while not stop_event.is_set():
        if stop_event.wait(timeout=15):  # Check every 15 seconds instead of 60
            break
        check_and_transfer()
        retry_pending_deposits()
    log_structured("balance_checker_stopped", "debug")


def retry_pending_deposits():
    """Retry pending deposits that failed to verify."""
    with state_lock:
        pending = list(miner_state["pending_deposits"])  # Copy list
    
    if not pending:
        return
    
    now = time.time()
    for deposit in pending:
        # Retry after 30 seconds, max 5 times
        age = now - deposit["timestamp"]
        if age < 30:
            continue
        
        retry_count = deposit.get("retry_count", 0)
        if retry_count >= 5:
            log_structured("deposit_retry_exhausted", "warning",
                txid=deposit["txid"],
                amount=deposit["amount"],
            )
            with state_lock:
                miner_state["pending_deposits"] = [
                    d for d in miner_state["pending_deposits"] if d["txid"] != deposit["txid"]
                ]
            continue
        
        try:
            response = requests.post(
                f"{BACKEND_URL}/api/exchange/deposit",
                json={"miner_id": MINER_ID, "amount": deposit["amount"], "txid": deposit["txid"]},
                timeout=10,
            )
            
            if response.status_code == 200:
                log_structured("deposit_retry_succeeded", "info",
                    txid=deposit["txid"],
                    amount=deposit["amount"],
                    retry_count=retry_count,
                )
                with state_lock:
                    miner_state["pending_deposits"] = [
                        d for d in miner_state["pending_deposits"] if d["txid"] != deposit["txid"]
                    ]
            else:
                # Increment retry count
                with state_lock:
                    for d in miner_state["pending_deposits"]:
                        if d["txid"] == deposit["txid"]:
                            d["retry_count"] = retry_count + 1
        except Exception as e:
            log_structured("deposit_retry_failed", "debug",
                txid=deposit["txid"],
                error=str(e),
            )


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
    try:
        data = request.get_json(force=True)
        new_threshold = float(data.get("threshold", 0))
    except Exception as e:
        log_structured("threshold_parse_error", "warning", error=str(e))
        return jsonify({"status": "error", "error": "Invalid threshold format"}), 400

    with state_lock:
        miner_state["threshold"] = new_threshold

    log_structured("threshold_set", "info", threshold=new_threshold)

    # Also accept optional addresses
    if data.get("exchange_deposit_address"):
        with state_lock:
            miner_state["exchange_deposit_address"] = data["exchange_deposit_address"]
            log_structured("exchange_address_set", "info",
                address=data["exchange_deposit_address"][:12] + "...",
            )
    if data.get("treasury_address"):
        with state_lock:
            miner_state["treasury_address"] = data["treasury_address"]
            log_structured("treasury_address_set", "info",
                address=data["treasury_address"][:12] + "...",
            )

    # Trigger a check immediately (don't wait for next balance_checker cycle)
    # This makes the transfer happen faster
    if new_threshold > 0:
        check_and_transfer()

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
    log_structured("mining_started", "info")
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
    log_structured("mining_stopped", "info")
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

    # Register with backend so it knows we're alive
    try:
        requests.post(
            f"{BACKEND_URL}/api/miner-register",
            json={"miner_id": MINER_ID},
            timeout=5,
        )
        log_structured("backend_registration", "info", status="registered")
    except Exception as e:
        log_structured("backend_registration_failed", "warning", error=str(e))

    # Recover persisted coordinator state before background checks start.
    fetch_addresses_from_backend()
    fetch_threshold_from_backend()

    # Start background pollers
    poller_thread = threading.Thread(target=address_poller, daemon=True)
    poller_thread.start()

    checker_thread = threading.Thread(target=balance_checker, daemon=True)
    checker_thread.start()


    # Run Flask
    log.info("Starting Flask API on port 5000 ...")
    app.run(host="0.0.0.0", port=5000, threaded=True)


if __name__ == "__main__":
    main()
