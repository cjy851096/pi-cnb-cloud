import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

export interface CnbCloudConfig {
  /** CNB API base URL, e.g. https://api.cnb.cool (SaaS) or your private deployment. */
  apiEndpoint: string;
  /** Pipeline event name declared in .cnb.yml. Must be api_trigger or start with api_trigger_. */
  event: string;
  /** Environment variable that holds the CNB access token. */
  tokenEnv: string;
  /** Optional token file; defaults to <agent dir>/cnb-token (chmod 600). */
  tokenFile?: string;
  /** Target repo slug ("group/repo"). Auto-detected from the git remote when omitted. */
  repo?: string;
  /** Branch to run on. Defaults to the current local branch. */
  branch?: string;
  /** Test command the cloud agent must make pass. Empty string disables the test loop. */
  testCommand?: string;
  /** How many pi passes the cloud runner may make (test failure → retry). */
  maxIterations: number;
  /** Local status polling interval, in milliseconds. */
  pollIntervalMs: number;
  /** Resume watching unfinished runs when a session starts. */
  autoWatch: boolean;
  /** Env var that holds an IM webhook URL (WeCom / Feishu / DingTalk / Slack / generic). */
  notifyWebhookEnv?: string;
  /** Prefix for generated build titles. */
  titlePrefix?: string;
  /** Agent image used by the generated .cnb.yml (plain image mode). */
  image?: string;
  /** Default organization for /cloud-new. */
  group?: string;
  /** Secret-repo file URL inserted as `imports:` in generated pipelines. */
  importsUrl?: string;
}

const DEFAULTS: CnbCloudConfig = {
  apiEndpoint: "https://api.cnb.cool",
  event: "api_trigger_agent",
  tokenEnv: "CNB_TOKEN",
  maxIterations: 2,
  pollIntervalMs: 20_000,
  autoWatch: true,
  titlePrefix: "pi: ",
};

export const CONFIG_FILE_NAME = "cnb-cloud.json";

export function globalConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", CONFIG_FILE_NAME);
}

function readJsonIfExists(path: string): Partial<CnbCloudConfig> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Partial<CnbCloudConfig>;
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface LoadConfigOptions {
  /** When false, the project-local .pi/cnb-cloud.json is ignored. */
  includeProject?: boolean;
}

export function loadConfig(cwd: string, options: LoadConfigOptions = {}): CnbCloudConfig {
  const merged: CnbCloudConfig = {
    ...DEFAULTS,
    ...readJsonIfExists(globalConfigPath()),
    ...(options.includeProject === false ? {} : readJsonIfExists(projectConfigPath(cwd))),
  };

  const env = process.env;
  if (env.CNB_API_ENDPOINT) merged.apiEndpoint = env.CNB_API_ENDPOINT;
  if (env.CNB_CLOUD_EVENT) merged.event = env.CNB_CLOUD_EVENT;
  if (env.CNB_CLOUD_REPO) merged.repo = env.CNB_CLOUD_REPO;
  if (env.CNB_CLOUD_BRANCH) merged.branch = env.CNB_CLOUD_BRANCH;
  if (env.CNB_CLOUD_TEST_CMD) merged.testCommand = env.CNB_CLOUD_TEST_CMD;
  if (env.CNB_CLOUD_IMAGE) merged.image = env.CNB_CLOUD_IMAGE;
  if (env.CNB_CLOUD_GROUP) merged.group = env.CNB_CLOUD_GROUP;

  merged.apiEndpoint = merged.apiEndpoint.replace(/\/+$/, "");
  return merged;
}

export function tokenFilePath(config: CnbCloudConfig): string {
  return config.tokenFile ?? join(getAgentDir(), "cnb-token");
}

/** Env var wins over the token file, so CI can override a laptop setup. */
export function resolveToken(config: CnbCloudConfig): string | undefined {
  const candidates = [config.tokenEnv, "CNB_TOKEN", "CNB_ACCESS_TOKEN"];
  for (const name of candidates) {
    if (!name) continue;
    const value = process.env[name];
    if (value) return value;
  }

  const path = tokenFilePath(config);
  try {
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    }
  } catch {
    // Unreadable token file is treated as "no token".
  }
  return undefined;
}

export interface RepoInfo {
  /** group/repo (no .git suffix). */
  slug: string;
  host: string;
  webProtocol: string;
}

/** Accepts https://host/group/repo.git, git@host:group/repo.git, ssh://git@host/group/repo.git. */
export function parseRepoUrl(remote: string): RepoInfo | undefined {
  const value = remote.trim();
  if (!value) return undefined;

  let host = "";
  let path = "";
  let webProtocol = "https";

  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
  if (!value.includes("://") && scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const url = new URL(value);
      host = url.hostname;
      path = url.pathname.replace(/^\/+/, "");
      webProtocol = url.protocol === "http:" ? "http" : "https";
    } catch {
      return undefined;
    }
  }

  const slug = path.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!host || !slug || !slug.includes("/")) return undefined;
  return { slug, host, webProtocol };
}

export interface RepoContext {
  repo: RepoInfo;
  branch: string;
  remoteUrl: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { timeout: 10_000 });
  return stdout.trim();
}

export async function resolveRepoContext(cwd: string, explicitRepo?: string): Promise<RepoContext> {
  let remoteUrl = "";
  try {
    remoteUrl = await git(cwd, ["remote", "get-url", "origin"]);
  } catch {
    // Not a git repo, or no origin — explicit config may still make this work.
  }

  const parsed = parseRepoUrl(remoteUrl);
  const repo: RepoInfo = explicitRepo
    ? {
        slug: explicitRepo.replace(/^\/+|\/+$/g, "").replace(/\.git$/, ""),
        host: parsed?.host ?? "cnb.cool",
        webProtocol: parsed?.webProtocol ?? "https",
      }
    : parsed ?? { slug: "", host: "cnb.cool", webProtocol: "https" };

  if (!repo.slug) {
    throw new Error(
      "无法确定仓库：origin 不是可识别的 git URL。请用 --repo group/repo 指定，或在 .pi/cnb-cloud.json 写 repo。",
    );
  }

  let branch = "";
  try {
    branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    // ignore
  }
  if (!branch || branch === "HEAD") branch = "main";

  return { repo, branch, remoteUrl };
}

export function buildWebUrl(repo: RepoInfo, sn?: string): string {
  const base = `${repo.webProtocol}://${repo.host}/${repo.slug}`;
  return sn ? `${base}/-/build/${sn}` : base;
}