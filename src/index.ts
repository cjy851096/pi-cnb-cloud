/**
 * pi-cnb-cloud — fire-and-forget coding agent on Tencent CNB.
 *
 * Local side (this extension):
 *   /cloud <prompt>     trigger a CNB build with the prompt as env, then return
 *   /cloud-status       inspect a run
 *   /cloud-logs         pull the agent log out of the build
 *   /cloud-runs         local run history
 *   /cloud-cancel       stop a build
 *   /cloud-setup        write .cnb.yml + .cnb/agent/* into the current repo
 *
 * Cloud side: .cnb/agent/run.sh runs pi headless, self-heals against the test
 * command, pushes a branch, opens a PR and posts an IM notification.
 */

import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { numberFlag, parseArgs, stringFlag } from "./args.ts";
import {
  buildWebUrl,
  loadConfig,
  projectConfigPath,
  resolveRepoContext,
  resolveToken,
  type CnbCloudConfig,
} from "./config.ts";
import {
  CnbApi,
  formatDuration,
  isTerminal,
  normalizeStatus,
  type BuildStatusResult,
  type NormalizedStatus,
} from "./cnb.ts";
import { parseRunResult, type RunResult } from "./result.ts";
import { provisionRepo } from "./provision.ts";
import { RunStore, type CloudRun } from "./runs.ts";
import { writeScaffold } from "./templates.ts";

const NOTE_ENTRY = "cnb-cloud-note";
const STATUS_KEY = "cnb-cloud";

const store = new RunStore();
const watchers = new Map<string, { timer?: NodeJS.Timeout; stopped: boolean; failures: number }>();

interface SessionInfo {
  ctx: ExtensionContext;
  cwd: string;
  trusted: boolean;
}

let session: SessionInfo | undefined;

function configFor(cwd: string, trusted: boolean): CnbCloudConfig {
  return loadConfig(cwd, { includeProject: trusted });
}

function apiFor(config: CnbCloudConfig): CnbApi {
  const token = resolveToken(config);
  if (!token) {
    throw new Error(
      [
        `未找到 CNB 访问令牌（${config.tokenEnv}）。`,
        "  export CNB_TOKEN=<个人访问令牌>",
        "  权限需要：repo-cnb-trigger:rw（触发/查询构建）＋ repo-pr:rw（创建 PR）",
      ].join("\n"),
    );
  }
  return new CnbApi(config.apiEndpoint, token);
}

function note(pi: ExtensionAPI, ctx: ExtensionContext, title: string, body: string): void {
  pi.appendEntry(NOTE_ENTRY, { title, body });
  const firstLine = body.split("\n").find((line) => line.trim()) ?? "";
  ctx.ui.notify(`${title}${firstLine ? ` — ${firstLine.slice(0, 120)}` : ""}`, "info");
}

function statusIcon(status: string | undefined): string {
  switch (normalizeStatus(status)) {
    case "success":
      return "✅";
    case "error":
      return "❌";
    case "cancel":
      return "⚪";
    case "running":
      return "🏃";
    default:
      return "⏳";
  }
}

function formatStatus(run: CloudRun, status: BuildStatusResult): string {
  const overall = normalizeStatus(status.status);
  const lines = [
    `${statusIcon(status.status)} ${run.sn} · ${overall}${run.title ? ` · ${run.title}` : ""}`,
    `   仓库 ${run.repo} · 基分支 ${run.branch}`,
  ];
  if (run.url) lines.push(`   构建 ${run.url}`);

  const pipelines = Object.entries(status.pipelinesStatus ?? {});
  for (const [pipelineId, pipeline] of pipelines) {
    lines.push(
      `   ${statusIcon(pipeline.status)} ${pipeline.name ?? pipelineId}  ${formatDuration(pipeline.duration)}`,
    );
    for (const stage of pipeline.stages ?? []) {
      lines.push(`      ${statusIcon(stage.status)} ${stage.name}  ${formatDuration(stage.duration)}`);
    }
  }

  if (run.workBranch) lines.push(`   工作分支 ${run.workBranch}`);
  if (run.prUrl) lines.push(`   PR ${run.prUrl}`);
  if (run.testStatus) lines.push(`   测试 ${run.testStatus}`);
  return lines.join("\n");
}

