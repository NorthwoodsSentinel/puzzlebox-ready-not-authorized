# AGENTS.md — puzzlebox-ready-not-authorized

Rules for any agent (or person) changing this repo. The shape and most of the wording come from Cliff Hall's
`modelcontextprotocol/inspector` AGENTS.md (branch v2/main, commit d330df9617e44ec893bc1a53618662239342d433), as the
maintainer ruled on it. Where his way and ours differ, **the source's way stands until there is a reason to
depart**; every departure below says why.

`CLAUDE.md` contains only `@./AGENTS.md`. Keep one copy of these rules: two copies are strictly worse than one,
because the stale copy is indistinguishable from the live one.

## What this is

A small adversarial fixture: can workflow completion ("done") be kept mechanically separate from effect authority
("allowed")? It wraps Cliff Hall's PuzzleBox `Puzzle` class, vendored unchanged, in a reference monitor, typed
warrants and a single effector, then attacks the separation. `README.md` is the description and the threat
model; read it before changing anything. Everything runs on loopback (ports 8788 / 8789 / 8790). There is no
deploy and no build artifact.

## Security rules (read these before touching any `.ts` file at the root)

This repo is a security fixture. Its code is the experiment, so a behavior change is a change to the result.

- **No behavior change without an issue that says so.** A refactor, a lint fix, a type fix or a review suggestion
  is never a reason to change what a check does. Type-only edits (annotations, `as` casts) are allowed when the
  emitted JavaScript stays the same; check by comparing `bun build --no-bundle --minify-syntax` output before and
  after. (That is why `authd3.ts` `let body = {}` and `pbxd.ts` `reason = ""` keep their dead initializers
  under a justified one-line `no-useless-assignment` waiver: removing them would change the emitted code.)
- **Never weaken a check**: warrant verification, typ/key binding, expiry, nonce single-use, the fail-closed nonce
  ledger, the epoch and state checks, the boot check, the protected-resource set, or the no-await critical section
  in `pbxd.ts` `/effect`.
- **Broken specimens stay behind their flags** (`TOCTOU_NAIVE=1`, `PERMIT_SINGLE_USE=0`, `STATE_UNSIGNED=1`,
  `EFFECT_STATE_CHECK=0`, `PERMIT_BOOT_CHECK=0`, `NONCE_FAIL_OPEN=1`, weaker `AUTHD_MODE`s). The default path is
  always the fixed one. Tests assert both.
- **`run.sh` is the end-to-end story and must end `RESULT: 17 passed, 0 failed`.** Add a numbered case when you add
  a finding; never delete or loosen one.
- **Keys are trust roots.** `.keys/` is generated at runtime by `gen-keys.sh` and git-ignored. Never commit a key,
  print one, or put one in a test. Tests generate throwaway keys in a temp directory.

### The vendored Puzzle is never edited

`vendor/puzzlebox/` is Cliff Hall's PuzzleBox (MIT), byte-identical to upstream; `README.md` cites the file's
sha256. It is outside every format and lint scope, and outside coverage. It is typechecked (because `pbxd.ts`
imports it) but never changed to satisfy a check. Cliff's two guard TODOs in `Puzzle.ts` stay as they are.

## Project structure

- `pbxd.ts` — workflow-state service and the only effector (`/effect`).
- `authd3.ts` — reference monitor; verifies warrants per `AUTHD_MODE` and emits execution permits.
- `warrants.ts` — typed, separately keyed warrants and the state seal.
- `deputy2.ts` — a helper holding a legitimate capability, to stage the confused-deputy case.
- `issue-cap3.ts`, `issue-invocation.ts`, `issue-workflow.ts` — warrant issuers. `verify-effect.ts` — independent
  effect check.
- `run.sh`, `gen-keys.sh` — the end-to-end story and key generation.
- `test/` — Vitest suites (`*.test.ts`) and `test/helpers/harness.ts`.
- `scripts/verify-gate-scope.ts` — gate tooling.

## Development setup

- `bun install`. Bun runs this repo's own scripts (`bun run <script>`); if you run one of Cliff Hall's own tools
  or procedures, use his runner (`npx`) as he documents it.
- Tests run on Vitest with `@vitest/coverage-v8`, Cliff's choice, because Bun's coverage cannot measure branches
  or enforce a per-file bar.
- The fixture scripts are Bun programs with top-level side effects (a server on a fixed port, `process.argv`,
  `process.exit`). They are tested **unchanged**: `test/helpers/harness.ts` imports each one into a fresh module
  registry with a throwaway `INQ_DIR`, a fake `Bun.serve` that captures the handler, and a `fetch` stub that routes
  loopback calls to captured handlers. `vitest.config.ts` rewrites `import.meta.dir` (Bun-only) to a test global
  so the `INQ_DIR`-unset fallback also runs against a sandbox. No test binds a port or touches the network.
- `zod` is a root dev dependency so the vendored `Puzzle` resolves under Vitest without a separate install in
  `vendor/puzzlebox/`. `run.sh` still installs the vendored copy itself, as before.

## Issue-driven work style

GitHub issues are the board for this public repo.

- **Before starting work, find the issue.** Every change has one. Search before filing: **never create a
  duplicate**.
- **When work begins**, create the branch **in a new git worktree**, never by switching branches in a checkout
  another session may share.
