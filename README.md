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