async function collectLogs(
  api: CnbApi,
  run: CloudRun,
  options: { failedOnly: boolean; maxChars: number },
): Promise<{ text: string; result?: RunResult }> {
  const status = await api.getBuildStatus(run.repo, run.sn);
  const chunks: string[] = [];
  let result: RunResult | undefined;

  for (const [pipelineId, pipeline] of Object.entries(status.pipelinesStatus ?? {})) {
    for (const stage of pipeline.stages ?? []) {
      if (options.failedOnly && normalizeStatus(stage.status) !== "error") continue;
      if (normalizeStatus(stage.status) === "pending") continue;
      try {
        const detail = await api.getStage(run.repo, run.sn, pipelineId, stage.id);
        const content = Array.isArray(detail.content) ? detail.content.join("\n") : (detail.content ?? "");
        if (!content) continue;
        result ??= parseRunResult(content);
        chunks.push(
          `\n===== ${pipeline.name ?? pipelineId} / ${stage.name ?? stage.id} (${stage.status ?? "?"}) =====\n${content.slice(-options.maxChars)}`,
        );
      } catch (error) {
        chunks.push(`\n[无法读取阶段 ${stage.name}: ${error instanceof Error ? error.message : String(error)}]`);
      }
    }
  }

  // Prefer the newest marker found in any log.
  for (const chunk of chunks) {
    const parsed = parseRunResult(chunk);
    if (parsed) result = parsed;
  }

  return { text: chunks.join("\n").trim(), result };
}

async function fetchLogs(api: CnbApi, run: CloudRun, all: boolean): Promise<{ text: string; result?: RunResult }> {
  const failed = await collectLogs(api, run, { failedOnly: !all, maxChars: 8000 });
  if (failed.text) return failed;
  return collectLogs(api, run, { failedOnly: false, maxChars: 8000 });
}

/** Pull the result marker out of the build log and merge it into the run. */
async function enrichRun(sn: string, api: CnbApi): Promise<RunResult | undefined> {
  const run = store.get(sn);
  if (!run) return undefined;

  let result: RunResult | undefined;
  try {
    result = (await fetchLogs(api, run, false)).result;
  } catch {
    return undefined;
  }
  if (result) {
    store.patch(sn, {
      workBranch: result.branch ?? run.workBranch,
      prUrl: result.pr || run.prUrl,
      summary: result.summary ?? run.summary,
      testStatus: result.tests ?? run.testStatus,
    });
  }
  return result;
}

async function finalize(sn: string, api: CnbApi, status: NormalizedStatus): Promise<void> {
  if (!store.get(sn)) return;
  await enrichRun(sn, api);
  store.patch(sn, { status, finishedAt: new Date().toISOString() });

  const updated = store.get(sn)!;
  const icon = status === "success" ? "✅" : status === "cancel" ? "⚪" : "❌";
  const lines: string[] = [];
  if (updated.title) lines.push(updated.title);
  if (updated.workBranch) lines.push(`分支 ${updated.workBranch}`);
  if (updated.prUrl) lines.push(`PR ${updated.prUrl}`);
  if (updated.testStatus) lines.push(`测试 ${updated.testStatus}`);
  if (updated.summary) lines.push("", updated.summary.slice(0, 600));
  if (updated.url) lines.push("", `构建 ${updated.url}`);

  const current = session;
  if (current && extensionApi) {
    const label = status === "success" ? "完成" : status === "cancel" ? "已取消" : "失败";
    // note() already raises the toast, so do not notify twice.
    note(extensionApi, current.ctx, `${icon} 云端任务${label} · ${updated.sn}`, lines.join("\n"));
  }
  updateStatusBar();
}

let extensionApi: ExtensionAPI | undefined;

function updateStatusBar(): void {
  const current = session;
  if (!current) return;
  const active = store.unfinished().length;
  current.ctx.ui.setStatus(STATUS_KEY, active > 0 ? `☁️ ${active} 个云端任务运行中` : undefined);
}

function stopWatch(sn: string): void {
  const handle = watchers.get(sn);
  if (!handle) return;
  handle.stopped = true;
  if (handle.timer) clearTimeout(handle.timer);
  watchers.delete(sn);
}

