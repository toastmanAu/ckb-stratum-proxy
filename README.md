# ckb-stratum-proxy

A Stratum v1 proxy for CKB (Nervos Network) mining. Connects upstream to a CKB pool and exposes a local Stratum server that any miner can point at.

Handles ViaBTC's quirky 5-parameter `mining.notify` format and per-miner extranonce allocation.

---

## What it does

- **Local Stratum server** on port 3333 — point any CKB miner here
- **Pool relay** — forwards upstream pool jobs, handles auth, submits shares
- **Per-miner extranonce** — 1-byte prefix per miner, non-overlapping nonce space (up to 256 concurrent miners)
- **Stats HTTP** — port 8081, `GET /` returns JSON stats, `GET /health` for uptime check
- **ViaBTC quirk handling** — mining.set_target and 5-param notify parsed correctly

---

## Quick Start

```bash
git clone https://github.com/toastmanAu/ckb-stratum-proxy
cd ckb-stratum-proxy
cp config.example.json config.json
# Edit config.json — set pool address, port, worker name
node proxy.js
```

Point your miner at `stratum+tcp://<this-machine-ip>:3333`.

---

## Configuration

```json
{
  "pool": {
    "host": "mining.viabtc.io",
    "port": 3001,
    "user": "YourWorkerName",
    "pass": "x"
  },
  "local": {
    "stratumPort": 3333,
    "statsPort": 8081
  }
}
```

`config.json` is gitignored — never committed.

---

## Stats

```bash
curl http://localhost:8081/
# → JSON: connected miners, shares submitted, uptime, current job

curl http://localhost:8081/health
# → "OK" with 200 status
```

---

## Running as a service

```bash
cp proxy.service.example ~/.config/systemd/user/ckb-stratum.service
systemctl --user enable --now ckb-stratum
```

Or using the included start script:
```bash
bash start.sh
```

---

## Hardware tested

- **NerdMiner CKB** (ESP32-2432S028R) — connects via WiFi, submits Eaglesong shares
- Any Stratum v1 compatible CKB miner

---

## Solo Mining (Direct to Your Own Node)

> Mine directly to a CKB full node you control. All block rewards go to your address — no pool fees, no middleman.

### Prerequisites

- A synced CKB full node (mainnet or testnet)
- `ckb-miner` binary (ships with the CKB release package)
- Your CKB reward address

### Step 1 — Configure your CKB node for mining

In your node's `ckb.toml`, set your reward address:

```toml
[block_assembler]
code_hash = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8"
hash_type = "type"
args      = "0xYOUR_LOCK_ARGS_HERE"   # 20-byte lock args from your CKB address
message   = "0x"
```

To get your lock args:
```bash
ckb-cli util address-info --address ckb1q...youraddress
# Look for "args" in the lock script section
```

Restart your node after editing.

### Step 2 — Configure ckb-miner

In `ckb-miner.toml` (in your node directory):

```toml
[miner.client]
rpc_url     = "http://127.0.0.1:8114"   # your node's RPC
poll_interval = 1000                     # ms between job polls

[[miner.workers]]
worker_type  = "Dummy"
delay_type   = "Constant"
value        = 0
```

> `ckb-miner` uses the node's `get_block_template` RPC — no Stratum needed for CPU mining.

Start it:
```bash
ckb miner -C /path/to/your/ckb/dir
```

### Step 3 — Point Stratum miners at the proxy (optional)

If you have Stratum hardware (NerdMiner, ASICs) and want them pointing at your own node instead of a pool, you need a Stratum → `get_block_template` bridge. The recommended option is [ckb-solo-miner](https://github.com/nervosnetwork/ckb-miner) or run this proxy pointed at a self-hosted pool like [ckpool](https://bitbucket.org/ckolivas/ckpool).

For **NerdMiner / ESP32 direct solo** via this proxy:

```json
{
  "pool": {
    "host": "127.0.0.1",
    "port": 3333,
    "user": "ckb1q...youraddress.worker1",
    "pass": "x"
  }
}
```

Then point the proxy upstream at your own Stratum bridge on the node machine.

### Architecture comparison

**Pool mining (default):**
```
Miner → ckb-stratum-proxy → Pool (ViaBTC, F2Pool…) → CKB network
```

**Solo mining via ckb-miner (simplest):**
```
ckb-miner → CKB node (get_block_template) → CKB network
```

**Solo mining with Stratum hardware:**
```
NerdMiner / ASIC → ckb-stratum-proxy → Stratum bridge → CKB node → CKB network
```

### Reward address

Your lock args come from your CKB address. Quick way to find them:

```bash
# If you have ckb-cli:
ckb-cli util address-info --address ckb1q...

# Or decode manually — the last 20 bytes of the bech32 payload are your args
```

---

## Architecture

```
CKB miners (NerdMiner, ASICs, etc.)
    │  Stratum v1 TCP :3333
    ▼
ckb-stratum-proxy  (this)
    │  Stratum v1 TCP → pool
    ▼
Pool (ViaBTC, F2Pool, etc.)
```

---

## License

MIT
