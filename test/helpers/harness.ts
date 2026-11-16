// Test harness: loads each fixture script in-process, unchanged, with its environment, keys and network stubbed.
// Why: the scripts are Bun programs with top-level side effects (Bun.serve on fixed loopback ports, process.argv,
// process.exit). Rather than restructure security code to make it importable, the harness gives each import a
// fresh module registry, a throwaway INQ_DIR with its own keys, a fake `Bun.serve` that captures the request
// handler, and a `fetch` stub that routes loopback calls to captured handlers. run.sh remains the end-to-end check.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { vi } from "vitest";

export type Handler = (req: Request) => Promise<Response> | Response;

export interface Sandbox {
  dir: string;
  prot: string;
  r1: string;
  r2: string;
  cleanup: () => void;
}

/** A fresh INQ_DIR with the five trust-root keys and an empty protected/ directory. */
export function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "pbx-test-"));
  mkdirSync(join(dir, ".keys"));
  for (const k of ["cap", "inv", "wf", "permit", "state"])
    writeFileSync(join(dir, ".keys", `${k}.key`), randomBytes(32).toString("base64") + "\n");
  const prot = join(dir, "protected");
  mkdirSync(prot);
  const r1 = join(prot, "deployments.log");
  const r2 = join(prot, "deployments2.log");
  writeFileSync(r1, "");
  writeFileSync(r2, "");
  return { dir, prot, r1, r2, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Routes for the fetch stub: port number -> handler. A missing port behaves like a refused connection. */
export const routes = new Map<number, Handler>();

export function installNetwork(): void {
  routes.clear();
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const port = Number(new URL(req.url).port);
    const h = routes.get(port);
    if (!h) throw new TypeError(`fetch failed: connection refused on ${port}`);
    return h(req);
  });
}

/**
 * Import one fixture script fresh, with `env` applied, and return the handler it passed to Bun.serve (if any).
 * Every key in `env` is stubbed; a value of undefined deletes the variable for this import.
 */
export async function load(
  mod: string,
  env: Record<string, string | undefined>,
  argv: string[] = [],
): Promise<{ handler: Handler | undefined; port: number | undefined; logs: string[]; errors: string[] }> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  let handler: Handler | undefined;
  let port: number | undefined;
  vi.stubGlobal("Bun", {
    serve: (opts: { port: number; fetch: Handler }) => {
      handler = opts.fetch;
      port = opts.port;
      routes.set(opts.port, opts.fetch);
      return { port: opts.port };
    },
  });
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
  const savedArgv = process.argv;
  process.argv = ["bun", mod, ...argv];
  try {
    await import(/* @vite-ignore */ new URL(`../../${mod}`, import.meta.url).href);
  } finally {
    process.argv = savedArgv;
  }
  return { handler, port, logs, errors };
}

export function post(port: number, path: string, body: unknown, raw = false): Request {
  return new Request(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? String(body) : JSON.stringify(body),
  });
}

export function get(port: number, path: string): Request {
  return new Request(`http://127.0.0.1:${port}${path}`);
}

export async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
