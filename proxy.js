#!/usr/bin/env node
'use strict';

const net  = require('net');
const http = require('http');

// ── Config ────────────────────────────────────────────────────────────────────
let config;
try {
  config = require('./config.json');
} catch (e) {
  console.error('[proxy] Missing config.json — copy config.example.json and fill in your details');
  process.exit(1);
}

const UPSTREAM_HOST = config.pool.host;
const UPSTREAM_PORT = config.pool.port;
const UPSTREAM_USER = config.pool.user;   // e.g. ckb1qyq....usvlg.Wyltek
const UPSTREAM_PASS = config.pool.pass || 'x';

const LOCAL_HOST   = config.local?.host       || '0.0.0.0';
const LOCAL_PORT   = config.local?.port       || 3333;
const STATS_PORT   = config.local?.statsPort  || 8081;
const LOCAL_DIFF   = config.local?.difficulty || null;   // null = inherit pool diff

// ── State ─────────────────────────────────────────────────────────────────────
let upstream          = null;
let upstreamBuf       = '';
let upstreamReady     = false;
let reconnectDelay    = 2000;

let poolExtranonce1     = '';
let poolExtranonce2Size = 0;
let currentJob          = null;   // last mining.notify params
let currentTarget       = null;   // last mining.set_target param
let poolDifficulty      = null;   // last mining.set_difficulty param

let minerIdCounter = 0;
const miners = new Map();         // minerId → miner object

const totals = {
  sharesSubmitted : 0,
  sharesAccepted  : 0,
  sharesRejected  : 0,
  startTime       : Date.now(),
};

// Pending upstream requests waiting for response: upstreamId → {type, miner?, originalId?}
const pendingUpstream = new Map();
let upstreamRequestId = 100;

