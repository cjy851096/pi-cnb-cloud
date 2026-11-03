/**
 * CNB client + result-marker checks against a local mock server.
 *   node --experimental-transform-types test/api.test.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { CnbApi, CnbApiError } from "../src/cnb.ts";
import { parseRunResult, RESULT_MARKER } from "../src/result.ts";

let passed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed++;
    console.log(`✓ ${name}`);
  });
}

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const requests: Recorded[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });

    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.url === "/team/demo/-/build/start") {
      return send(200, { success: true, sn: "cnb-1", buildLogUrl: "https://cnb.cool/team/demo/-/build/cnb-1" });
    }
    if (req.url === "/team/demo/-/build/status/cnb-1") {
      return send(200, {
        status: "success",
        pipelinesStatus: {
          "pipeline-0": {
            name: "pi-cloud-agent",
            status: "success",
            duration: 1000,
            stages: [{ id: "s1", name: "pi cloud agent", status: "success", duration: 900 }],
          },
        },
      });
    }
    if (req.url === "/team/demo/-/build/logs/stage/cnb-1/pipeline-0/s1") {
      return send(200, {
        id: "s1",
        name: "pi cloud agent",
        status: "success",
        // Real CNB responses use an array of log lines.
        content: [
          "noise",
          RESULT_MARKER,
          '{"status":"success","branch":"agent/x","pr":"https://p/1","tests":"passed","summary":"ok"}',
          "",
        ],
      });
    }
    if (req.url === "/team/demo/-/build/stop/cnb-1") {
      return send(200, { success: true, sn: "cnb-1" });
    }
    if (req.url === "/team/demo/-/pulls") {
      return send(201, { web_url: "https://cnb.cool/team/demo/-/pulls/1" });
    }
    if (req.url === "/forbidden/-/build/start") {
      return send(403, { message: "permission denied" });
    }
    return send(404, { message: "not found" });
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no port");
const base = `http://127.0.0.1:${address.port}`;
const api = new CnbApi(base, "tok");

try {
  await test("startBuild posts the event, branch and env", async () => {
    const result = await api.startBuild("team/demo", {
      event: "api_trigger_agent",
      branch: "main",
      title: "pi: fix tests",
      env: { AGENT_TASK: "fix tests", AGENT_TITLE: "pi: fix tests" },
    });
    assert.equal(result.success, true);
    assert.equal(result.sn, "cnb-1");

    const request = requests.find((item) => item.url === "/team/demo/-/build/start");
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer tok");
    assert.equal(request.headers.accept, "application/vnd.cnb.api+json");
    assert.deepEqual(JSON.parse(request.body), {
      event: "api_trigger_agent",
      branch: "main",
      title: "pi: fix tests",
      env: { AGENT_TASK: "fix tests", AGENT_TITLE: "pi: fix tests" },
    });
  });

  await test("getBuildStatus returns pipelines and stages", async () => {
    const status = await api.getBuildStatus("team/demo", "cnb-1");
    assert.equal(status.status, "success");
    assert.equal(status.pipelinesStatus?.["pipeline-0"]?.stages?.[0]?.name, "pi cloud agent");
  });

  await test("getStage returns stage content", async () => {
    const stage = await api.getStage("team/demo", "cnb-1", "pipeline-0", "s1");
    const content = Array.isArray(stage.content) ? stage.content.join("\n") : (stage.content ?? "");
    assert.match(content, /PI-CNB-RESULT/);
  });

  await test("stopBuild posts to the stop endpoint", async () => {
    await api.stopBuild("team/demo", "cnb-1");
    assert.ok(requests.some((item) => item.url === "/team/demo/-/build/stop/cnb-1" && item.method === "POST"));
  });

  await test("createPull sends head/base/title/body", async () => {
    const pull = await api.createPull("team/demo", {
      title: "agent: fix",
      body: "body",
      head: "agent/x",
      base: "main",
    });
    assert.equal(pull.web_url, "https://cnb.cool/team/demo/-/pulls/1");
    const request = requests.find((item) => item.url === "/team/demo/-/pulls");
    assert.deepEqual(JSON.parse(request!.body), {
      title: "agent: fix",
      body: "body",
      head: "agent/x",
      base: "main",
    });
  });

  await test("HTTP errors become CnbApiError with a permission hint", async () => {
    await assert.rejects(
      () => api.startBuild("forbidden", { event: "api_trigger_agent" }),
      (error: unknown) => {
        assert.ok(error instanceof CnbApiError);
        assert.equal(error.status, 403);
        assert.match(error.message, /CNB_TOKEN/);
        return true;
      },
    );
  });

  await test("parseRunResult reads the last marker", () => {
    const log = [
      "some log",
      RESULT_MARKER,
      '{"status":"error","tests":"failed"}',
      "trailing",
      RESULT_MARKER,
      '{"status":"success","branch":"agent/y","pr":"https://p/2","summary":"green"}',
    ].join("\n");
    const result = parseRunResult(log);
    assert.equal(result?.status, "success");
    assert.equal(result?.branch, "agent/y");
    assert.equal(result?.pr, "https://p/2");
  });

  await test("parseRunResult ignores logs without a marker", () => {
    assert.equal(parseRunResult("plain output"), undefined);
    assert.equal(parseRunResult(`${RESULT_MARKER}\nnot json`), undefined);
  });
} finally {
  server.close();
}

console.log(`\n${passed} checks passed`);