// pbxd.ts: the workflow-state service and the only effector. Asserts the README's claims about it at runtime:
// workflow transitions bump a monotonic epoch, persisted state is sealed {state,epoch} together, and /effect
// writes DEPLOYED:<id> only for a valid, fresh, single-use permit whose epoch and required state match live.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { get, installNetwork, json, load, post, sandbox, type Handler, type Sandbox } from "./helpers/harness.ts";

const PB = 8788;
let sb: Sandbox;
let h: Handler;
let w: typeof import("../warrants.ts");
const stateFile = () => join(sb.dir, "puzzle-state.json");
const receipts = () =>
  readFileSync(join(sb.dir, "receipts.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

async function boot(env: Record<string, string | undefined> = {}) {
  const r = await load("pbxd.ts", { INQ_DIR: sb.dir, PROTECTED_DIR: sb.prot, ...env });
  h = r.handler!;
  w = await import("../warrants.ts");
  return r;
}
const act = async (actionName: unknown) => json(await h(post(PB, "/action", { actionName })));
const state = async () => json(await h(get(PB, "/state")));
const permit = (over: Record<string, unknown> = {}) =>
  w.mint("permit", {
    puzzle_id: "deploy-marker-puzzle",
    expected_epoch: 1,
    required_state: "READY",
    issued_at: new Date().toISOString(),
    principal: "pbagent",
    caller: null,
    action: "deploy-marker",
    resource: sb.r1,
    attempt_id: "a1",
    expires: new Date(Date.now() + 5000).toISOString(),
    ...over,
  });
const effect = async (p: string) => {
  const res = await h(post(PB, "/effect", { permit: p }));
  return { status: res.status, ...(await json(res)) } as Record<string, unknown>;
};
const markers = (f = sb.r1) => readFileSync(f, "utf8").split("\n").filter(Boolean);

beforeEach(() => {
  sb = sandbox();
  installNetwork();
});
afterEach(() => sb.cleanup());

describe("pbxd workflow service", () => {
  it("listens on loopback 8788 and answers /health, /state and /snapshot", async () => {
    const r = await boot();
    expect(r.port).toBe(PB);
    expect(r.logs.join("\n")).toContain("pbxd listening on 127.0.0.1:8788 — state WORKING");
    expect(await json(await h(get(PB, "/health")))).toMatchObject({ ok: true, service: "pbxd" });
    const s = await state();
    expect(s).toEqual({
      puzzle_id: "deploy-marker-puzzle",
      currentState: "WORKING",
      epoch: 0,
      availableActions: ["finish_work"],
    });
    expect(await json(await h(get(PB, "/snapshot")))).toEqual(s);
  });

  it("returns 404 with a hint for unknown routes and for GET on POST routes", async () => {
    await boot();
    for (const path of ["/nope", "/action", "/effect"]) {
      const res = await h(get(PB, path));
      expect(res.status).toBe(404);
      expect((await json(res)).hint).toContain("POST /effect");
    }
  });

  it("bumps the epoch only on a successful transition", async () => {
    await boot();
    expect(await act("mark_done")).toMatchObject({ ok: false, before: "WORKING", after: "WORKING" });
    expect((await state()).epoch).toBe(0);
    expect(await act("finish_work")).toMatchObject({ ok: true, before: "WORKING", after: "READY" });
    expect(await act("tick")).toMatchObject({ ok: true, before: "READY", after: "READY" });
    expect(await state()).toMatchObject({ currentState: "READY", epoch: 2 });
    expect(await act("mark_done")).toMatchObject({ ok: true, after: "DONE", availableActions: [] });
    expect((await state()).epoch).toBe(3);
  });

  it("treats an unparseable or empty action body as no action", async () => {
    await boot();
    const res = await h(post(PB, "/action", "{not json", true));
    expect(await json(res)).toMatchObject({ ok: false, actionName: "" });
    expect(await act(undefined)).toMatchObject({ ok: false, actionName: "" });
    expect((await state()).epoch).toBe(0);
  });

  it("persists a sealed {state, epoch} pair and restores it after a restart", async () => {
    await boot();
    await act("finish_work");
    const saved = JSON.parse(readFileSync(stateFile(), "utf8"));
    expect(saved).toMatchObject({ puzzle_id: "deploy-marker-puzzle", state: "READY", epoch: 1 });
    expect(w.sealOk("deploy-marker-puzzle|READY|1", saved.sig)).toBe(true);
    await boot();
    expect(await state()).toMatchObject({ currentState: "READY", epoch: 1 });
  });

  it("refuses a forged (unsealed) state file and starts fresh (issue #1 rollback)", async () => {
    writeFileSync(stateFile(), JSON.stringify({ puzzle_id: "deploy-marker-puzzle", state: "READY", epoch: 7 }));
    const r = await boot();
    expect(r.errors.join("\n")).toContain("seal missing or invalid");
    expect(await state()).toMatchObject({ currentState: "WORKING", epoch: 0 });
  });

  it("refuses a sealed state file whose epoch was swapped", async () => {
    await boot();
    await act("finish_work");
    const saved = JSON.parse(readFileSync(stateFile(), "utf8"));
    writeFileSync(stateFile(), JSON.stringify({ ...saved, state: "WORKING" }));
    await boot();
    expect(await state()).toMatchObject({ currentState: "WORKING", epoch: 0 });
  });

  it("refuses state files with mistyped fields", async () => {
    writeFileSync(stateFile(), JSON.stringify({ state: 5, epoch: "1", sig: "x" }));
    expect((await boot()).errors.join("\n")).toContain("refusing");
    writeFileSync(stateFile(), "null");
    expect((await boot()).errors.join("\n")).toContain("refusing");
  });

  it("STATE_UNSIGNED=1 (broken specimen) accepts a forged file", async () => {
    writeFileSync(stateFile(), JSON.stringify({ state: "WORKING", epoch: 1 }));
    await boot({ STATE_UNSIGNED: "1" });
    expect(await state()).toMatchObject({ currentState: "WORKING", epoch: 1 });
  });

  it("STATE_UNSIGNED=1 ignores an unknown state name and a non-numeric epoch, and a file without a state", async () => {
    writeFileSync(stateFile(), JSON.stringify({ state: "BOGUS", epoch: "9" }));
    await boot({ STATE_UNSIGNED: "1" });
    expect(await state()).toMatchObject({ currentState: "WORKING", epoch: 0 });
    writeFileSync(stateFile(), JSON.stringify({ epoch: 4 }));
    await boot({ STATE_UNSIGNED: "1" });
    expect(await state()).toMatchObject({ currentState: "WORKING", epoch: 0 });
  });

  it("survives an unreadable state file and an unwritable one", async () => {
    mkdirSync(stateFile()); // a directory: read throws (first-boot path), write throws (best-effort path)
    await boot();
    expect(await act("finish_work")).toMatchObject({ ok: true, after: "READY" });
  });

  it("falls back to INQ_DIR/protected when PROTECTED_DIR is unset", async () => {
    await boot({ PROTECTED_DIR: undefined });
    await act("finish_work");
    expect(await effect(permit())).toMatchObject({ decision: "ALLOW" });
    expect(markers()).toEqual(["DEPLOYED:a1"]);
  });
});

describe("pbxd /effect (the effector)", () => {
  beforeEach(async () => {
    await boot();
    await act("finish_work"); // READY @ epoch 1
  });

  it("ALLOWs a valid fresh permit, writes the marker once and records a receipt", async () => {
    expect(await effect(permit())).toMatchObject({ status: 200, decision: "ALLOW", side_effect_observed: true });
    expect(markers()).toEqual(["DEPLOYED:a1"]);
    expect(receipts().at(-1)).toMatchObject({
      effector: "pbxd",
      attempt_id: "a1",
      live_epoch: 1,
      live_state: "READY",
      authorization_decision: "ALLOW",
      mode: "permit-effector",
    });
  });

  it("writes to deployments2.log when the permit names it", async () => {
    expect(await effect(permit({ resource: sb.r2 }))).toMatchObject({ decision: "ALLOW" });
    expect(markers(sb.r2)).toEqual(["DEPLOYED:a1"]);
  });

  it("DENYs a forged, missing or cross-typed permit, with a receipt", async () => {
    expect(await effect("garbage")).toMatchObject({
      status: 403,
      decision: "DENY",
      reason: "malformed permit warrant",
    });
    const res = await h(post(PB, "/effect", "{bad", true));
    expect(await json(res)).toMatchObject({ decision: "DENY", reason: "no permit warrant" });
    const capAsPermit = w.mint("cap", { expires: new Date(Date.now() + 5000).toISOString() });
    expect(await effect(capAsPermit)).toMatchObject({ decision: "DENY", reason: "bad permit signature" });
    const r = await h(post(PB, "/effect", { permit: "x", attempt_id: "z" }));
    expect(r.status).toBe(403);
    expect(receipts().at(-1)).toMatchObject({ attempt_id: "z", authorization_decision: "DENY" });
    expect(receipts().at(-2)).toMatchObject({ attempt_id: null });
    expect(markers()).toEqual([]);
  });

  it("refuses a replayed permit (single-use)", async () => {
    const p = permit();
    expect(await effect(p)).toMatchObject({ decision: "ALLOW" });
    expect(await effect(p)).toMatchObject({
      decision: "DENY",
      reason: "effector: permit a1 already consumed (replay)",
    });
    expect(markers()).toEqual(["DEPLOYED:a1"]);
  });

  it("refuses a permit issued before this effector started", async () => {
    const p = permit({ issued_at: new Date(Date.now() - 60_000).toISOString() });
    expect((await effect(p)).reason).toContain("issued before this effector started");
    expect((await effect(permit({ issued_at: "not a date" }))).reason).toContain("issued before");
  });

  it("refuses a stale epoch", async () => {
    await act("tick"); // epoch 2
    expect(await effect(permit())).toMatchObject({
      decision: "DENY",
      reason: "effector stale: permit epoch 1 != live epoch 2",
    });
  });

  it("refuses when the live state is not the permit's required state, by name", async () => {
    expect(await effect(permit({ required_state: "DONE" }))).toMatchObject({
      decision: "DENY",
      reason: "effector: live state READY != required DONE",
    });
  });

  it("skips the state check only when the permit carries no required state", async () => {
    expect(await effect(permit({ required_state: null }))).toMatchObject({ decision: "ALLOW" });
  });

  it("refuses a resource outside protected/", async () => {
    expect(await effect(permit({ resource: join(sb.dir, "elsewhere.log") }))).toMatchObject({
      decision: "DENY",
      reason: "effector: resource not protected",
    });
  });

  it("still decides when the receipts file cannot be written", async () => {
    mkdirSync(join(sb.dir, "receipts.jsonl"));
    expect(await effect(permit())).toMatchObject({ decision: "ALLOW" });
    expect(await effect("garbage")).toMatchObject({ decision: "DENY" });
  });
});

describe("pbxd broken specimens (env flags)", () => {
  it("PERMIT_SINGLE_USE=0 lets one permit fire twice", async () => {
    await boot({ PERMIT_SINGLE_USE: "0" });
    await act("finish_work");
    const p = permit();
    await effect(p);
    expect(await effect(p)).toMatchObject({ decision: "ALLOW" });
    expect(markers()).toEqual(["DEPLOYED:a1", "DEPLOYED:a1"]);
  });

  it("PERMIT_BOOT_CHECK=0 honors a permit minted before boot", async () => {
    await boot({ PERMIT_BOOT_CHECK: "0" });
    await act("finish_work");
    expect(await effect(permit({ issued_at: new Date(0).toISOString() }))).toMatchObject({ decision: "ALLOW" });
  });

  it("EFFECT_STATE_CHECK=0 trusts the epoch alone", async () => {
    await boot({ EFFECT_STATE_CHECK: "0" });
    await act("finish_work");
    expect(await effect(permit({ required_state: "DONE" }))).toMatchObject({ decision: "ALLOW" });
  });
});

describe("pbxd with INQ_DIR unset", () => {
  it("keeps its state file, receipts and protected/ under import.meta.dir", async () => {
    vi.stubGlobal("__PBX_META_DIR__", sb.dir);
    await boot({ INQ_DIR: undefined, PROTECTED_DIR: undefined });
    await act("finish_work");
    expect(JSON.parse(readFileSync(stateFile(), "utf8")).state).toBe("READY");
    expect(await effect(permit())).toMatchObject({ decision: "ALLOW" });
    expect(receipts().at(-1)).toMatchObject({ authorization_decision: "ALLOW" });
  });
});
