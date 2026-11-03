# pi-cnb-cloud

把 pi 变成「合盖即走」的云端编码 agent：本地一句话派发，任务在腾讯云原生构建（CNB）里无人值守执行，跑完推分支、开 PR，并用 IM 通知你。

本地 pi 只负责「发起 + 查看」，真正的读代码、改代码、跑测试、提交，全在 CNB 的临时容器里完成。

```
本地 pi                                CNB 云端
┌─────────────────┐                  ┌──────────────────────────────────────┐
│ /cloud <任务>    │   OpenAPI 触发    │ 1. 拉起构建（预构建镜像，秒级）        │
│ /cloud-new <仓库>│ ───────────────► │ 2. .cnb/agent/run.sh 无头运行 pi       │
│   一句话建仓库    │                  │ 3. 测试失败 → 带日志再跑一轮（自愈）    │
│   立刻返回       │                  │ 4. commit → push agent/<id> → 开 PR    │
└─────────────────┘                  │ 5. IM webhook 通知                     │
        （合盖）                      └──────────────────────────────────────┘
```

## 特性

- **一条命令从零开始**：`/cloud-new` 自动建仓库、推脚手架、派发任务，云端生成整个项目
- **一条命令继续迭代**：`/cloud` 在已有仓库上派发，产出 PR
- **测试驱动自愈**：测试不过就把失败日志回灌给 agent，最多 `maxIterations` 轮
- **心跳保活**：CNB 会杀掉 10 分钟无输出的 stage，runner 每 30s 打点，长任务不会被误杀
- **结果可回读**：构建日志末尾输出 `===PI-CNB-RESULT===` JSON，本地解析出分支 / PR / 摘要 / 测试状态
- **密钥不落仓库**：模型 key 放 CNB 密钥仓库，通过 `imports` 注入；插件只存 CNB 访问令牌
- **瘦仓库 + 胖镜像**：支持引用预构建镜像（JDK/Node/pi 预装），Prepare 从 30s+ 降到 10s 级

## 安装

扩展是纯 TypeScript，无需编译（pi 用 jiti 直接加载）。

```bash
git clone <this-repo> ~/code/pi-cnb-cloud
ln -s ~/code/pi-cnb-cloud ~/.pi/agent/extensions/pi-cnb-cloud
```

或写进 `~/.pi/agent/settings.json`：

```json
{ "extensions": ["/path/to/pi-cnb-cloud"] }
```

验证：`pi --no-session --list-models > /dev/null && echo ok`

## 准备

### 1. CNB 访问令牌

个人设置 → 访问令牌，权限：

| 权限 | 用途 |
|---|---|
| `repo-cnb-trigger:rw` | 触发 / 查询 / 停止构建 |
| `repo-pr:rw` | 创建 PR、合并 |
| `repo-cnb-history:r` | 可选，查构建历史 |

存放（二选一，环境变量优先）：

```bash
export CNB_TOKEN=...
# 或
install -m 600 /dev/null ~/.pi/agent/cnb-token
printf '%s' '<token>' > ~/.pi/agent/cnb-token
```

> API 地址默认 `https://api.cnb.cool`（cnb.cool SaaS）。私有化部署用 `CNB_API_ENDPOINT` 覆盖。
> 注意 `api.cnb.build` 与 `api.cnb.cool` 的令牌不互通。

### 2. 密钥仓库（云端模型 key）

CNB「密钥仓库」只能网页编辑（禁止 clone/push，有审计和水印），所以这一步必须手工：

1. `https://cnb.cool/new/repos` → 类型选 **密钥仓库**，例如 `your-org/pi-agent-secrets`
2. 新建 `agent.yml`：

```yaml
AGENT_API_KEY: "sk-..."
AGENT_BASE_URL: "https://api.deepseek.com/v1"
AGENT_MODEL: "deepseek-flash"
AGENT_API: "openai-completions"        # 或 anthropic-messages
AGENT_NOTIFY_WEBHOOK: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."  # 可选

allow_slugs:
  - "your-org/**"
```

> `allow_slugs` 一旦配置，会**忽略触发者角色权限**，完全按规则校验。范围别写太宽。

### 3. 全局配置

`~/.pi/agent/cnb-cloud.json`：

```json
{
  "apiEndpoint": "https://api.cnb.cool",
  "event": "api_trigger_agent",
  "group": "your-org",
  "importsUrl": "https://cnb.cool/your-org/pi-agent-secrets/-/blob/main/agent.yml",
  "image": "docker.cnb.cool/your-org/your-image-repo/agent-runner:latest",
  "testCommand": "(cd backend && mvn -q -B test) && (cd frontend && npm ci && npm test)",
  "maxIterations": 2,
  "pollIntervalMs": 15000,
  "autoWatch": true
}
```

`image` 可选：

- 配了 → 脚手架用 `docker.image`（秒级冷启动）
- 没配 → 脚手架用 `docker.build .cnb/agent/Dockerfile`（自包含，但每次构建慢 5~7 分钟）

## 使用

### 从零建一个项目

