import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { NormalizedStatus } from "./cnb.ts";

export interface CloudRun {
  sn: string;
  repo: string;
  /** Branch the build ran on. */
  branch: string;
  prompt: string;
  title?: string;
  url?: string;
  createdAt: string;
  status: NormalizedStatus;
  finishedAt?: string;
  /** Branch the cloud agent pushed, once known. */
  workBranch?: string;
  prUrl?: string;
  summary?: string;
  testStatus?: string;
  lastError?: string;
}

interface RunFile {
  version: 1;
  runs: CloudRun[];
}

const MAX_RUNS = 100;

export function runStorePath(): string {
  return join(getAgentDir(), "cnb-cloud", "runs.json");
}

export class RunStore {
  private runs: CloudRun[] = [];

  constructor(private readonly path: string = runStorePath()) {}

  load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<RunFile>;
      this.runs = Array.isArray(parsed.runs) ? parsed.runs.filter(isRun) : [];
    } catch {
      this.runs = [];
    }
  }

  list(limit = 10): CloudRun[] {
    return [...this.runs]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);
  }

  get(sn: string): CloudRun | undefined {
    return this.runs.find((run) => run.sn === sn);
  }

  latest(): CloudRun | undefined {
    return this.list(1)[0];
  }

  unfinished(): CloudRun[] {
    return this.runs.filter((run) => run.status === "pending" || run.status === "running");
  }

  upsert(run: CloudRun): CloudRun {
    const index = this.runs.findIndex((item) => item.sn === run.sn);
    if (index >= 0) {
      this.runs[index] = { ...this.runs[index], ...run };
    } else {
      this.runs.push(run);
    }
    this.runs = this.list(MAX_RUNS);
    this.persist();
    return this.get(run.sn)!;
  }

  /** Merge a patch without changing the stored object's identity. */
  patch(sn: string, patch: Partial<CloudRun>): CloudRun | undefined {
    const run = this.get(sn);
    if (!run) return undefined;
    Object.assign(run, patch);
    this.persist();
    return run;
  }

  /** Synchronous on purpose: fire-and-forget means pi may exit right after. */
  private persist(): void {
    const payload: RunFile = { version: 1, runs: this.runs.slice(0, MAX_RUNS) };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

function isRun(value: unknown): value is CloudRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Record<string, unknown>;
  return typeof run.sn === "string" && typeof run.repo === "string" && typeof run.createdAt === "string";
}