#!/usr/bin/env bash
# READY != AUTHORIZED — Saturday toy. One command, clean checkout. Demonstrates the story, not just green.
# Requires: bun. Runs everything as YOU (this fixture tests warrant LOGIC, not OS privilege separation).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$DIR"
export INQ_DIR="$DIR"; export PROTECTED_DIR="$DIR/protected"
PB=8788; MON=8790; DEP=8789
R1="$PROTECTED_DIR/deployments.log"; R2="$PROTECTED_DIR/deployments2.log"; P=deploy-marker-puzzle
PIDS=(); cleanup(){ for p in "${PIDS[@]:-}"; do kill -9 -"$p" 2>/dev/null || true; kill -9 "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
die(){ echo "FATAL: $*" >&2; exit 1; }
portfree(){ if command -v ss >/dev/null && ss -tlnp 2>/dev/null | grep -q "127.0.0.1:$1 "; then die "port $1 is in use — close it and retry (this script only manages its own processes)"; fi; }

# --- prereqs ---
command -v bun >/dev/null || die "bun not found — install bun first"
bash gen-keys.sh >/dev/null
[ -d vendor/puzzlebox/node_modules ] || ( cd vendor/puzzlebox && bun install >/dev/null 2>&1 ) || die "bun install (zod) failed in vendor/puzzlebox"
for pt in $PB $MON $DEP; do portfree $pt; done

# --- fresh state (idempotent) ---
mkdir -p "$PROTECTED_DIR"; : > "$R1"; : > "$R2"; rm -f "$DIR/puzzle-state.json" "$DIR/used-nonces.jsonl" "$DIR/receipts.jsonl"

SETSID=$(command -v setsid || true)   # Linux has setsid; macOS does not (reported by Cliff Hall, issue #1)
start(){ $SETSID bash -c "$2" >"$DIR/.log-$1" 2>&1 < /dev/null & PIDS+=($!); disown; }
freshpuzzle(){ rm -f "$DIR/puzzle-state.json"; }
waitup(){ for i in $(seq 1 40); do curl -s -m1 "http://127.0.0.1:$1$2" >/dev/null 2>&1 && return 0; sleep 0.1; done; die "service on $1 did not come up"; }
stopall(){ cleanup; PIDS=(); sleep 0.4; }
cap(){ bun issue-cap3.ts --principal "$1" --action deploy-marker --resource "$2" --nonce "$3" --ttl-seconds 600; }
wf(){ bun issue-workflow.ts --puzzle $P --required-state READY --resource "$1" --nonce "$2" ${3:-}; }
inv(){ bun issue-invocation.ts --caller "$1" --deputy deputy --action deploy-marker --resource "$2" --nonce "$3"; }
snap(){ curl -s -m2 http://127.0.0.1:$PB/state; }
ep(){ snap | grep -o '"epoch": [0-9]*' | grep -o '[0-9]*'; }
advance(){ curl -s -m2 -X POST http://127.0.0.1:$PB/action -H 'content-type: application/json' -d "{\"actionName\":\"$1\"}" >/dev/null; }
marker(){ local c; c=$(grep -c "DEPLOYED:$1" "$2" 2>/dev/null); echo "${c:-0}"; }
report(){ local r; if [ "$4" = "$5" ]; then r=PASS; PASS=$((PASS+1)); else r=FAIL; FAIL=$((FAIL+1)); fi; printf '  EXPECTED: %s\n  OBSERVED: %s\n  EFFECT SEEN? %s\n  %s\n\n' "$1" "$2" "$3" "$r"; }

PASS=0; FAIL=0

echo "=================================================================="
echo " READY != AUTHORIZED  —  workflow state is not effect authority"
echo "=================================================================="

# ---------- 1. HAPPY PATH ----------
echo; echo "### 1. HAPPY PATH — all warrants valid, epoch fresh, atomic effect"
freshpuzzle; start pbxd "bun pbxd.ts"; waitup $PB /state
start mon "AUTHD_MODE=all WF_FRESHNESS=continuous EMIT_PERMIT=1 bun authd3.ts"; waitup $MON /health
start dep "DEPUTY_CAP=\"$(cap deputy "$R2" dep-happy)\" bun deputy2.ts"; waitup $DEP /health
advance finish_work   # -> READY, epoch 1
WF=$(wf "$R2" wf-happy); IV=$(inv pbagent "$R2" inv-happy)
PMT=$(curl -s -m6 -X POST http://127.0.0.1:$DEP/deploy -H 'content-type: application/json' \
  -d "{\"resource\":\"$R2\",\"attempt_id\":\"happy\",\"caller\":\"pbagent\",\"puzzle_id\":\"$P\",\"workflow_warrant\":\"$WF\",\"invocation_warrant\":\"$IV\",\"invocation_nonce\":\"inv-happy\"}")
# deputy2 forwards to monitor (mode=all EMIT_PERMIT) -> permit; then effector applies it
PERMIT=$(echo "$PMT" | grep -oE '"permit":"[^"]*"' | cut -d'"' -f4)
if [ -n "$PERMIT" ]; then curl -s -m5 -X POST http://127.0.0.1:$PB/effect -H 'content-type: application/json' -d "{\"permit\":\"$PERMIT\"}" >/dev/null; fi
E=$(marker deputy-happy "$R2"); V=$([ "$E" -ge 1 ] && echo yes || echo no)
report "ALLOW + effect written" "effect_marker_count=$E" "$V" "$V" "yes"
stopall

# ---------- 2. CONFUSED DEPUTY ----------
echo "### 2. CONFUSED DEPUTY — unauthorized caller drives an authorized deputy"
echo "  2a BROKEN SPECIMEN (monitor mode cap+wf, NO invocation warrant required):"
freshpuzzle; start pbxd "bun pbxd.ts"; waitup $PB /state
start mon "AUTHD_MODE=cap+wf WF_FRESHNESS=point-in-time bun authd3.ts"; waitup $MON /health
start dep "DEPUTY_CAP=\"$(cap deputy "$R2" dep-cd1)\" bun deputy2.ts"; waitup $DEP /health
advance finish_work
WF=$(wf "$R2" wf-cd1)
curl -s -m6 -X POST http://127.0.0.1:$DEP/deploy -H 'content-type: application/json' \
  -d "{\"resource\":\"$R2\",\"attempt_id\":\"cd-broken\",\"caller\":\"pbagent\",\"puzzle_id\":\"$P\",\"workflow_warrant\":\"$WF\"}" >/dev/null
E=$(marker deputy-cd-broken "$R2"); V=$([ "$E" -ge 1 ] && echo yes || echo no)
report "unauthorized caller induces effect (the vulnerability)" "effect_marker_count=$E" "$V" "$V" "yes"
stopall
echo "  2b CURRENT FIXTURE (monitor mode cap+inv — caller-bound invocation warrant required):"
freshpuzzle; start pbxd "bun pbxd.ts"; waitup $PB /state
start mon "AUTHD_MODE=cap+inv EMIT_PERMIT=1 bun authd3.ts"; waitup $MON /health
start dep "DEPUTY_CAP=\"$(cap deputy "$R2" dep-cd2)\" bun deputy2.ts"; waitup $DEP /health
advance finish_work
RESP=$(curl -s -m6 -X POST http://127.0.0.1:$DEP/deploy -H 'content-type: application/json' \
  -d "{\"resource\":\"$R2\",\"attempt_id\":\"cd-fixed\",\"caller\":\"pbagent\",\"puzzle_id\":\"$P\"}")
DEC=$(echo "$RESP" | grep -oE '"decision": *"[A-Z]*"' | cut -d'"' -f4); E=$(marker cd-fixed "$R2"); V=$([ "$E" -ge 1 ] && echo yes || echo no)
report "DENY (no invocation warrant), no effect" "decision=$DEC marker=$E" "$V" "$V" "no"
stopall

# ---------- 3. STALE WORKFLOW WARRANT ----------
echo "### 3. STALE WORKFLOW WARRANT — 'ready' used after state moved"
echo "  3a BROKEN SPECIMEN (point-in-time): warrant issued READY, puzzle -> DONE, warrant still used:"
freshpuzzle; start pbxd "bun pbxd.ts"; waitup $PB /state
start mon "AUTHD_MODE=cap+wf WF_FRESHNESS=point-in-time bun authd3.ts"; waitup $MON /health
advance finish_work; WF=$(wf "$R1" wf-stale1); C=$(cap pbagent "$R1" c-stale1); advance mark_done
RESP=$(curl -s -m6 -X POST http://127.0.0.1:$MON/act -H 'content-type: application/json' \
  -d "{\"principal\":\"pbagent\",\"action\":\"deploy-marker\",\"resource\":\"$R1\",\"attempt_id\":\"stale-broken\",\"capability\":\"$C\",\"puzzle_id\":\"$P\",\"workflow_warrant\":\"$WF\"}")
E=$(marker stale-broken "$R1"); V=$([ "$E" -ge 1 ] && echo yes || echo no)
report "stale READY warrant still ALLOWs (the vulnerability)" "marker=$E" "$V" "$V" "yes"
stopall
echo "  3b CURRENT FIXTURE (continuous + epoch): same stale warrant after transition:"
freshpuzzle; start pbxd "bun pbxd.ts"; waitup $PB /state
start mon "AUTHD_MODE=cap+wf WF_FRESHNESS=continuous bun authd3.ts"; waitup $MON /health
advance finish_work; WF=$(wf "$R1" wf-stale2); C=$(cap pbagent "$R1" c-stale2); advance mark_done
RESP=$(curl -s -m6 -X POST http://127.0.0.1:$MON/act -H 'content-type: application/json' \
  -d "{\"principal\":\"pbagent\",\"action\":\"deploy-marker\",\"resource\":\"$R1\",\"attempt_id\":\"stale-fixed\",\"capability\":\"$C\",\"puzzle_id\":\"$P\",\"workflow_warrant\":\"$WF\"}")
DEC=$(echo "$RESP" | grep -oE '"decision": *"[A-Z]*"' | cut -d'"' -f4); E=$(marker stale-fixed "$R1"); V=$([ "$E" -ge 1 ] && echo yes || echo no)
report "DENY (epoch stale), no effect" "decision=$DEC marker=$E" "$V" "$V" "no"
stopall

# ---------- 4. TOCTOU ----------
echo "### 4. TOCTOU — state changes between check and effect"
echo "  4a BROKEN SPECIMEN (monitor does effect, check-only, transition in the window):"
freshpuzzle; start pbxd "bun pbxd.ts"; waitup $PB /state
start mon "AUTHD_MODE=cap+wf WF_FRESHNESS=continuous TOCTOU_DELAY_MS=1500 TOCTOU_NAIVE=1 bun authd3.ts"; waitup $MON /health
advance finish_work; WF=$(wf "$R1" wf-tt1); C=$(cap pbagent "$R1" c-tt1)
( curl -s -m8 -X POST http://127.0.0.1:$MON/act -H 'content-type: application/json' \
  -d "{\"principal\":\"pbagent\",\"action\":\"deploy-marker\",\"resource\":\"$R1\",\"attempt_id\":\"toctou-broken\",\"capability\":\"$C\",\"puzzle_id\":\"$P\",\"workflow_warrant\":\"$WF\"}" >/dev/null ) & REQ=$!
sleep 0.5; advance tick 2>/dev/null || advance mark_done; wait $REQ
E=$(marker toctou-broken "$R1"); V=$([ "$E" -ge 1 ] && echo yes || echo no)
report "stale effect fires despite mid-window transition (the race)" "marker=$E" "$V" "$V" "yes"
stopall
echo "  4b CURRENT FIXTURE (atomic effector /effect, epoch compared in a no-await critical section):"
freshpuzzle; start pbxd "bun pbxd.ts"; waitup $PB /state
start mon "AUTHD_MODE=cap+wf WF_FRESHNESS=continuous EMIT_PERMIT=1 bun authd3.ts"; waitup $MON /health
advance finish_work; WF=$(wf "$R1" wf-tt2); C=$(cap pbagent "$R1" c-tt2)
PMT=$(curl -s -m6 -X POST http://127.0.0.1:$MON/act -H 'content-type: application/json' \
  -d "{\"principal\":\"pbagent\",\"action\":\"deploy-marker\",\"resource\":\"$R1\",\"attempt_id\":\"toctou-fixed\",\"capability\":\"$C\",\"puzzle_id\":\"$P\",\"workflow_warrant\":\"$WF\"}")
PERMIT=$(echo "$PMT" | grep -oE '"permit":"[^"]*"' | cut -d'"' -f4)
advance tick   # transition BEFORE the effect is applied -> epoch moves
RESP=$(curl -s -m5 -X POST http://127.0.0.1:$PB/effect -H 'content-type: application/json' -d "{\"permit\":\"$PERMIT\"}")
DEC=$(echo "$RESP" | grep -oE '"decision": *"[A-Z]*"' | cut -d'"' -f4); E=$(marker toctou-fixed "$R1"); V=$([ "$E" -ge 1 ] && echo yes || echo no)
report "DENY (effector epoch != permit epoch), no effect" "decision=$DEC marker=$E" "$V" "$V" "no"
stopall

# ---------- 5. PERMIT REPLAY ----------
echo "### 5. EXECUTION-PERMIT REPLAY — same permit fired twice, no transition between"
echo "  5a BROKEN SPECIMEN (effector single-use disabled):"
freshpuzzle; start pbxd "PERMIT_SINGLE_USE=0 bun pbxd.ts"; waitup $PB /state
start mon "AUTHD_MODE=cap+wf WF_FRESHNESS=continuous EMIT_PERMIT=1 bun authd3.ts"; waitup $MON /health
advance finish_work; WF=$(wf "$R1" wf-rp1); C=$(cap pbagent "$R1" c-rp1)
PMT=$(curl -s -m6 -X POST http://127.0.0.1:$MON/act -H 'content-type: application/json' \
  -d "{\"principal\":\"pbagent\",\"action\":\"deploy-marker\",\"resource\":\"$R1\",\"attempt_id\":\"replay-broken\",\"capability\":\"$C\",\"puzzle_id\":\"$P\",\"workflow_warrant\":\"$WF\"}")
PERMIT=$(echo "$PMT" | grep -oE '"permit":"[^"]*"' | cut -d'"' -f4)
curl -s -m5 -X POST http://127.0.0.1:$PB/effect -H 'content-type: application/json' -d "{\"permit\":\"$PERMIT\"}" >/dev/null
curl -s -m5 -X POST http://127.0.0.1:$PB/effect -H 'content-type: application/json' -d "{\"permit\":\"$PERMIT\"}" >/dev/null
E=$(marker replay-broken "$R1"); V=$([ "$E" -ge 2 ] && echo "twice" || echo "once")
report "permit fires TWICE (marker count 2 = the vulnerability)" "marker=$E" "$V" "$V" "twice"
stopall
echo "  5b CURRENT FIXTURE (effector single-use, default):"
freshpuzzle; start pbxd "bun pbxd.ts"; waitup $PB /state
start mon "AUTHD_MODE=cap+wf WF_FRESHNESS=continuous EMIT_PERMIT=1 bun authd3.ts"; waitup $MON /health
advance finish_work; WF=$(wf "$R1" wf-rp2); C=$(cap pbagent "$R1" c-rp2)
PMT=$(curl -s -m6 -X POST http://127.0.0.1:$MON/act -H 'content-type: application/json' \
  -d "{\"principal\":\"pbagent\",\"action\":\"deploy-marker\",\"resource\":\"$R1\",\"attempt_id\":\"replay-fixed\",\"capability\":\"$C\",\"puzzle_id\":\"$P\",\"workflow_warrant\":\"$WF\"}")
PERMIT=$(echo "$PMT" | grep -oE '"permit":"[^"]*"' | cut -d'"' -f4)
curl -s -m5 -X POST http://127.0.0.1:$PB/effect -H 'content-type: application/json' -d "{\"permit\":\"$PERMIT\"}" >/dev/null
R2ND=$(curl -s -m5 -X POST http://127.0.0.1:$PB/effect -H 'content-type: application/json' -d "{\"permit\":\"$PERMIT\"}")
DEC=$(echo "$R2ND" | grep -oE '"decision": *"[A-Z]*"' | cut -d'"' -f4); E=$(marker replay-fixed "$R1"); V=$([ "$E" -eq 1 ] && echo "once" || echo "$E")
report "first ALLOW, second DENY (marker count 1)" "2nd_decision=$DEC marker=$E" "$V" "$V" "once"
stopall

# ---------- 6. STATE ROLLBACK (issue #1, found by Cliff Hall) ----------
# Drive to READY, mint a LEGITIMATE warrant, stop pbxd, forge {WORKING, epoch 1} into the state file, restart,
# redeem. No signing key is touched. Fix 1 seals {state,epoch} together; Fix 2 re-checks the live state name
# in the effector's critical section. Either one alone stops it.
pbstart(){ start pbxd "$1"; PBPID=${PIDS[${#PIDS[@]}-1]}; waitup $PB /state; }
pbstop(){ kill -9 "$PBPID" 2>/dev/null; for i in $(seq 1 40); do curl -s -m1 http://127.0.0.1:$PB/state >/dev/null 2>&1 || return 0; sleep 0.1; done; die "pbxd did not stop"; }
forge(){ printf '{"puzzle_id":"%s","state":"WORKING","epoch":1}\n' "$P" > "$DIR/puzzle-state.json"; }
live(){ snap | grep -o '"currentState": "[A-Z]*"' | cut -d'"' -f4; }
rollback(){ # $1 pbxd env, $2 attempt id -> sets DEC (monitor), EDEC (effector), LIVE
  freshpuzzle; pbstart "$1 bun pbxd.ts"
  start mon "AUTHD_MODE=cap+wf WF_FRESHNESS=continuous EMIT_PERMIT=1 bun authd3.ts"; waitup $MON /health
  advance finish_work; WF=$(wf "$R1" "wf-$2"); C=$(cap pbagent "$R1" "c-$2")
  pbstop; forge; pbstart "$1 bun pbxd.ts"; LIVE="$(live)@$(ep)"
  PMT=$(curl -s -m6 -X POST http://127.0.0.1:$MON/act -H 'content-type: application/json' \
    -d "{\"principal\":\"pbagent\",\"action\":\"deploy-marker\",\"resource\":\"$R1\",\"attempt_id\":\"$2\",\"capability\":\"$C\",\"puzzle_id\":\"$P\",\"workflow_warrant\":\"$WF\"}")
  DEC=$(echo "$PMT" | grep -oE '"decision": *"[A-Z]*"' | cut -d'"' -f4)
  PERMIT=$(echo "$PMT" | grep -oE '"permit":"[^"]*"' | cut -d'"' -f4); EDEC="(no permit)"
  if [ -n "$PERMIT" ]; then EDEC=$(curl -s -m5 -X POST http://127.0.0.1:$PB/effect -H 'content-type: application/json' -d "{\"permit\":\"$PERMIT\"}" | grep -oE '"reason": *"[^"]*"' | cut -d'"' -f4); fi
}
echo "### 6. STATE ROLLBACK — forged {WORKING, epoch 1} after a legitimate READY warrant (issue #1)"
echo "  6a BROKEN SPECIMEN (unsealed state file accepted, effector trusts epoch alone):"
rollback "STATE_UNSIGNED=1 EFFECT_STATE_CHECK=0" rollback-broken
E=$(marker rollback-broken "$R1"); V=$([ "$E" -ge 1 ] && echo yes || echo no)
report "deploy fires while live state is WORKING (the vulnerability)" "live=$LIVE monitor=$DEC marker=$E" "$V" "$V" "yes"
stopall
echo "  6b CURRENT FIXTURE (sealed state file + effector state check):"
rollback "" rollback-fixed
E=$(marker rollback-fixed "$R1"); V=$([ "$E" -ge 1 ] && echo yes || echo no)
report "pbxd refuses forged file (WORKING@0), monitor DENY, no effect" "live=$LIVE monitor=$DEC marker=$E" "$V" "$V" "no"
stopall
echo "  6c DEFENSE IN DEPTH (forged file ACCEPTED; only the effector's state check stands):"
rollback "STATE_UNSIGNED=1" rollback-depth
E=$(marker rollback-depth "$R1"); V=$([ "$E" -ge 1 ] && echo yes || echo no)
report "monitor ALLOWs on epoch, effector DENYs on live state" "live=$LIVE monitor=$DEC effector='$EDEC' marker=$E" "$V" "$V" "no"
stopall
echo "  6d CURRENT FIXTURE: a legitimately sealed state still survives restart:"
freshpuzzle; pbstart "bun pbxd.ts"; advance finish_work; pbstop; pbstart "bun pbxd.ts"
S="$(live)@$(ep)"
report "READY@1 restored after restart" "live=$S" "n/a" "$S" "READY@1"
stopall

# ---------- 7. PERMIT REPLAY ACROSS RESTART (issue #1, second observation) ----------
replayrestart(){ # $1 pbxd env, $2 attempt id -> sets DEC2
  freshpuzzle; pbstart "$1 bun pbxd.ts"
  start mon "AUTHD_MODE=cap+wf WF_FRESHNESS=continuous EMIT_PERMIT=1 bun authd3.ts"; waitup $MON /health
  advance finish_work; WF=$(wf "$R1" "wf-$2"); C=$(cap pbagent "$R1" "c-$2")
  PMT=$(curl -s -m6 -X POST http://127.0.0.1:$MON/act -H 'content-type: application/json' \
    -d "{\"principal\":\"pbagent\",\"action\":\"deploy-marker\",\"resource\":\"$R1\",\"attempt_id\":\"$2\",\"capability\":\"$C\",\"puzzle_id\":\"$P\",\"workflow_warrant\":\"$WF\"}")
  PERMIT=$(echo "$PMT" | grep -oE '"permit":"[^"]*"' | cut -d'"' -f4)
  curl -s -m5 -X POST http://127.0.0.1:$PB/effect -H 'content-type: application/json' -d "{\"permit\":\"$PERMIT\"}" >/dev/null
  pbstop; pbstart "$1 bun pbxd.ts"   # single-use memory is gone; sealed READY@1 is restored
  DEC2=$(curl -s -m5 -X POST http://127.0.0.1:$PB/effect -H 'content-type: application/json' -d "{\"permit\":\"$PERMIT\"}" | grep -oE '"decision": *"[A-Z]*"' | cut -d'"' -f4)
}
echo "### 7. PERMIT REPLAY ACROSS AN EFFECTOR RESTART (single-use set is in-memory)"
echo "  7a BROKEN SPECIMEN (effector honors permits minted before it started):"
replayrestart "PERMIT_BOOT_CHECK=0" rr-broken
E=$(marker rr-broken "$R1"); V=$([ "$E" -ge 2 ] && echo "twice" || echo "once")
report "same permit fires again after restart (the vulnerability)" "2nd_decision=$DEC2 marker=$E" "$V" "$V" "twice"
stopall
echo "  7b CURRENT FIXTURE (permits issued before effector boot are refused):"
replayrestart "" rr-fixed
E=$(marker rr-fixed "$R1"); V=$([ "$E" -ge 2 ] && echo "twice" || echo "once")
report "first ALLOW, post-restart DENY (marker count 1)" "2nd_decision=$DEC2 marker=$E" "$V" "$V" "once"
stopall

# ---------- 8. NONCE LEDGER FAILS OPEN (issue #1, first observation) ----------
noncecorrupt(){ # $1 monitor env, $2 attempt prefix -> sets DEC2
  freshpuzzle; rm -f "$DIR/used-nonces.jsonl"; pbstart "bun pbxd.ts"
  start mon "AUTHD_MODE=cap+wf WF_FRESHNESS=point-in-time $1 bun authd3.ts"; waitup $MON /health
  advance finish_work; WF=$(wf "$R1" "wf-$2"); C=$(cap pbagent "$R1" "c-$2")
  echo 'not-json' > "$DIR/used-nonces.jsonl"   # one malformed line AHEAD of every nonce recorded after it
  for n in 1 2; do
    RESP=$(curl -s -m6 -X POST http://127.0.0.1:$MON/act -H 'content-type: application/json' \
      -d "{\"principal\":\"pbagent\",\"action\":\"deploy-marker\",\"resource\":\"$R1\",\"attempt_id\":\"$2-$n\",\"capability\":\"$C\",\"puzzle_id\":\"$P\",\"workflow_warrant\":\"$WF\"}")
  done
  DEC2=$(echo "$RESP" | grep -oE '"decision": *"[A-Z]*"' | cut -d'"' -f4)
}
echo "### 8. NONCE LEDGER — one malformed line, then the same workflow warrant replayed"
echo "  8a BROKEN SPECIMEN (parse error => 'nonce unused'):"
noncecorrupt "NONCE_FAIL_OPEN=1" nr-broken
E=$(marker nr-broken-2 "$R1"); V=$([ "$E" -ge 1 ] && echo yes || echo no)
report "replayed warrant ALLOWed (the vulnerability)" "2nd_decision=$DEC2 marker=$E" "$V" "$V" "yes"
stopall
echo "  8b CURRENT FIXTURE (unreadable ledger fails CLOSED):"
noncecorrupt "" nr-fixed
E=$(marker nr-fixed-2 "$R1"); V=$([ "$E" -ge 1 ] && echo yes || echo no)
report "replay DENY, no second effect (a corrupt ledger now blocks all, by design)" "2nd_decision=$DEC2 marker=$E" "$V" "$V" "no"
stopall

echo "=================================================================="
echo " RESULT: $PASS passed, $FAIL failed"
echo " (BROKEN SPECIMENs are meant to show the vulnerability; CURRENT FIXTURE lines are the fix.)"
echo "=================================================================="
[ "$FAIL" -eq 0 ]
