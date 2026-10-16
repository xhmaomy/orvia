# Orvia Revision 3 功能完成情况

对照正式基线 `../outputs/Orvia_v0.1_Product_Technical_Specification_Revision_3.docx` 的 §14「包含」项。当前已达到本机调试基线；Pi 是 v0.1 必需且唯一的 Agent Runtime Adapter，后续云端部署仍使用同一 Runtime 接口。规格 §14.1 排除的分布式基础设施仍然不做。

## 一、完成结论

| 判断 | 说明 |
|---|---|
| 功能开发 | 已完成 Revision 3 §14 列出的 MVP 能力 |
| 自动化验证 | 后端类型检查与单测通过（含 Runtime Policy、Schema 解析、Pi 输出解析）；控制台生产构建生成八个静态路由；本机真实 Pi Golden Path 已通过。HTTP Golden Path 集成测试在配置 `ORVIA_INTEGRATION_DATABASE_URL` 时执行 |
| 数据库 | API 对外监听前补齐缺失表，并自动修补缺失列/索引/外键；`pnpm seed` 同样执行修补 |
| 控制台 | Overview / 模型管理 / 能力 / Skill / Workflow Builder。执行日志、人工复核和 Agent 对话都在面板上；Agent 在 Workflow 节点维护，无独立 Agents 页 |
| 未纳入本轮 | 复杂模型 fallback、Temporal/Kubernetes、生产级 Secret 与自动费用结算 |

## 二、规格对照

| 规格能力 | 状态 | 实现位置 |
|---|---|---|
| Project / Agent / Agent Version | 已完成 | `src/db/schema.ts`、`src/api/server.ts`；Agent 由 Workflow 节点物化维护 |
| Model Provider / Model | 已完成 | Provider/Model CRUD；执行时使用 Pi 本机已配置的默认模型，不把厂商和模型名传给 Pi |
| Model Resolver | 已完成 | `src/application/model-resolver.ts`：能力匹配与 Provider 校验。面板节点直接使用 Pi 本机模型 |
| Permission → Pi | 暂缓 | 主流程先不限制工具。`runtime-policy.ts` 仍保留，供以后接回 |
| Budget 硬限额 | 暂缓 | 额度表已从当前库中移除，主流程不再预占 |
| Direct Chat | 暂缓 | 独立对话页和 `ov_chat_*` 已移除。和 Agent 沟通走面板侧栏 `ov_node_messages` |
| Workflow / Workflow Run | 已完成 | 多节点 `nodes` + `edges`。每个 Workflow 一条 Run，`ov_workflows.run_status` 与该 Run 同步；非运行中都可以执行 |
| Task / Session / Event | 已完成 | 顺序依赖调度、Pi Session、`ov_events` + SSE |
| Human Checkpoint / Decision | 已完成 | `approve` / `request_changes` / `reject` / `override` / `replan` / `repeat`。在 Workflow 面板处理 |
| Artifact / Memory | 暂缓 | 产物写在节点目录。`ov_artifacts`、`ov_memories` 已移除 |
| Pi Runtime Adapter | 已完成 | `src/runtime/pi-adapter.ts`：start / wait / pause / resume / stop / shutdown |
| 多租户账号 | 已完成 | `ov_tenants` / `ov_users` / 成员角色；项目按租户隔离；控制台可登录与切换 |
| Redis | 已完成 | 本机 `REDIS_URL`（默认 `redis://127.0.0.1:6379`）必需；用于锁、会话、事件广播 |
| 监控告警 | 暂缓 | `/metrics` 仍返回 Redis 与项目数。告警表和 Monitoring 页已移除 |
| MySQL + Drizzle | 已完成 | `src/db/schema.ts`，表名一律 `ov_` 前缀 |

## 三、本轮额外补齐（规格要求但早期代码缺失）

- Plan / Workflow Edge / 无环依赖图校验
- 真实 Replan（Plan 版本递增，事务内 supersede；默认自动续跑，`resume: false` 可停在 paused）
- 异步 `POST /execute` 与面板 Agent 对话（HTTP 202）
- 进程重启后把中断的 running Run 恢复为 paused
- Replan 后控制台在面板上继续处理人工复核
- Workflow 创建、Run 物化、Checkpoint/Decision、Replan 使用数据库事务
- SSE `ready` + `heartbeat`
- `/health` 区分 database ok / error / schema_incomplete
- 启动时修补缺失列/索引/外键
- `pnpm seed`、`.github/workflows/ci.yml`、可选 `ORVIA_INTEGRATION_DATABASE_URL` 集成测试

## 四、Golden Path

```text
创建 Project
  → 注册 Provider 与 Model
  → 在 Workflow 画布配置 Agent 节点（能力 / 模型 / Skill）与 Checkpoint
  → 创建 Workflow Run（生成 Plan / Task / Session）
  → POST /execute（202）
  → Resolver 按节点选择 Model / Provider
  → Pi 执行 Task，写入 Event，文件落在节点目录
  → Checkpoint 进入 awaiting_decision
  → 在 Workflow 面板批准 Decision
  → Workflow 继续并完成
```

控制台对应路径：模型管理与能力 / Skill 目录 → Workflow Builder 建图、执行、看日志，并在面板上处理人工复核。

