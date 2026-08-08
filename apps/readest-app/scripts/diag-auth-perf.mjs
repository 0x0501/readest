#!/usr/bin/env node
/**
 * Feedback loop for auth/get-session latency & concurrency collapse.
 *
 * GREEN: sequential p95 < 2s AND concurrent 10-way all succeed within 5s
 * RED:   otherwise (matches production symptom of multi-minute get-session)
 *
 * Usage: node scripts/diag-auth-perf.mjs [baseUrl]
 */
import { performance } from 'node:perf_hooks';

const base = (process.argv[2] || 'https://read.sumku.cc').replace(/\/$/, '');
const url = `${base}/api/auth/get-session`;

const hit = async (timeoutMs = 30000) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'readest-diag-auth-perf/1.0' },
      signal: ac.signal,
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, ms: performance.now() - t0, body: body.slice(0, 40) };
  } catch (e) {
    return { ok: false, status: 0, ms: performance.now() - t0, body: String(e.name || e.message) };
  } finally {
    clearTimeout(timer);
  }
};

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

console.log(`target: ${url}`);
console.log('=== sequential x5 (timeout 90s) ===');
const seq = [];
for (let i = 0; i < 5; i++) {
  const r = await hit(90000);
  seq.push(r);
  console.log(`  ${i + 1}: status=${r.status} ${r.ms.toFixed(0)}ms ${r.body}`);
}

console.log('=== concurrent x10 (timeout 30s each) ===');
const t0 = performance.now();
const conc = await Promise.all(Array.from({ length: 10 }, () => hit(30000)));
const wall = performance.now() - t0;
conc.forEach((r, i) => console.log(`  ${i + 1}: status=${r.status} ${r.ms.toFixed(0)}ms ${r.body}`));
console.log(`  wall=${wall.toFixed(0)}ms`);

const seqMs = seq.map((r) => r.ms);
const concOk = conc.filter((r) => r.ok).length;
const concMs = conc.map((r) => r.ms);
const seqP95 = pct(seqMs, 95);
const concP95 = pct(concMs, 95);

// Thresholds encode the production bug: multi-second/minute get-session under light load
const green = seqP95 < 2000 && concOk === 10 && concP95 < 5000;
console.log('\n=== verdict ===');
console.log(JSON.stringify({ seqP95: Math.round(seqP95), concOk, concP95: Math.round(concP95), wall: Math.round(wall), green }, null, 2));
console.log(green ? 'GREEN' : 'RED');
process.exit(green ? 0 : 1);
