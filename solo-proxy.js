#!/usr/bin/env node
/**
 * solo-proxy.js — CKB Solo Mining Stratum Proxy
 *
 * Connects directly to a local CKB node (get_block_template / submit_block).
 * Presents a standard Stratum interface to miners on port 3333.
 * No pool involved — any block found goes straight to the network.
 */
'use strict';

const net  = require('net');
const http = require('http');
const { ckbBlake2b }  = require('./blake2b.js');
const { eaglesong }   = require('./eaglesong.js');
const { computePowHash, serializeFullHeader, parseEpoch } = require('./ckb-header.js');

// ── Self-tests ────────────────────────────────────────────────────────────────
require('./blake2b.js').selftest();
require('./eaglesong.js').selftest();
console.log('[SOLO] All self-tests OK');

// ── Config ────────────────────────────────────────────────────────────────────
let config;
try { config = require('./config.json'); } catch {
  console.error('[SOLO] Missing config.json'); process.exit(1);
}

const NODE_HOST  = config.node?.host     || '127.0.0.1';
const NODE_PORT  = config.node?.port     || 8114;
const COINBASE   = config.node?.coinbase || config.pool?.user || '';  // CKB address for rewards

const LOCAL_HOST = config.local?.host      || '0.0.0.0';
const LOCAL_PORT = config.local?.port      || 3333;
const STATS_PORT = config.local?.statsPort || 8081;

// Vardiff
const VARDIFF = {
  targetShareSec : config.vardiff?.targetShareSec  || 30,
  retargetSec    : config.vardiff?.retargetSec      || 60,
  variancePercent: config.vardiff?.variancePercent  || 30,
  minDiff        : config.vardiff?.minDiff          || 0.001,
  maxDiff        : config.vardiff?.maxDiff          || 1e9,
  initialDiff    : config.vardiff?.initialDiff      ?? 1.0,
};

// ── State ─────────────────────────────────────────────────────────────────────
let currentTemplate  = null;   // raw get_block_template result
let currentPowHash   = null;   // hex string, computed from template
let currentTargetLE  = null;   // 64-char LE hex, from compact_target
let currentJobId     = 0;
let pollTimer        = null;

let minerIdCounter = 0;
const miners = new Map();

const totals = {
  blocksFound    : 0,
  sharesSubmitted: 0,
  sharesAccepted : 0,
  sharesRejected : 0,
  startTime      : Date.now(),
};

// ── Logging ───────────────────────────────────────────────────────────────────
function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11,23);
  console.log(`[${ts}] [${tag.padEnd(5)}]`, ...args);
}

// ── Target helpers ────────────────────────────────────────────────────────────
const MASK256 = (1n << 256n) - 1n;

function compactToTargetLE(compact) {
  const c   = BigInt(compact);
  const exp = c >> 24n;
  const man = c & 0xffffffn;
  let n = (exp <= 3n) ? (man >> (8n * (3n - exp))) : (man << (8n * (exp - 3n)));
  if (n > MASK256) n = MASK256;
  let be = n.toString(16).padStart(64, '0');
  let le = ''; for (let i = 62; i >= 0; i -= 2) le += be.slice(i, i+2);
  return le;
}

/** Scale a pool-difficulty target to a local difficulty */
// Standard CKB stratum diff=1 reference: 2^224
// This matches industry convention — hashes/share at diff=1 = 2^32
const DIFF1_TARGET = (1n << 224n);

function diffToTargetLE(diff) {
  // Target = DIFF1_TARGET / diff
  // diff=1 → 2^224 (easy, ~1 share per 2^32 hashes at any hashrate)
  // diff=N → 2^224/N (N times harder, N times fewer shares)
  if (diff <= 0) return bigIntToHexLE(DIFF1_TARGET);
  const diffBig = BigInt(Math.round(diff * 1_000_000));
  let local = (DIFF1_TARGET * 1_000_000n) / diffBig;
  if (local > MASK256) local = MASK256;
  return bigIntToHexLE(local);
}

function hexLEToBigInt(hex) {
  let be = ''; for (let i = 62; i >= 0; i -= 2) be += hex.slice(i, i+2);
  return BigInt('0x' + be);
}

function bigIntToHexLE(n) {
  if (n <= 0n) return '0'.repeat(64);
  if (n > MASK256) n = MASK256;
  let be = n.toString(16).padStart(64,'0');
  let le = ''; for (let i = 62; i >= 0; i -= 2) le += be.slice(i,i+2);
  return le;
}