function startWatch(sn: string): void {
  if (watchers.has(sn)) return;
  const handle = { stopped: false, failures: 0, timer: undefined as NodeJS.Timeout | undefined };
  watchers.set(sn, handle);

  const schedule = (delayMs: number): void => {
    if (handle.stopped) return;
    handle.timer = setTimeout(() => void tick(), delayMs);
    handle.timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (handle.stopped) return;
    const run = store.get(sn);
    const current = session;
    if (!run || !current) {
      stopWatch(sn);
      return;
    }

    const config = configFor(current.cwd, current.trusted);
    const token = resolveToken(config);
    if (!token) {
      stopWatch(sn);
      return;
    }

    try {
      const api = new CnbApi(config.apiEndpoint, token);
      const status = await api.getBuildStatus(run.repo, sn);
      const normalized = normalizeStatus(status.status);
      handle.failures = 0;

      if (isTerminal(normalized)) {
        stopWatch(sn);
        store.patch(sn, { status: normalized });
        await finalize(sn, api, normalized);
        return;
      }

      if (normalized !== run.status) {
        store.patch(sn, { status: normalized });
        updateStatusBar();
      }
      schedule(config.pollIntervalMs);
    } catch (error) {
      handle.failures += 1;
      store.patch(sn, { lastError: error instanceof Error ? error.message : String(error) });
      if (handle.failures >= 5) {
        stopWatch(sn);
        current.ctx.ui.notify(`云端任务 ${sn} 状态查询连续失败，已停止轮询`, "warning");
        return;
      }
      schedule(Math.min(config.pollIntervalMs * 2, 120_000));
    }
  };

  void tick();
}

interface DispatchOptions {
  prompt: string;
  repo?: string;
  branch?: string;
  title?: string;
  event?: string;
  testCommand?: string;
}

interface DispatchOutcome {
  run: CloudRun;
  text: string;
}

