#!/bin/bash
PROXY_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$PROXY_DIR/proxy.pid"
LOG_FILE="$PROXY_DIR/proxy.log"

# Determine mode from config.json
MODE=$(node -e "try{const c=require('$PROXY_DIR/config.json');console.log(c.mode||'pool')}catch(e){console.log('pool')}" 2>/dev/null)
if [ "$MODE" = "solo" ]; then
  SCRIPT="$PROXY_DIR/solo-proxy.js"
  echo "Mode: SOLO (direct to local CKB node)"
else
  SCRIPT="$PROXY_DIR/proxy.js"
  echo "Mode: POOL (upstream pool relay)"
fi

# Kill any existing instance
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing proxy (PID $OLD_PID)..."
    kill "$OLD_PID"
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

echo "Starting CKB Stratum Proxy ($MODE)..."
nohup node "$SCRIPT" >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 1

if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Proxy started (PID $(cat "$PID_FILE"))"
  echo "Stratum : $(hostname -I | awk '{print $1}'):3333"
  echo "Stats   : http://localhost:8081/"
  echo "Log     : $LOG_FILE"
else
  echo "ERROR: Proxy failed to start — check $LOG_FILE"
  cat "$LOG_FILE" | tail -20
  exit 1
fi
