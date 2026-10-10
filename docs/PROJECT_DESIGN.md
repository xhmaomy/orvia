# Orvia Revision 3 项目设计文档

## 一、设计目标

Orvia 是以人为中心的多 Agent 协作编排平台。它负责把项目、Agent、模型、Workflow、Task、Session、Runtime 和事件串起来，同时保留人工决策入口。

Revision 3 的目标是形成完整 MVP 闭环：图式编排、人工检查点、可版本化计划与产物、知识记忆、
直接对话、基础治理、异步执行和可观察控制台。

## 二、解耦层次

```text
Orvia
  → Agent
    → Agent Runtime
      → LLM Provider
        → Model
```

- Orvia：项目、工作流、任务、会话、事件和人工决策。
- Agent：承担角色、能力和提示词配置。
- Agent Runtime：把统一 Session 协议转换为具体执行进程；当前 MVP 使用 Pi。
- LLM Provider：OpenAI、Anthropic、Google、OpenRouter、Ollama 等可扩展供应商边界。
- Model：具体模型名称、版本和参数。

这两个方向必须保持可替换：Runtime-agnostic 与 LLM Provider-agnostic。

## 三、Agent 与模型关系

```text
Agent
  └── Agent Version
        └── model_id → Model
                         └── provider_id → Model Provider
```

Agent 不直接绑定某个 LLM。Agent Version 可以随着版本变化切换 Model；同一套 Agent 角色可以在不同项目或版本中使用不同厂商模型。各 Agent Version 的 Provider/Model 配置彼此独立，也独立于 Pi CLI 的本机默认 Provider/Model。

## 四、Plan、Workflow Node 与 Edge

Workflow 不直接写死 `gpt-*` 或 `claude-*`。每个项目有一份能力目录，条目包含稳定标识、中文名称和说明。面板上的 Agent 节点可以从能力目录下拉选择多项能力，并按连线把产出交给下一个 Agent。执行时直接跑这些 Agent，Pi 使用本机已配置的模型：

```text
Workflow Node
  → capabilities
    → Agent Registry
      → Agent Version
        → Model
          → Provider
            → Runtime
```

Workflow Definition 的 `nodes` 被持久化为 `ov_workflow_nodes`，`edges` 被持久化为
`ov_workflow_edges`。每个 Workflow 只绑定一条 Run，当前状态写在 `ov_workflows.run_status`。
首次执行生成 Plan，并为每个 Node 物化 Task/Session；入边源节点
写入 Task 的 `dependsOnNodeIds`。只要这条 Run 不是运行中，就可以再次执行。已经跑过一次时，要在 execute 里选择 `restart`（从头开始）或 `resume`（从当前停下的节点继续）。执行器每轮选择所有依赖均已完成的 pending/blocked Task，
因此可以表达链式、分叉和汇合依赖。互不依赖的非 Checkpoint 任务会并行执行；Checkpoint 仍串行等待人工决策。

面板上的任务称为 Agent 节点，按连线协作。Checkpoint 是人工复核，不启动 Runtime，而是进入人工决策。Agent 节点和人工复核可以在画布上点开直接对话。这些指导会保留，之后执行时写进提示。开始和结束只负责交接，不参与对话。执行过程中也可以直接对话。当前这次执行不会中途改口，新的指导留给这个 Agent 之后的执行。

Agent 节点可以写上游产物校验规则。规则按条添加，每一条都是不合格条件，满足任意一条即不合格。一条都没有时，直接交给它的内容视为合格。有规则时，它先验收再做自己的工作。不合格只退回交出这份内容的节点，由执行器安排重跑，不需要循环配置，也不画回头线。退回次数有上限。来自开始节点、次数用尽或判断不清时，生成一条不挂检查点的 Decision，人可以选择再做一次或批准继续。判断结果留在这个 Agent 节点上，点「合格」或「不合格」可以查看检查了谁、用的规则和判断说明。除开始和结束外，节点「⋯」里可以打开当前交付物目录，路径不显示在节点上。从头开始时，这些进度和校验结果会清掉，退回次数也重新计算。

## 五、Checkpoint、Decision 与 Replan

Checkpoint 会创建 `ov_checkpoints` 与 `ov_decisions`，并暂停 Run。Decision 支持五种动作：

- `approve`：批准检查点并继续。
- `request_changes`：记录需修改并触发 Replan。
- `reject`：拒绝并令 Run 失败。
- `override`：人工覆盖并继续。
- `replan`：显式触发 Replan。

Replan 会在事务中 supersede 当前 Plan、创建递增版本的新 Plan、重新关联和重置未完成/失败 Task、
supersede 待处理 Checkpoint/Decision，并更新 Run 的 `currentPlanVersion`。已完成 Task 保留。
请求体可只带 `reason` 复制原图，也可带 `definitionJson` 替换剩余任务图。默认自动续跑。

## 六、运行时与异步执行