// ── Logging ───────────────────────────────────────────────────────────────────
function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag.padEnd(5)}]`, ...args);
}

// ── Upstream (pool) connection ────────────────────────────────────────────────
function connectUpstream() {
  log('UP', `Connecting to ${UPSTREAM_HOST}:${UPSTREAM_PORT}...`);
  upstream    = new net.Socket();
  upstreamBuf = '';
  upstreamReady = false;

  upstream.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    log('UP', 'Connected');
    reconnectDelay = 2000;
    subscribeUpstream();
  });

  upstream.on('data', (data) => {
    upstreamBuf += data.toString();
    let nl;
    while ((nl = upstreamBuf.indexOf('\n')) !== -1) {
      const line = upstreamBuf.slice(0, nl).trim();
      upstreamBuf = upstreamBuf.slice(nl + 1);
      if (line) handleUpstreamMessage(line);
    }
  });

  upstream.on('close', () => {
    log('UP', `Disconnected — reconnecting in ${reconnectDelay / 1000}s`);
    upstreamReady = false;
    upstream = null;
    setTimeout(connectUpstream, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  });

  upstream.on('error', (err) => {
    log('UP', 'Error:', err.message);
  });
}

function sendUpstream(obj) {
  if (!upstream || !upstream.writable) return false;
  upstream.write(JSON.stringify(obj) + '\n');
  return true;
}

function subscribeUpstream() {
  const id = upstreamRequestId++;
  sendUpstream({ id, method: 'mining.subscribe', params: ['ckb-stratum-proxy/1.0'] });
  pendingUpstream.set(id, { type: 'subscribe' });
}

function authorizeUpstream() {
  const id = upstreamRequestId++;
  sendUpstream({ id, method: 'mining.authorize', params: [UPSTREAM_USER, UPSTREAM_PASS] });
  pendingUpstream.set(id, { type: 'authorize' });
}

function handleUpstreamMessage(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) {
    log('UP', 'Bad JSON:', line.slice(0, 80));
    return;
  }

  // Response to one of our requests
  if (msg.id != null && pendingUpstream.has(msg.id)) {
    const ctx = pendingUpstream.get(msg.id);
    pendingUpstream.delete(msg.id);
    handleUpstreamResponse(ctx, msg);
    return;
  }

  // Response to a forwarded miner share
  if (msg.id != null) {
    for (const [, miner] of miners) {
      if (miner.pendingShares.has(msg.id)) {
        const { originalId } = miner.pendingShares.get(msg.id);
        miner.pendingShares.delete(msg.id);
        if (msg.result === true) {
          totals.sharesAccepted++;
          miner.sharesAccepted++;
          log('SHARE', `✓ accepted from ${miner.worker}`);
          sendToMiner(miner, { id: originalId, result: true, error: null });
        } else {
          totals.sharesRejected++;
          miner.sharesRejected++;
          log('SHARE', `✗ rejected from ${miner.worker}:`, JSON.stringify(msg.error));
          sendToMiner(miner, { id: originalId, result: false, error: msg.error });
        }
        return;
      }
    }
  }

  // Pool notifications
  switch (msg.method) {
    case 'mining.notify':
      currentJob = msg.params;
      log('POOL', `Job ${msg.params[0]} height=${msg.params[2]}`);
      broadcastToMiners({ id: null, method: 'mining.notify', params: currentJob });
      break;

    case 'mining.set_target':
      currentTarget = msg.params[0];
      log('POOL', `set_target → ${currentTarget}`);
      broadcastToMiners({ id: null, method: 'mining.set_target', params: [currentTarget] });
      break;

    case 'mining.set_difficulty':
      poolDifficulty = msg.params[0];
      log('POOL', `set_difficulty → ${poolDifficulty}`);
      broadcastDifficulty();
      break;

    default:
      log('UP', `Unhandled method: ${msg.method}`);
  }
}

function handleUpstreamResponse(ctx, msg) {
  if (ctx.type === 'subscribe') {
    if (!msg.result) {
      log('UP', 'Subscribe FAILED:', msg.error);
      return;
    }
    // Standard stratum: [subscriptions_array, extranonce1, extranonce2_size]
    // Some pools: [null, extranonce1, extranonce2_size]
    const en1    = msg.result[1];
    const en2sz  = msg.result[2];
    poolExtranonce1     = en1   || '';
    poolExtranonce2Size = en2sz || 8;
    log('UP', `Subscribed: extranonce1=${poolExtranonce1} extranonce2_size=${poolExtranonce2Size}`);
    authorizeUpstream();

  } else if (ctx.type === 'authorize') {
    if (msg.result) {
      log('UP', `Authorized as ${UPSTREAM_USER}`);
      upstreamReady = true;
    } else {
      log('UP', 'Authorization FAILED:', msg.error);
    }
  }
}

// ── Extranonce allocation ─────────────────────────────────────────────────────
// We reserve 1 byte (2 hex chars) per miner as a suffix on pool's extranonce1.
// Miner extranonce1  = poolExtranonce1 + minerIdByte (hex)
// Miner extranonce2_size = poolExtranonce2Size - 1
// When forwarding a share, prepend minerIdByte to the miner's extranonce2.

function minerExtranonce(minerId) {
  const suffix = (minerId & 0xff).toString(16).padStart(2, '0');
  return {
    extranonce1    : poolExtranonce1 + suffix,
    extranonce2Size: Math.max(1, poolExtranonce2Size - 1),
  };
}

function buildFullExtranonce2(miner, minerEn2) {
  const suffix = (miner.id & 0xff).toString(16).padStart(2, '0');
  return suffix + minerEn2;
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────
function broadcastToMiners(obj) {
  for (const [, miner] of miners) {
    if (miner.authorized) sendToMiner(miner, obj);
  }
}

function broadcastDifficulty() {
  const diff = LOCAL_DIFF != null ? LOCAL_DIFF : poolDifficulty;
  broadcastToMiners({ id: null, method: 'mining.set_difficulty', params: [diff] });
}

// ── Miner (downstream) server ─────────────────────────────────────────────────
function sendToMiner(miner, obj) {
  if (!miner.socket?.writable) return;
  try { miner.socket.write(JSON.stringify(obj) + '\n'); } catch (_) {}
}

function handleMinerMessage(miner, line) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }

  switch (msg.method) {

    case 'mining.subscribe': {
      const { extranonce1, extranonce2Size } = minerExtranonce(miner.id);
      miner.extranonce2Size = extranonce2Size;
      sendToMiner(miner, { id: msg.id, result: [null, extranonce1, extranonce2Size], error: null });
      log('MINER', `#${miner.id} subscribed (en1=${extranonce1} en2sz=${extranonce2Size})`);
      break;
    }

    case 'mining.authorize': {
      miner.worker     = msg.params[0] || 'unknown';
      miner.authorized = true;
      sendToMiner(miner, { id: msg.id, result: true, error: null });
      log('MINER', `#${miner.id} authorized as ${miner.worker}`);
      // Send current pool state immediately
      if (currentTarget)    sendToMiner(miner, { id: null, method: 'mining.set_target',     params: [currentTarget] });
      if (poolDifficulty)   sendToMiner(miner, { id: null, method: 'mining.set_difficulty', params: [LOCAL_DIFF != null ? LOCAL_DIFF : poolDifficulty] });
      if (currentJob)       sendToMiner(miner, { id: null, method: 'mining.notify',         params: currentJob });
      break;
    }

    case 'mining.submit': {
      totals.sharesSubmitted++;
      miner.sharesSubmitted++;
      const [, jobId, en2, ntime, nonce] = msg.params;
      const fullEn2 = buildFullExtranonce2(miner, en2);
      const upId    = upstreamRequestId++;
      miner.pendingShares.set(upId, { originalId: msg.id });
      sendUpstream({ id: upId, method: 'mining.submit', params: [UPSTREAM_USER, jobId, fullEn2, ntime, nonce] });
      log('MINER', `#${miner.id} share submitted job=${jobId}`);
      break;
    }

    case 'mining.get_transactions':
      sendToMiner(miner, { id: msg.id, result: [], error: null });
      break;

    case 'mining.extranonce.subscribe':
      // Acknowledge but we handle extranonce allocation ourselves
      sendToMiner(miner, { id: msg.id, result: true, error: null });
      break;

    default:
      log('MINER', `#${miner.id} unhandled: ${msg.method}`);
  }
}

