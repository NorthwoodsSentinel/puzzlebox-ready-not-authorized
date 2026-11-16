// warrants.ts: typed, separately-keyed warrants and the state seal. Asserts the properties README.md claims:
// a warrant verifies only under its own typ and key, tampering and expiry are refused, the seal is keyed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load, sandbox, type Sandbox } from "./helpers/harness.ts";

type W = typeof import("../warrants.ts");
let sb: Sandbox;
let w: W;
const future = () => new Date(Date.now() + 60_000).toISOString();
const b64u = (s: string) => Buffer.from(s).toString("base64url");
const signAs = (typ: string, payload: string) =>
  `${payload}.${createHmac("sha256", readFileSync(join(sb.dir, ".keys", `${typ}.key`), "utf8").trim())
    .update(payload)
    .digest("base64url")}`;

beforeEach(async () => {
  sb = sandbox();
  await load("warrants.ts", { INQ_DIR: sb.dir });
  w = await import("../warrants.ts");
});
afterEach(() => sb.cleanup());

describe("mint / verify", () => {
  it("round-trips a warrant under its own typ and stamps typ into the claims", () => {
    const tok = w.mint("cap", { principal: "p", expires: future() });
    const v = w.verify("cap", tok);
    expect(v.ok).toBe(true);
    expect(v.why).toBe("ok");
    expect(v.claims).toMatchObject({ principal: "p", typ: "cap" });
  });

  it("a claims typ field cannot override the minting typ", () => {
    const tok = w.mint("cap", { typ: "wf", expires: future() });
    expect(w.verify("cap", tok).ok).toBe(true);
    expect(w.verify("wf", tok)).toMatchObject({ ok: false, why: "bad wf signature" });
  });

  it.each(["cap", "inv", "wf", "permit"] as const)("refuses a %s warrant presented as another typ", (typ) => {
    const tok = w.mint(typ, { expires: future() });
    for (const other of ["cap", "inv", "wf", "permit"] as const)
      if (other !== typ) expect(w.verify(other, tok).ok).toBe(false);
  });

  it("refuses a payload signed with the right key but carrying the wrong typ", () => {
    const tok = signAs("inv", b64u(JSON.stringify({ typ: "cap", expires: future() })));
    expect(w.verify("inv", tok)).toMatchObject({ ok: false, why: "warrant typ cap presented as inv" });
  });

  it("refuses missing, empty and non-string tokens", () => {
    expect(w.verify("cap", "")).toMatchObject({ ok: false, why: "no cap warrant", claims: null });
    expect(w.verify("cap", undefined as unknown as string)).toMatchObject({ ok: false, why: "no cap warrant" });
    expect(w.verify("cap", 42 as unknown as string)).toMatchObject({ ok: false, why: "no cap warrant" });
  });

  it("refuses a token without exactly two parts", () => {
    expect(w.verify("wf", "abc")).toMatchObject({ ok: false, why: "malformed wf warrant" });
    expect(w.verify("wf", "a.b.c")).toMatchObject({ ok: false, why: "malformed wf warrant" });
  });

  it("refuses a tampered payload and a tampered signature", () => {
    const tok = w.mint("cap", { principal: "p", expires: future() });
    const [p, sig] = tok.split(".");
    const forged = b64u(JSON.stringify({ principal: "root", typ: "cap", expires: future() }));
    expect(w.verify("cap", `${forged}.${sig}`)).toMatchObject({ ok: false, why: "bad cap signature" });
    expect(w.verify("cap", `${p}.${sig}x`)).toMatchObject({ ok: false, why: "bad cap signature" });
  });

  it("refuses a correctly signed payload that is not JSON", () => {
    expect(w.verify("cap", signAs("cap", b64u("not json")))).toMatchObject({
      ok: false,
      why: "unparseable cap claims",
      claims: null,
    });
  });

  it("refuses expired and expiry-less warrants", () => {
    const past = w.mint("permit", { expires: new Date(Date.now() - 1000).toISOString() });
    expect(w.verify("permit", past)).toMatchObject({ ok: false, why: "permit warrant expired" });
    const none = w.mint("permit", {});
    expect(w.verify("permit", none)).toMatchObject({ ok: false, why: "permit warrant expired" });
    const junk = w.mint("permit", { expires: "not a date" });
    expect(w.verify("permit", junk).ok).toBe(true); // NaN <= now is false: an unparseable expiry is not refused here
  });

  it("decodes standard base64 alphabets in the payload", () => {
    const payload = Buffer.from(JSON.stringify({ typ: "cap", expires: future(), x: "??>>" })).toString("base64");
    const v = w.verify("cap", signAs("cap", payload.replace(/=+$/, "")));
    expect(v.ok).toBe(true);
  });
});

describe("seal / sealOk", () => {
  it("accepts its own seal and refuses any other", () => {
    const s = w.seal("puzzle|READY|1");
    expect(w.sealOk("puzzle|READY|1", s)).toBe(true);
    expect(w.sealOk("puzzle|WORKING|1", s)).toBe(false);
    expect(w.sealOk("puzzle|READY|1", s.slice(1))).toBe(false);
    expect(w.sealOk("puzzle|READY|1", "")).toBe(false);
  });

  it("is keyed with the state key, not a warrant key", () => {
    const stateKey = readFileSync(join(sb.dir, ".keys", "state.key"), "utf8").trim();
    expect(w.seal("x")).toBe(createHmac("sha256", stateKey).update("x").digest("base64url"));
  });
});
