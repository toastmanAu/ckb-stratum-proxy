#!/usr/bin/env node
'use strict';

const net  = require('net');
const http = require('http');
const { hashCKB, meetsTarget, selftest } = require('./eaglesong.js');

// ── Eaglesong self-test ───────────────────────────────────────────────────────
try {
  selftest();
  console.log('[PROXY] Eaglesong self-test OK');
} catch (e) {
  console.error('[PROXY] FATAL:', e.message);
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────
let config;
try { config = require('./config.json'); } catch (e) {
  console.error('[proxy] Missing config.json — copy config.example.json and fill in your details');
  process.exit(1);
}

const UPSTREAM_HOST = config.pool.host;
const UPSTREAM_PORT = config.pool.port;
const UPSTREAM_USER = config.pool.user;
const UPSTREAM_PASS = config.pool.pass || 'x';

const LOCAL_HOST  = config.local?.host      || '0.0.0.0';
const LOCAL_PORT  = config.local?.port      || 3333;
const STATS_PORT  = config.local?.statsPort || 8081;

// Vardiff settings
const VARDIFF = {
  targetShareSec : config.vardiff?.targetShareSec  || 30,   // aim for 1 share every N seconds
  retargetSec    : config.vardiff?.retargetSec      || 60,   // check interval
  variancePercent: config.vardiff?.variancePercent  || 30,   // ±30% tolerance
  minDiff        : config.vardiff?.minDiff          || 0.001,
  maxDiff        : config.vardiff?.maxDiff          || 1e9,
  // Initial difficulty sent to miners before pool diff is known.
  // null = wait for pool diff; number = send this immediately on connect.
  initialDiff    : config.vardiff?.initialDiff      ?? null,
};

// ── State ─────────────────────────────────────────────────────────────────────
let upstream        = null;
let upstreamBuf     = '';
let upstreamReady   = false;
let reconnectDelay  = 2000;

let poolExtranonce1     = '';
let poolExtranonce2Size = 0;
let currentJob          = null;  // last mining.notify params
let currentTarget       = null;  // last mining.set_target hex (LE 64 chars)
let poolDifficulty      = null;  // from mining.set_difficulty

let minerIdCounter = 0;
const miners = new Map();

const totals = {
  sharesSubmitted : 0,
  sharesAccepted  : 0,
  sharesRejected  : 0,
  startTime       : Date.now(),
};

const pendingUpstream = new Map();
let upstreamRequestId = 100;

// ── Logging ───────────────────────────────────────────────────────────────────
function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag.padEnd(5)}]`, ...args);
}

// ── Target / difficulty helpers ───────────────────────────────────────────────
// CKB target is 64-char LE hex.
// difficulty is an abstract unit: diff=1 ≈ pool base target.
// We scale the pool target up (easier) to create a local target.
// poolTarget × (poolDiff / localDiff) = localTarget (bigger = easier).
// We keep target ≤ 0xFFFF...FF (256 bits).

const MAX256 = (1n << 256n) - 1n;

/** Hex LE string → BigInt (little-endian byte order) */
function hexLEToBigInt(hex) {
  if (!hex || hex.length !== 64) return 0n;
  // reverse bytes for big-endian interpretation
  let beHex = '';
  for (let i = 62; i >= 0; i -= 2) beHex += hex.slice(i, i+2);
  return BigInt('0x' + beHex);
}

/** BigInt → hex LE string (64 chars) */
function bigIntToHexLE(n) {
  if (n <= 0n) return '0'.repeat(64);
  if (n > MAX256) n = MAX256;
  let beHex = n.toString(16).padStart(64, '0');
  let leHex = '';
  for (let i = 62; i >= 0; i -= 2) leHex += beHex.slice(i, i+2);
  return leHex;
}

/** Compute a local target for a given local difficulty, using the pool target as base. */
function localTargetForDiff(localDiff) {
  if (!currentTarget || !poolDifficulty || localDiff <= 0) return currentTarget;
  const poolTargetBig = hexLEToBigInt(currentTarget);
  // localTarget = poolTarget * (poolDiff / localDiff)
  // Use BigInt: multiply by poolDiff*1e6, divide by localDiff*1e6 to preserve precision
  const scale = 1_000_000n;
  const poolDiffScaled  = BigInt(Math.round(poolDifficulty * 1_000_000));
  const localDiffScaled = BigInt(Math.round(localDiff      * 1_000_000));
  let localTarget = (poolTargetBig * poolDiffScaled) / localDiffScaled;
  if (localTarget > MAX256) localTarget = MAX256;
  return bigIntToHexLE(localTarget);
}

// ── Vardiff engine ────────────────────────────────────────────────────────────
function computeNewDiff(miner) {
  const now = Date.now();
  const windowMs = now - miner.vardiff.windowStart;
  if (windowMs < 1000) return miner.vardiff.currentDiff;

  const shareCount = miner.vardiff.sharesInWindow;
  const actualShareSec = windowMs / 1000 / Math.max(shareCount, 1);
  const target = VARDIFF.targetShareSec;
  const variance = VARDIFF.variancePercent / 100;

  // Within tolerance — don't change
  if (Math.abs(actualShareSec - target) / target <= variance) {
    return miner.vardiff.currentDiff;
  }

  // Scale: newDiff = currentDiff * (actualShareSec / targetShareSec)
  // More shares than expected → actualShareSec < target → diff should go up (× >1 when ratio <1)
  // Fewer shares than expected → actualShareSec > target → diff should go down (× <1 when ratio >1)
  let ratio = target / actualShareSec;  // >1 means miner is fast → increase diff
  // Clamp adjustment to 4× per interval
  ratio = Math.min(Math.max(ratio, 0.25), 4.0);

  let newDiff = miner.vardiff.currentDiff * ratio;
  newDiff = Math.min(Math.max(newDiff, VARDIFF.minDiff), VARDIFF.maxDiff);

  return newDiff;
}

function checkVardiff(miner) {
  const now = Date.now();
  if (now - miner.vardiff.lastRetarget < VARDIFF.retargetSec * 1000) return;

  const newDiff = computeNewDiff(miner);
  miner.vardiff.windowStart  = now;
  miner.vardiff.sharesInWindow = 0;
  miner.vardiff.lastRetarget = now;

  if (newDiff !== miner.vardiff.currentDiff) {
    const old = miner.vardiff.currentDiff;
    miner.vardiff.currentDiff = newDiff;
    log('VDIFF', `#${miner.id} ${miner.worker}: ${old.toFixed(4)} → ${newDiff.toFixed(4)}`);
    sendLocalTarget(miner);
  }
}