## 五、控制台信息架构

控制台当前保留这些页面，组件在 `web/components/ControlCenter.tsx`：

| 视图 | 用途 |
|---|---|
| `/` Overview | 项目指标、SSE/WebSocket 连接、最近事件 payload |
| `/models` 模型管理 | 打开先看已添加的模型；创建 Provider / Model 在弹窗里完成 |
| `/capabilities` 能力 | 维护项目能力目录：标识、中文名称、说明 |
| `/skills` Skill 管理 | 维护租户级 Skill；节点可勾选 |
| `/workflows` Workflow Builder | 列表在外，并显示这条 Workflow 绑定的 Run 状态。打开面板会带上开始和结束。开始填写需求描述或上传文件，交给后面的 Agent；Agent 节点填写任务说明、产出要求和按条添加的上游产物校验规则，每一条都是不合格条件。执行后每个 Agent 会显示自己的进度：待处理、等待上游、进行中、已完成、失败或等待确认。进度刷新只改变化的节点，不重载整个页面。面板有「循环」，把任务和人工复核组成可重复的一段。面板顶栏显示主目录 `~/.orvia/workflows/{Workflow名称}/`，点击后在访达中打开。同名目录全部用序号区分，例如「产品研发小组-1」。节点产物目录用节点名称，例如「需求分析」；同一轮里重名则为「需求分析-1」。除开始和结束外，节点「⋯」里的「交付物」可以在访达中打开当前目录，路径不显示在节点上。编码工作目录就是这个目录，暂不能指定外部路径。在画布上点 Agent 节点或人工复核，右侧可以和这个 Agent 对话，执行过程中也可以对话，指导会留到之后的执行里。添加和编辑 Agent 节点用弹窗填写，编辑从节点「⋯」进入，点保存后写入。Agent 在发布后和 Run 之后都可以拖动。节点右下角可以拖动改变大小，松手后会保存。右侧对话栏可以拖分隔线调整宽度。日志栏可拖动上沿调整高度。只要没在运行，点「执行」就会跑这条唯一的 Run。已经执行过再点执行，会先问从头开始，还是从当前停下的 Agent 继续。从头开始会清掉各节点的进度和校验结果。运行中点执行会提示先停止。运行中不能改 Agent；停止后可以编辑。执行过程看面板底部日志。等待人工复核时，日志上方可以直接批准、再做一次、要求修改、重新规划、拒绝或 Override。删除会去掉节点、连线、Run 和执行日志，数据无法恢复。执行直接使用面板上的 Agent 节点。 |

## 六、新增数据表

当前表包括：

- `ov_capabilities`
- `ov_workflow_edges`
- `ov_plans`
- `ov_checkpoints`
- `ov_node_messages`
- `ov_events`

并扩展 `ov_workflow_runs`、`ov_tasks`、`ov_sessions`、`ov_decisions`、`ov_workflow_nodes` 的状态与关联字段。

## 七、测试与交付脚本

| 命令 | 作用 |
|---|---|
| `pnpm typecheck` | 后端 TypeScript 检查 |
| `pnpm test` | `test/*.test.ts`：Pi Adapter、状态机、任务图、Runtime Policy、Schema 解析、Budget 原子预占、Replan 自动续跑、Provider；配置 `ORVIA_INTEGRATION_DATABASE_URL` 时再跑 HTTP Golden Path |
| `pnpm build` | `tsc` 编译 API + Next.js 生产构建 |
| `pnpm seed` | 可重复写入 Demo Project / Agent / Golden Path Workflow / Budget |
| CI | `.github/workflows/ci.yml`：install、typecheck、test、build |

## 八、明确未做

- 复杂 Model Routing、自动竞价、跨 Provider 智能降级
- Temporal / Kubernetes
- 生产级外部 Secret 托管（Vault 等）与自动费用结算
- Windows 上 Pi 进程暂停仍不可用
- Pi 本机需要已经配好默认模型和访问凭证。Orvia 不把厂商和模型名传给 Pi。没有凭证时不会伪造一次成功执行

已补齐的调试能力：生产 Bearer 鉴权与 1MB 请求体限制、WebSocket `/api/events/ws`、互不依赖任务的并行执行、Replan 可提交新的 `definitionJson` 并默认自动续跑、Checkpoint 事件实时广播、`awaiting_decision` 状态守卫、Replan/Reject 停止活跃 Pi Session、八个控制台路径、Artifact 追加版本与 Memory 闭环、失败或暂停任务重试、启动前表/列/索引修补、正确的生产入口和跨 CPU 的 Webpack 开发启动。本阶段只走本机双进程。

## 九、使用前必须做

1. 配置 `.env` 的 `DATABASE_URL`。生产环境同时设置 `NODE_ENV=production` 与 `ORVIA_API_TOKEN`。
2. 启动 `pnpm dev` 与 `cd web && pnpm dev`。控制台请用 `WEB_ORIGIN` 对应的地址打开，默认是 `http://localhost:3000`。
3. 实际跑 Agent 前，在 API 所在本机或云端主机安装并登录 Pi CLI。
4. 按 [验收清单](V0.1_ACCEPTANCE.md) 在目标环境勾选带 Pi 的黄金路径。
