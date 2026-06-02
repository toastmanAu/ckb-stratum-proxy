# ckb-stratum-proxy

A Stratum v1 proxy for CKB (Nervos Network) mining. Ships **two** Node.js servers:

- **`proxy.js`** — pool-relay mode. Forwards upstream pool jobs and submits shares for many local miners over a single upstream connection.
- **`solo-proxy.js`** — direct-to-node solo mode. Pulls block templates from a CKB node you control via `get_block_template`, hands out work to miners as Stratum jobs, and submits any found block straight to the node via `submit_block`. No pool involved.

Includes a self-contained cyberpunk **live dashboard** at `http://<host>:8081/` for either mode.

---

## What works today

| Miner | Mode | Notes |
|---|---|---|
| **Bitmain Antminer K7** (GodMiner/2.0.1) | solo + pool | Validated 2026-06-02 against `solo-proxy.js` at ~67 TH/s, sustained share flow with 0% rejects |
| **Goldshell intminer** (Goldshell K7-series firmware) | solo + pool | Session-resume + nested-subscribe + `set_difficulty` path |
| **NerdMiner CKB** (ESP32) | solo + pool | Simple Eaglesong miner; uses LE target wire format |
| Any Stratum v1 CKB miner | both | Best effort — open an issue if your firmware needs a tweak |

The proxy auto-detects K7 / GodMiner via the `mining.subscribe` user-agent and switches subscribe format, target endianness, and nonce assembly accordingly. Other miners use the original code path. See `solo-proxy.js` `case 'mining.subscribe'` for the branch.

---

## Quick start — pool relay (forward to ViaBTC / F2Pool / etc.)

```bash
git clone https://github.com/toastmanAu/ckb-stratum-proxy
cd ckb-stratum-proxy
cp config.example.json config.json
# Edit config.json — set pool host/port/user
node proxy.js
```

Point your miner at `stratum+tcp://<host-ip>:3333`. Worker username is forwarded to the pool.

## Quick start — solo (direct to your own CKB node)

```bash
git clone https://github.com/toastmanAu/ckb-stratum-proxy
cd ckb-stratum-proxy
cp config.example.json config.json
# Edit config.json — point "node" at your local CKB RPC + your payout address
node solo-proxy.js
```

The proxy repeatedly calls `get_block_template` on your node, hands the templates out as Stratum jobs, and calls `submit_block` if any miner finds a network-difficulty hash. Block rewards go to whatever address your node's `block_assembler` is configured for.

Point your miner at `stratum+tcp://<host-ip>:3333` exactly as for pool mode.

---

## Configuration

```json
{
  "pool": {
    "host": "mining.viabtc.io",
    "port": 3001,
    "user": "ckb1q...YOUR_ADDRESS.WorkerName",
    "pass": "x"
  },
  "node": {
    "host": "127.0.0.1",
    "port": 8114,
    "coinbase": "ckb1q...YOUR_ADDRESS"
  },
  "local": {
    "host": "0.0.0.0",
    "port": 3333,
    "statsPort": 8081
  },
  "vardiff": {
    "targetShareSec": 30,
    "retargetSec": 60,
    "variancePercent": 30,
    "minDiff": 0.001,
    "maxDiff": 1000000000,
    "initialDiff": null
  }
}
```

- `pool` — required for `proxy.js`, ignored by `solo-proxy.js`
- `node` — required for `solo-proxy.js`, ignored by `proxy.js`
- `vardiff.initialDiff` — `null` lets vardiff start at 1.0 (network difficulty). For low-hashrate miners or quick share visibility, set lower (e.g. `0.0001`). Vardiff will retarget toward `targetShareSec` (default 30 s) automatically.
- `config.json` is `.gitignore`d — never committed.

---

## Live dashboard

`http://<host>:8081/` — single self-contained HTML page, no external dependencies, polls `/api/stats` every 2 s.

Shows:
- node tip height + epoch + work ID
- connected miners (worker, IP, difficulty, accepted/rejected counts)
- session uptime, total submitted/accepted/rejected, blocks found
- cumulative-shares sparkline + chain-tip drift sparkline
- accept-rate %, share rate per minute

Empty miners list renders a radar sweep so the proxy visibly "looks alive" before any miner connects.

## HTTP endpoints

| Path | Returns |
|---|---|
| `GET /` | dashboard HTML |
| `GET /api/stats` | live JSON: node, uptime, current job, miners list, share totals |
| `GET /health` | minimal `{ok, miners, hasTemplate}` JSON for probes |

---

## Running as a service

```bash
# user-level systemd
cp proxy.service.example ~/.config/systemd/user/ckb-stratum.service
systemctl --user enable --now ckb-stratum

# or detached background
bash start.sh
```

See `install.sh` for a one-shot installer.

---

## Solo mining notes

### Block-find probability

At CKB mainnet difficulty (~100 PH/s network as of mid-2026):

| Your hashrate | Expected time per block |
|---|---|
| 1 TH/s (NerdMiner cluster) | ~9 days |
| 7 TH/s (K7 underclocked) | ~32 hours |
| 67 TH/s (K7 spec) | ~3.3 hours |
| 1 PH/s | ~13 minutes |

Variance is enormous — one block ≈ 30 minutes of expected future hashrate, so an early-luck block well within the first 10 % of expected time is normal statistical behavior.

### Pool relay vs solo

| | Pool | Solo |
|---|---|---|
| Reward smoothing | yes (proportional shares) | no (lottery — full block reward or nothing) |
| Pool fee | typical 1-2% | 0% |
| Stratum complexity | one upstream, many downstream | proxy generates jobs from local node |
| Failure mode | upstream pool down → miners idle | local node down → miners idle |
| Best for | <10% of network hashrate | 1%+ of network hashrate, or "verify my hardware works" runs |

---

## Architecture

**Pool relay (`proxy.js`):**
```
Miners (Stratum)  →  ckb-stratum-proxy  →  Pool  →  CKB network
       :3333                                upstream
```

**Solo (`solo-proxy.js`):**
```
Miners (Stratum)  →  ckb-stratum-proxy  ↔  Your CKB node  →  CKB network
       :3333                              get_block_template / submit_block
```

---

## Protocol notes — why two miner code paths?

K7's GodMiner firmware enforces several invariants that NerdMiner / Goldshell don't:

- `extranonce1_bytes + extranonce2_size` **must equal 16 bytes**. K7 logs `n1size N, n2size M, n1size + n2size != 16, in parse_extranonce` and refuses to authorize otherwise.
- `mining.set_target` and `mining.notify` target hex must be **big-endian** on the wire. Other miners accept the original LE encoding.
- `mining.subscribe` response must be a simple 3-tuple `[null, extranonce1, en2_size]` — K7 closes the socket on Bitcoin's nested `[[subs], session, en2_size]` format.
- `mining.submit` is a 3-field `[worker, jobId, nonce]` — Bitcoin's 5-field `[worker, jobId, en2, ntime, nonce]` causes a naive destructure to read `nonce = undefined`.
- Full 16-byte Eaglesong nonce = `extranonce1 (server-assigned) || miner's 8-byte submitted nonce`. K7 zero-pads internally if extranonce1 < 8 bytes.
- CKB consensus interprets the Eaglesong hash as **big-endian** (`U256::from_big_endian`). Earlier versions of this proxy compared LE — which silently rejected real shares. Fixed for all miners.

The proxy detects GodMiner / ckbminer via the subscribe user-agent and branches accordingly. Adding support for another strict miner is one branch.

---

## License

MIT