function sendLocalTarget(miner) {
  const t = localTargetForDiff(miner.vardiff.currentDiff);
  if (t) sendToMiner(miner, { id: null, method: 'mining.set_target', params: [t] });
  // Also send set_difficulty for miners that use it
  const d = miner.vardiff.currentDiff;
  if (poolDifficulty != null) {
    sendToMiner(miner, { id: null, method: 'mining.set_difficulty', params: [d] });
  }
}

// ── Upstream connection ───────────────────────────────────────────────────────
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

  upstream.on('data', data => {
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

  upstream.on('error', err => log('UP', 'Error:', err.message));
}

function sendUpstream(obj) {
  if (!upstream?.writable) return false;
  upstream.write(JSON.stringify(obj) + '\n');
  return true;
}

function subscribeUpstream() {
  const id = upstreamRequestId++;
  sendUpstream({ id, method: 'mining.subscribe', params: ['ckb-stratum-proxy/1.1'] });
  pendingUpstream.set(id, { type: 'subscribe' });
}

function authorizeUpstream() {
  const id = upstreamRequestId++;
  sendUpstream({ id, method: 'mining.authorize', params: [UPSTREAM_USER, UPSTREAM_PASS] });
  pendingUpstream.set(id, { type: 'authorize' });
}

function handleUpstreamMessage(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { log('UP', 'Bad JSON:', line.slice(0,80)); return; }

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
          log('SHARE', `✓ pool accepted from ${miner.worker}`);
          sendToMiner(miner, { id: originalId, result: true, error: null });
        } else {
          totals.sharesRejected++;
          miner.sharesRejected++;
          log('SHARE', `✗ pool rejected from ${miner.worker}:`, JSON.stringify(msg.error));
          sendToMiner(miner, { id: originalId, result: false, error: msg.error });
        }
        return;
      }
    }
  }

  // Notifications
  switch (msg.method) {
    case 'mining.notify':
      currentJob = msg.params;
      log('POOL', `Job ${msg.params[0]} height=${msg.params[2]}`);
      broadcastToMiners({ id: null, method: 'mining.notify', params: currentJob });
      break;

    case 'mining.set_target':
      currentTarget = msg.params[0];
      log('POOL', `set_target → ${currentTarget.slice(0,16)}...`);
      // Don't relay pool target directly — send each miner their vardiff target
      for (const [, miner] of miners) {
        if (miner.authorized) sendLocalTarget(miner);
      }
      break;

    case 'mining.set_difficulty':
      poolDifficulty = msg.params[0];
      log('POOL', `set_difficulty → ${poolDifficulty}`);
      for (const [, miner] of miners) {
        if (miner.authorized) sendLocalTarget(miner);
      }
      break;

    default:
      log('UP', `Unhandled: ${msg.method}`);
  }
}

