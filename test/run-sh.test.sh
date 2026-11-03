#!/usr/bin/env bash
# Exercise templates/agent/run.sh end-to-end with a fake pi and a fake test
# command. No network and no CNB account required.
#
#   bash test/run-sh.test.sh

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$ROOT/templates/agent/run.sh"
TMP="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf '✓ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '✗ %s\n' "$1"; [ -n "${2:-}" ] && printf '   %s\n' "$2"; }

make_repo() { # make_repo <dir>
  local dir="$1"
  local fakebin="$TMP/bin-$RANDOM"
  mkdir -p "$dir/.cnb/agent" "$fakebin"
  cp "$RUNNER" "$dir/.cnb/agent/run.sh"
  chmod +x "$dir/.cnb/agent/"*.sh
  FAKEBIN="$fakebin"

  git -C "$dir" init -q
  git -C "$dir" config user.email test@example.com
  git -C "$dir" config user.name test
  echo "base" >"$dir/file.txt"
  git -C "$dir" add -A
  git -C "$dir" commit -qm init

  cat >"$fakebin/testcmd.sh" <<'SH'
#!/bin/sh
[ -f .fixed ] && exit 0
exit 1
SH
  chmod +x "$fakebin/testcmd.sh"

  # Fake pi: first pass creates a file + reports a summary, second pass fixes.
  cat >"$fakebin/pi" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = "--version" ] && { echo "fake-pi 0.0.0"; exit 0; }
COUNT_FILE="${FAKE_PI_COUNT:?}"
count=0
[ -f "$COUNT_FILE" ] && count="$(cat "$COUNT_FILE")"
count=$((count + 1))
printf '%s' "$count" >"$COUNT_FILE"
if [ "$count" = "1" ]; then
  echo "changed by fake pi" >> file.txt
else
  touch .fixed
fi
echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"fake summary: did the thing"}]}}'
exit 0
SH
  chmod +x "$fakebin/pi"
}

run_case() { # run_case <dir> [env assignments...]
  local dir="$1"
  shift
  ( cd "$dir" && env -u CNB_TOKEN -u AGENT_TEST_CMD -u AGENT_MODEL PATH="$FAKEBIN:$PATH" \
      CNB_BUILD_WORKSPACE="$dir" CNB_BRANCH=main CNB_REPO_SLUG=team/demo \
      CNB_WEB_HOST=cnb.cool CNB_WEB_PROTOCOL=https CNB_BUILD_ID=cnb-test \
      CNB_API_ENDPOINT=https://api.cnb.build "$@" bash .cnb/agent/run.sh 2>&1 )
}

# 1) self-heal loop: first test fails, second passes, push fails on missing token.
DIR="$TMP/case1"
make_repo "$DIR"
OUT="$(FAKE_PI_COUNT="$TMP/count1" run_case "$DIR" AGENT_TASK="fix the tests" AGENT_TEST_CMD="sh $FAKEBIN/testcmd.sh" AGENT_MAX_ITERATIONS=2)"
printf '%s\n' "$OUT" | grep -q "第 1/2 轮" && ok "runs the first agent pass" || bad "first pass missing" "$OUT"
printf '%s\n' "$OUT" | grep -q "测试未通过" && ok "detects failing test" || bad "failing test not detected" "$OUT"
printf '%s\n' "$OUT" | grep -q "第 2/2 轮" && ok "retries after failure" || bad "retry missing" "$OUT"
printf '%s\n' "$OUT" | grep -q "缺少 CNB_TOKEN" && ok "stops before push without a token" || bad "missing push guard" "$OUT"
printf '%s\n' "$OUT" | grep -q "===PI-CNB-RESULT===" && ok "prints the result marker" || bad "no result marker" "$OUT"
printf '%s\n' "$OUT" | grep -q '"tests":"passed"' && ok "reports tests passed after self-heal" || bad "wrong test result" "$OUT"
printf '%s\n' "$OUT" | grep -q '"summary":"fake summary' && ok "captures the last assistant message" || bad "summary missing" "$OUT"

# 2) no diff -> success without pushing.
DIR="$TMP/case2"
make_repo "$DIR"
cat >"$FAKEBIN/pi" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = "--version" ] && { echo "fake-pi 0.0.0"; exit 0; }
echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"nothing to change"}]}}'
exit 0
SH
chmod +x "$FAKEBIN/pi"
OUT="$(run_case "$DIR" AGENT_TASK="look around" AGENT_TEST_CMD="")"
printf '%s\n' "$OUT" | grep -q "没有代码变更" && ok "detects an empty diff" || bad "empty diff not detected" "$OUT"
printf '%s\n' "$OUT" | grep -q '"status":"success"' && ok "reports no-op as success" || bad "no-op status wrong" "$OUT"

# 3) missing AGENT_TASK fails fast.
DIR="$TMP/case3"
make_repo "$DIR"
OUT="$(run_case "$DIR")"
printf '%s\n' "$OUT" | grep -q "AGENT_TASK 为空" && ok "rejects an empty task" || bad "empty task not rejected" "$OUT"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]