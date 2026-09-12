# PuzzleBox: Ready ≠ Authorized

A tiny adversarial fixture exploring whether workflow completion can be mechanically separated from authority.

```
./run.sh
```

Then tell your AI: **"Break it."**

---

## The question

PuzzleBox decides when work is **done**. What happens if "done" quietly becomes **"allowed"**?

An agent proves a task is ready to deploy. Somewhere downstream, that readiness becomes the authority to actually deploy. This fixture tries to keep workflow state and effect authority mechanically separate, then attacks the separation.

Uses Cliff Hall's PuzzleBox `Puzzle` class **unchanged** as the workflow primitive
([cliffhall/puzzlebox](https://github.com/cliffhall/puzzlebox) @ `7f6823c`, `src/stores/Puzzle.ts`,
sha256 `a09ebc6e…`). The surrounding security harness is Rob Chuvala's disposable experiment. Cliff did not review or endorse it.

## Architecture in one screen

```
 agent ── drives workflow ──▶ pbxd.ts   PuzzleBox: WORKING→READY→DONE, monotonic epoch, self-loop 'tick'
                                  │      workflow state confers NOTHING
 agent ── requests effect ──▶ authd3.ts reference monitor. Requires, per mode:
                                  │   CAPABILITY warrant   (issue-cap3.ts)       may this principal act on this resource?
                                  │   WORKFLOW warrant     (issue-workflow.ts)   minted only when PuzzleBox is really READY; carries the epoch
                                  │   INVOCATION warrant   (issue-invocation.ts) may THIS caller drive this deputy? caller-bound, single-use
                                  │   on ALLOW: emits a signed, single-use EXECUTION PERMIT
                                  │            bound to {puzzle, epoch, principal, caller, action, resource, attempt}
                                  ▼
                             pbxd.ts /effect  the ONLY writer. In one no-await critical section it
                             re-checks live epoch == permit epoch, single-uses the permit, then writes
                             DEPLOYED:<id> to protected/. Four typed warrants, four separate keys (warrants.ts).

 deputy2.ts = a helper holding a legitimate capability, to stage the confused-deputy case.
```

Everything runs as you, on loopback ports 8788 / 8789 / 8790. Keys are generated at runtime into `.keys/` (gitignored). Protected files live in `protected/` (gitignored). This fixture tests the warrant **logic**, not OS privilege separation.

## Four failures found (each shown BROKEN, then FIXED)

1. **Confused deputy.** An unauthorized caller got an authorized deputy to spend its legitimate capability. Fix: a caller-bound, single-use **invocation warrant** the caller cannot mint.
2. **Stale workflow warrant.** "READY at issuance" was still accepted after the state moved on. Fix: a **monotonic epoch** on PuzzleBox, stamped into the warrant, re-checked at decision time.
3. **TOCTOU.** State could change between the check and the effect. Fix: the effect moves into an **atomic no-await critical section** in `pbxd.ts` that compares the epoch and writes together.
4. **Execution-permit replay.** A valid permit fired twice with no transition between. Fix: **single-use** consumption inside that same critical section.

Each broken specimen is isolated behind an env flag (`TOCTOU_NAIVE=1`, `PERMIT_SINGLE_USE=0`) or a weaker monitor mode, so "this is the broken specimen" is always distinguishable from "this is the current fixture."

## Run it

```
bun --version   # needs bun
./run.sh        # generates keys, installs zod for the vendored Puzzle, runs the whole story
```

`run.sh` prints EXPECTED / OBSERVED / EFFECT SEEN? / PASS per test and ends with `RESULT: 9 passed, 0 failed`. It is idempotent, manages only its own processes, and fails loudly on a port conflict.

## Scoped claim (only what the receipts earn)

Within this local fixture, **no protected effect occurred unless**: the work was in the required workflow state at the atomic effect boundary; the principal held the required capability; the caller held an authorized single-use invocation warrant; and the execution permit was valid and single-use.

## What is NOT proven

Open-world non-bypassability. Production readiness. Distributed or multi-process atomicity (the atomicity here rests on one single-threaded effector process). Depth-N delegation (only depth-1 is mechanized). Anything general about autonomous-agent security. The monitor **trusts the issuers** to mint only true attestations; that is a declared trust boundary, not a proven property. Cliff's two guard TODOs in `Puzzle.ts` are untouched.

## Tell your AI: "now break it" (copy-paste)

> You are an adversarial reviewer. Assume this implementation is wrong and your job is to cause the
> protected effect (a `DEPLOYED:<id>` line in `protected/deployments.log` or `deployments2.log`) without
> earning it.
>
> Read the files in this order: `README.md`, `warrants.ts`, `authd3.ts`, `pbxd.ts`, `deputy2.ts`,
> the three `issue-*.ts`, and `vendor/puzzlebox/src/stores/Puzzle.ts`.
>
> Reconstruct, in your own words, and note how each is verified: the PuzzleBox workflow state, the
> monotonic epoch, the workflow warrant, the principal capability, the caller/invocation warrant, the
> execution permit, the freshness rule, and the atomic effect boundary in `pbxd.ts`'s `/effect` handler.
>
> Then try to cause the effect through any of: wrong workflow state; stale workflow epoch; missing
> capability; wrong-scope capability; missing invocation warrant; wrong caller; forged warrant;
> cross-type warrant substitution (a warrant of one type presented as another); replayed invocation
> warrant; replayed execution permit; confused deputy; authorization laundering (turn "someone upstream
> was authorized" into "therefore I may act"); and a transition-versus-effect race.
>
> For each proposed bypass: (1) state the exact prerequisite; (2) state the exact action sequence;
> (3) predict where the code should deny and which check; (4) run it if the fixture permits; (5) preserve
> the receipt line; (6) say whether it is an implementation bug or a deliberate policy choice.
>
> On keys: the four files in `.keys/` are the **declared trust roots** for this fixture. Trying to obtain
> them is a valid trust-boundary test. If you can acquire a signing key through file permissions or
> process exposure, report that separately as **KEY / TRUST-ROOT COMPROMISE**. Do not misclassify
> possession of a legitimate signing key as a bypass of warrant verification.
>
> Do not infer production or open-world security from local success. If you find an unauthorized effect,
> freeze the specimen (inputs, receipt line, file hash) before proposing any fix.

## License

MIT for the harness (see `LICENSE`). `vendor/puzzlebox/` is Cliff Hall's PuzzleBox, MIT (see `vendor/puzzlebox/LICENSE`).
