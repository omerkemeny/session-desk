#!/usr/bin/env bash
# Runs every automated check in the tree, prints one line per suite, exits non-zero when any suite fails.
# Usage: tools/check.sh [--fast]   (CHROME=/path/to/chrome overrides the browser used by the smoke tests; JOBS=N sets the Python workers, PYTHON=path the interpreter)
# --fast skips the slow Python suites (feed churn, crash, two servers, descriptor budget) for use while iterating; the default runs everything.
# The Python modules run in parallel processes (tools/run_tests.py); the node and smoke suites run beside them when the machine has the cores.
cd "$(dirname "$0")/.." || exit 2
FAST=0
[ "${1:-}" = "--fast" ] && FAST=1
LOGS=$(mktemp -d "${TMPDIR:-/tmp}/desk-check.XXXXXX")
trap '[ "$FAILED" = 0 ] && rm -rf "$LOGS"' EXIT  # logs and screenshots stay only when something failed
FAILED=0
PY=${PYTHON:-python3}  # PYTHON=/usr/bin/python3 runs the Python suite on another interpreter
CORES=$("$PY" -c 'import os; print(os.cpu_count() or 1)')
BESIDE=0
[ "$CORES" -ge 6 ] && BESIDE=1  # node and smoke suites run beside the Python suite only with cores to spare

# Run one suite quietly: its PASS/FAIL report goes to <slug>.out and its exit code to <slug>.rc, printed later in a fixed order.
run() {
  local name=$1; shift
  local slug log out t0=$SECONDS
  slug=$(echo "$name" | tr -c 'a-zA-Z0-9' _)
  log="$LOGS/$slug.log"; out="$LOGS/$slug.out"
  if "$@" >"$log" 2>&1; then
    printf 'PASS  %-22s (%ss)\n' "$name" $((SECONDS - t0)) >"$out"
    echo 0 >"$LOGS/$slug.rc"
  else
    {
      printf 'FAIL  %-22s (%ss)\n' "$name" $((SECONDS - t0))
      local names
      names=$(grep -E '^(FAIL|ERROR): |^not ok ' "$log" | head -n 40)  # unittest and node test names
      [ -n "$names" ] && { echo "      failing tests:"; echo "$names" | sed 's/^/        /'; }
      tail -n 25 "$log" | sed 's/^/      /'
    } >"$out"
    echo 1 >"$LOGS/$slug.rc"
  fi
}

# Same browser lookup as the smoke tests, plus common Linux names; exported so the smoke tests use it.
find_chrome() {
  local c
  for c in "${CHROME:-}" "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return; }
  done
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    command -v "$c" && return
  done
}

# The node unit tests, then both smoke suites side by side.
node_suites() {
  run "node unit tests" node --test web/tests/
  if [ -z "$CHROME" ]; then
    echo "SKIP  smoke tests           (Chrome not found; set CHROME=/path/to/chrome)" >"$LOGS/smoke_skip.out"
    return
  fi
  run "smoke (demo page)" node tools/smoke.mjs --shots "$LOGS/shots" &
  [ -f tools/smoke_real.mjs ] && run "smoke (real server)" node tools/smoke_real.mjs
  wait
}

T0=$SECONDS
PYFLAGS=()
[ "$FAST" = 1 ] && PYFLAGS+=(--fast)
[ -n "${JOBS:-}" ] && PYFLAGS+=(--jobs "$JOBS")
NODE=0
command -v node >/dev/null 2>&1 && NODE=1
[ "$NODE" = 1 ] && { CHROME=$(find_chrome); export CHROME; }
if [ "$NODE" = 1 ] && [ "$BESIDE" = 1 ]; then
  node_suites &
  run "python unit tests" "$PY" tools/run_tests.py --reserve 3 "${PYFLAGS[@]}"
  wait
else
  run "python unit tests" "$PY" tools/run_tests.py "${PYFLAGS[@]}"
  [ "$NODE" = 1 ] && node_suites
fi

# Report in a fixed order, whatever order the suites finished in.
for slug in python_unit_tests_ node_unit_tests_ smoke_skip smoke__demo_page__ smoke__real_server__; do
  [ -f "$LOGS/$slug.out" ] || continue
  cat "$LOGS/$slug.out"
  if [ "$slug" = python_unit_tests_ ]; then
    [ "$FAST" = 1 ] && echo "      skipped: $("$PY" tools/run_tests.py --list-slow)"
    grep -q '^OK' "$LOGS/$slug.log" && sed -n '/^Slowest test durations/,/^$/p' "$LOGS/$slug.log" | sed 's/^/      /'
  fi
  [ "$(cat "$LOGS/$slug.rc" 2>/dev/null || echo 0)" = 0 ] || FAILED=1
done
[ "$NODE" = 1 ] || echo "SKIP  node suites           (node not found)"

[ "$FAILED" = 0 ] && echo "ALL PASSED in $((SECONDS - T0))s" || echo "SOME CHECKS FAILED after $((SECONDS - T0))s (logs and screenshots in $LOGS)"
exit "$FAILED"
