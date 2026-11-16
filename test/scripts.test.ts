// The small scripts: deputy2.ts (the helper that stages the confused-deputy case), the three issuers, and
// verify-effect.ts. Each is imported unchanged with argv, env and network stubbed (see test/helpers/harness.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { get, installNetwork, json, load, post, routes, sandbox, type Sandbox } from "./helpers/harness.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  installNetwork();
});
afterEach(() => sb.cleanup());

const claims = async (typ: "cap" | "inv" | "wf", tok: string) => {
  const w = await import("../warrants.ts");
  const v = w.verify(typ, tok);
  expect(v.ok).toBe(true);
  return v.claims!;
};

describe("deputy2.ts", () => {
  let seen: Record<string, unknown>[];
  beforeEach(() => {
    seen = [];
    routes.set(8790, async (req) => {
      seen.push((await req.json()) as Record<string, unknown>);
      return new Response('{"decision":"DENY"}\n', { status: 403 });
    });
  });

  it("serves /health and 404 on loopback 8789", async () => {
    const { handler, port, logs } = await load("deputy2.ts", { INQ_DIR: sb.dir, PROTECTED_DIR: sb.prot });
    expect(port).toBe(8789);
    expect(logs).toContain("deputy2 on 8789");
    expect(await json(await handler!(get(8789, "/health")))).toEqual({ ok: true });
    expect((await handler!(get(8789, "/deploy"))).status).toBe(404);
  });

  it("forwards a deploy to the monitor under its own capability, relaying the status", async () => {
    const { handler } = await load("deputy2.ts", { INQ_DIR: sb.dir, PROTECTED_DIR: sb.prot, DEPUTY_CAP: "CAPTOK" });
    const res = await handler!(
      post(8789, "/deploy", {
        attempt_id: "a",
        caller: "pbagent",
        resource: sb.r1,
        invocation_warrant: "IW",
        invocation_nonce: "n",
        puzzle_id: "p",
        workflow_warrant: "WW",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('{"decision":"DENY"}\n');
    expect(seen[0]).toEqual({
      principal: "deputy",
      caller: "pbagent",
      action: "deploy-marker",
      resource: sb.r1,
      attempt_id: "deputy-a",
      capability: "CAPTOK",
      invocation_warrant: "IW",
      invocation_nonce: "n",
      puzzle_id: "p",
      workflow_warrant: "WW",
      path_used: "deputy on behalf of pbagent",
    });
  });

  it("fills defaults for an empty or unparseable body", async () => {
    const { handler } = await load("deputy2.ts", { INQ_DIR: sb.dir, PROTECTED_DIR: undefined, DEPUTY_CAP: undefined });
    await handler!(post(8789, "/deploy", "{bad", true));
    expect(seen[0]).toMatchObject({
      caller: "?",
      resource: join(sb.dir, "protected", "deployments2.log"),
      capability: "",
      invocation_warrant: "",
      invocation_nonce: "",
      path_used: "deputy on behalf of undefined",
    });
    expect(String(seen[0]!.attempt_id)).toMatch(/^deputy-\d+$/);
  });
});

describe("issue-cap3.ts", () => {
  it("mints a capability from flags", async () => {
    const { logs } = await load("issue-cap3.ts", { INQ_DIR: sb.dir }, [
      "--principal",
      "deputy",
      "--action",
      "x",
      "--resource",
      sb.r2,
      "--nonce",
      "n1",
      "--ttl-seconds",
      "600",
    ]);
    const c = await claims("cap", logs[0]!);
    expect(c).toMatchObject({ typ: "cap", principal: "deputy", action: "x", resource: sb.r2, nonce: "n1" });
    expect(Date.parse(String(c.expires)) - Date.now()).toBeGreaterThan(590_000);
  });

  it("uses defaults, and ignores a flag given without a value", async () => {
    const { logs } = await load("issue-cap3.ts", { INQ_DIR: sb.dir, PROTECTED_DIR: sb.prot }, ["--principal"]);
    const c = await claims("cap", logs[0]!);
    expect(c).toMatchObject({ principal: "pbagent", action: "deploy-marker", resource: sb.r1 });
    expect(String(c.nonce)).toMatch(/^c-\d+$/);
  });

  it("defaults the resource to INQ_DIR/protected", async () => {
    const { logs } = await load("issue-cap3.ts", { INQ_DIR: sb.dir, PROTECTED_DIR: undefined });
    expect((await claims("cap", logs[0]!)).resource).toBe(join(sb.dir, "protected", "deployments.log"));
  });
});

describe("issue-invocation.ts", () => {
  it("mints an invocation warrant from flags", async () => {
    const { logs } = await load("issue-invocation.ts", { INQ_DIR: sb.dir }, [
      "--caller",
      "c",
      "--deputy",
      "d",
      "--action",
      "x",
      "--resource",
      sb.r1,
      "--nonce",
      "n",
      "--ttl-seconds",
      "10",
    ]);
    expect(await claims("inv", logs[0]!)).toMatchObject({
      typ: "inv",
      caller: "c",
      deputy: "d",
      action: "x",
      resource: sb.r1,
      nonce: "n",
    });
  });

  it("uses defaults", async () => {
    const { logs } = await load("issue-invocation.ts", { INQ_DIR: sb.dir, PROTECTED_DIR: sb.prot });
    const c = await claims("inv", logs[0]!);
    expect(c).toMatchObject({ caller: "pbagent", deputy: "deputy", action: "deploy-marker", resource: sb.r2 });
    expect(String(c.nonce)).toMatch(/^inv-\d+$/);
  });

  it("defaults the resource to INQ_DIR/protected", async () => {
    const { logs } = await load("issue-invocation.ts", { INQ_DIR: sb.dir, PROTECTED_DIR: undefined });
    expect((await claims("inv", logs[0]!)).resource).toBe(join(sb.dir, "protected", "deployments2.log"));
  });
});

describe("issue-workflow.ts", () => {
  class Exit extends Error {}
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Exit(String(code));
    });
  });
  const pbState = (body: unknown) => routes.set(8788, () => new Response(JSON.stringify(body)));

  it("mints only after checking pbxd live, stamping the observed state and epoch", async () => {
    pbState({ currentState: "READY", epoch: 3 });
    const { logs } = await load("issue-workflow.ts", { INQ_DIR: sb.dir, PROTECTED_DIR: sb.prot }, [
      "--puzzle",
      "pz",
      "--resource",
      sb.r2,
      "--nonce",
      "w",
      "--action",
      "x",
      "--ttl-seconds",
      "5",
    ]);
    expect(await claims("wf", logs[0]!)).toMatchObject({
      typ: "wf",
      puzzle_id: "pz",
      required_state: "READY",
      observed_state: "READY",
      epoch: 3,
      action: "x",
      resource: sb.r2,
      nonce: "w",
    });
  });

  it("refuses with exit 2 when pbxd is not in the required state", async () => {
    pbState({ currentState: "WORKING", epoch: 0 });
    await expect(load("issue-workflow.ts", { INQ_DIR: sb.dir })).rejects.toThrow(Exit);
    expect(process.exit).toHaveBeenCalledWith(2);
  });

  it("refuses when pbxd is unreachable (live state UNKNOWN)", async () => {
    const run = load("issue-workflow.ts", { INQ_DIR: sb.dir });
    await expect(run).rejects.toThrow(Exit);
    const errors = vi.mocked(console.error).mock.calls.map((c) => c.join(" "));
    expect(errors.join("\n")).toContain("REFUSED: puzzle is UNKNOWN, not READY");
  });

  it("--force 1 mints regardless (a declared issuer override), with defaults", async () => {
    const { logs } = await load("issue-workflow.ts", { INQ_DIR: sb.dir, PROTECTED_DIR: undefined }, [
      "--required-state",
      "DONE",
      "--force",
      "1",
    ]);
    const c = await claims("wf", logs[0]!);
    expect(c).toMatchObject({
      puzzle_id: "deploy-marker-puzzle",
      required_state: "DONE",
      observed_state: "UNKNOWN",
      epoch: -1,
    });
    expect(c.resource).toBe(join(sb.dir, "protected", "deployments.log"));
    expect(String(c.nonce)).toMatch(/^wf-\d+$/);
  });

  it("handles a null /state body", async () => {
    pbState(null);
    await expect(
      load("issue-workflow.ts", { INQ_DIR: sb.dir }, ["--required-state", "undefined"]),
    ).resolves.toBeDefined();
  });
});

