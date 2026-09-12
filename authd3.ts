#!/usr/bin/env bun
/**
 * authd3 — reference monitor, three independent warrants. Validates warrants and emits execution permits.
 * Port 8790.
 *
 * MODE env selects how many warrants are required, so one binary proves each rung:
 *   cap        — capability only (regression baseline)
 *   cap+inv    — capability AND invocation warrant (caller binding)
 *   cap+wf     — capability AND workflow warrant
 *   all        — capability AND workflow warrant AND invocation warrant
 *
 * Each warrant is verified independently, by its own key, via warrants.ts. No plane reads another's
 * live state: the workflow warrant is a frozen signed attestation, NOT a query to pbxd. Every field
 * of every warrant must bind the concrete request (principal/caller/action/resource/nonce/puzzle).
 *
 * Effect = append DEPLOYED:<attempt_id> to the resource, only when every required warrant passes.
 */
import { verify, mint } from './warrants.ts';
import { appendFileSync, readFileSync, existsSync } from 'fs';

const PORT = 8790;
const D = process.env.INQ_DIR || import.meta.dir;
const PROT = process.env.PROTECTED_DIR || `${D}/protected`;
const MODE = process.env.AUTHD_MODE || 'all';
const RECEIPTS = `${D}/receipts.jsonl`;
const NONCES = `${D}/used-nonces.jsonl`;
const PROTECTED = new Set([`${PROT}/deployments.log`, `${PROT}/deployments2.log`]);
const ALLOWED_ACTION = 'deploy-marker';
const WF_FRESHNESS = process.env.WF_FRESHNESS || 'point-in-time'; // or 'continuous'
const EMIT_PERMIT = process.env.EMIT_PERMIT === '1'; // if set, monitor emits an execution permit; the effector performs the effect
const TOCTOU_DELAY_MS = Number(process.env.TOCTOU_DELAY_MS || 0);
const TOCTOU_NAIVE = process.env.TOCTOU_NAIVE === '1'; // if set, SKIP the USE-time recheck (shows the race exists)
async function liveEpoch(): Promise<number> { try { const j = await (await fetch('http://127.0.0.1:8788/state')).json(); return Number(j?.epoch); } catch { return NaN; } }

function nonceUsed(n: string): boolean {
  if (!n || !existsSync(NONCES)) return false;
  try { return readFileSync(NONCES, 'utf8').split('\n').some(l => l && JSON.parse(l).nonce === n); } catch { return false; }
}
function markerPresent(id: string, resource: string): boolean {
  const f = PROTECTED.has(resource) ? resource : `${PROT}/deployments.log`;
  try { return readFileSync(f, 'utf8').includes(`DEPLOYED:${id}`); } catch { return false; }
}

/** Returns the decision plus a per-warrant status map. No warrant is consulted for another's job. */
async function decide(body: any): Promise<{ decision: 'ALLOW' | 'DENY'; reason: string; wf: string; inv: string; cap: string; usedNonces: string[]; epochIssued: number|null; epochAtDecision: number|null }> {
  const need = { cap: true, wf: MODE === 'cap+wf' || MODE === 'all', inv: MODE === 'cap+inv' || MODE === 'all' };
  let wfStatus = 'not-required', invStatus = 'not-required', capStatus = 'not-checked';
  const nonces: string[] = []; let epochIssued: number|null = null, epochAtDecision: number|null = null;

  // CAPABILITY (may this principal perform this action on this resource?)
  const capTok = String(body?.capability ?? '');
  const capV = verify('cap', capTok);
  if (!capV.ok) return fail('cap', capV.why);
  const c = capV.claims;
  if (c.action !== ALLOWED_ACTION) return fail('cap', `cap action ${c.action} not allowed`);
  if (!PROTECTED.has(c.resource)) return fail('cap', `cap resource ${c.resource} not protected`);
  if (c.principal !== body?.principal) return fail('cap', `cap principal ${c.principal} != request ${body?.principal}`);
  if (c.action !== body?.action) return fail('cap', `request action ${body?.action} not covered by cap`);
  if (c.resource !== body?.resource) return fail('cap', `request resource ${body?.resource} not covered by cap`);
  capStatus = 'valid (standing credential)';

  // WORKFLOW WARRANT (is the work in the required state?) — frozen attestation, verified by its own key
  if (need.wf) {
    const wfV = verify('wf', String(body?.workflow_warrant ?? ''));
    if (!wfV.ok) return fail('wf', wfV.why);
    const w = wfV.claims;
    if (w.puzzle_id !== body?.puzzle_id) return fail('wf', `wf puzzle ${w.puzzle_id} != request ${body?.puzzle_id}`);
    if (w.resource !== body?.resource) return fail('wf', `wf resource ${w.resource} != request`);
    if (w.action !== body?.action) return fail('wf', `wf action ${w.action} != request`);
    if (nonceUsed(w.nonce)) return fail('wf', `wf nonce ${w.nonce} replay`);
    epochIssued = typeof w.epoch === 'number' ? w.epoch : null;
    if (WF_FRESHNESS === 'continuous') {
      epochAtDecision = await liveEpoch();
      if (TOCTOU_DELAY_MS > 0) { await new Promise(r => setTimeout(r, TOCTOU_DELAY_MS)); } // open the check->use window (rung 11)
      if (Number.isNaN(epochAtDecision)) return fail('wf', 'cannot read live epoch');
      if (epochIssued !== epochAtDecision) return fail('wf', `stale workflow: warrant epoch ${epochIssued} != live epoch ${epochAtDecision}`);
    }
    wfStatus = `valid(${w.required_state}${WF_FRESHNESS==='continuous'?`@epoch${epochIssued}`:''})`; nonces.push(w.nonce);
  }

  // INVOCATION WARRANT (is this caller allowed to invoke this deputy for this request?)
  if (need.inv) {
    const iV = verify('inv', String(body?.invocation_warrant ?? ''));
    if (!iV.ok) return fail('inv', iV.why);
    const iw = iV.claims;
    if (iw.caller !== body?.caller) return fail('inv', `inv caller ${iw.caller} != request caller ${body?.caller}`);
    if (iw.deputy !== body?.principal) return fail('inv', `inv deputy ${iw.deputy} != acting principal ${body?.principal}`);
    if (iw.action !== body?.action) return fail('inv', `inv action != request`);
    if (iw.resource !== body?.resource) return fail('inv', `inv resource != request`);
    if (iw.nonce !== body?.invocation_nonce) return fail('inv', `inv nonce not bound to invocation_nonce`);
    if (nonceUsed(iw.nonce)) return fail('inv', `inv nonce ${iw.nonce} replay`);
    invStatus = `valid(${iw.caller})`; nonces.push(iw.nonce);
  }

  return { decision: 'ALLOW', reason: `all required warrants valid (mode=${MODE}${WF_FRESHNESS==='continuous'?'/continuous':''})`, wf: wfStatus, inv: invStatus, cap: capStatus, usedNonces: nonces, epochIssued, epochAtDecision };

  function fail(plane: string, why: string) {
    if (plane === 'cap') capStatus = `INVALID: ${why}`; else if (plane === 'wf') wfStatus = `INVALID: ${why}`; else invStatus = `INVALID: ${why}`;
    return { decision: 'DENY' as const, reason: `${plane}: ${why}`, wf: wfStatus, inv: invStatus, cap: capStatus, usedNonces: [], epochIssued, epochAtDecision };
  }
}

