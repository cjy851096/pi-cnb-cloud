import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CnbApi } from "./cnb.ts";
import { buildCnbYml, readTemplate, GENERATED_MARKER } from "./templates.ts";

const execFileAsync = promisify(execFile);

export interface ProvisionOptions {
  api: CnbApi;
  token: string;
  /** Organization / group path, e.g. "Project-2025-2025". */
  group: string;
  /** Repo name only, e.g. "demo-login". */
  name: string;
  visibility?: "private" | "public";
  event: string;
  /** Prebuilt agent image. When omitted the scaffold builds .cnb/agent/Dockerfile. */
  image?: string;
  /** Secret-repo file URL rendered as `imports:`. */
  importsUrl?: string;
  testCommand?: string;
  maxIterations?: number;
  /** Git host used for the push URL, e.g. cnb.cool. */
  host?: string;
  webProtocol?: string;
}

export interface ProvisionResult {
  repo: string;
  branch: string;
  url: string;
  files: string[];
}

/** Retry a push: a freshly created CNB repo can reject the first few attempts. */
async function pushWithRetry(cwd: string, url: string, attempts = 6): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await execFileAsync("git", ["push", "-q", url, "HEAD:refs/heads/main"], { cwd, timeout: 60_000 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw new Error(
    `无法推送脚手架到新仓库（已重试 ${attempts} 次）：${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Create a CNB repo and seed it with just enough config for the cloud agent to
 * run: .cnb.yml, .cnb/agent/run.sh, .pi/cnb-cloud.json.
 * There is no "create commit" API, so the seed is pushed over git.
 */
export async function provisionRepo(options: ProvisionOptions): Promise<ProvisionResult> {
  const { api, token, group, name } = options;
  const repo = `${group.replace(/^\/+|\/+$/g, "")}/${name}`;
  const host = options.host ?? "cnb.cool";
  const protocol = options.webProtocol ?? "https";

  await api.createRepo(group, {
    name,
    visibility: options.visibility ?? "private",
    description: "cloud agent bootstrap",
  });

  const dir = mkdtempSync(join(tmpdir(), "pi-cnb-scaffold-"));
  const files = [
    ".cnb.yml",
    ".cnb/agent/run.sh",
    ".pi/cnb-cloud.json",
    ".gitignore",
  ];

  try {
    mkdirSync(join(dir, ".cnb/agent"), { recursive: true });
    mkdirSync(join(dir, ".pi"), { recursive: true });

    writeFileSync(
      join(dir, ".cnb.yml"),
      buildCnbYml({
        event: options.event,
        image: options.image,
        imports: options.importsUrl,
      }),
      "utf8",
    );
    writeFileSync(join(dir, ".cnb/agent/run.sh"), readTemplate("agent/run.sh"), "utf8");
    chmodSync(join(dir, ".cnb/agent/run.sh"), 0o755);
    writeFileSync(
      join(dir, ".pi/cnb-cloud.json"),
      `${JSON.stringify(
        {
          apiEndpoint: api.endpoint,
          event: options.event,
          testCommand: options.testCommand ?? "",
          maxIterations: options.maxIterations ?? 2,
          pollIntervalMs: 15000,
          autoWatch: true,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ntarget/\ndist/\n*.log\n", "utf8");

    const git = (args: string[]) => execFileAsync("git", ["-c", "user.name=pi-cloud-agent", "-c", "user.email=pi-cloud-agent@cnb.cool", ...args], { cwd: dir, timeout: 30_000 });
    await git(["init", "-q", "-b", "main"]);
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", `chore: ${GENERATED_MARKER} scaffold`]);

    const pushUrl = `${protocol}://cnb:${token}@${host}/${repo}.git`;
    await pushWithRetry(dir, pushUrl);

    return {
      repo,
      branch: "main",
      url: `${protocol}://${host}/${repo}`,
      files,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}