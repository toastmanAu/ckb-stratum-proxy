#!/bin/bash
PROXY_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$PROXY_DIR/proxy.pid"
LOG_FILE="$PROXY_DIR/proxy.log"

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

echo "Starting CKB Stratum Proxy..."
nohup node "$PROXY_DIR/proxy.js" >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 1

if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Proxy started (PID $(cat "$PID_FILE"))"
  echo "Stratum : $(hostname -I | awk '{print $1}'):3333"
  echo "Stats   : http://localhost:8081/"
  echo "Log     : $LOG_FILE"
else
  echo "ERROR: Proxy failed to start — check $LOG_FILE"
  exit 1
fi
