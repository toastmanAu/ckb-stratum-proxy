'use strict';
/**
 * job-registry.test.js — snapshot each job by id and validate a submitted share
 * against the EXACT job the miner solved, not whatever job is current now.
 *
 * This is the fix for the stale-job drop: a block solved just after the job
 * rolled over must still be recovered, not silently ACK'd and discarded.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createJobRegistry, evaluateShare } = require('../job-registry.js');

const POW = 'a'.repeat(64);          // any 32-byte pow_hash hex
const MAX_TARGET = 'ff'.repeat(32);  // easiest possible target — any hash is a "block"
const ZERO_TARGET = '00'.repeat(32); // impossible target — nothing is a block

function snap(id, targetLE = MAX_TARGET) {
  return { jobId: id, powHash: POW, targetLE, template: { number: '0x' + id.toString(16) } };
}

// ── registry: snapshot + resolve ────────────────────────────────────────────
test('add then get returns the snapshot; current is the last added', () => {
  const r = createJobRegistry(8);
  r.add(snap(1)); r.add(snap(2));
  assert.strictEqual(r.get(1).jobId, 1);
  assert.strictEqual(r.current.jobId, 2);
});

test('get on an unknown job id returns undefined', () => {
  const r = createJobRegistry(8);
  r.add(snap(1));
  assert.strictEqual(r.get(999), undefined);
});

test('registry evicts oldest beyond maxJobs but keeps recent ones', () => {
  const r = createJobRegistry(3);
  for (let i = 1; i <= 5; i++) r.add(snap(i));
  assert.strictEqual(r.size, 3);
  assert.strictEqual(r.get(1), undefined, 'oldest evicted');
  assert.strictEqual(r.get(2), undefined, 'second-oldest evicted');
  assert.ok(r.get(3) && r.get(4) && r.get(5), 'three most recent retained');
});

// ── evaluateShare: validate against the snapshot ────────────────────────────
test('unknown job (evicted / never issued) yields status "unknown_job"', () => {
  const v = evaluateShare(undefined, '0x01', 1);
  assert.strictEqual(v.status, 'unknown_job');
  assert.strictEqual(v.isBlock, false);
});

test('a share meeting the job network target is flagged isBlock=true', () => {
  // MAX network target → any hash clears it → block detected against THIS job
  const v = evaluateShare(snap(1, MAX_TARGET), '0x1234', 0.0001);
  assert.strictEqual(v.isBlock, true);
});

test('a share not meeting the network target has isBlock=false', () => {
  // ZERO network target → no ordinary hash clears it
  const v = evaluateShare(snap(1, ZERO_TARGET), '0x1234', 0.0001);
  assert.strictEqual(v.isBlock, false);
});

test('a share below the miner local difficulty is low_diff', () => {
  // huge minerDiff → local target ~2^184; a real eaglesong hash exceeds it w.h.p.
  const v = evaluateShare(snap(1, MAX_TARGET), '0x1234', 1e12);
  assert.strictEqual(v.status, 'low_diff');
});

test('evaluateShare pads the nonce to 16 bytes (32 hex) consistently', () => {
  const v = evaluateShare(snap(1, MAX_TARGET), '0xabc', 0.0001);
  assert.strictEqual(v.noncePadded, 'abc'.padStart(32, '0'));
});

// ── the actual fix: a stale-but-solved job is still recoverable ─────────────
test('a block solved on an OLD job (after the job rolled) is still detectable', () => {
  const r = createJobRegistry(8);
  r.add(snap(1, MAX_TARGET)); // the job the miner will solve
  r.add(snap(2));             // job rolls forward...
  r.add(snap(3));             // ...current is now 3, so job 1 is "stale"
  assert.strictEqual(r.current.jobId, 3);

  const solved = r.get(1);                       // resolve the job the miner solved
  assert.ok(solved, 'stale job snapshot still present');
  const v = evaluateShare(solved, '0xdeadbeef', 0.0001);
  assert.strictEqual(v.isBlock, true, 'stale-job block recovered, not dropped');
});