const minerServer = net.createServer((socket) => {
  const id    = minerIdCounter++;
  const miner = {
    id,
    socket,
    authorized    : false,
    worker        : 'unknown',
    buf           : '',
    sharesSubmitted: 0,
    sharesAccepted : 0,
    sharesRejected : 0,
    connectedAt   : Date.now(),
    pendingShares : new Map(),
  };
  miners.set(id, miner);

  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  log('MINER', `#${id} connected from ${remote}`);

  socket.on('data', (data) => {
    miner.buf += data.toString();
    let nl;
    while ((nl = miner.buf.indexOf('\n')) !== -1) {
      const line = miner.buf.slice(0, nl).trim();
      miner.buf  = miner.buf.slice(nl + 1);
      if (line) handleMinerMessage(miner, line);
    }
  });

  socket.on('close', () => {
    log('MINER', `#${id} (${miner.worker}) disconnected`);
    miners.delete(id);
  });

  socket.on('error', (err) => {
    log('MINER', `#${id} socket error: ${err.message}`);
  });
});

minerServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('ERROR', `Port ${LOCAL_PORT} already in use — is the proxy already running?`);
    process.exit(1);
  }
  throw err;
});

// ── Stats HTTP server ─────────────────────────────────────────────────────────
function formatUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

const statsServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, miners: miners.size, upstreamReady }));
    return;
  }

  const uptime = Math.floor((Date.now() - totals.startTime) / 1000);

  const minerList = [...miners.values()].map(m => ({
    id             : m.id,
    worker         : m.worker,
    authorized     : m.authorized,
    address        : m.socket?.remoteAddress,
    uptimeSec      : Math.floor((Date.now() - m.connectedAt) / 1000),
    sharesSubmitted: m.sharesSubmitted,
    sharesAccepted : m.sharesAccepted,
    sharesRejected : m.sharesRejected,
  }));

  const data = {
    proxy: {
      uptime        : formatUptime(uptime),
      upstream      : `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
      upstreamReady,
      currentJobId  : currentJob ? currentJob[0] : null,
      blockHeight   : currentJob ? currentJob[2] : null,
      poolDifficulty,
      localDifficulty: LOCAL_DIFF,
      currentTarget,
    },
    shares: {
      submitted : totals.sharesSubmitted,
      accepted  : totals.sharesAccepted,
      rejected  : totals.sharesRejected,
      acceptRate: totals.sharesSubmitted > 0
        ? ((totals.sharesAccepted / totals.sharesSubmitted) * 100).toFixed(1) + '%'
        : 'n/a',
    },
    miners: {
      count: miners.size,
      list : minerList,
    },
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
});

statsServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('WARN', `Stats port ${STATS_PORT} already in use — stats disabled`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
minerServer.listen(LOCAL_PORT, LOCAL_HOST, () => {
  log('PROXY', `Stratum server listening on ${LOCAL_HOST}:${LOCAL_PORT}`);
});

statsServer.listen(STATS_PORT, () => {
  log('PROXY', `Stats HTTP on http://localhost:${STATS_PORT}/`);
});

connectUpstream();

log('PROXY', '─── CKB Stratum Proxy started ───');
log('PROXY', `Upstream : ${UPSTREAM_HOST}:${UPSTREAM_PORT} as ${UPSTREAM_USER}`);
log('PROXY', `Local    : ${LOCAL_HOST}:${LOCAL_PORT}`);
if (LOCAL_DIFF != null) log('PROXY', `Local diff override: ${LOCAL_DIFF}`);