async function dispatchTask(cwd: string, trusted: boolean, options: DispatchOptions): Promise<DispatchOutcome> {
  const prompt = options.prompt.trim();
  if (!prompt) throw new Error("任务描述为空");

  const config = configFor(cwd, trusted);
  const api = apiFor(config);
  const repoContext = await resolveRepoContext(cwd, options.repo ?? config.repo);
  const branch = options.branch ?? config.branch ?? repoContext.branch;
  const event = options.event ?? config.event;
  const testCommand = options.testCommand ?? config.testCommand;

  if (!/^api_trigger(_|$)/.test(event)) {
    throw new Error(`CNB event 名必须以 api_trigger 开头（当前：${event}）`);
  }

  const firstLine = prompt.split("\n").find((line) => line.trim()) ?? prompt;
  const title = options.title ?? `${config.titlePrefix ?? ""}${firstLine.trim().slice(0, 60)}`;
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const env: Record<string, string> = {
    AGENT_TASK: prompt,
    AGENT_TITLE: title,
    AGENT_RUN_ID: runId,
  };
  if (testCommand) env.AGENT_TEST_CMD = testCommand;

  const result = await api.startBuild(repoContext.repo.slug, { event, branch, title, env });
  if (!result.success || !result.sn) {
    throw new Error(`CNB 触发失败：${result.message ?? "未返回 sn"}`);
  }

  const sn = result.sn;
  const url = result.buildLogUrl || buildWebUrl(repoContext.repo, sn);
  const run: CloudRun = {
    sn,
    repo: repoContext.repo.slug,
    branch,
    prompt,
    title,
    url,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  store.upsert(run);
  startWatch(sn);
  updateStatusBar();

  const text = [
    `🚀 已提交到 CNB：${sn}`,
    `仓库 ${run.repo} · 基分支 ${branch} · event ${event}`,
    `构建 ${url}`,
    testCommand ? `测试 ${testCommand}` : "测试 未配置（agent 只改代码，不跑测试）",
    "",
    "已进入后台托管，可以合盖离开。完成后会推送分支/PR，并通过 CNB 侧的 IM webhook 通知。",
  ].join("\n");

  return { run, text };
}

async function dispatchAndReport(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: DispatchOptions,
): Promise<string> {
  const { text } = await dispatchTask(ctx.cwd, ctx.isProjectTrusted(), options);
  note(pi, ctx, "☁️ 云端任务已派发", text);
  return text;
}

/** Resolve `[sn]` from command args, falling back to the latest local run. */
async function resolveRunArg(args: string, cwd: string, config: CnbCloudConfig): Promise<CloudRun | undefined> {
  const explicit = args
    .trim()
    .split(/\s+/)
    .find((token) => token.length > 0 && !token.startsWith("--"));

  if (!explicit) return store.latest();

  const stored = store.get(explicit);
  if (stored) return stored;

  // The SN may come from another machine or an older run that is no longer in
  // the local history; the repo is enough to query CNB.
  const repoContext = await resolveRepoContext(cwd, config.repo);
  return {
    sn: explicit,
    repo: repoContext.repo.slug,
    branch: config.branch ?? repoContext.branch,
    prompt: "",
    createdAt: new Date().toISOString(),
    status: "pending",
  };
}

export default function cnbCloudExtension(pi: ExtensionAPI): void {
  extensionApi = pi;

  pi.registerEntryRenderer(NOTE_ENTRY, (entry, { expanded }, theme) => {
    const data = (entry.data ?? {}) as { title?: string; body?: string };
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.bold(data.title ?? "CNB"), 0, 0));
    const body = data.body ?? "";
    const shown = expanded ? body : body.split("\n").slice(0, 10).join("\n");
    box.addChild(new Text(theme.fg("dim", shown), 0, 0));
    if (!expanded && body.split("\n").length > 10) {
      box.addChild(new Text(theme.fg("dim", "… (expand to see the full output)"), 0, 0));
    }
    return box;
  });

  pi.on("session_start", async (_event, ctx) => {
    session = { ctx, cwd: ctx.cwd, trusted: ctx.isProjectTrusted() };
    store.load();
    updateStatusBar();
    const config = configFor(ctx.cwd, ctx.isProjectTrusted());
    if (!config.autoWatch) return;
    for (const run of store.unfinished()) startWatch(run.sn);
  });

  pi.on("session_shutdown", async () => {
    for (const sn of [...watchers.keys()]) stopWatch(sn);
    session = undefined;
  });

  // ------------------------------------------------------------- commands ---

  pi.registerCommand("cloud", {
    description: "把任务派发到 CNB 云端异步执行（合盖即走）",
    getArgumentCompletions: (prefix) => {
      const flags = ["--repo", "--branch", "--title", "--test", "--no-watch"];
      const items = flags.filter((flag) => flag.startsWith(prefix)).map((flag) => ({ value: flag, label: flag }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const parsed = parseArgs(args, {
        valueFlags: ["repo", "branch", "title", "event", "test"],
        booleanFlags: ["no-watch", "watch"],
      });

      let prompt = parsed.rest;
      if (!prompt && ctx.hasUI) {
        const editor = (ctx.ui as { editor?: (title: string, prefill?: string) => Promise<string | undefined> }).editor;
        prompt = editor ? ((await editor("云端 Agent 任务", "")) ?? "") : (await ctx.ui.input("云端 Agent 任务", "描述要 agent 做什么")) ?? "";
      }
      if (!prompt.trim()) {
        ctx.ui.notify("用法：/cloud [--repo g/r] [--branch main] [--test 'npm test'] <任务描述>", "warning");
        return;
      }

      try {
        await dispatchAndReport(pi, ctx, {
          prompt,
          repo: stringFlag(parsed.flags, "repo"),
          branch: stringFlag(parsed.flags, "branch"),
          title: stringFlag(parsed.flags, "title"),
          event: stringFlag(parsed.flags, "event"),
          testCommand: stringFlag(parsed.flags, "test"),
        });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("cloud-new", {
    description: "新建 CNB 仓库并派发一个从零构建的任务",
    getArgumentCompletions: (prefix) => {
      const flags = ["--group", "--public", "--image", "--test"];
      const items = flags.filter((f) => f.startsWith(prefix)).map((f) => ({ value: f, label: f }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const parsed = parseArgs(args, {
        valueFlags: ["group", "image", "test", "event"],
        booleanFlags: ["public"],
      });

      let name = parsed.positional[0];
      if (!name) {
        ctx.ui.notify(
          "用法：/cloud-new <仓库名> [--group 组织] [--public] [--image 镜像] [--test '命令'] <任务描述>",
          "warning",
        );
        return;
      }

      let prompt = parsed.positional.slice(1).join(" ").trim();
      if (!prompt && ctx.hasUI) {
        const editor = (ctx.ui as { editor?: (title: string, prefill?: string) => Promise<string | undefined> }).editor;
        prompt =
          (editor ? await editor("云端从零构建：任务描述", "") : await ctx.ui.input("任务描述", "要生成什么项目")) ?? "";
      }
      if (!prompt.trim()) {
        ctx.ui.notify("缺少任务描述：/cloud-new <仓库名> <任务>", "warning");
        return;
      }

      try {
        const config = configFor(ctx.cwd, ctx.isProjectTrusted());
        const api = apiFor(config);
        const token = resolveToken(config);
        if (!token) throw new Error("未找到 CNB 访问令牌");

        let group = stringFlag(parsed.flags, "group") ?? config.group;
        if (name.includes("/")) {
          const parts = name.split("/");
          name = parts.pop()!;
          group = parts.join("/");
        }

        let host = "cnb.cool";
        let webProtocol = "https";
        if (!group) {
          const repoContext = await resolveRepoContext(ctx.cwd, config.repo);
          group = repoContext.repo.slug.split("/")[0]!;
          host = repoContext.repo.host;
          webProtocol = repoContext.repo.webProtocol;
        }

        ctx.ui.notify(`正在创建仓库 ${group}/${name} …`, "info");
        const provisioned = await provisionRepo({
          api,
          token,
          group,
          name,
          visibility: parsed.flags.public === true ? "public" : "private",
          event: stringFlag(parsed.flags, "event") ?? config.event,
          image: stringFlag(parsed.flags, "image") ?? config.image,
          importsUrl: config.importsUrl,
          testCommand: stringFlag(parsed.flags, "test") ?? config.testCommand,
          maxIterations: config.maxIterations,
          host,
          webProtocol,
        });

        // CNB needs a moment to index the fresh branch/config before a trigger.
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const dispatched = await dispatchTask(ctx.cwd, ctx.isProjectTrusted(), {
          prompt,
          repo: provisioned.repo,
          branch: "main",
          testCommand: stringFlag(parsed.flags, "test") ?? config.testCommand,
        });

        note(
          pi,
          ctx,
          "🆕 仓库已创建并派发",
          [
            `仓库 ${provisioned.url}`,
            dispatched.text,
            "",
            "PR 会开在 main 上；合盖后可用 /cloud-status 查看。",
          ].join("\n"),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          message.includes("already exists") || message.includes("exists")
            ? `仓库已存在：用 /cloud --repo <group/name> <任务> 直接派发`
            : message,
          "error",
        );
      }
    },
  });

  pi.registerCommand("cloud-status", {
    description: "查看 CNB 云端任务状态",
    handler: async (args, ctx) => {
      try {
        const config = configFor(ctx.cwd, ctx.isProjectTrusted());
        const run = await resolveRunArg(args, ctx.cwd, config);
        if (!run) {
          ctx.ui.notify("还没有云端任务记录。先运行 /cloud <任务>", "warning");
          return;
        }
        const api = apiFor(config);
        const status = await api.getBuildStatus(run.repo, run.sn);
        const normalized = normalizeStatus(status.status);
        store.patch(run.sn, { status: normalized });
        // Terminal runs carry branch/PR/summary in the log marker; recover it
        // even when the local watcher was not alive at completion time.
        if (isTerminal(normalized)) await enrichRun(run.sn, api);
        const body = formatStatus(store.get(run.sn) ?? run, status);
        note(pi, ctx, "☁️ 云端任务状态", body);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("cloud-runs", {
    description: "列出本地记录的云端任务",
    handler: async (_args, ctx) => {
      const runs = store.list(15);
      if (runs.length === 0) {
        ctx.ui.notify("还没有云端任务记录", "info");
        return;
      }
      const body = runs
        .map((run) => {
          const icon = statusIcon(run.status);
          const pr = run.prUrl ? `  ${run.prUrl}` : "";
          return `${icon} ${run.sn}  ${run.createdAt.slice(0, 16).replace("T", " ")}  ${run.repo}  ${run.title ?? ""}${pr}`;
        })
        .join("\n");
      note(pi, ctx, "☁️ 云端任务历史", body);
    },
  });

  pi.registerCommand("cloud-logs", {
    description: "拉取云端任务的构建日志（默认只看失败阶段）",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args, { booleanFlags: ["all"] });
      try {
        const config = configFor(ctx.cwd, ctx.isProjectTrusted());
        const run = await resolveRunArg(parsed.rest, ctx.cwd, config);
        if (!run) {
          ctx.ui.notify("没有可查询的任务", "warning");
          return;
        }
        const api = apiFor(config);
        const { text, result } = await fetchLogs(api, run, parsed.flags.all === true);
        if (result) {
          store.patch(run.sn, {
            workBranch: result.branch ?? run.workBranch,
            prUrl: result.pr || run.prUrl,
            summary: result.summary ?? run.summary,
            testStatus: result.tests ?? run.testStatus,
          });
        }
        const header = `sn ${run.sn} · ${run.status}${run.workBranch ? ` · ${run.workBranch}` : ""}${run.prUrl ? ` · ${run.prUrl}` : ""}`;
        const body = text
          ? `${header}\n\n${text.slice(-12_000)}`
          : `${header}\n\n（没有可读取的日志；构建可能还没开始，或日志已被清理）`;
        note(pi, ctx, "☁️ 云端任务日志", body);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("cloud-cancel", {
    description: "取消正在运行的云端任务",
    handler: async (args, ctx) => {
      try {
        const config = configFor(ctx.cwd, ctx.isProjectTrusted());
        const run = await resolveRunArg(args, ctx.cwd, config);
        if (!run) {
          ctx.ui.notify("用法：/cloud-cancel <sn>", "warning");
          return;
        }
        const api = apiFor(config);
        await api.stopBuild(run.repo, run.sn);
        store.patch(run.sn, { status: "cancel", finishedAt: new Date().toISOString() });
        stopWatch(run.sn);
        updateStatusBar();
        ctx.ui.notify(`已请求取消 ${run.sn}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("cloud-setup", {
    description: "在当前仓库生成 .cnb.yml 与 .cnb/agent/* 脚手架",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args, {
        valueFlags: ["image", "test", "event", "max-iters"],
        booleanFlags: ["force"],
      });

      const config = configFor(ctx.cwd, ctx.isProjectTrusted());
      const result = writeScaffold(ctx.cwd, {
        event: stringFlag(parsed.flags, "event") ?? config.event,
        image: stringFlag(parsed.flags, "image") ?? config.image,
        testCommand: stringFlag(parsed.flags, "test") ?? config.testCommand,
        maxIterations: numberFlag(parsed.flags, "max-iters") ?? config.maxIterations,
        force: parsed.flags.force === true,
      });

      const lines = [
        result.written.length > 0 ? `已写入：\n${result.written.map((f) => `  + ${f}`).join("\n")}` : "没有写入任何文件",
        result.skipped.length > 0
          ? `已跳过（已存在且不是本插件生成的文件，加 --force 覆盖）：\n${result.skipped.map((f) => `  - ${f}`).join("\n")}`
          : "",
        "",
        "下一步：",
        "  1. 提交 .cnb.yml 与 .cnb/agent/ 到默认分支",
        `  2. 在 CNB 密钥仓库里配置 AGENT_API_KEY / AGENT_BASE_URL / AGENT_MODEL（以及可选的 AGENT_NOTIFY_WEBHOOK），并在 .cnb.yml 里 imports 它`,
        `  3. 编辑 ${projectConfigPath(ctx.cwd)} 里的 model/baseUrl/testCommand`,
        "  4. 运行 /cloud <任务> 派发",
      ].filter(Boolean);
      note(pi, ctx, "🛠️ CNB 云端 Agent 脚手架", lines.join("\n"));
    },
  });

  pi.registerCommand("cloud-config", {
    description: "显示当前生效的 CNB 云端配置（不含令牌）",
    handler: async (_args, ctx) => {
      const config = configFor(ctx.cwd, ctx.isProjectTrusted());
      const token = resolveToken(config);
      const body = [
        `apiEndpoint   ${config.apiEndpoint}`,
        `event         ${config.event}`,
        `repo          ${config.repo ?? "(auto from origin)"}`,
        `branch        ${config.branch ?? "(current branch)"}`,
        `testCommand   ${config.testCommand ?? "(none)"}`,
        `maxIterations ${config.maxIterations}`,
        `pollInterval  ${config.pollIntervalMs}ms`,
        `autoWatch     ${config.autoWatch}`,
        `image         ${config.image ?? "(docker.build from .cnb/agent/Dockerfile)"}`,
        `token         ${token ? `已设置（${config.tokenEnv ?? "env"}，${token.slice(0, 4)}…）` : "未设置"}`,
        "",
        `global  ${loadConfig(ctx.cwd, { includeProject: false }).apiEndpoint ? "" : ""}`.trim(),
        `project ${projectConfigPath(ctx.cwd)}${ctx.isProjectTrusted() ? "" : "（项目未受信任，已忽略）"}`,
      ].join("\n");
      note(pi, ctx, "⚙️ CNB 云端配置", body);
    },
  });

  // ---------------------------------------------------------------- tool ---

  pi.registerTool({
    name: "cnb_cloud",
    label: "CNB Cloud Agent",
    description:
      "Dispatch and monitor fire-and-forget coding tasks on Tencent CNB (cnb.cool). A task runs headless in a CNB pipeline, pushes a branch/PR and notifies via IM. Use dispatch when the user wants work done in the cloud and does not need to wait.",
    promptSnippet: "Dispatch or inspect a headless coding task on Tencent CNB",
    promptGuidelines: [
      "Use cnb_cloud with action=dispatch when the user asks to run a coding task in the CNB cloud, in the background, or after they close the laptop.",
      "Use cnb_cloud with action=status or action=logs to check a CNB task; omit sn to use the most recent local run.",
      "cnb_cloud never runs the task locally; it only triggers the CNB pipeline and reports its state.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("dispatch"),
        Type.Literal("status"),
        Type.Literal("logs"),
        Type.Literal("list"),
        Type.Literal("cancel"),
      ]),
      prompt: Type.Optional(Type.String({ description: "Task description for the cloud agent (required for dispatch)." })),
      repo: Type.Optional(Type.String({ description: "group/repo; defaults to the git origin or local config." })),
      branch: Type.Optional(Type.String({ description: "Branch the cloud build runs on." })),
      testCommand: Type.Optional(Type.String({ description: "Command the agent must make pass, e.g. 'npm test'." })),
      title: Type.Optional(Type.String({ description: "Build and PR title." })),
      sn: Type.Optional(Type.String({ description: "Build SN for status/logs/cancel." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const trusted = ctx.isProjectTrusted();

      try {
        switch (params.action) {
          case "dispatch": {
            if (!params.prompt?.trim()) throw new Error("dispatch 需要 prompt");
            const { run, text } = await dispatchTask(cwd, trusted, {
              prompt: params.prompt,
              repo: params.repo,
              branch: params.branch,
              title: params.title,
              testCommand: params.testCommand,
            });
            return {
              content: [{ type: "text", text }],
              details: { sn: run.sn, url: run.url, repo: run.repo, branch: run.branch, status: run.status },
            };
          }

          case "status": {
            const run = params.sn ? store.get(params.sn) : store.latest();
            if (!run) throw new Error(`没有找到任务 ${params.sn ?? "(latest)"}`);
            const api = apiFor(configFor(cwd, trusted));
            const status = await api.getBuildStatus(run.repo, run.sn);
            const normalized = normalizeStatus(status.status);
            store.patch(run.sn, { status: normalized });
            if (isTerminal(normalized)) await enrichRun(run.sn, api);
            const text = formatStatus(store.get(run.sn) ?? run, status);
            return { content: [{ type: "text", text }], details: { sn: run.sn, status: status.status } };
          }

          case "logs": {
            const run = params.sn ? store.get(params.sn) : store.latest();
            if (!run) throw new Error(`没有找到任务 ${params.sn ?? "(latest)"}`);
            const api = apiFor(configFor(cwd, trusted));
            const { text, result } = await fetchLogs(api, run, false);
            if (result) {
              store.patch(run.sn, {
                workBranch: result.branch,
                prUrl: result.pr,
                summary: result.summary,
                testStatus: result.tests,
              });
            }
            return {
              content: [{ type: "text", text: text ? text.slice(-12_000) : "没有日志" }],
              details: { sn: run.sn, hasResult: Boolean(result) },
            };
          }

          case "list": {
            const runs = store.list(15);
            const text =
              runs.length === 0
                ? "还没有云端任务记录"
                : runs
                    .map((run) => `${statusIcon(run.status)} ${run.sn}  ${run.repo}  ${run.title ?? ""}`)
                    .join("\n");
            return { content: [{ type: "text", text }], details: { count: runs.length } };
          }

          case "cancel": {
            const run = params.sn ? store.get(params.sn) : store.latest();
            if (!run) throw new Error(`没有找到任务 ${params.sn ?? "(latest)"}`);
            const api = apiFor(configFor(cwd, trusted));
            await api.stopBuild(run.repo, run.sn);
            store.patch(run.sn, { status: "cancel", finishedAt: new Date().toISOString() });
            stopWatch(run.sn);
            updateStatusBar();
            return { content: [{ type: "text", text: `已请求取消 ${run.sn}` }], details: { sn: run.sn } };
          }

          default:
            throw new Error(`未知 action: ${String(params.action)}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `CNB 操作失败：${message}` }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });
}