```bash
pi
/cloud-new shop-api 生成一个 SpringBoot3 + Vue3 的商品 CRUD 项目，后端 /api/products，前端列表页，前后端都要测试
```

插件会：

1. `POST /{group}/-/repos` 建私有仓库
2. 推 4 个文件（`.cnb.yml`、`.cnb/agent/run.sh`、`.cnb/agent/notify.sh`、`.pi/cnb-cloud.json`）
3. 派发任务，云端 agent 从空仓库生成项目、跑测试、开 PR

常用参数：

```bash
/cloud-new shop-api --group your-org --public ...
/cloud-new shop-api --image node:22-bookworm ...        # 不用胖镜像
/cloud-new shop-api --test "npm test" ...               # 覆盖测试命令
```

### 在已有仓库上迭代

```bash
cd your-repo && pi
/cloud 给登录加 JWT：/api/auth/me 校验 token，前后端补测试
```

变体：

```bash
/cloud --repo your-org/api --branch release/1.2 修复导出 CSV 的编码问题
/cloud --test "pnpm test" 把 moment 换成 date-fns
/cloud --no-watch 只派发，不在本地轮询
```

### 查看结果

```bash
/cloud-status            # 最近一次任务：状态、阶段耗时、分支、PR
/cloud-status cnb-xxx    # 指定 SN
/cloud-logs              # 失败阶段日志（--all 看全部）
/cloud-runs              # 本地任务历史
/cloud-cancel cnb-xxx    # 取消
```

LLM 也能直接调用 `cnb_cloud` 工具（`action=dispatch|status|logs|list|cancel`），所以可以自然语言：

> 把这个任务丢到云端跑，跑完告诉我。

### 脚手架

```bash
/cloud-setup --test "npm test"     # 在当前仓库生成 .cnb.yml + .cnb/agent/*
/cloud-setup --force --image node:22-bookworm
/cloud-config                      # 查看生效配置（令牌打码）
```

## 命令一览

| 命令 | 作用 |
|---|---|
| `/cloud <任务>` | 派发到已有仓库（自动从 origin 解析 group/repo，从当前分支取 ref） |
| `/cloud-new <仓库名> <任务>` | 建仓库 + 推脚手架 + 派发 |
| `/cloud-status [sn]` | 构建状态、阶段耗时、PR；终态时自动回读日志补全元数据 |
| `/cloud-logs [sn] [--all]` | 拉取阶段日志 |
| `/cloud-runs` | 本地任务历史（`~/.pi/agent/cnb-cloud/runs.json`） |
| `/cloud-cancel [sn]` | 停止构建 |
| `/cloud-setup` | 生成 / 刷新仓库内脚手架 |
| `/cloud-config` | 显示生效配置 |

## 配置参考

优先级：默认值 → `~/.pi/agent/cnb-cloud.json` → `<repo>/.pi/cnb-cloud.json` → 环境变量。

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiEndpoint` | `https://api.cnb.cool` | CNB API |
| `event` | `api_trigger_agent` | 必须是 `api_trigger` 或以它开头 |
| `tokenEnv` | `CNB_TOKEN` | 令牌环境变量名 |
| `tokenFile` | `<agent dir>/cnb-token` | 令牌文件（0600） |
| `repo` / `branch` | 自动 | 默认仓库 / 分支 |
| `group` | — | `/cloud-new` 的默认组织 |
| `importsUrl` | — | 写进脚手架 `.cnb.yml` 的 `imports` |
| `image` | — | 写进脚手架的镜像；空则用 `docker.build` |
| `testCommand` | — | 空则跳过测试循环 |
| `maxIterations` | `2` | agent 最多跑几轮 |
| `pollIntervalMs` | `20000` | 本地轮询间隔 |
| `autoWatch` | `true` | 启动时继续跟踪未完成任务 |
| `notifyWebhookEnv` | — | IM webhook 的环境变量名 |

环境变量覆盖：`CNB_TOKEN`、`CNB_API_ENDPOINT`、`CNB_CLOUD_EVENT`、`CNB_CLOUD_REPO`、`CNB_CLOUD_BRANCH`、`CNB_CLOUD_TEST_CMD`、`CNB_CLOUD_IMAGE`、`CNB_CLOUD_GROUP`。

## 云端 runner

`.cnb/agent/run.sh` 读取的环境变量：

| 变量 | 说明 |
|---|---|
| `AGENT_TASK` | 任务描述（必填） |
| `AGENT_TITLE` / `AGENT_RUN_ID` | 标题 / 关联 ID |
| `AGENT_TEST_CMD` | 测试命令；缺省读 `.pi/cnb-cloud.json` |
| `AGENT_MAX_ITERATIONS` | 最多几轮 |
| `AGENT_MODEL` / `AGENT_PROVIDER` / `AGENT_BASE_URL` / `AGENT_API` / `AGENT_API_KEY` | 模型配置；有 `baseUrl` 时自动写 `~/.pi/agent/models.json`，key 用 `$AGENT_API_KEY` 引用，不落盘 |
| `AGENT_NOTIFY_WEBHOOK` | IM webhook（企微 / 飞书 / 钉钉 / Slack 自动适配） |