`AgentRuntimeAdapter` 统一定义启动、暂停、恢复、等待完成和事件输出。Pi 是 v0.1 必需且唯一的 Runtime 实现；`PiRuntimeAdapter` 将协议转换为 API 所在本机或云端主机的 Pi CLI：

```text
pi --print --mode json --no-session
```

Pi 的 stdout/stderr 被归一化为 Orvia Event，写入 `ov_events` 并通过 SSE 推送给 Control Center。安装路径通过 `PI_COMMAND` 注入，领域层不依赖操作系统目录。未来只有实现完整 Session、工具和进程控制协议的 Runtime Adapter 才能替换 Pi；普通 Provider HTTP 请求不能替代 Runtime。

Model Resolver 仍按 Agent Version 解析 Provider/Model，供控制台和匹配使用。启动 Pi 时不传 `--provider` 和 `--model`，实际调用使用 Pi 本机已经配好的默认模型。

Run execute 与面板上的 Agent 对话均以 HTTP 202 接收，实际 Pi 工作在请求返回后继续。服务内存中防止
同一 Run 重复执行；进程启动时会把中断的 running Run/Task 恢复为可人工处理的 paused 状态。
SSE 在 `ready` 后发送业务事件，并每 15 秒发送 heartbeat。

## 七、当前先不做的治理能力

Artifact 目录、Memory、独立 Direct Chat、Permission Policy、Budget 和监控告警先从主流程拿掉。节点产出写在 Workflow 目录，和 Agent 的沟通写在 `ov_node_messages`。这些能力等主流程跑通后再加回对应的表和页面。

## 八、核心数据对象

| 对象 | 作用 |
|---|---|
| Project | 隔离 Agent、Workflow、模型和运行数据 |
| Model Provider | 保存供应商类型、地址和非敏感配置 |
| Model | 保存具体模型标识和参数 |
| Agent | 保存角色与能力 |
| Agent Version | 保存提示词、能力快照和 `model_id` |
| Workflow | 保存工作流定义 |
| Workflow Node | 保存节点顺序，以及一份能力标识列表 |
| Workflow Edge | 保存节点依赖与可选条件数据 |
| Workflow Run | 保存一次工作流运行 |
| Plan | 保存 Run 的版本化执行图 |
| Task | 保存节点执行任务及状态 |
| Session | 保存一次 Agent Runtime 会话 |
| Checkpoint | 保存人工检查点状态 |
| Node Message | 保存面板上某个 Agent 的指导对话 |
| Event | 保存统一事件流 |
| Human Decision | 保存暂停点的人工作业和决定 |

## 九、Control Center 与可观察性

Control Center 当前包含 Overview、模型管理、能力目录和 Workflow Builder。执行日志、人工复核和 Agent 对话都在 Workflow 面板上。

健康检查 `/health` 验证数据库并返回 Runtime 和 Revision 版本；事件历史与 SSE 实时流共同支持排障。

## 十、技术实现

- 后端：Node.js + TypeScript。
- 数据库：MySQL 8.x。
- ORM：Drizzle ORM。
- API：REST 风格 HTTP API。
- 实时：SSE 与 `/api/events/ws` WebSocket。
- 前端：Next.js + TypeScript。主导航是 Overview、模型管理、能力、Workflow Builder。
- Runtime：Pi CLI Adapter。互不依赖的任务并行执行。
- 部署：本机原生 API + Next.js 双进程。
- 多租户：Tenant / User / 成员角色，Project 归属租户。
- Redis：本机必需。执行锁、登录会话、SSE 广播。领域事件写入 MySQL 后经 Redis Pub/Sub 扇出。
- 指标：`/metrics` 返回 Redis 状态和项目数。告警先不做。
- 鉴权：生产环境 `ORVIA_API_TOKEN`。

## 十一、种子数据与 CI

表结构定义在 `src/db/schema.ts`。`pnpm seed` 创建可重复使用的 Golden
Path 示例（Plan → Implement → Human approval）。CI 在 Node.js 22 / pnpm 9 上执行
锁文件安装、类型检查、Node 测试与前端构建。

## 十二、已实现范围

已实现完整 MVP，逐项对照见 [STATUS.md](STATUS.md)：Provider/Model/Agent Version 解析、
Plan/Workflow Edge、多节点依赖与并行就绪任务、Checkpoint/Decision、真实 Replan 并默认自动续跑、
面板 Agent 对话、异步 execute 202、SSE heartbeat、启动时修补缺失列/索引/外键、健康检查、seed 与 CI。

## 十四、范围边界

### 14.1 排除项

保留 Temporal/Kubernetes、生产级外部 Secret、自动化费用结算、Kafka。同一台机器上互不依赖的任务会并行执行。多租户和本机 Redis 已纳入实现。Artifact、Memory、独立 Direct Chat、Permission Policy、Budget 和监控告警先不做，等主流程跑通后再加。
