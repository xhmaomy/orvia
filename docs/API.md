# Orvia API

默认地址：`http://127.0.0.1:4100`。路由以 `src/api/server.ts` 为准。

## 约定

- 开发环境不设置 `ORVIA_API_TOKEN` 时，接口开放。生产环境（`NODE_ENV=production`）必须配置令牌，请求带 `Authorization: Bearer <token>`。
- `/health` 和 CORS 预检不要求令牌。SSE 与 WebSocket 用查询参数 `access_token`。
- JSON 请求体上限 1MB，超出返回 413。
- 多租户请求带 `X-Orvia-Tenant-Id`。登录用 `POST /api/auth/login`，当前用户用 `GET /api/auth/me`。项目只在当前租户内可见。
- API 启动必须连上 `REDIS_URL`（默认 `redis://127.0.0.1:6379`）。

## 健康与指标

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 检查 API、MySQL、Redis。成功时包含 `runtime`、`auth`、`redis.status`、`redis.url`、`version`。数据库或 Redis 不可用返回 503 |
| GET | `/metrics` | 当前租户的 Redis 状态和项目数 |

## 项目、能力、模型

| 方法 | 路径 | 说明 |
|---|---|---|
| GET, POST | `/api/projects` | 项目列表、创建 |
| GET, POST | `/api/tenants` | 租户 |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/register` | 注册 |
| GET | `/api/auth/me` | 当前用户 |
| GET, POST | `/api/capabilities?projectId=` | 能力目录 |
| PATCH | `/api/capabilities/:id` | 修改能力名称或说明。标识创建后不变 |
| GET, POST | `/api/model-providers` | 模型厂商 |
| PATCH | `/api/model-providers/:id` | 修改厂商 |
| GET, POST | `/api/models` | 模型 |
| PATCH | `/api/models/:id` | 修改模型 |
| GET | `/api/model-resolver?projectId=` | 解析 Agent Version、Model、Provider |

控制台里的模型记录不传给 Pi。执行时使用 Pi 本机已经保存的默认模型。

## Agent

| 方法 | 路径 | 说明 |
|---|---|---|
| GET, POST | `/api/agents?projectId=&workflowId=` | Agent 列表、创建 |
| PATCH | `/api/agents/:id` | 修改 Agent |
| GET, POST | `/api/agent-versions` | 版本。创建时用 `modelId` 绑定模型 |
| PATCH | `/api/agent-versions/:id` | 修改版本 |

`POST /api/agents` 可选 `workflowId`。传入时必须是同一项目、同一租户下的 Workflow。不传则是项目级 Agent。

## Workflow

| 方法 | 路径 | 说明 |
|---|---|---|
| GET, POST | `/api/workflows` | 列表、创建 |
| PATCH, DELETE | `/api/workflows/:id` | 修改或删除 |
| GET | `/api/workflows/:id/nodes` | 节点、连线、循环和主目录 `root` |
| GET, POST, DELETE | `/api/workflows/:id/files` | 开始节点的上传文件 |
| POST | `/api/workflows/:id/open` | 在本机打开目录 |
| GET | `/api/workflows/:id/file?path=` | 读取产物文件内容 |
| GET, POST | `/api/workflows/:id/nodes/:nodeKey/messages` | 节点对话 |

### 定义

`definitionJson` 包含 `nodes`、`edges`、`loops`。

- 开始（`start`）保存本轮需求，结束（`end`）不调用模型。打开节点列表时若缺少二者，会自动补上。
- 任务节点用 `capabilities` 声明能力，并可带 `instruction`（任务说明）和 `outputRequirement`（产出要求）。产出要求会写进提示和 `任务.md`。
- `acceptanceRule` 是上游产物校验规则，多条用换行分隔。每一条都是不合格条件，满足任意一条即不合格。留空则视为合格。`maxRedos` 是最多退回次数，默认 3。
- 人工复核节点类型为 `checkpoint`。
- `loops` 为 `{ key, nodeKeys, maxIterations }`。新建时循环次数默认 1。组内至少有一个任务和一个人工复核。开始和结束不能进循环，节点不能同时属于两个循环。图必须无环。

控制台新建 Workflow 时 `status` 为 `draft`。`PATCH` 把 `status` 改为 `published` 即发布，并替换节点与连线。有正在运行的 Run 时修改返回 409，需要先停止。

`DELETE` 会删掉节点、连线、Run、执行日志，以及 `workflow_id` 指向它的 Agent。数据无法恢复。项目级 Agent 会保留。

### 目录和文件

主目录是 `~/.orvia/workflows/{项目名}/{Workflow名称}/`。改名后目录跟着改。同一层重名时全部加上序号，例如 `名称-1`。只有一个时不加序号。老版本建的目录留在原处，不会被搬动。

- `input/` 放开始节点上传的文件。
- `executions/{北京时间}/` 是一轮执行。同一秒再次执行时目录同样用序号区分。
- 节点目录用节点名称。同一轮里两个「需求分析」会是 `需求分析-1`、`需求分析-2`。重做放在 `第N次`，上一轮文件留在原目录。

`POST /api/workflows/:id/files` 的请求体是文件本身，文件名放在请求头 `x-orvia-filename`（`encodeURIComponent`）。`GET` 返回目录和文件列表。`DELETE ?name=` 删除其中一个。

`POST /api/workflows/:id/open` 打开主目录。请求体带 `directory` 时，打开该 Workflow 下的某个交付物目录。路径不显示在节点上。

`GET /api/workflows/:id/file?path=` 读取文本产物（`md`、`txt`、`json`、`csv`、`log`）。其它文件返回 `binary: true`，由调用方在本机打开。

### 节点对话

`POST /api/workflows/:id/nodes/:nodeKey/messages`，请求体 `{ "content": "指导" }`，返回 202。侧栏先流出思考过程，再流出正文。之后的执行只带上正文。

执行过程中也可以发送。当前这次执行不会中途改口。开始和结束不参与对话。这个 Agent 正在回复时再发一条，返回 409。

## Run

每个 Workflow 只有一条 Run。再次创建时返回已有的那一条。状态同时写在 `ov_workflows.run_status`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET, POST | `/api/workflow-runs` | 列表、创建 |
| GET | `/api/workflow-runs/:id` | 聚合 Plan、Task、Session、Checkpoint、Decision、Event |
| GET | `/api/workflow-runs/:id/summary` | 每个节点的进度和产物文件名 |
| POST | `/api/workflow-runs/:id/execute` | 开始执行，返回 202 |
| POST | `/api/workflow-runs/:id/stop` | 停止 |
| POST | `/api/workflow-runs/:id/pause` | 暂停。只有 `running` 可以暂停 |
| POST | `/api/workflow-runs/:id/resume` | 从暂停继续。只有 `paused` 可以恢复 |
| POST | `/api/workflow-runs/:id/replan` | 重新规划 |

`execute` 成功时：

```json
{"workflowRunId":1,"status":"accepted"}
```

- Run 不是 `running` 时都可以执行。正在运行返回 409。
- 第一次执行（仍是 `pending`）可以不带 `mode`。
- 已经执行过必须带 `mode`：`restart` 从头开始，新建一轮目录，清掉节点进度和校验结果，退回次数重新计算；`resume` 从停下的节点继续。没带 `mode` 返回 400。
- 节点已经改过，或这次已经全部完成，`resume` 返回 409。
- `stop` 结束正在跑的 Pi，Run 标为 `cancelled`，未完成任务改为 `cancelled`，未处理的检查点和决策改为 `superseded`。停止后可以改节点。
- `awaiting_decision` 不能直接 resume。先处理 Decision。
- `replan` 先停掉正在跑的 Pi。当前 Plan 标为 `superseded`，新建递增版本。默认自动续跑；`resume: false` 则停在暂停。可以只带 `reason`，也可以带新的 `definitionJson`。

互不依赖的非人工复核任务会并行执行。结束节点汇总整条流程的进度和各节点产物文件名，并写入 `结果.md`。

## Task 与 Session

| 方法 | 路径 | 说明 |
|---|---|---|
| GET, POST | `/api/tasks` | 任务 |
| GET | `/api/tasks/:id` | 任务及 Session |
| POST | `/api/tasks/:id/pause` | 暂停 |
| POST | `/api/tasks/:id/resume` | 继续 |
| POST | `/api/tasks/:id/retry` | 重试失败或暂停的任务 |
| GET, POST | `/api/sessions` | 会话 |
| GET | `/api/sessions/:id` | 会话详情 |
| POST | `/api/sessions/:id/start` | 启动 Pi |
| POST | `/api/sessions/:id/pause` | 暂停 |
| POST | `/api/sessions/:id/resume` | 继续 |

没有 `POST /api/sessions/:id/execute`。启动用 `/start`。

面板上的 Agent 节点启动 Pi 时不传厂商和模型名。Pi 使用本机默认模型。

## Decision

| 方法 | 路径 | 说明 |
|---|---|---|
| GET, POST | `/api/decisions` | 决策 |
| POST | `/api/decisions/:id/resolve` | 处理决策 |
| GET | `/api/checkpoints` | 检查点 |
| GET | `/api/plans` | 计划 |

`resolve` 的 `action`：

| action | 结果 |
|---|---|
| `approve` | 批准并继续 |
| `override` | 人工覆盖并继续 |
| `reject` | Run 失败 |
| `request_changes` | 重新规划并默认继续 |
| `replan` | 重新规划并默认继续 |
| `repeat` | 再做一次当前循环 |

上游产物校验停下来时，`context.kind` 为 `acceptance`。这时只用「批准继续」和「再做一次」。

```bash
curl -X POST http://127.0.0.1:4100/api/decisions/1/resolve \
  -H 'content-type: application/json' \
  -d '{"decision":"Looks good","action":"approve"}'