function meetsTargetLE(hashBuf, targetHex) {
  const t = Buffer.from(targetHex, 'hex');
  for (let i = 31; i >= 0; i--) {
    if (hashBuf[i] < t[i]) return true;
    if (hashBuf[i] > t[i]) return false;
  }
  return true;
}

// ── CKB Node RPC ─────────────────────────────────────────────────────────────
let nodeHealthy    = true;
let nodeFailCount  = 0;
const NODE_TIMEOUT = 8000;  // 8s timeout on RPC calls

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req  = http.request({
      host: NODE_HOST, port: NODE_PORT, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: NODE_TIMEOUT,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const msg = JSON.parse(d);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`RPC timeout: ${method}`));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── Block template polling ────────────────────────────────────────────────────
let lastTemplateTime = 0;

async function fetchTemplate() {
  try {
    const tpl = await rpc('get_block_template', [null, null, null]);

    // Check if it's a new template (different work_id or parent_hash)
    if (currentTemplate &&
        tpl.work_id === currentTemplate.work_id &&
        tpl.parent_hash === currentTemplate.parent_hash) {
      // Same template — but update timestamp field so miners get fresh nonce space
      // (avoids nonce collisions if same job runs for many seconds)
      currentTemplate.current_time = tpl.current_time;
      lastTemplateTime = Date.now();
      return;
    }

    // Node recovered after failures
    if (!nodeHealthy) {
      log('NODE', `CKB node recovered after ${nodeFailCount} failures`);
      nodeHealthy   = true;
      nodeFailCount = 0;
    }

    currentTemplate  = tpl;
    currentJobId     = (currentJobId + 1) & 0xffffffff;
    lastTemplateTime = Date.now();

    // Compute pow_hash from the template's header fields
    const fields = templateToHeaderFields(tpl);
    currentPowHash  = computePowHash(fields);
    currentTargetLE = compactToTargetLE(parseInt(tpl.compact_target, 16));

    const epoch  = parseEpoch(tpl.epoch);
    const height = parseInt(tpl.number, 16);
    log('JOB', `#${currentJobId} height=${height} epoch=${epoch.number}.${epoch.index}/${epoch.length} target=${currentTargetLE.slice(0,16)}...`);

    broadcastJob(false);
  } catch (e) {
    nodeFailCount++;
    if (nodeHealthy) {
      log('NODE', `CKB node error: ${e.message}`);
      nodeHealthy = false;
    } else if (nodeFailCount % 30 === 0) {
      // Log every 60s (30 × 2s poll) to avoid log spam
      log('NODE', `Still unreachable after ${nodeFailCount} attempts (${Math.round(nodeFailCount*2/60)}min)`);
    }
  }
}

function templateToHeaderFields(tpl) {
  return {
    version        : tpl.version,
    compact_target : tpl.compact_target,
    timestamp      : tpl.current_time,
    number         : tpl.number,
    epoch          : tpl.epoch,
    parent_hash    : tpl.parent_hash,
    transactions_root: tpl.transactions_root || ('0x' + '0'.repeat(64)),
    proposals_hash : tpl.proposals_hash     || ('0x' + '0'.repeat(64)),
    extra_hash     : tpl.uncles_hash        || ('0x' + '0'.repeat(64)),
    dao            : tpl.dao,
  };
}

function startPolling() {
  fetchTemplate();
  // Poll every 2 seconds — CKB blocks are ~6s
  pollTimer = setInterval(fetchTemplate, 2000);

  // Watchdog: if we haven't gotten a new template in 5 minutes, log loudly
  setInterval(() => {
    if (!lastTemplateTime) return;
    const staleSec = Math.floor((Date.now() - lastTemplateTime) / 1000);
    if (staleSec > 300) {
      log('WARN', `Template is ${staleSec}s old — CKB node may be stuck or offline`);
    }
  }, 60000);
}

// ── Stratum job format ────────────────────────────────────────────────────────
// We serve miners with a simplified Stratum:
//   mining.notify: [job_id, pow_hash, height, target, clean_jobs]
//   (mirrors the ViaBTC 5-param format NerdMiner already understands)
//   mining.set_target: [target_hex]
//
// Miners submit: [worker, job_id, extranonce2, ntime, nonce]
// We ignore extranonce/ntime for solo (we have the full template),
// just need the nonce.

