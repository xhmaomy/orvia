# Orvia

> 以人为中心的多 Agent 协作编排平台。在画布上把多个 Agent 连成工作流，由 Orvia 按依赖调度执行，在需要时停下来让人决策。真正执行任务的是本机的 Pi CLI。

Orvia 负责编排、产物目录、对话和人工复核，不替代模型本身。当前版本按本机双进程运行：API 在 `4100`，控制台在 `3000`。

---

## 目录

- [核心功能](#核心功能)
- [架构与执行链路](#架构与执行链路)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [配置指南](#配置指南)
- [生产部署](#生产部署)
- [开发与测试](#开发与测试)
- [文档索引](#文档索引)

---

## 核心功能

### 画布与工作流编排

- **可视化画布**：添加「开始 / Agent / 人工复核 / 结束」节点，支持拖动、调整大小、连线。
- **依赖由连线决定**：谁等谁、退回给谁，看边不看位置。未接到开始节点的孤立节点不会执行。
- **节点配置**：每个 Agent 可配置任务说明、产出要求、模型、能力与可选 Skill。
- **产物落盘**：产物落在 `~/.orvia/workflows/{项目名}/{工作流名称}/`，按执行轮次与节点名称分目录。
- **循环结构**：支持把一段 Agent + 人工复核配成可重复的循环，可设定最大迭代次数。
- **版本化执行**：每个 Workflow 一条 Run，未运行时可再次执行，选择「从头开始」或「从停下的节点继续」。

### 执行调度

- **DAG 调度**：以有向无环图为唯一调度语义，依赖全部完成的 Task 才可运行。
- **并行执行**：互不依赖的非人工复核任务并行启动多个 Pi 进程。
- **异步受理**：`POST /execute` 返回 HTTP 202，实际执行在请求返回后继续。
- **状态管理**：Run 状态转换由状态机约束（`pending → running → paused/completed/failed/cancelled`），进程重启后中断的 `running` Run 恢复为 `paused`。
- **重新规划（Replan）**：事务内 supersede 当前 Plan，创建递增版本的新 Plan，默认自动续跑。

### 人工复核

- **检查点暂停**：流程走到人工复核节点会停住，等待批准 / 退回 / 拒绝 / 覆盖。
- **按上游分别复核**：每个上游一张卡片，可写说明、打开交付物、单独退回。
- **退回机制**：只重跑被点名的上游 Agent，不能退回到人工节点。
- **全部批准**：各节点说明可选，未填则记为「批准」。
- **决策动作**：支持 `approve` / `request_changes` / `reject` / `override` / `replan` / `repeat`。

### 上游产物校验

- **规则配置**：Agent 上可按条配置不合格条件，满足任意一条则不合格。
- **自动退回**：不合格时自动退回给出内容的节点，次数用尽后停下来等人确认。
- **人工确认**：说明可选，不填则「批准继续」或「按原判定退回」。
- **穿透人工节点**：校验只检查真正有产物的上游 Agent，避免把人工节点当文件源误判。

### Agent 对话（节点侧栏）

在画布上点 Agent 节点或人工复核，右侧侧栏可直接与该节点对话。

- **流式回复**：发送指导后返回 HTTP 202，侧栏先流出思考过程，再流出正文。
- **指导留痕**：用户消息写入 `ov_node_messages`，同时在群聊时间线留下一条 `guidance` 记录，供之后的执行读取。
- **执行中可对话**：执行过程中也可发送指导，但当前这次执行不会中途改口，新指导留给该 Agent 之后的执行。
- **互斥保护**：同一个 Agent 正在回复时再发一条，返回 409；支持主动中断当前回复。
- **人工复核对话**：`@` 人工复核或在侧栏给人工复核发消息，不跑模型，只把说明记下，写进后续复核说明。
- **边界**：开始和结束节点不参与对话。

### 群聊对话

工作流面板可切换到群聊视图，时间线里能看到执行开始、完成、失败、复核和退回。

- **点名机制**：用 `@节点名` 点名；`@all` 点除开始、结束外的全部节点。正文里单独出现的单词 `all` 不算点名。
- **单节点对话**：只 `@` 一个空闲节点时，直接和这个节点对话。它判断是提问就只回复；判断是要开始做任务且上游都已完成，就启动这个节点执行。
- **多节点点名**：`@all` 或一次 `@` 多个节点时，空闲节点各自回复。管理员只替正在执行的节点说话，不打断正在跑的任务。
- **人工复核点名**：`@` 人工复核只记下说明，不跑模型。
- **执行链复用**：从群里点名启动的节点，进入的是同一条 Workflow Run，依赖、并行、验收和人工复核都不另写一套。
- **下游交接**：节点做完后，按画布上的出边在群里 `@` 下游，带上产出短摘要。下游是人工复核时停住等人决定。
- **进度反馈**：节点开始执行后，群聊立即显示「已开始执行」消息，随后通过 SSE 事件和轮询实时刷新 `started` / `progress` / `completed` 等进度消息。
- **清空会话**：可一键清空当前 Workflow 的全部群聊消息（含执行进度记录），操作需二次确认。
- **未点名消息**：没点名的消息只留在群时间线里，不触发任何节点动作。

### Skill 管理

- 维护租户级 Skill 包（如联网访问）。
- 节点可勾选多项 Skill，执行时物化到工作区并交给 Pi。

### 模型与能力

- **模型管理**：注册 Provider（OpenAI / Anthropic / Google / OpenRouter / Ollama 等）与 Model。
- **能力目录**：维护项目能力标识、中文名称和说明，节点从能力目录选择多项能力。
- **模型解析**：`Model Resolver` 按 Agent Version 解析 Provider / Model。
- **执行时使用 Pi 本机默认模型**：Orvia 启动 Pi 时不传 `--provider` 和 `--model`，实际调用使用 Pi 已经配好的默认模型。

### 多租户与鉴权

- **租户隔离**：`ov_tenants` / `ov_users` / 成员角色，项目按租户隔离。
- **登录鉴权**：`POST /api/auth/login` 登录，`GET /api/auth/me` 获取当前用户。
- **生产令牌**：生产环境通过 `ORVIA_API_TOKEN` 进行 Bearer 鉴权。
- **本机默认账号**：开发环境默认 `admin@local.orvia` / `orvia-local`，不登录也可使用默认租户。

### 可观察性

- **SSE 实时事件流**：`GET /api/events/stream`，先发 `ready`，业务事件为 `orvia.event`，每 15 秒一次 `heartbeat`。
- **WebSocket**：`GET /api/events/ws?projectId=` 文本帧推送。
- **执行日志**：面板底部实时显示执行日志，只刷新变化的节点，不重载整个页面。
- **健康检查**：`GET /health` 检查 API、MySQL、Redis，返回 `runtime`、`auth`、`redis`、`version`。
- **指标**：`GET /metrics` 返回当前租户的 Redis 状态和项目数。

### 产物与文件

- **目录结构**：主目录 `~/.orvia/workflows/{工作流名称}/`，`input/` 放开始节点上传文件，`executions/{北京时间}/` 是一轮执行，节点目录用节点名称。
- **文件管理**：开始节点支持上传文件；可读取文本产物（`md`、`txt`、`json`、`csv`、`log`）。
- **本机打开**：面板可在访达中打开主目录或节点交付物目录。

---

## 架构与执行链路

Orvia 采用**图驱动的本机编排运行时**：Workflow 以 DAG（节点 + 有向依赖边）为唯一调度语义；执行时物化为 Plan / Task / Session，由进程内调度器按依赖闭合推进，Agent 任务委托本机 Pi Runtime 完成。

```text
┌─────────────────────────────────────────────────────────┐
│                      编排层 (Orvia)                       │
│  Workflow → Plan → Task → Session                        │
│  调度循环：仅将依赖全部完成的 Task 置为可运行               │
│  Checkpoint 挂起 Run，Decision 决议后续跑                  │
└───────────────────────┬─────────────────────────────────┘
                        │ 委托
┌───────────────────────▼─────────────────────────────────┐
│                   执行层 (Pi Runtime)                     │
│  pi --print --mode json --no-session -- <任务提示>        │
│  stdout/stderr 归一化为 Orvia Event                       │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│                   治理层 (Governance)                     │
│  人工复核 · 退回重做 · 上游产物校验 · 重新规划             │
└─────────────────────────────────────────────────────────┘
```

**关键设计**：

- **编排层**：`execute` 异步受理（HTTP 202），经 Redis 互斥锁进入调度循环。开始 / 结束为边界节点本地闭合；Agent 可并行；Checkpoint 将 Run 置为 `awaiting_decision` 并挂起。群聊里让某个节点开始，进入的是同一次调度，只是起点换成该节点及其下游。
- **执行层**：节点配置（能力、Skill、模型凭证）写入 Task 输入；工作区按「工作流 → 执行轮次 → 节点」落盘；上游产物以**路径引用 + 摘要注入**交接，而非中心化拷贝。
- **治理层**：人工复核支持按上游定向退回；上游验收作为 Agent 前置门禁，不合格触发有限次自动重做或升级为人工决策。`restart` 重建任务图并作废历史进度；`resume` 在图结构一致前提下保留已完成节点，自中断前沿续执行。
- **定位**：Orvia 是编排与治理控制面，Pi 是唯一 Agent Runtime；调度、校验、人工闸门与产物目录由 Orvia 统一负责，模型推理与工具执行由 Pi 完成。

---

## 技术栈

| 层级 | 技术选型 |
|---|---|
| 后端 | Node.js 20+ / TypeScript |
| 数据库 | MySQL 8.x + Drizzle ORM |
| 缓存 / 锁 / 广播 | Redis（本机必需） |
| API | REST 风格 HTTP API |
| 实时推送 | SSE (`/api/events/stream`) + WebSocket (`/api/events/ws`) |
| 前端 | Next.js + TypeScript |
| Agent Runtime | Pi CLI Adapter（`start / wait / pause / resume / stop / shutdown`） |
| 测试 | Node.js 内置 `node --test` + tsx |

---

## 快速开始

### 1. 安装环境和依赖

在仓库根目录执行：

```bash
bash scripts/install-env.sh
```

该命令会安装或复用 Node.js 22、pnpm 9 和 Pi CLI，并安装本仓库的依赖。在 macOS（已有 Homebrew）或 Debian/Ubuntu 上，还会安装并尝试启动 Redis 和 MySQL，并创建名为 `orvia` 的数据库。

Windows 请先自行安装 Node.js 20+、pnpm 9、Redis、MySQL 和 Pi CLI，然后执行：

```bash
pnpm install
pnpm --dir web install --ignore-workspace
copy .env.example .env
copy web\.env.example web\.env.local
```

### 2. 配置环境变量

编辑仓库根目录的 `.env`（由 `.env.example` 复制而来）：

```env
DATABASE_URL=mysql://用户名:密码@127.0.0.1:3306/orvia?charset=utf8mb4&multipleStatements=true&timezone=%2B08%3A00
REDIS_URL=redis://127.0.0.1:6379
WEB_ORIGIN=http://localhost:3000
```

密码含 `@`、`#`、`?`、`&` 等字符时必须 URL 编码。

控制台侧另有 `web/.env.local`（由 `web/.env.example` 复制），只需确认 API 地址：

```env
NEXT_PUBLIC_ORVIA_API_URL=http://127.0.0.1:4100
```

### 3. 配置 Pi

Orvia 执行节点、校验上游产物、侧栏对话和群聊时，都在 API 所在机器上启动 Pi。先确认命令可用：

```bash
pi --version
```

然后进入 Pi，登录厂商并选定默认模型：

```bash
pi
```

在 Pi 里：

1. 执行 `/login`，选择厂商，按提示保存订阅登录或 API Key。凭证写在 `~/.pi/agent/auth.json`。
2. 执行 `/model`，选中要使用的模型，按 `Ctrl+S` 存成新会话的默认模型。Orvia 每次都是一次新的调用，只在当前会话里切换模型不会作用到 Orvia。
3. 需要思考深度时执行 `/thinking`，同样可以用 `Ctrl+S` 保存启动时的级别。

### 4. 启动

开两个终端，都在仓库根目录。

```bash
pnpm dev
```

```bash
cd web
pnpm dev
```

浏览器打开 [http://localhost:3000](http://localhost:3000)。请用 `localhost`，不要用 `127.0.0.1`。

确认 API 健康状态：

```bash
curl http://127.0.0.1:4100/health
```

本机默认账号是 `admin@local.orvia` / `orvia-local`。开发环境不登录也可以使用默认租户。

### 5. 种子数据

```bash
pnpm seed
```

`pnpm seed` 会补齐 `ov_` 表并写入一份可重复的示例数据（Plan → Implement → Human approval 的 Golden Path）。Orvia 只使用 `ov_` 前缀的表。

---

## 配置指南

### 后端环境变量

| 变量 | 默认值 | 必需 | 用途 |
|---|---|---|---|
| `NODE_ENV` | `development` | 否 | 运行环境标识 |
| `HOST` | `127.0.0.1` | 否 | API 监听地址，对外服务时设为 `0.0.0.0` |
| `PORT` | `4100` | 否 | API 监听端口 |
| `DATABASE_URL` | 无 | **是** | MySQL 连接串 |
| `REDIS_URL` | `redis://127.0.0.1:6379` | **是** | Redis 连接串，有密码时 `redis://:密码@127.0.0.1:6379` |
| `PI_COMMAND` | `pi` | 否 | Pi CLI 命令或完整路径 |
| `WEB_ORIGIN` | `http://localhost:3000` | 否 | CORS 与 SSE 来源 |
| `ORVIA_API_TOKEN` | 空 | 生产**是** | Bearer 令牌，`NODE_ENV=production` 时缺失会拒绝启动 |
| `ORVIA_BOOTSTRAP_EMAIL` | `admin@local.orvia` | 否 | 启动时创建的本机管理员 |
| `ORVIA_BOOTSTRAP_PASSWORD` | `orvia-local` | 否 | 仅本机引导密码，不要用于生产 |
| `ORVIA_INTEGRATION_DATABASE_URL` | 无 | 否 | 配置后 `pnpm test` 执行 HTTP Golden Path 集成测试，使用专用空库 |

完整说明见 [环境文档](docs/ENVIRONMENT.md)。

### 端口与访问关系

| 服务 | 默认地址 | 访问者 |
|---|---|---|
| Next.js 控制台 | `http://localhost:3000` | 浏览器 |
| Orvia API | `http://127.0.0.1:4100` | 控制台、脚本、内部服务 |
| Redis | `127.0.0.1:6379` | Orvia API |
| MySQL | `主机:3306` | Orvia API |

---

## 生产部署

### 构建与启动

```bash
pnpm build
pnpm start
```

```bash
pnpm web:build
pnpm web:start
```

生产环境必须设置：

```env
NODE_ENV=production
ORVIA_API_TOKEN=<随机长字符串>
```

### 部署注意事项

- API 进程必须持续运行，后台 Pi 执行依赖它。
- SSE 连接每 15 秒发送 heartbeat，反向代理不得缓冲或过早关闭连接。
- `.env`、`.env.local` 和任何 Provider Secret 不入库。
- 远程 MySQL 使用独立账号、最小权限和网络白名单。
- 生产环境通过 Secret 管理服务注入凭证。

更完整的升级、回滚和排障见 [部署文档](docs/DEPLOYMENT.md)。

---

## 开发与测试

### 常用命令

```bash
pnpm typecheck    # 后端 TypeScript 类型检查
pnpm test         # 运行 test/*.test.ts 全部单测
pnpm build        # 编译 API + Next.js 生产构建
pnpm seed         # 写入示例数据
pnpm check        # typecheck + test + web:build
```

### 测试覆盖

测试文件位于 `test/` 目录，涵盖：

- Pi Runtime Adapter
- Workflow / Task 状态机
- 任务图依赖调度
- Runtime Policy
- Schema 解析
- Replan 自动续跑
- Provider Adapter
- 群聊路由与执行焦点
- 验收规则
- 恢复图（resume graph）

配置 `ORVIA_INTEGRATION_DATABASE_URL` 后会额外执行 HTTP Golden Path 集成测试。

### CI

`.github/workflows/ci.yml` 在 Node.js 22 / pnpm 9 上执行：依赖安装 → 类型检查 → 单元测试 → 前端构建。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [项目设计](docs/PROJECT_DESIGN.md) | 编排、Agent、Workflow 和 Runtime 的关系 |
| [功能状态](docs/STATUS.md) | 当前控制台和已完成能力对照 |
| [API 接口](docs/API.md) | 完整 HTTP 接口文档 |
| [环境配置](docs/ENVIRONMENT.md) | 端口、环境变量、Pi 和数据库约定 |
| [部署运维](docs/DEPLOYMENT.md) | 安装、启动、升级和回滚 |