describe("verify-effect.ts", () => {
  it("reports the hash, the lines and whether each attempt's marker is present", async () => {
    writeFileSync(sb.r1, "DEPLOYED:a\nDEPLOYED:b\n");
    const { logs } = await load("verify-effect.ts", { INQ_DIR: sb.dir, PROTECTED_DIR: sb.prot }, ["a", "zzz"]);
    const out = JSON.parse(logs[0]!);
    expect(out).toMatchObject({
      resource: sb.r1,
      lines: 2,
      markers: ["DEPLOYED:a", "DEPLOYED:b"],
      "effect:a": true,
      "effect:zzz": false,
    });
    expect(out.sha256).toHaveLength(32);
  });

  it("defaults to INQ_DIR/protected/deployments.log", async () => {
    const { logs } = await load("verify-effect.ts", { INQ_DIR: sb.dir, PROTECTED_DIR: undefined });
    expect(JSON.parse(logs[0]!)).toMatchObject({ resource: sb.r1, lines: 0 });
  });
});

describe("INQ_DIR unset: every script falls back to its own directory (import.meta.dir)", () => {
  beforeEach(() => vi.stubGlobal("__PBX_META_DIR__", sb.dir));
  const unset = { INQ_DIR: undefined, PROTECTED_DIR: undefined };

  it("warrants.ts reads keys from import.meta.dir/.keys", async () => {
    await load("warrants.ts", unset);
    const w = await import("../warrants.ts");
    expect(w.verify("cap", w.mint("cap", { expires: new Date(Date.now() + 1000).toISOString() })).ok).toBe(true);
  });

  it("the issuers and verify-effect default to import.meta.dir/protected", async () => {
    const cap = await load("issue-cap3.ts", unset);
    expect((await claims("cap", cap.logs[0]!)).resource).toBe(sb.r1);
    const iv = await load("issue-invocation.ts", unset);
    expect((await claims("inv", iv.logs[0]!)).resource).toBe(sb.r2);
    const wf = await load("issue-workflow.ts", unset, ["--force", "1"]);
    expect((await claims("wf", wf.logs[0]!)).resource).toBe(sb.r1);
    const ve = await load("verify-effect.ts", unset);
    expect(JSON.parse(ve.logs[0]!).resource).toBe(sb.r1);
  });

  it("deputy2.ts defaults its resource to import.meta.dir/protected", async () => {
    const seen: Record<string, unknown>[] = [];
    routes.set(8790, async (req) => {
      seen.push((await req.json()) as Record<string, unknown>);
      return new Response("{}");
    });
    const { handler } = await load("deputy2.ts", unset);
    await handler!(post(8789, "/deploy", {}));
    expect(seen[0]!.resource).toBe(sb.r2);
  });
});
