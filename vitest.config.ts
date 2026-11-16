// Test and coverage config. The coverage bar is the source's (Cliff Hall's inspector): >= 90 on all four
// dimensions, per file, enforced here and therefore in `bun run test` and CI. Never lower it to pass;
// see AGENTS.md "Always test new or modified code".
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Under Bun, import.meta.dir is the script's directory (the repo root for every fixture script). Vitest runs on
  // Node, where it is undefined, so tests point it at a per-test directory through a global. That lets the
  // INQ_DIR-unset fallback run against a throwaway sandbox instead of the real checkout.
  // (Vite's `define` does not reach import.meta in SSR transforms, hence this one-line pre-transform plugin.)
  plugins: [
    {
      name: "bun-import-meta-dir",
      enforce: "pre",
      transform: (code: string, id: string) =>
        id.endsWith(".ts") && code.includes("import.meta.dir")
          ? code.replaceAll("import.meta.dir", "globalThis.__PBX_META_DIR__")
          : undefined,
    },
  ],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    // Each test imports the fixture scripts into a fresh module registry; files run one at a time so the
    // shared fetch-route table in test/helpers/harness.ts is never touched by two files at once.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      // Every first-party script at the repo root. vendor/ is Cliff Hall's PuzzleBox, byte-identical to upstream.
      include: ["*.ts"],
      exclude: ["vitest.config.ts"],
      reporter: [["text", { skipFull: false }], "json-summary"],
      thresholds: { perFile: true, lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
