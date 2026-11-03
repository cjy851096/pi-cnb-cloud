/**
 * RPC smoke test: loads the real extension in a pi subprocess, drives the
 * slash commands, and checks the HTTP calls it makes against a mock CNB API.
 *
 *   node --experimental-transform-types test/rpc-smoke.test.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI_BIN = process.env.PI_BIN ?? "pi";
const EXTENSION = new URL("../src/index.ts", import.meta.url).pathname;

interface Recorded {
  method: string;
  url: string;
  body: string;
}

const requests: Recorded[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", body });
    const send = (payload: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.url === "/team/demo/-/build/start") {
      return send({ success: true, sn: "cnb-smoke", buildLogUrl: "https://cnb.cool/team/demo/-/build/cnb-smoke" });
    }
    if (req.url === "/team/demo/-/build/status/cnb-smoke") {
      return send({
        status: "running",
        pipelinesStatus: {
          "pipeline-0": {
            name: "pi-cloud-agent",
            status: "running",
            duration: 1000,
            stages: [{ id: "s1", name: "pi cloud agent", status: "running" }],
          },
        },
      });
    }
    return send({ message: "not found" });
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no port");
const apiBase = `http://127.0.0.1:${address.port}`;

// --- fixtures ---------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "pi-cnb-rpc-"));
const repo = join(root, "repo");
const agentDir = join(root, "agent");
mkdirSync(repo, { recursive: true });
mkdirSync(join(repo, ".pi"), { recursive: true });
mkdirSync(agentDir, { recursive: true });

execFileSync("git", ["init", "-q"], { cwd: repo });
execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
writeFileSync(join(repo, "README.md"), "demo\n");
execFileSync("git", ["add", "-A"], { cwd: repo });
execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
execFileSync("git", ["remote", "add", "origin", "https://cnb.cool/team/demo.git"], { cwd: repo });

writeFileSync(
  join(repo, ".pi/cnb-cloud.json"),
  JSON.stringify({
    apiEndpoint: apiBase,
    event: "api_trigger_agent",
    testCommand: "npm test",
    maxIterations: 2,
    pollIntervalMs: 500,
    autoWatch: false,
  }),
);

// --- pi RPC process ---------------------------------------------------------
const child = spawn(PI_BIN, ["--mode", "rpc", "--no-session", "-e", EXTENSION], {
  cwd: repo,
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    CNB_TOKEN: "tok",
    CNB_API_ENDPOINT: "",
    CNB_CLOUD_REPO: "",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => (stderr += String(chunk)));

const pending = new Map<string, (record: Record<string, unknown>) => void>();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += String(chunk);
  let index: number;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type === "response" && typeof record.id === "string") {
      pending.get(record.id)?.(record);
      pending.delete(record.id);
    }
  }
});

let nextId = 0;
function send(command: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const id = `req-${++nextId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${JSON.stringify(command)}`));
    }, timeoutMs);
    pending.set(id, (record) => {
      clearTimeout(timer);
      resolve(record);
    });
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  });
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for ${label}\nstderr:\n${stderr}`);
}

let passed = 0;
try {
  await waitFor("startup", () => child.pid !== undefined);

  const dispatch = await send({ type: "prompt", message: "/cloud 补齐支付模块单测 --test 'npm test'" });
  assert.equal(dispatch.success, true, `dispatch failed: ${JSON.stringify(dispatch)}`);
  await waitFor("build start request", () => requests.some((r) => r.url === "/team/demo/-/build/start"));

  const start = requests.find((r) => r.url === "/team/demo/-/build/start")!;
  const startBody = JSON.parse(start.body) as {
    event: string;
    branch: string;
    title: string;
    env: Record<string, string>;
  };
  assert.equal(startBody.event, "api_trigger_agent");
  assert.equal(startBody.branch, "master");
  assert.equal(startBody.env.AGENT_TASK, "补齐支付模块单测");
  assert.equal(startBody.env.AGENT_TEST_CMD, "npm test");
  console.log("✓ /cloud triggers a build with the prompt in env");

  const status = await send({ type: "prompt", message: "/cloud-status cnb-smoke" });
  assert.equal(status.success, true);
  await waitFor("status request", () => requests.some((r) => r.url === "/team/demo/-/build/status/cnb-smoke"));
  console.log("✓ /cloud-status queries the build");

  const setup = await send({ type: "prompt", message: "/cloud-setup --test 'npm run test'" });
  assert.equal(setup.success, true);
  await waitFor("scaffold files", () => existsSync(join(repo, ".cnb.yml")) && existsSync(join(repo, ".cnb/agent/run.sh")));
  const yaml = readFileSync(join(repo, ".cnb.yml"), "utf8");
  assert.match(yaml, /api_trigger_agent/);
  assert.match(yaml, /bash \.cnb\/agent\/run\.sh/);
  console.log("✓ /cloud-setup writes the pipeline scaffold");

  const config = await send({ type: "prompt", message: "/cloud-config" });
  assert.equal(config.success, true, `config failed: ${JSON.stringify(config)}`);
  console.log("✓ /cloud-config resolves the project config");

  const runsJson = join(agentDir, "cnb-cloud", "runs.json");
  await waitFor("run store", () => existsSync(runsJson));
  const stored = JSON.parse(readFileSync(runsJson, "utf8")) as { runs: Array<{ sn: string; repo: string }> };
  assert.equal(stored.runs[0]?.sn, "cnb-smoke");
  assert.equal(stored.runs[0]?.repo, "team/demo");
  console.log("✓ run history is persisted outside the session");

  passed = 6;
} finally {
  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(undefined);
    }, 5_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
  server.close();
}

console.log(`\n${passed} checks passed`);