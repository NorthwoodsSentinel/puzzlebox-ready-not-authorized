// authd3.ts: the reference monitor. Asserts, per mode, that every required warrant must verify and bind the
// concrete request, that replays and stale epochs are refused, and that the broken specimens behind env flags
// still show the vulnerability they exist to show. pbxd's /state is a stub route here so the epoch is controlled.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  get,
  installNetwork,
  json,
  load,
  post,
  routes,
  sandbox,
  type Handler,
  type Sandbox,
} from "./helpers/harness.ts";

const MON = 8790;
let sb: Sandbox;
let h: Handler;
let w: typeof import("../warrants.ts");
let epochs: Array<number | "down">;
const P = "deploy-marker-puzzle";
const exp = () => new Date(Date.now() + 60_000).toISOString();

async function boot(env: Record<string, string | undefined> = {}) {
  const r = await load("authd3.ts", { INQ_DIR: sb.dir, PROTECTED_DIR: sb.prot, ...env });
  h = r.handler!;
  w = await import("../warrants.ts");
  return r;
}
const cap = (over: Record<string, unknown> = {}) =>
  w.mint("cap", {
    principal: "pbagent",
    action: "deploy-marker",
    resource: sb.r1,
    nonce: "c1",
    expires: exp(),
    ...over,
  });
const wf = (over: Record<string, unknown> = {}) =>
  w.mint("wf", {
    puzzle_id: P,
    required_state: "READY",
    observed_state: "READY",
    epoch: 1,
    action: "deploy-marker",
    resource: sb.r1,
    nonce: "wf1",
    expires: exp(),
    ...over,
  });
const inv = (over: Record<string, unknown> = {}) =>
  w.mint("inv", {
    caller: "pbagent",
    deputy: "pbagent",
    action: "deploy-marker",
    resource: sb.r1,
    nonce: "i1",
    expires: exp(),
    ...over,
  });
function req(over: Record<string, unknown> = {}) {
  return {
    principal: "pbagent",
    caller: "pbagent",
    action: "deploy-marker",
    resource: sb.r1,
    attempt_id: "t1",
    capability: cap(),
    puzzle_id: P,
    workflow_warrant: wf(),
    invocation_warrant: inv(),
    invocation_nonce: "i1",
    ...over,
  };
}
async function act(body: unknown) {
  const res = await h(post(MON, "/act", body));
  return { status: res.status, ...(await json(res)) } as Record<string, unknown>;
}
const markers = (f = sb.r1) => readFileSync(f, "utf8").split("\n").filter(Boolean);
const lastReceipt = () =>
  JSON.parse(readFileSync(join(sb.dir, "receipts.jsonl"), "utf8").trim().split("\n").at(-1)!) as Record<
    string,
    unknown
  >;

beforeEach(() => {
  sb = sandbox();
  installNetwork();
  epochs = [1];
  routes.set(8788, () => {
    const e = epochs.length > 1 ? epochs.shift()! : epochs[0];
    if (e === "down") throw new TypeError("connection refused");
    return new Response(JSON.stringify({ epoch: e }));
  });
});
afterEach(() => sb.cleanup());

describe("authd3 routing", () => {
  it("listens on loopback 8790, defaults to mode=all and answers /health", async () => {
    const r = await boot();
    expect(r.port).toBe(MON);
    expect(r.logs.join("\n")).toContain("authd3 (mode=all) on 127.0.0.1:8790");
    expect(await json(await h(get(MON, "/health")))).toEqual({ ok: true, service: "authd3", mode: "all" });
  });

  it("DENYs unknown routes, GET /act and unparseable bodies", async () => {
    await boot();
    expect((await h(get(MON, "/act"))).status).toBe(404);
    const r = await h(post(MON, "/other", {}));
    expect(await json(r)).toMatchObject({ decision: "DENY", reason: "unknown route /other" });
    const bad = await h(post(MON, "/act", "{nope", true));
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({ decision: "DENY", reason: "unparseable body" });
  });

  it("attributes an attempt without an id and records a receipt for every decision", async () => {
    await boot({ AUTHD_MODE: "cap" });
    const d = await act({});
    expect(d).toMatchObject({ status: 403, decision: "DENY", reason: "cap: no cap warrant" });
    expect(String(d.attempt_id)).toMatch(/^unattr-\d+$/);
    expect(lastReceipt()).toMatchObject({
      authorization_decision: "DENY",
      mode: "cap",
      puzzle_id: null,
      path_used: "POST /act",
    });
    await act(null);
    expect(lastReceipt()).toMatchObject({ caller: null, acting_principal: null, requested_resource: null });
  });
});