function buildNotify(clean) {
  if (!currentTemplate) return null;
  return {
    id: null,
    method: 'mining.notify',
    params: [
      currentJobId.toString(16),          // job_id
      currentPowHash,                      // pow_hash (what miners hash against)
      parseInt(currentTemplate.number, 16),// block height (int, ViaBTC style)
      currentTargetLE,                     // network target (LE hex)
      clean,                               // clean jobs
    ],
  };
}

function broadcastJob(clean) {
  const notify = buildNotify(clean);
  if (!notify) return;
  for (const [, miner] of miners) {
    if (miner.authorized) sendToMiner(miner, notify);
  }
}

// ── Block submission ──────────────────────────────────────────────────────────
async function submitBlock(nonce) {
  const tpl    = currentTemplate;
  const fields = templateToHeaderFields(tpl);

  // Build full block as molecule (hex) for submit_block
  // CKB submit_block expects: { work_id, block }
  // block = { header, uncles, transactions, proposals }
  // For simplicity we build only the header bytes and use the template data

  // Construct the block object matching what get_block_template returned
  const block = {
    header: {
      version        : fields.version,
      compact_target : fields.compact_target,
      timestamp      : fields.timestamp,
      number         : fields.number,
      epoch          : fields.epoch,
      parent_hash    : fields.parent_hash,
      transactions_root: fields.transactions_root,
      proposals_hash : fields.proposals_hash,
      extra_hash     : fields.extra_hash,
      dao            : fields.dao,
      nonce          : '0x' + nonce.replace(/^0x/, '').padStart(32, '0'),
    },
    uncles      : tpl.uncles       || [],
    transactions: tpl.transactions || [],
    proposals   : tpl.proposals    || [],
  };

  try {
    const result = await rpc('submit_block', [tpl.work_id, block]);
    log('BLOCK', `✓ BLOCK FOUND! height=${parseInt(tpl.number,16)} nonce=${nonce} result=${result}`);
    totals.blocksFound++;
    return true;
  } catch (e) {
    log('BLOCK', `✗ submit failed: ${e.message}`);
    return false;
  }
}

// ── Vardiff ───────────────────────────────────────────────────────────────────
function checkVardiff(miner) {
  const now = Date.now();
  if (now - miner.vardiff.lastRetarget < VARDIFF.retargetSec * 1000) return;

  const windowMs = now - miner.vardiff.windowStart;
  const shares   = miner.vardiff.sharesInWindow;
  const actual   = windowMs / 1000 / Math.max(shares, 1);  // seconds/share
  const target   = VARDIFF.targetShareSec;
  const variance = VARDIFF.variancePercent / 100;

  miner.vardiff.windowStart   = now;
  miner.vardiff.sharesInWindow = 0;
  miner.vardiff.lastRetarget  = now;

  if (Math.abs(actual - target) / target <= variance) return;

  let ratio = Math.min(Math.max(target / actual, 0.25), 4.0);
  let newDiff = Math.min(Math.max(miner.vardiff.currentDiff * ratio, VARDIFF.minDiff), VARDIFF.maxDiff);
  if (newDiff === miner.vardiff.currentDiff) return;

  log('VDIF', `#${miner.id} ${miner.worker}: diff ${miner.vardiff.currentDiff.toFixed(4)} → ${newDiff.toFixed(4)}`);
  miner.vardiff.currentDiff = newDiff;
  sendVardiff(miner);
}

function sendVardiff(miner) {
  const t = diffToTargetLE(miner.vardiff.currentDiff);
  if (t) {
    // Send both set_target (NerdMiner) and set_difficulty (Goldshell/intminer)
    sendToMiner(miner, { id: null, method: 'mining.set_target', params: [t] });
    sendToMiner(miner, { id: null, method: 'mining.set_difficulty', params: [miner.vardiff.currentDiff] });
  }
}

// ── Miner handling ────────────────────────────────────────────────────────────
function sendToMiner(miner, obj) {
  if (!miner.socket?.writable) return;
  try { miner.socket.write(JSON.stringify(obj) + '\n'); } catch (_) {}
}