- **When work is complete**, run `bun run format` then `bun run local:gate`, **sign off every commit**
  (`git commit -s`), and open a PR with **the issue reference as the body's first line**.
- **After opening a PR, run a review loop with an off-lineage reviewer**, unprompted. Stop on the **first** clean
  round. **Weigh each finding against the issue the PR closes and decline scope expansion.** Two failed rounds in
  a row: stop, leave the PR open, list the findings in it. (Departure: Cliff uses Copilot; the maintainer chose a
  different off-lineage reviewer.)
- **If new tasks are discovered during development, file issues** rather than widening the PR.
- **Pace bulk GitHub writes: 1 s between requests, never in parallel.**
- **A security issue stays private until its fix is ready**; accepting or publishing an advisory is
  outward-facing and stays human-gated, never automated. (Findings that are the fixture's own subject, like
  issue #1, are public by design.)
- **This repo is public. Merging is the maintainer's act**, and nothing personal goes into a commit, PR or test
  (home paths, emails, names, tokens). Tests use synthetic data only.

### Responding to code reviews

- Judge each suggestion against the issue the PR closes. Fix defects in what the PR added; decline, with a reason,
  what expands it; file an issue for anything worth doing on its own.
- Reply in each review comment's own thread, then post a summary in addition.

## Always test new or modified code

- **Every fixture script at the repo root must clear ≥ 90 on all four dimensions (lines, statements, functions,
  branches), per file**, enforced by `vitest.config.ts` and therefore by `bun run test`, `bun run local:gate` and
  CI. This is the source's bar (Cliff's inspector). **Never lower the threshold to pass.**
- Measured on 2026-11-16 (statements / branches / functions / lines): `authd3.ts` 99.33 / 98.56 / 100 / 99.2,
  `pbxd.ts` 100 / 95.77 / 100 / 100, `warrants.ts`, `deputy2.ts`, `issue-cap3.ts`, `issue-invocation.ts`,
  `issue-workflow.ts`, `verify-effect.ts` 100 / 100 / 100 / 100. No coverage exclusions.
- Coverage exclusions, if one is ever needed, are exact paths, one per entry, each with a reason and a follow-up
  issue; never a glob that could hide a new file.
- **A gate must show how much it checked.** `scripts/verify-gate-scope.ts` runs after the tests and fails if a
  tracked `.ts` file is in no tsconfig project or a root script is missing from the coverage summary. Fix that by
  fixing the globs, never by excusing the file.
- Test files are `test/**/*.test.ts`; a file named otherwise is silently not run.
- A rule about what the code does is asserted at runtime in a test, not read out of the source.
- A test that races is fixed with an awaited condition, never with a longer timeout.

## Mandatory pre-push gate

- **ALWAYS run `bun run format` before committing.**
- **`bun run local:gate` is the mandatory pre-push command.** It runs every check CI runs: `format:check`, `lint`,
  `typecheck`, `test` (Vitest with the coverage bar, then the gate-scope check) and `test:fixture` (`run.sh`, which
  needs ports 8788–8790 free). A green run here means every check CI applies has already passed on your machine.
- CI: `.github/workflows/ci.yml` runs the first four stages as separate steps; `.github/workflows/test.yml` runs
  `run.sh`, as it did before. Neither deploys; there is nothing to deploy.
- There is deliberately no `ci` script (the name collides with the package-manager built-in).
- Departures, each for a stated reason: no gate lease (the gate takes seconds and `run.sh` already refuses a busy
  port); no DCO check job (a required-check ruleset is a repository setting, the maintainer's to change).

## Waiting on long-running work

**When you are waiting for something to finish, arm a notifier and stop. Never spend turns polling.** For state
the harness cannot observe (a CI run, a remote review), poll inside one backgrounded loop that exits when the
condition holds, at 30 s or more.

## Build output is never a gate target

**No gate (lint, format or typecheck) may read generated output.** Out of scope: `node_modules/`, `coverage/`,
`bun.lock`, and `run.sh`'s runtime output (`.keys/`, `protected/`, `*.jsonl`, `puzzle-state.json`, `.log-*`).
Each scope states it: `globalIgnores` in `eslint.config.js`, `.prettierignore`, and the tsconfig `include` list.
**When something starts writing to a new location, add it to the ignore lists in the same change.** Never widen
an ignore to silence a finding in first-party code. Markdown is outside the format scope: prettier rewrites prose.

## Lint has no warning tier

**`lint` runs with `--max-warnings 0`, so a warning fails the gate exactly as an error does.** Rules: ESLint
recommended, typescript-eslint recommended, and `@typescript-eslint/no-floating-promises` at `error`.

- **Do not silence a finding to satisfy the gate.** A warning is a defect to fix. If a rule genuinely must be
  waived on one line, use its inline disable comment **with a one-line justification**. Dropping a rule or
  widening an ignore to make `lint` pass is not a fix.

## TypeScript

- TypeScript for all code. Never `any`: parsed JSON (request bodies, warrant claims) is `Record<string, unknown>`
  (`Claims` in `warrants.ts`) and is compared, not trusted.
- No floating promises: `await` them, or `void` them with a comment saying why.
- An empty `catch` carries a comment saying why swallowing is correct there.
- Every new file starts with a header comment saying what it is for and why.