describe("capability plane (mode=cap)", () => {
  beforeEach(async () => void (await boot({ AUTHD_MODE: "cap" })));

  it("ALLOWs a capability that covers the request and writes the marker itself", async () => {
    expect(await act(req())).toMatchObject({
      status: 200,
      decision: "ALLOW",
      cap: "valid (standing credential)",
      side_effect_observed: true,
    });
    expect(markers()).toEqual(["DEPLOYED:t1"]);
    expect(lastReceipt()).toMatchObject({
      workflow_warrant_status: "not-required",
      invocation_warrant_status: "not-required",
    });
  });

  it.each([
    ["a forged capability", { capability: "x.y" }, "cap: bad cap signature"],
    ["a capability for another action", { capability: "@action" }, "cap: cap action rm-rf not allowed"],
    ["a capability for an unprotected resource", { capability: "@resource" }, "not protected"],
    ["a different principal", { principal: "mallory" }, "cap: cap principal pbagent != request mallory"],
    [
      "a request action the capability does not cover",
      { action: "other" },
      "cap: request action other not covered by cap",
    ],
    ["a request resource the capability does not cover", { resource: "@r2" }, "not covered by cap"],
  ])("DENYs %s", async (_n, over, reason) => {
    const o: Record<string, unknown> = { ...over };
    if (o.capability === "@action") o.capability = cap({ action: "rm-rf" });
    if (o.capability === "@resource") o.capability = cap({ resource: join(sb.dir, "x.log") });
    if (o.resource === "@r2") o.resource = sb.r2;
    const d = await act(req(o));
    expect(d.decision).toBe("DENY");
    expect(String(d.reason)).toContain(reason);
    expect(String(d.cap)).toMatch(/^INVALID: /);
    expect(markers()).toEqual([]);
  });

  it("writes a marker for deployments2.log when that is the covered resource", async () => {
    expect(await act(req({ resource: sb.r2, capability: cap({ resource: sb.r2 }) }))).toMatchObject({
      decision: "ALLOW",
    });
    expect(markers(sb.r2)).toEqual(["DEPLOYED:t1"]);
  });
});