function handleMinerMessage(miner, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  switch (msg.method) {

    case 'mining.subscribe': {
      // Echo back provided session ID for session-resume (Goldshell intminer sends it in params[1])
      const sessionId = (msg.params && msg.params[1]) || Math.random().toString(16).slice(2, 10);
      miner._sessionId = sessionId;
      sendToMiner(miner, {
        id: msg.id,
        result: [
          [['mining.set_difficulty', sessionId], ['mining.notify', sessionId]],
          sessionId,
          4,
        ],
        error: null,
      });
      log('MINE', `#${miner.id} subscribed (session=${sessionId})`);
      break;
    }

    case 'mining.authorize': {
      miner.worker     = msg.params[0] || 'miner';
      miner.authorized = true;
      sendToMiner(miner, { id: msg.id, result: true, error: null });
      log('MINE', `#${miner.id} authorized as ${miner.worker}`);

      // Send current difficulty and job
      if (currentTargetLE) sendVardiff(miner);
      const notify = buildNotify(false);
      if (notify) sendToMiner(miner, notify);
      break;
    }

    case 'mining.submit': {
      totals.sharesSubmitted++;
      miner.sharesSubmitted++;
      miner.vardiff.sharesInWindow++;
      checkVardiff(miner);

      const [, jobId, , , nonce] = msg.params;
      const jobIdInt = parseInt(jobId, 16);

      // If share is for an old job: ACK it (so miner stops replaying buffer)
      // but don't actually validate/submit — the work is stale
      if (jobIdInt !== currentJobId) {
        totals.sharesSubmitted++;
        totals.sharesAccepted++;
        miner.sharesSubmitted++;
        miner.sharesAccepted++;
        sendToMiner(miner, { id: msg.id, result: true, error: null });
        return;
      }

      if (!nonce || !currentPowHash) {
        sendToMiner(miner, { id: msg.id, result: false, error: [20, 'No current job', null] });
        return;
      }

      // Validate nonce
      const noncePadded = nonce.replace(/^0x/,'').padStart(32, '0');
      const input       = Buffer.concat([Buffer.from(currentPowHash, 'hex'), Buffer.from(noncePadded, 'hex')]);
      const hash        = eaglesong(input);

      // Check local (vardiff) target
      const localTarget = diffToTargetLE(miner.vardiff.currentDiff);
      if (localTarget && !meetsTargetLE(hash, localTarget)) {
        totals.sharesRejected++;
        miner.sharesRejected++;
        log('MINE', `#${miner.id} share below local diff`);
        sendToMiner(miner, { id: msg.id, result: false, error: [23, 'Low difficulty share', null] });
        return;
      }

      totals.sharesAccepted++;
      miner.sharesAccepted++;
      log('MINE', `#${miner.id} share accepted (${miner.worker})`);
      sendToMiner(miner, { id: msg.id, result: true, error: null });

      // Check if it meets the actual network target
      if (meetsTargetLE(hash, currentTargetLE)) {
        log('MINE', '🎉 🎉 🎉  BLOCK SOLUTION! Submitting to node...');
        submitBlock(noncePadded).then(ok => {
          if (ok) broadcastJob(true);  // force clean job refresh after find
        });
      }
      break;
    }

    case 'mining.get_transactions':
      sendToMiner(miner, { id: msg.id, result: [], error: null });
      break;

    case 'mining.extranonce.subscribe':
      sendToMiner(miner, { id: msg.id, result: true, error: null });
      break;

    case 'mining.suggest_difficulty':
    case 'mining.suggest_target':
      // Acknowledge but let vardiff control the actual difficulty
      sendToMiner(miner, { id: msg.id, result: true, error: null });
      break;

    default:
      log('MINE', `#${miner.id} unhandled: ${msg.method}`);
  }
}

const minerServer = net.createServer(socket => {
  const id  = minerIdCounter++;
  const now = Date.now();
  const miner = {
    id, socket, authorized: false, worker: 'unknown', buf: '',
    sharesSubmitted: 0, sharesAccepted: 0, sharesRejected: 0,
    connectedAt: now,
    vardiff: {
      currentDiff: VARDIFF.initialDiff,
      windowStart: now, sharesInWindow: 0, lastRetarget: now,
    },
  };
  miners.set(id, miner);
  log('MINE', `#${id} connected from ${socket.remoteAddress}`);

  socket.on('data', data => {
    const raw = data.toString();
    // Debug: log first data from new connections for diagnosis
    if (!miner._firstData) {
      miner._firstData = true;
      log('DBG ', `#${id} first data (${raw.length}b): ${raw.slice(0,200).replace(/\n/g,'\\n')}`);
    }
    miner.buf += raw;
    let nl;
    while ((nl = miner.buf.indexOf('\n')) !== -1) {
      const line = miner.buf.slice(0, nl).trim();
      miner.buf  = miner.buf.slice(nl + 1);
      if (line) handleMinerMessage(miner, line);
    }
  });

  socket.on('close', () => { log('MINE', `#${id} (${miner.worker}) disconnected`); miners.delete(id); });
  socket.on('error', err => log('MINE', `#${id} error: ${err.message}`));
});

