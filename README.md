# CKB Stratum Proxy

A local Stratum proxy for **CKB (Eaglesong)** mining. Point any number of miners (ASICs, NerdMiners, etc.) at your Pi's IP address, and this proxy handles a single upstream pool connection, distributing work and forwarding shares.

## Why?

- **Single upstream connection** — all your miners share one pool connection
- **Local network mining** — miners connect to your Pi, not direct to pool
- **Stats dashboard** — see all connected miners and share counts in one place
- **Works with ViaBTC** — handles the 5-param `mining.notify` and `mining.set_target` CKB protocol quirks

## Setup

```bash
cp config.example.json config.json
# Edit config.json with your pool details
nano config.json
```

## Config

```json
{
  "pool": {
    "host": "mining.viabtc.io",
    "port": 3001,
    "user": "ckb1qyqYOURADDRESS.WorkerName",
    "pass": "x"
  },
  "local": {
    "host": "0.0.0.0",
    "port": 3333,
    "statsPort": 8081,
    "difficulty": null
  }
}
```

- `difficulty`: Set a local difficulty override (e.g. `1` for NerdMiners). `null` = inherit pool difficulty.

## Run

```bash
# Foreground (dev/test)
node proxy.js

# Background (production)
bash start.sh
```

## Point your miner at it

| Setting  | Value                        |
|----------|------------------------------|
| Host     | `<your-pi-ip>` (e.g. 192.168.68.87) |
| Port     | `3333`                       |
| User     | anything (proxied under your pool account) |
| Pass     | anything                     |

## Stats

Visit `http://<pi-ip>:8081/` for live JSON stats:
- Upstream connection status
- Current job / block height
- Share accept rate
- Per-miner breakdown

## How it works

The proxy allocates each miner a unique extranonce prefix (1 byte appended to the pool's `extranonce1`). This means each miner searches a non-overlapping nonce space — no duplicate work. When a share is submitted, the proxy reconstructs the full extranonce before forwarding upstream.

## Notes

- Tested with ViaBTC CKB pool (`mining.viabtc.io:3001`)
- Supports `mining.set_target` (ViaBTC-style difficulty) and `mining.set_difficulty` (standard stratum)
- NerdMiner CKB connects fine — just update its pool address to `stratum+tcp://<pi-ip>:3333`
- `config.json` is gitignored — never committed