describe("workflow plane (mode=cap+wf)", () => {
  it("point-in-time: ALLOWs a valid workflow warrant and records its nonce", async () => {
    await boot({ AUTHD_MODE: "cap+wf" });
    expect(await act(req())).toMatchObject({ decision: "ALLOW", wf: "valid(READY)", inv: "not-required" });
    expect(readFileSync(join(sb.dir, "used-nonces.jsonl"), "utf8")).toContain('"nonce":"wf1"');
  });

  it("point-in-time (the broken specimen): a stale READY warrant still ALLOWs after the epoch moved", async () => {
    await boot({ AUTHD_MODE: "cap+wf" });
    epochs = [5];
    expect(await act(req())).toMatchObject({ decision: "ALLOW" });
  });

  it.each([
    ["a missing warrant", { workflow_warrant: undefined }, "wf: no wf warrant"],
    ["another puzzle", { puzzle_id: "other" }, `wf: wf puzzle ${P} != request other`],
    ["another resource", { wf: { resource: "/elsewhere" } }, "wf: wf resource /elsewhere != request"],
    ["another action", { wf: { action: "x" } }, "wf: wf action x != request"],
  ])("DENYs %s", async (_n, over, reason) => {
    await boot({ AUTHD_MODE: "cap+wf" });
    const { wf: wfOver, ...rest } = over as { wf?: Record<string, unknown> };
    const body = req({ ...rest, ...(wfOver ? { workflow_warrant: wf(wfOver) } : {}) });
    expect(await act(body)).toMatchObject({ decision: "DENY", reason });
  });

  it("DENYs a replayed workflow warrant nonce", async () => {
    await boot({ AUTHD_MODE: "cap+wf" });
    expect((await act(req())).decision).toBe("ALLOW");
    expect(await act(req({ attempt_id: "t2" }))).toMatchObject({ decision: "DENY", reason: "wf: wf nonce wf1 replay" });
  });

  it("continuous: ALLOWs when the warrant epoch equals the live epoch, at check and at use", async () => {
    await boot({ AUTHD_MODE: "cap+wf", WF_FRESHNESS: "continuous" });
    expect(await act(req())).toMatchObject({ decision: "ALLOW", wf: "valid(READY@epoch1)" });
    expect(lastReceipt()).toMatchObject({ epoch_issued: 1, epoch_at_decision: 1, freshness: "continuous" });
  });

  it("continuous: DENYs a stale warrant", async () => {
    await boot({ AUTHD_MODE: "cap+wf", WF_FRESHNESS: "continuous" });
    epochs = [2];
    expect(await act(req())).toMatchObject({
      decision: "DENY",
      reason: "wf: stale workflow: warrant epoch 1 != live epoch 2",
    });
  });

  it("continuous: DENYs a warrant without a numeric epoch", async () => {
    await boot({ AUTHD_MODE: "cap+wf", WF_FRESHNESS: "continuous" });
    expect((await act(req({ workflow_warrant: wf({ epoch: "1", required_state: 3 }) }))).reason).toBe(
      "wf: stale workflow: warrant epoch null != live epoch 1",
    );
  });

  it("continuous: DENYs when the live epoch cannot be read", async () => {
    await boot({ AUTHD_MODE: "cap+wf", WF_FRESHNESS: "continuous" });
    epochs = ["down"];
    expect(await act(req())).toMatchObject({ decision: "DENY", reason: "wf: cannot read live epoch" });
  });

  it("continuous: DENYs at use when the epoch moves between check and effect", async () => {
    await boot({ AUTHD_MODE: "cap+wf", WF_FRESHNESS: "continuous", TOCTOU_DELAY_MS: "5" });
    epochs = [1, 2];
    expect(await act(req())).toMatchObject({
      decision: "DENY",
      reason: "stale at USE: epoch moved 1 -> 2 between check and effect",
    });
    expect(markers()).toEqual([]);
  });

  it("TOCTOU_NAIVE=1 (the broken specimen) skips the use-time recheck, so the stale effect fires", async () => {
    await boot({ AUTHD_MODE: "cap+wf", WF_FRESHNESS: "continuous", TOCTOU_NAIVE: "1" });
    epochs = [1, 2];
    expect(await act(req())).toMatchObject({ decision: "ALLOW", side_effect_observed: true });
  });
});

describe("invocation plane (mode=cap+inv)", () => {
  const deputyReq = (over: Record<string, unknown> = {}) =>
    req({
      principal: "deputy",
      capability: cap({ principal: "deputy" }),
      invocation_warrant: inv({ deputy: "deputy" }),
      ...over,
    });

  it("ALLOWs a caller-bound invocation warrant and records its nonce", async () => {
    await boot({ AUTHD_MODE: "cap+inv" });
    expect(await act(deputyReq())).toMatchObject({ decision: "ALLOW", inv: "valid(pbagent)", wf: "not-required" });
    expect(readFileSync(join(sb.dir, "used-nonces.jsonl"), "utf8")).toContain('"nonce":"i1"');
  });

  it.each([
    ["no invocation warrant (the confused deputy)", { invocation_warrant: undefined }, "inv: no inv warrant"],
    ["a different caller", { caller: "mallory" }, "inv: inv caller pbagent != request caller mallory"],
    ["a warrant for another deputy", { inv: { deputy: "other" } }, "inv: inv deputy other != acting principal deputy"],
    ["another action", { inv: { deputy: "deputy", action: "x" } }, "inv: inv action != request"],
    ["another resource", { inv: { deputy: "deputy", resource: "/x" } }, "inv: inv resource != request"],
    ["an unbound nonce", { invocation_nonce: "other" }, "inv: inv nonce not bound to invocation_nonce"],
  ])("DENYs %s", async (_n, over, reason) => {
    await boot({ AUTHD_MODE: "cap+inv" });
    const { inv: invOver, ...rest } = over as { inv?: Record<string, unknown> };
    expect(await act(deputyReq({ ...rest, ...(invOver ? { invocation_warrant: inv(invOver) } : {}) }))).toMatchObject({
      decision: "DENY",
      reason,
    });
  });

  it("DENYs a replayed invocation warrant", async () => {
    await boot({ AUTHD_MODE: "cap+inv" });
    await act(deputyReq());
    expect(await act(deputyReq({ attempt_id: "t2" }))).toMatchObject({
      decision: "DENY",
      reason: "inv: inv nonce i1 replay",
    });
  });
});