minerServer.on('error', err => {
  if (err.code === 'EADDRINUSE') { log('ERR', `Port ${LOCAL_PORT} in use`); process.exit(1); }
  throw err;
});

// ── Stats HTTP ────────────────────────────────────────────────────────────────
function fmtUptime(s) {
  return `${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m ${s%60}s`;
}

const statsServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, miners: miners.size, hasTemplate: !!currentTemplate }));
    return;
  }
  const uptime = Math.floor((Date.now() - totals.startTime) / 1000);

    // Hashrate estimate: sps × diff × 2^32
  // Standard CKB stratum formula — diff=1 baseline is 2^32 hashes/share
  function fmtHashrate(hps) {
    if (hps >= 1e12) return (hps / 1e12).toFixed(2) + ' TH/s';
    if (hps >= 1e9)  return (hps / 1e9).toFixed(2)  + ' GH/s';
    if (hps >= 1e6)  return (hps / 1e6).toFixed(2)  + ' MH/s';
    if (hps >= 1e3)  return (hps / 1e3).toFixed(2)  + ' kH/s';
    return hps.toFixed(0) + ' H/s';
  }

  const minerList = [...miners.values()].map(m => {
    const uptimeSec    = Math.max(1, Math.floor((Date.now() - m.connectedAt) / 1000));
    const sharesPerSec = m.sharesAccepted / uptimeSec;
    const hashrateHps  = sharesPerSec * m.vardiff.currentDiff * Math.pow(2, 32);
    return {
      id: m.id, worker: m.worker,
      address: m.socket?.remoteAddress,
      uptimeSec,
      difficulty: +m.vardiff.currentDiff.toFixed(4),
      sharesSubmitted: m.sharesSubmitted,
      sharesAccepted : m.sharesAccepted,
      sharesRejected : m.sharesRejected,
      hashrate: fmtHashrate(hashrateHps),
      hashrateHps: Math.round(hashrateHps),
    };
  });

  // Total hashrate across all miners
  const totalHps = minerList.reduce((s, m) => s + m.hashrateHps, 0);

  const data = {
    node    : `${NODE_HOST}:${NODE_PORT}`,
    nodeHealthy,
    coinbase: COINBASE,
    status  : currentTemplate ? (nodeHealthy ? 'active' : 'node-error') : 'waiting',
    uptime  : fmtUptime(uptime),
    templateAge: lastTemplateTime ? Math.floor((Date.now() - lastTemplateTime) / 1000) : null,
    block   : currentTemplate ? {
      height : parseInt(currentTemplate.number, 16),
      epoch  : currentTemplate.epoch,
      target : currentTargetLE?.slice(0,16) + '...',
      workId : currentTemplate.work_id,
    } : null,
    totals,
    hashrate: fmtHashrate(totalHps),
    hashrateHps: totalHps,
    miners  : {
      count: miners.size,
      list : minerList,
    },
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
});

statsServer.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
});

// ── Boot ──────────────────────────────────────────────────────────────────────
minerServer.listen(LOCAL_PORT, LOCAL_HOST, () => {
  log('SOLO', `Stratum listening on ${LOCAL_HOST}:${LOCAL_PORT}`);
});
statsServer.listen(STATS_PORT, () => {
  log('SOLO', `Stats on http://localhost:${STATS_PORT}/`);
});

log('SOLO', '─── CKB Solo Mining Proxy ───');
log('SOLO', `Node     : http://${NODE_HOST}:${NODE_PORT}`);
log('SOLO', `Coinbase : ${COINBASE || '(not set)'}`);
log('SOLO', `Vardiff  : target=${VARDIFF.targetShareSec}s  retarget=${VARDIFF.retargetSec}s`);

startPolling();