function handleUpstreamResponse(ctx, msg) {
  if (ctx.type === 'subscribe') {
    if (!msg.result) { log('UP', 'Subscribe FAILED:', msg.error); return; }
    poolExtranonce1     = msg.result[1] || '';
    poolExtranonce2Size = msg.result[2] || 8;
    log('UP', `Subscribed: en1=${poolExtranonce1} en2sz=${poolExtranonce2Size}`);
    authorizeUpstream();
  } else if (ctx.type === 'authorize') {
    if (msg.result) {
      log('UP', `Authorized as ${UPSTREAM_USER}`);
      upstreamReady = true;
    } else {
      log('UP', 'Auth FAILED:', msg.error);
    }
  }
}

// ── Extranonce allocation ─────────────────────────────────────────────────────
function minerExtranonce(minerId) {
  const suffix = (minerId & 0xff).toString(16).padStart(2, '0');
  return {
    extranonce1    : poolExtranonce1 + suffix,
    extranonce2Size: Math.max(1, poolExtranonce2Size - 1),
  };
}

function buildFullExtranonce2(miner, minerEn2) {
  return (miner.id & 0xff).toString(16).padStart(2, '0') + minerEn2;
}

// ── Broadcast ─────────────────────────────────────────────────────────────────
function broadcastToMiners(obj) {
  for (const [, miner] of miners) {
    if (miner.authorized) sendToMiner(miner, obj);
  }
}

// ── Miner server ──────────────────────────────────────────────────────────────
function sendToMiner(miner, obj) {
  if (!miner.socket?.writable) return;
  try { miner.socket.write(JSON.stringify(obj) + '\n'); } catch (_) {}
}

function handleMinerMessage(miner, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

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

      // Determine initial difficulty
      if (VARDIFF.initialDiff != null) {
        miner.vardiff.currentDiff = VARDIFF.initialDiff;
      } else if (poolDifficulty != null) {
        miner.vardiff.currentDiff = poolDifficulty;
      }

      // Send current mining state
      if (currentTarget || poolDifficulty != null) sendLocalTarget(miner);
      if (currentJob) sendToMiner(miner, { id: null, method: 'mining.notify', params: currentJob });
      break;
    }

    case 'mining.submit': {
      totals.sharesSubmitted++;
      miner.sharesSubmitted++;
      miner.vardiff.sharesInWindow++;
      checkVardiff(miner);

      const [workerName, jobId, en2, ntime, nonce] = msg.params;
      const fullEn2 = buildFullExtranonce2(miner, en2);

      // Validate share against the local (easy) target — accept for stats
      let localAccept = true;
      let meetsPool   = false;

      if (currentJob && currentTarget && nonce) {
        const powHash = currentJob[1];   // hex string
        // Reconstruct full nonce: extranonce1+suffix+en2 || nonce_from_miner
        // CKB nonce layout: bytes 0-7 = counter (from miner nonce field), bytes 8-15 = extranonce
        // ViaBTC stratum: nonce submitted as 32-char hex (16 bytes)
        try {
          const hash = hashCKB(powHash, nonce.padStart(32, '0'));

          // Check pool target
          meetsPool = meetsTarget(hash, currentTarget);

          // Check local (vardiff) target
          const localTarget = localTargetForDiff(miner.vardiff.currentDiff);
          localAccept = localTarget ? meetsTarget(hash, localTarget) : true;

          if (!localAccept) {
            log('SHARE', `#${miner.id} stale/low-diff share (below local target)`);
            sendToMiner(miner, { id: msg.id, result: false, error: [23, 'Low difficulty share', null] });
            return;
          }
        } catch (e) {
          log('SHARE', `#${miner.id} validation error: ${e.message} — forwarding anyway`);
          meetsPool = true;  // forward on error, let pool decide
        }
      } else {
        meetsPool = true;  // no job/target yet, forward
      }

      if (meetsPool) {
        // Forward to pool
        const upId = upstreamRequestId++;
        miner.pendingShares.set(upId, { originalId: msg.id });
        sendUpstream({ id: upId, method: 'mining.submit', params: [UPSTREAM_USER, jobId, fullEn2, ntime, nonce] });
        log('SHARE', `#${miner.id} → pool (job=${jobId})`);
      } else {
        // Local accept only — counts for hashrate, not forwarded
        miner.sharesLocalOnly++;
        miner.sharesAccepted++;  // count locally for display
        log('SHARE', `#${miner.id} local accept (below pool diff, not forwarded)`);
        sendToMiner(miner, { id: msg.id, result: true, error: null });
      }
      break;
    }

    case 'mining.get_transactions':
      sendToMiner(miner, { id: msg.id, result: [], error: null });
      break;

    case 'mining.extranonce.subscribe':
      sendToMiner(miner, { id: msg.id, result: true, error: null });
      break;

    default:
      log('MINER', `#${miner.id} unhandled: ${msg.method}`);
  }
}

