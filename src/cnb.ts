/**
 * Minimal CNB OpenAPI client.
 *
 * Only the endpoints needed by the fire-and-forget flow are implemented:
 *   POST /{repo}/-/build/start          trigger a build
 *   GET  /{repo}/-/build/status/{sn}    build + pipeline + stage status
 *   GET  /{repo}/-/build/logs           build history
 *   GET  /{repo}/-/build/logs/stage/... one stage's log
 *   POST /{repo}/-/build/stop/{sn}      cancel
 *   POST /{repo}/-/pulls                open a pull request
 *
 * Docs: https://api.cnb.cool/swagger.json
 */

export class CnbApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "CnbApiError";
  }
}

export interface BuildResult {
  sn?: string;
  buildLogUrl?: string;
  message?: string;
  success?: boolean;
}

export interface StageInfo {
  id: string;
  name: string;
  status?: string;
  duration?: number;
  /** CNB returns stage logs as an array of lines, not one string. */
  content?: string | string[];
  error?: string;
}

export interface PipelineInfo {
  id: string;
  name?: string;
  status?: string;
  duration?: number;
  stages?: StageInfo[];
}

export interface BuildStatusResult {
  status?: string;
  pipelinesStatus?: Record<string, PipelineInfo>;
}

export interface BuildLogInfo {
  sn: string;
  status?: string;
  event?: string;
  sourceRef?: string;
  commitTitle?: string;
  title?: string;
  duration?: number;
  createTime?: string;
  buildLogUrl?: string;
  pipelineTotalCount?: number;
}

export interface StartBuildInput {
  branch?: string;
  sha?: string;
  tag?: string;
  event: string;
  title?: string;
  env?: Record<string, string>;
  /** Inline .cnb.yml content, when you do not want to commit one. */
  config?: string;
  /** "true" makes CNB wait for the build; omit for fire-and-forget. */
  sync?: string;
}

export interface CreatePullInput {
  title: string;
  body: string;
  head: string;
  base: string;
}

const ACCEPT = "application/vnd.cnb.api+json";

export function encodeRepoPath(repo: string): string {
  return repo
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export class CnbApi {
  private readonly base: string;

  /** Public base URL, for writing config into a scaffold. */
  get endpoint(): string {
    return this.base;
  }

  constructor(
    apiEndpoint: string,
    private readonly token: string,
    private readonly timeoutMs = 30_000,
  ) {
    this.base = apiEndpoint.replace(/\/+$/, "");
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: ACCEPT,
      Authorization: `Bearer ${this.token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    };

    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CnbApiError(`CNB API 不可达（${this.base}）: ${reason}`, 0);
    }

    const text = await response.text();
    let body: unknown;
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text.slice(0, 500);
      }
    }

    if (!response.ok) {
      throw new CnbApiError(explainError(response.status, body), response.status, body);
    }
    return body as T;
  }

  async createRepo(
    group: string,
    input: { name: string; visibility?: "private" | "public" | "secret"; description?: string },
  ): Promise<Record<string, unknown>> {
    return this.request(`/${encodeRepoPath(group)}/-/repos`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async startBuild(repo: string, input: StartBuildInput): Promise<BuildResult> {
    return this.request<BuildResult>(`/${encodeRepoPath(repo)}/-/build/start`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async getBuildStatus(repo: string, sn: string): Promise<BuildStatusResult> {
    return this.request<BuildStatusResult>(
      `/${encodeRepoPath(repo)}/-/build/status/${encodeURIComponent(sn)}`,
    );
  }

  async listBuilds(
    repo: string,
    params: { page?: number; pageSize?: number; status?: string; event?: string; title?: string } = {},
  ): Promise<{ data?: BuildLogInfo[]; total?: number }> {
    const search = new URLSearchParams();
    search.set("page", String(params.page ?? 1));
    search.set("page_size", String(params.pageSize ?? 10));
    if (params.status) search.set("status", params.status);
    if (params.event) search.set("event", params.event);
    if (params.title) search.set("title", params.title);
    return this.request(`/${encodeRepoPath(repo)}/-/build/logs?${search.toString()}`);
  }

  async getStage(repo: string, sn: string, pipelineId: string, stageId: string): Promise<StageInfo> {
    return this.request<StageInfo>(
      `/${encodeRepoPath(repo)}/-/build/logs/stage/${encodeURIComponent(sn)}/${encodeURIComponent(
        pipelineId,
      )}/${encodeURIComponent(stageId)}`,
    );
  }

  async stopBuild(repo: string, sn: string): Promise<BuildResult> {
    return this.request<BuildResult>(
      `/${encodeRepoPath(repo)}/-/build/stop/${encodeURIComponent(sn)}`,
      { method: "POST" },
    );
  }

  async createPull(repo: string, input: CreatePullInput): Promise<Record<string, unknown>> {
    return this.request(`/${encodeRepoPath(repo)}/-/pulls`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
}

function explainError(status: number, body: unknown): string {
  const detail =
    body && typeof body === "object"
      ? ((body as Record<string, unknown>).message ??
        (body as Record<string, unknown>).error ??
        JSON.stringify(body).slice(0, 300))
      : String(body ?? "");
  const hint =
    status === 401 || status === 403
      ? "（检查 CNB_TOKEN 是否有效，权限是否包含 repo-cnb-trigger:rw）"
      : status === 404
        ? "（检查 repo 路径、event 名是否与 .cnb.yml 一致）"
        : "";
  return `CNB API ${status}${hint}: ${detail}`;
}

export type NormalizedStatus = "pending" | "running" | "success" | "error" | "cancel";

export function normalizeStatus(status: string | undefined): NormalizedStatus {
  switch ((status ?? "").toLowerCase()) {
    case "success":
    case "passed":
      return "success";
    case "error":
    case "failed":
    case "failure":
      return "error";
    case "cancel":
    case "cancelled":
    case "canceled":
      return "cancel";
    case "running":
    case "in_progress":
      return "running";
    default:
      return "pending";
  }
}

export function isTerminal(status: NormalizedStatus): boolean {
  return status === "success" || status === "error" || status === "cancel";
}

export function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return "-";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}