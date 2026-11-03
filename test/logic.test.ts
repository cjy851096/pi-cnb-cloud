/**
 * Plain-node checks for the pure logic. Run with:
 *   node --experimental-strip-types test/logic.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, tokenize } from "../src/args.ts";
import { parseRepoUrl } from "../src/config.ts";
import { RunStore } from "../src/runs.ts";
import { buildCnbYml, writeScaffold } from "../src/templates.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

test("tokenize keeps quoted text together", () => {
  assert.deepEqual(tokenize(`fix "payment flow" --branch main`), ["fix", "payment flow", "--branch", "main"]);
  assert.deepEqual(tokenize(`--test 'npm run test -- --watch=false'`), ["--test", "npm run test -- --watch=false"]);
});

test("parseArgs separates flags from the prompt", () => {
  const parsed = parseArgs(`--repo team/api --branch=dev "补齐支付单测" --test 'npm test'`, {
    valueFlags: ["repo", "branch", "test"],
  });
  assert.equal(parsed.flags.repo, "team/api");
  assert.equal(parsed.flags.branch, "dev");
  assert.equal(parsed.flags.test, "npm test");
  assert.equal(parsed.rest, "补齐支付单测");
});

test("parseArgs treats an unknown --flag as boolean", () => {
  const parsed = parseArgs(`--all`, { booleanFlags: ["all"] });
  assert.equal(parsed.flags.all, true);
  assert.equal(parsed.rest, "");
});

test("parseRepoUrl handles https, scp and ssh remotes", () => {
  assert.deepEqual(parseRepoUrl("https://cnb.cool/team/api.git"), {
    slug: "team/api",
    host: "cnb.cool",
    webProtocol: "https",
  });
  assert.equal(parseRepoUrl("git@cnb.cool:team/sub/api.git")?.slug, "team/sub/api");
  assert.equal(parseRepoUrl("ssh://git@cnb.cool/team/api.git")?.slug, "team/api");
  assert.equal(parseRepoUrl("not a url"), undefined);
});

test("buildCnbYml uses the configured event and docker.build", () => {
  const yaml = buildCnbYml({ event: "api_trigger_agent" });
  assert.match(yaml, /^\$:/m);
  assert.match(yaml, /api_trigger_agent:/);
  assert.match(yaml, /\.cnb\/agent\/Dockerfile/);
  assert.match(yaml, /bash \.cnb\/agent\/run\.sh/);
});

test("buildCnbYml supports a plain image and keeps npm cache", () => {
  const yaml = buildCnbYml({ event: "api_trigger_custom", image: "node:22-bookworm" });
  assert.match(yaml, /image: node:22-bookworm/);
  assert.match(yaml, /\/root\/\.npm/);
  assert.doesNotMatch(yaml, /dockerfile/);
});

test("writeScaffold writes files and refuses to clobber user files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cnb-cloud-"));
  const first = writeScaffold(dir, { event: "api_trigger_agent", testCommand: "npm test" });
  assert.ok(first.written.includes(".cnb.yml"));
  assert.ok(existsSync(join(dir, ".cnb/agent/run.sh")));
  assert.ok(existsSync(join(dir, ".cnb/agent/Dockerfile")));
  assert.ok(existsSync(join(dir, ".pi/cnb-cloud.json")));

  // A user-edited .cnb.yml must survive a second run without --force.
  const cnbPath = join(dir, ".cnb.yml");
  const userContent = "# my custom pipeline\n";
  writeFileSync(cnbPath, userContent);
  const second = writeScaffold(dir, { event: "api_trigger_agent" });
  assert.ok(second.skipped.includes(".cnb.yml"));
  assert.equal(readFileSync(cnbPath, "utf8"), userContent);
});

test("RunStore survives reload and patches runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cnb-store-"));
  const path = join(dir, "runs.json");
  const store = new RunStore(path);
  store.load();
  store.upsert({
    sn: "cnb-1",
    repo: "team/api",
    branch: "main",
    prompt: "fix tests",
    createdAt: new Date().toISOString(),
    status: "pending",
  });
  store.patch("cnb-1", { status: "success", prUrl: "https://cnb.cool/team/api/-/pulls/1" });

  const reloaded = new RunStore(path);
  reloaded.load();
  assert.equal(reloaded.get("cnb-1")?.status, "success");
  assert.equal(reloaded.get("cnb-1")?.prUrl, "https://cnb.cool/team/api/-/pulls/1");
  assert.equal(reloaded.unfinished().length, 0);
});

console.log(`\n${passed} checks passed`);