const minerServer = net.createServer(socket => {
  const id    = minerIdCounter++;
  const now   = Date.now();
  const miner = {
    id,
    socket,
    authorized     : false,
    worker         : 'unknown',
    buf            : '',
    sharesSubmitted: 0,
    sharesAccepted : 0,
    sharesRejected : 0,
    sharesLocalOnly: 0,
    connectedAt    : now,
    extranonce2Size: 0,
    pendingShares  : new Map(),
    vardiff: {
      currentDiff   : VARDIFF.initialDiff ?? 1.0,
      windowStart   : now,
      sharesInWindow: 0,
      lastRetarget  : now,
    },
  };
  miners.set(id, miner);
  log('MINER', `#${id} connected from ${socket.remoteAddress}:${socket.remotePort}`);

  socket.on('data', data => {
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

  socket.on('error', err => log('MINER', `#${id} error: ${err.message}`));
});

minerServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    log('ERROR', `Port ${LOCAL_PORT} in use — already running?`);
    process.exit(1);
  }
  throw err;
});

// ── Stats HTTP ────────────────────────────────────────────────────────────────
function fmtUptime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
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
    address        : m.socket?.remoteAddress,
    uptimeSec      : Math.floor((Date.now() - m.connectedAt) / 1000),
    difficulty     : +m.vardiff.currentDiff.toFixed(4),
    sharesSubmitted: m.sharesSubmitted,
    sharesAccepted : m.sharesAccepted,
    sharesRejected : m.sharesRejected,
    sharesLocalOnly: m.sharesLocalOnly,
  }));

  const data = {
    proxy: {
      uptime, uptimeFmt: fmtUptime(uptime),
      upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
      upstreamReady,
      currentJobId  : currentJob?.[0] ?? null,
      blockHeight   : currentJob?.[2] ?? null,
      poolDifficulty,
      currentTarget : currentTarget ? currentTarget.slice(0,16)+'...' : null,
    },
    vardiff: {
      targetShareSec : VARDIFF.targetShareSec,
      retargetSec    : VARDIFF.retargetSec,
      variancePercent: VARDIFF.variancePercent,
    },
    shares: {
      submitted : totals.sharesSubmitted,
      accepted  : totals.sharesAccepted,
      rejected  : totals.sharesRejected,
      acceptRate: totals.sharesSubmitted > 0
        ? ((totals.sharesAccepted / totals.sharesSubmitted) * 100).toFixed(1) + '%' : 'n/a',
    },
    miners: { count: miners.size, list: minerList },
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
});

statsServer.on('error', err => {
  if (err.code === 'EADDRINUSE') log('WARN', `Stats port ${STATS_PORT} in use — stats disabled`);
});

// ── Start ─────────────────────────────────────────────────────────────────────
minerServer.listen(LOCAL_PORT, LOCAL_HOST, () => log('PROXY', `Stratum on ${LOCAL_HOST}:${LOCAL_PORT}`));
statsServer.listen(STATS_PORT, () => log('PROXY', `Stats on http://localhost:${STATS_PORT}/`));
connectUpstream();

log('PROXY', '─── CKB Stratum Proxy v1.1 ───');
log('PROXY', `Upstream  : ${UPSTREAM_HOST}:${UPSTREAM_PORT} as ${UPSTREAM_USER}`);
log('PROXY', `Vardiff   : target=${VARDIFF.targetShareSec}s  retarget=${VARDIFF.retargetSec}s  ±${VARDIFF.variancePercent}%`);
