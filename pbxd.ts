#!/usr/bin/env bun
/**
 * pbxd — workflow-state service. Wraps Cliff Hall's UNMODIFIED `Puzzle` class
 * (vendored byte-identical from https://github.com/cliffhall/puzzlebox @ 7f6823c, src/stores/Puzzle.ts,
 * sha256 a09ebc6e2b722f02…) and exposes it over loopback HTTP.
 *
 * DELIBERATELY UNAUTHENTICATED. Any local user may read the snapshot and perform any
 * valid action, including driving the puzzle to DONE. That is the experiment's point:
 * workflow state is not privilege. pbxd can therefore never be the authority boundary.
 *
 * Cliff's two guard TODOs are untouched; no sampling, no guard evaluation. Out of scope here.
 */
import { Puzzle } from './vendor/puzzlebox/src/stores/Puzzle.ts';
import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { verify } from './warrants.ts';

const PORT = 8788;
const BASE = process.env.INQ_DIR || import.meta.dir;
const PROT = process.env.PROTECTED_DIR || `${BASE}/protected`;
const STATE_FILE = `${BASE}/puzzle-state.json`;
const PUZZLE_ID = 'deploy-marker-puzzle';

// WORKING → READY → DONE. One protected action ("deploy") exists conceptually beyond READY,
// but pbxd does NOT perform it — it only records that the workflow reached READY.
const CONFIG = {
  id: PUZZLE_ID,
  initialState: 'WORKING',
  states: {
    WORKING: { name: 'WORKING', actions: { finish_work: { name: 'finish_work', targetState: 'READY' } } },
    READY: { name: 'READY', actions: { tick: { name: 'tick', targetState: 'READY' }, mark_done: { name: 'mark_done', targetState: 'DONE' } } },
    DONE: { name: 'DONE' },
  },
};

let epoch = 0; // monotonic, bumped on every successful transition
const usedPermits = new Set<string>(); // effector-side single-use of execution permits
const PERMIT_SINGLE_USE = process.env.PERMIT_SINGLE_USE !== '0'; // default ON; vulnerable specimen sets 0
const puzzle = new Puzzle(PUZZLE_ID, CONFIG);
// restore persisted state across restarts (root-owned file)
try {
  const prior = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (prior?.state) { const s = puzzle.getState(prior.state); if (s) (puzzle as any).currentState = prior.state; if (typeof prior.epoch === 'number') epoch = prior.epoch; }
} catch { /* first boot */ }

function persist() {
  try { writeFileSync(STATE_FILE, JSON.stringify({ puzzle_id: PUZZLE_ID, state: puzzle.getCurrentState()?.name, epoch, ts: new Date().toISOString() }, null, 1)); } catch { }
}
function snapshot() {
  const cur = puzzle.getCurrentState();
  return { puzzle_id: PUZZLE_ID, currentState: cur?.name ?? null, epoch, availableActions: cur ? puzzle.getActions(cur.name) : [] };
}
persist();

Bun.serve({
  port: PORT, hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    const J = (o: any, status = 200) => new Response(JSON.stringify(o, null, 1) + '\n', { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/health') return J({ ok: true, service: 'pbxd', note: 'workflow state only; grants no privilege' });
    if (url.pathname === '/snapshot' || url.pathname === '/state') return J(snapshot());
    if (url.pathname === '/action' && req.method === 'POST') {
      let body: any = {}; try { body = await req.json(); } catch { }
      const actionName = String(body?.actionName ?? '');
      const before = snapshot().currentState;
      const ok = await puzzle.performAction(actionName);
      if (ok) epoch += 1;
      persist();
      return J({ ok, actionName, before, after: snapshot().currentState, availableActions: snapshot().availableActions });
    }
    if (url.pathname === '/effect' && req.method === 'POST') {
      // EFFECTOR: the only writer of the protected file in permit mode. Single-threaded event loop =>
      // the block from epoch-compare to appendFileSync is one critical section with NO await inside it.
      let body: any = {}; try { body = await req.json(); } catch {}
      const permit = String(body?.permit ?? '');
      const v = verify('permit', permit);
      const R = new Set([`${PROT}/deployments.log`,`${PROT}/deployments2.log`]);
      const rcpt = (o: any) => { try { appendFileSync(`${BASE}/receipts.jsonl`, JSON.stringify({ timestamp: new Date().toISOString(), effector: 'pbxd', ...o }) + '\n'); } catch {} };
      if (!v.ok) { rcpt({ attempt_id: body?.attempt_id ?? null, authorization_decision: 'DENY', reason: `effector: ${v.why}`, side_effect_observed: false }); return J({ decision: 'DENY', reason: v.why, side_effect_observed: false }, 403); }
      const c = v.claims;
      // ----- CRITICAL SECTION (no await): compare epoch, then act -----
      const liveEpoch = epoch;
      let effect = false, decision = 'DENY', reason = '';
      if (PERMIT_SINGLE_USE && usedPermits.has(String(c.attempt_id))) { reason = `effector: permit ${c.attempt_id} already consumed (replay)`; }
      else if (c.expected_epoch !== liveEpoch) { reason = `effector stale: permit epoch ${c.expected_epoch} != live epoch ${liveEpoch}`; }
      else if (!R.has(String(c.resource))) { reason = `effector: resource not protected`; }
      else { usedPermits.add(String(c.attempt_id)); appendFileSync(String(c.resource), `DEPLOYED:${c.attempt_id}\n`); decision = 'ALLOW'; reason = 'effector: permit valid, epoch fresh, single-use in critical section'; effect = true; }
      // ----- END CRITICAL SECTION -----
      rcpt({ attempt_id: c.attempt_id, puzzle_id: c.puzzle_id, expected_epoch: c.expected_epoch, live_epoch: liveEpoch, principal: c.principal, caller: c.caller, requested_resource: c.resource, authorization_decision: decision, reason, side_effect_observed: effect, mode: 'permit-effector' });
      return J({ decision, reason, side_effect_observed: effect }, decision === 'ALLOW' ? 200 : 403);
    }
    return J({ error: 'not found', hint: 'GET /snapshot, POST /action {actionName}, POST /effect {permit}' }, 404);
  },
});
console.log(`pbxd listening on 127.0.0.1:${PORT} — state ${snapshot().currentState}`);