```

## 事件

| 方法 | 路径 | 说明 |
|---|---|---|
| GET, POST | `/api/events` | 事件列表、写入。`limit` 默认 50，最大 100，可用 `offset` |
| GET | `/api/events/stream?projectId=` | SSE |
| GET | `/api/events/ws?projectId=` | WebSocket，文本帧 |
| GET | `/api/control-center?projectId=` | 控制台汇总 |

SSE 先发 `ready`，业务事件为 `orvia.event`，每 15 秒一次 `heartbeat`。业务事件同时写入 `ov_events`。

`GET /api/control-center` 里，`counts.decisions` 只统计 `pending`，`counts.events` 统计全部事件，`recentEvents` 只返回最近 20 条。

## 错误排查

| 现象 | 处理 |
|---|---|
| `/health` 里数据库失败 | 检查 `DATABASE_URL`、MySQL 网络和权限 |
| `schema_incomplete` | 启动会先建表再补列、索引和外键。仍失败时对照 `src/db/schema.ts` |
| Redis 异常 | `/health` 为 503。检查 `REDIS_URL` |
| 浏览器跨域 | 检查 `WEB_ORIGIN` 与 `NEXT_PUBLIC_ORVIA_API_URL` |
| Session 启动失败 | 检查 `PI_COMMAND` 和 `pi --version`，以及 Pi 的默认模型 |
| 运行中不能改 Workflow | 先 `stop`，再 `PATCH` |
| `awaiting_decision` 不能 resume | 先处理 Decision |