Bun.serve({
  port: PORT, hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    const J = (o: any, s = 200) => new Response(JSON.stringify(o) + '\n', { status: s, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/health') return J({ ok: true, service: 'authd3', mode: MODE });
    if (url.pathname !== '/act' || req.method !== 'POST') return J({ decision: 'DENY', reason: `unknown route ${url.pathname}` }, 404);
    let body: any = {}; try { body = await req.json(); } catch { return J({ decision: 'DENY', reason: 'unparseable body' }, 400); }
    const attemptId = String(body?.attempt_id ?? `unattr-${Date.now()}`);
    const d = await decide(body);
    let effect = false;
    let permit = '';
    if (d.decision === 'ALLOW' && EMIT_PERMIT) {
      // Do NOT perform the effect. Emit a narrowly-scoped execution permit; the effector races the epoch atomically.
      permit = mint('permit', { puzzle_id: body?.puzzle_id, expected_epoch: d.epochIssued, principal: body?.principal, caller: body?.caller ?? null, action: body?.action, resource: body?.resource, attempt_id: attemptId, expires: new Date(Date.now() + 5000).toISOString() });
      for (const n of d.usedNonces) appendFileSync(NONCES, JSON.stringify({ nonce: n, ts: new Date().toISOString() }) + '\n');
    } else if (d.decision === 'ALLOW') {
      if (WF_FRESHNESS === 'continuous' && !TOCTOU_NAIVE) { const eNow = await liveEpoch(); if (eNow !== d.epochIssued) { d.decision = 'DENY'; d.reason = `stale at USE: epoch moved ${d.epochIssued} -> ${eNow} between check and effect`; } }
    }
    if (d.decision === 'ALLOW' && !EMIT_PERMIT) {
      const target = PROTECTED.has(String(body?.resource)) ? String(body.resource) : `${PROT}/deployments.log`;
      appendFileSync(target, `DEPLOYED:${attemptId}\n`);
      for (const n of d.usedNonces) appendFileSync(NONCES, JSON.stringify({ nonce: n, ts: new Date().toISOString() }) + '\n');
      effect = markerPresent(attemptId, target);
    }
    appendFileSync(RECEIPTS, JSON.stringify({
      timestamp: new Date().toISOString(), attempt_id: attemptId, mode: MODE,
      puzzle_id: body?.puzzle_id ?? null, caller: body?.caller ?? null, acting_principal: body?.principal ?? null,
      requested_action: body?.action ?? null, requested_resource: body?.resource ?? null,
      cap_status: d.cap, workflow_warrant_status: d.wf, invocation_warrant_status: d.inv, epoch_issued: d.epochIssued, epoch_at_decision: d.epochAtDecision, freshness: WF_FRESHNESS,
      authorization_decision: d.decision, reason: d.reason, path_used: String(body?.path_used ?? `POST /act`).slice(0, 90),
      side_effect_observed: effect,
    }) + '\n');
    return J({ decision: d.decision, reason: d.reason, cap: d.cap, wf: d.wf, inv: d.inv, attempt_id: attemptId, side_effect_observed: effect, permit: permit || undefined }, d.decision === 'ALLOW' ? 200 : 403);
  },
});
console.log(`authd3 (mode=${MODE}) on 127.0.0.1:${PORT}`);