流程：

```
git checkout -B agent/<run-id>
for i in 1..N:
    pi --mode json --no-session <prompt> > events.jsonl &
    heartbeat 每 30s 打点        # 防止 CNB 10 分钟无输出杀 stage
    跑 AGENT_TEST_CMD；失败 → 日志进下一轮 prompt
commit → push agent/<run-id> → POST /pulls → 通知
println ===PI-CNB-RESULT=== {json}
```

结果标记：

```json
{"status":"success","branch":"agent/xxx","pr":"https://...","tests":"passed","summary":"...","sn":"cnb-...","repo":"g/r"}
```

## 架构

```
src/
├── index.ts       命令、工具、后台轮询、结果回读
├── cnb.ts         CNB OpenAPI 客户端（触发/状态/日志/停止/建仓库/建 PR）
├── provision.ts   建仓库 + 推送脚手架
├── config.ts      配置合并、从 git origin 解析 group/repo
├── runs.ts        本地任务历史（同步落盘）
├── templates.ts   .cnb.yml / 脚手架生成
├── result.ts      解析 ===PI-CNB-RESULT===
└── args.ts        命令参数解析

templates/agent/
├── run.sh         云端主循环（心跳、自愈、推送、PR、通知）
├── notify.sh      企微/飞书/钉钉/Slack webhook
└── Dockerfile     胖镜像（node + pi，按需替换为 JDK/Maven 等）
```

用到的 CNB OpenAPI：

| 操作 | 端点 |
|---|---|
| 触发构建 | `POST /{repo}/-/build/start` |
| 查状态 | `GET /{repo}/-/build/status/{sn}` |
| 阶段日志 | `GET /{repo}/-/build/logs/stage/{sn}/{pipelineId}/{stageId}` |
| 停止 | `POST /{repo}/-/build/stop/{sn}` |
| 建仓库 | `POST /{group}/-/repos` |
| 建 PR | `POST /{repo}/-/pulls` |

> 注意不是 `POST /api/v1/repos/{repo}/builds`（那是常见误传）。

## 测试

需要 Node 22：

```bash
node --experimental-transform-types test/logic.test.ts    # 参数/仓库解析/脚手架/run store
node --experimental-transform-types test/api.test.ts      # CNB 客户端对 mock server
bash test/run-sh.test.sh                                  # 云端 run.sh 全链路（假 pi + 本地裸仓库）
node --experimental-transform-types test/rpc-smoke.test.ts # 真实 pi 子进程 + RPC
./node_modules/.bin/tsc --noEmit
```

`run-sh.test.sh` 覆盖：自愈循环、无变更、缺令牌、推送、建 PR、通知、结果标记。
`rpc-smoke.test.ts` 覆盖：`/cloud`、`/cloud-status`、`/cloud-setup`、`/cloud-config`、任务持久化。

## 实测数据

| 场景 | Prepare | Agent | 结果 |
|---|---|---|---|
| 空仓库生成 SpringBoot+Vue 登录 | 8~15s | 11m33s | 20 文件 + PR |
| 已有项目加 JWT / 注册 | 10~24s | 1.5~6min | PR + 测试全绿 |
| `docker.build` 每次现场构建 | 32~43s | — | 慢在装环境 |

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `CNB API 404` | repo 路径或 event 名不对；`.cnb.yml` 必须在触发的分支上 |
| `CNB API 401/403` | 令牌无效或缺 `repo-cnb-trigger:rw`；建 PR 需要 `repo-pr:rw` |
| `Secret repos do not support token access` | 密钥仓库只能网页编辑，这是设计 |
| `未配置模型` | 脚手架漏了 `imports`，或密钥仓库的 `allow_slugs` 没包含该仓库 |
| `任务超过(10m0s)没有任何输出而被强制关闭` | 老版本 run.sh 无心跳；升级到带 heartbeat 的版本 |
| 分支推不上去 | 流水线开了 `sandbox: true`（会让 `CNB_TOKEN` 失效） |
| PR 没建但分支在 | 令牌缺 `repo-pr:rw`，或仓库关闭了 PR；分支本身可用 |
| 本地 watcher 不更新 | 合盖后进程已退出；用 `/cloud-status` 回读，或加 IM 通知 |
| agent 只输出文本不改文件 | 模型偶发行为；prompt 里加「必须用 write/bash 真实改文件」，或重跑 |

## 安全

- 令牌只从环境变量或 `~/.pi/agent/cnb-token` 读取，不写进仓库、不打印
- 模型 key 放 CNB 密钥仓库，`imports` 注入；`models.json` 只写 `$AGENT_API_KEY` 引用
- agent 在 CNB 临时容器里运行，只能访问本次 clone 的仓库和 CNB 注入的临时令牌
- 云端产物是分支 + PR，不会直推 `main`；合并权在你
- 建议定期轮换：CNB 令牌、模型 key（改密钥仓库文件即可，无需改代码）

## 许可

私有项目，未授权请勿分发。