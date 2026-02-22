# CKB Stratum Proxy

A solo mining stratum proxy for [Nervos CKB](https://www.nervos.org/) (Eaglesong PoW).

Connects directly to your local CKB full node — no pool involved. Any block found goes straight to the network and rewards go to your address.

## Features

- **Solo mining** — direct to your CKB node via `get_block_template` / `submit_block`
- **Multi-miner** — supports any stratum-compatible CKB miner (Goldshell CKBox, NerdMiner, etc.)
- **Vardiff** — automatic difficulty adjustment per miner
- **Goldshell compatible** — handles `mining.set_difficulty`, session resume, `mining.suggest_difficulty`
- **NerdMiner compatible** — handles `mining.set_target`, `mining.suggest_target`
- **Live stats** — HTTP stats API on port 8081 with hashrate estimation
- **Stable** — systemd service, RPC timeouts, node health tracking, auto-restart

## Quick Start

```bash
git clone https://github.com/toastmanAu/ckb-stratum-proxy
cd ckb-stratum-proxy
npm install
cp config.example.json config.json
# Edit config.json with your node details and CKB address
bash install.sh
```

## Config

```json
{
  "node": {
    "host": "127.0.0.1",
    "port": 8114,
    "coinbase": "ckb1qyq..."
  },
  "local": {
    "host": "0.0.0.0",
    "port": 3333,
    "statsPort": 8081
  },
  "mode": "solo",
  "vardiff": {
    "targetShareSec": 30,
    "initialDiff": 7000
  }
}
```

## Stats API

```
GET http://localhost:8081/        — full stats JSON
GET http://localhost:8081/health  — health check
```

Returns hashrate, connected miners, accepted shares, blocks found.

## Miner Setup

Point your miner at:
```
stratum+tcp://<your-pi-ip>:3333
```

Username: your CKB address  
Password: `x`

## Requirements

- Node.js 18+
- CKB full node with `block_assembler` configured (see [CKB docs](https://github.com/nervosnetwork/ckb))
- `--ba-advanced` flag on CKB node

## Tested Miners

| Miner | Status |
|-------|--------|
| Goldshell CKBox | ✅ Working |
| NerdMiner CKB (ESP32) | ✅ Working |

## License

MIT