describe("mode=all with EMIT_PERMIT=1", () => {
  it("emits a permit bound to the request and performs no effect itself", async () => {
    await boot({ AUTHD_MODE: "all", WF_FRESHNESS: "continuous", EMIT_PERMIT: "1" });
    const d = await act(req({ caller: undefined, invocation_warrant: inv({ caller: undefined }) }));
    expect(d).toMatchObject({ decision: "ALLOW", side_effect_observed: false });
    expect(markers()).toEqual([]);
    const v = w.verify("permit", String(d.permit));
    expect(v.ok).toBe(true);
    expect(v.claims).toMatchObject({
      puzzle_id: P,
      expected_epoch: 1,
      required_state: "READY",
      caller: null,
      attempt_id: "t1",
      resource: sb.r1,
    });
    const used = readFileSync(join(sb.dir, "used-nonces.jsonl"), "utf8");
    expect(used).toContain('"nonce":"wf1"');
    expect(used).toContain('"nonce":"i1"');
  });

  it("emits no permit on DENY", async () => {
    await boot({ AUTHD_MODE: "all", EMIT_PERMIT: "1" });
    const d = await act(req({ invocation_warrant: "" }));
    expect(d.decision).toBe("DENY");
    expect(d.permit).toBeUndefined();
  });
});

describe("nonce ledger", () => {
  const ledger = () => join(sb.dir, "used-nonces.jsonl");

  it("fails closed: a malformed line makes every nonce count as used", async () => {
    await boot({ AUTHD_MODE: "cap+wf" });
    writeFileSync(ledger(), "not-json\n");
    expect(await act(req())).toMatchObject({ decision: "DENY", reason: "wf: wf nonce wf1 replay" });
  });

  it("fails closed when the ledger cannot be read", async () => {
    await boot({ AUTHD_MODE: "cap+wf" });
    mkdirSync(ledger());
    expect((await act(req())).reason).toBe("wf: wf nonce wf1 replay");
  });

  it("skips blank lines and ignores other nonces", async () => {
    await boot({ AUTHD_MODE: "cap+wf" });
    writeFileSync(ledger(), '\n{"nonce":"other"}\nnull\n');
    expect((await act(req())).decision).toBe("ALLOW");
  });

  it("a warrant without a nonce is never looked up", async () => {
    await boot({ AUTHD_MODE: "cap+wf" });
    writeFileSync(ledger(), "not-json\n");
    expect((await act(req({ workflow_warrant: wf({ nonce: "" }) }))).decision).toBe("ALLOW");
  });

  it("NONCE_FAIL_OPEN=1 (the broken specimen): a malformed line makes a replay look unused", async () => {
    await boot({ AUTHD_MODE: "cap+wf", NONCE_FAIL_OPEN: "1" });
    writeFileSync(ledger(), "not-json\n");
    expect((await act(req())).decision).toBe("ALLOW");
    expect(await act(req({ attempt_id: "t2" }))).toMatchObject({ decision: "ALLOW" });
    expect(markers()).toEqual(["DEPLOYED:t1", "DEPLOYED:t2"]);
  });

  it("NONCE_FAIL_OPEN=1 still finds a nonce in a clean ledger", async () => {
    await boot({ AUTHD_MODE: "cap+wf", NONCE_FAIL_OPEN: "1" });
    writeFileSync(ledger(), '{"nonce":"wf1"}\n');
    expect((await act(req())).reason).toBe("wf: wf nonce wf1 replay");
  });
});

describe("defaults", () => {
  it("falls back to INQ_DIR/protected when PROTECTED_DIR is unset", async () => {
    await boot({ AUTHD_MODE: "cap", PROTECTED_DIR: undefined });
    expect((await act(req())).decision).toBe("ALLOW");
    expect(markers()).toEqual(["DEPLOYED:t1"]);
  });
});

describe("authd3 with INQ_DIR unset", () => {
  it("keeps receipts, the nonce ledger and protected/ under import.meta.dir", async () => {
    vi.stubGlobal("__PBX_META_DIR__", sb.dir);
    await boot({ AUTHD_MODE: "cap+wf", INQ_DIR: undefined, PROTECTED_DIR: undefined });
    expect((await act(req())).decision).toBe("ALLOW");
    expect(markers()).toEqual(["DEPLOYED:t1"]);
    expect(readFileSync(join(sb.dir, "used-nonces.jsonl"), "utf8")).toContain("wf1");
    expect(lastReceipt()).toMatchObject({ authorization_decision: "ALLOW" });
  });
});
