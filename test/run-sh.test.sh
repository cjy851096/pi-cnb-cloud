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
  cp "$ROOT/templates/agent/notify.sh" "$dir/.cnb/agent/notify.sh"
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

# 4) notify.sh shapes payloads per provider.
DIR="$TMP/case4"
mkdir -p "$DIR/.cnb/agent"
cp "$ROOT/templates/agent/notify.sh" "$DIR/.cnb/agent/notify.sh"
PORT_FILE="$TMP/port"
node -e '
  const http = require("http"), fs = require("fs");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { fs.writeFileSync(process.argv[1], body); res.end("{}"); server.close(); });
  });
  server.listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[2], String(server.address().port)));
' "$TMP/notify-body.json" "$PORT_FILE" &
NODE_PID=$!
for _ in $(seq 1 50); do [ -s "$PORT_FILE" ] && break; sleep 0.05; done
PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
if [ -n "$PORT" ]; then
  AGENT_NOTIFY_WEBHOOK="http://127.0.0.1:$PORT/hook" bash "$DIR/.cnb/agent/notify.sh" "✅ done" >/dev/null 2>&1
  wait "$NODE_PID" 2>/dev/null
  grep -q '"text"' "$TMP/notify-body.json" 2>/dev/null && ok "notify.sh posts a generic JSON payload" || bad "notify payload missing" "$(cat "$TMP/notify-body.json" 2>/dev/null)"
else
  bad "notify test server did not start"
fi

# 5) happy path: push lands in a local bare repo, PR is opened via a mock API.
DIR="$TMP/case5"
make_repo "$DIR"
BARE="$TMP/bare5.git"
git init -q --bare "$BARE"
git -C "$DIR" config url."$BARE".insteadOf "https://cnb:tok@example.test/team/demo.git"

cat >"$FAKEBIN/pi" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = "--version" ] && { echo "fake-pi 0.0.0"; exit 0; }
echo "fixed" >> file.txt
touch .fixed
echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"all green: fixed the thing"}]}}'
exit 0
SH
chmod +x "$FAKEBIN/pi"

API_LOG="$TMP/pr-request.json"
PORT_FILE5="$TMP/port5"
node --input-type=module - "$API_LOG" "$PORT_FILE5" <<'JS' &
import http from "node:http";
import fs from "node:fs";
const [bodyOut, portOut] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    if (req.method === "POST" && req.url.endsWith("/-/pulls")) {
      fs.writeFileSync(bodyOut, JSON.stringify({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) }));
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ web_url: "https://cnb.example/team/demo/-/pulls/1" }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
    }
  });
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portOut, String(server.address().port)));
JS
API_PID=$!
for _ in $(seq 1 50); do [ -s "$PORT_FILE5" ] && break; sleep 0.05; done
API_PORT="$(cat "$PORT_FILE5" 2>/dev/null || true)"

OUT="$(FAKE_PI_COUNT="$TMP/count5" run_case "$DIR" \
  CNB_TOKEN=tok CNB_WEB_HOST=example.test \
  CNB_API_ENDPOINT="http://127.0.0.1:$API_PORT" \
  AGENT_TASK="make the tests green" AGENT_TEST_CMD="sh $FAKEBIN/testcmd.sh" AGENT_MAX_ITERATIONS=2)"

printf '%s\n' "$OUT" | grep -q "已推送分支" && ok "pushes the work branch" || bad "push failed" "$OUT"
BRANCHES="$(git -C "$BARE" for-each-ref --format='%(refname:short)' refs/heads)"
printf '%s\n' "$BRANCHES" | grep -q '^agent/' && ok "branch exists in the remote" || bad "branch missing in remote" "$BRANCHES"
printf '%s\n' "$OUT" | grep -q '"status":"success"' && ok "final status is success" || bad "final status wrong" "$OUT"
printf '%s\n' "$OUT" | grep -q 'https://cnb.example/team/demo/-/pulls/1' && ok "reports the PR URL" || bad "PR URL missing" "$OUT"
grep -q '"head":"agent/' "$API_LOG" 2>/dev/null && ok "PR request carries the work branch" || bad "PR request malformed" "$(cat "$API_LOG" 2>/dev/null)"
grep -q '"auth":"Bearer tok"' "$API_LOG" 2>/dev/null && ok "PR request is authenticated" || bad "PR auth header missing" "$(cat "$API_LOG" 2>/dev/null)"
kill "$API_PID" 2>/dev/null || true
wait "$API_PID" 2>/dev/null || true

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]