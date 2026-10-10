# Orvia Revision 3 环境说明

本文档说明完整 MVP 所需的软件、端口、环境变量、数据库约定和多厂商模型凭证边界。

## 一、软件环境

| 项目 | 要求 | 说明 |
|---|---|---|
| Node.js | 20+ | 后端、脚本和 Next.js 运行时 |
| pnpm | 9+ | 依赖安装与项目脚本 |
| MySQL | 8.0+ | 持久化数据库，可远程部署 |
| Redis | 本机已安装并监听 | API 启动必需；用于锁、登录会话、SSE 事件广播 |
| Pi CLI | 已安装并已配置模型凭证 | Workflow Session 与面板 Agent 对话实际执行时需要 |
| 浏览器 | 支持 EventSource | 用于 Control Center SSE 实时事件 |

macOS / Linux 执行 `bash scripts/install-env.sh` 即可安装 Node.js、pnpm、Pi CLI、项目依赖，并在有 Homebrew 或 apt 时安装并启动 Redis 和 MySQL。

## 二、后端变量

| 变量 | 默认值 | 是否必需 | 用途 |
|---|---|---|---|
| `NODE_ENV` | `development` | 否 | 运行环境标识 |
| `HOST` | `127.0.0.1` | 否 | API 监听地址。对外提供服务时可设为 `0.0.0.0` |
| `PORT` | `4100` | 否 | API 监听端口 |
| `DATABASE_URL` | 无 | 是 | MySQL 连接串 |
| `PI_COMMAND` | `pi` | 启动 API 否；执行 Session 或面板对话时是 | Pi CLI 命令或完整路径 |
| `OPENAI_API_KEY` | 空 | 按模型厂商 | 由 Pi 读取的 OpenAI 凭证 |
| `ANTHROPIC_API_KEY` | 空 | 按模型厂商 | 由 Pi 读取的 Anthropic 凭证 |
| `WEB_ORIGIN` | `http://localhost:3000` | 否 | CORS 与 SSE 来源 |
| `ORVIA_API_TOKEN` | 空 | 生产环境是 | Bearer 令牌。`NODE_ENV=production` 时缺失会拒绝启动 |
| `ORVIA_INTEGRATION_DATABASE_URL` | 无 | 否 | 配置后 `pnpm test` 会执行 HTTP Golden Path 集成测试。请使用专用空库，不要指向生产数据 |
| `REDIS_URL` | `redis://127.0.0.1:6379` | 是 | 本机 Redis。有密码时写成 `redis://:密码@127.0.0.1:6379`。连不上时 API 拒绝启动 |
| `ORVIA_BOOTSTRAP_EMAIL` | `admin@local.orvia` | 否 | 启动时创建的本机管理员 |
| `ORVIA_BOOTSTRAP_PASSWORD` | `orvia-local` | 否 | 仅本机引导密码，不要用于生产 |

推荐连接串：

```env
DATABASE_URL=mysql://用户名:密码@主机:3306/数据库名?charset=utf8mb4&multipleStatements=true&timezone=%2B08%3A00
```

密码包含 `@`、`#`、`?`、`&` 等字符时必须 URL 编码。不要把真实密码写入示例、日志或 Git。

## 三、前端变量

文件位置：`web/.env.local`。

| 变量 | 默认值 | 用途 |
|---|---|---|
| `NEXT_PUBLIC_ORVIA_API_URL` | `http://127.0.0.1:4100` | 浏览器访问 Orvia API 的地址 |

该变量会被编译进浏览器端代码，因此不能放置数据库密码或 Provider API Key。

## 四、端口与访问关系

| 服务 | 默认地址 | 访问者 |
|---|---|---|
| Next.js Control Center | `http://localhost:3000` | 浏览器 |
| Orvia API | `http://127.0.0.1:4100` | 控制台、脚本、内部服务 |
| Redis | `127.0.0.1:6379` | Orvia API |
| MySQL | `主机:3306` | Orvia API |

## 五、Pi

Pi 是 v0.1 必需的 Agent Runtime，包名 `@earendil-works/pi-coding-agent`。Orvia 在本机或服务器执行 Workflow 和面板上的 Agent 对话时调用：

```bash
pi --print --mode json --no-session -- <任务提示>
```

Orvia 启动 Pi 时不传 `--provider` 和 `--model`。模型和访问凭证用 Pi 本机已经配好的默认配置，例如你在 Pi 里配置的 MiniMax-M3。`.env` 的 `PI_COMMAND` 默认是 `pi`，启动 API 的进程必须能在 `PATH` 中找到它。Orvia 的领域层只依赖 `AgentRuntimeAdapter`，不依赖 Pi 的安装路径或操作系统目录。云端主机同样安装 Pi。

Pi 本身不需要订阅。先运行 `pi`，用 `/login` 保存凭证，再用 `/model` 选出模型并按 `Ctrl+S` 存成默认模型。也可以在启动 API 的环境里设置厂商 API Key。配置步骤见 [README 的「配置 Pi」](../README.md#3-配置-pi)。

密钥不要写入数据库、Git 或文档。可用下面的命令确认命令和凭证：

```bash
pi --version
pi auth check --provider openai
```

把 `openai` 换成实际使用的厂商。

## 六、模型厂商配置边界

Orvia 的领域模型支持 `Model Provider → Model → Agent Version` 关系。`models` 表保存模型标识和参数配置，但不把 API Key 写入数据库。模型凭证由 Pi 进程环境、登录会话或外部 Secret 管理。Provider Adapter 负责模型协议；它不能替代负责工具、进程、暂停和恢复的 Pi Runtime。

Workflow 节点从能力目录声明一项或多项 `capability`。执行时直接跑面板上的节点，Pi 使用本机已配置的模型，不再按 Agent 目录匹配。和 Agent 沟通在面板侧栏完成。复杂 fallback 与自动 routing 不属于当前 MVP。

## 七、数据与运行边界

功能是否完成、控制台视图和 Golden Path 见 [STATUS.md](STATUS.md)。

- 表结构：`src/db/schema.ts`。API 进程在对外监听前补齐缺失表，并自动修补缺失列、索引和外键。
- Workflow、Session 与面板 Agent 对话都通过 Pi Runtime 执行；Provider 类型、模型和凭证由 Pi 接收。
- `pnpm seed` 会先补齐并修补表结构，再创建 Revision 3 Golden Path 和 Workflow Edges。启动时也会删掉当前主流程不再使用的旧表。
- Run execute 与 Chat message 返回 202；API 进程必须持续运行才能完成后台 Pi 执行。
- SSE 连接由 API 维护，每 15 秒发送 heartbeat；反向代理不得缓冲或过早关闭连接。
- Permission Policy 的 allow/deny 参与 Agent 解析；`tools` 与工作目录约束会传给 Pi。Budget 在额度耗尽后原子拒绝新的派发。两者没有额外环境变量，也不等于完整身份授权或自动计费。
- Artifact/Memory/Chat 数据保存在 MySQL；生产环境升级前必须纳入备份。

## 八、环境检查

```bash
node --version
pnpm --version
mysql --version
redis-cli ping
pi --version
pnpm typecheck
pnpm test
pnpm web:build
```

数据库检查使用：

```bash
pnpm seed
curl http://127.0.0.1:4100/health
```

以上命令仅列出检查路径；未保存实际输出前不得记录为已通过。

## 九、安全基线

- `.env`、`.env.local` 和任何 Provider Secret 不入库。
- 远程 MySQL 使用独立账号、最小权限和网络白名单。
- 生产环境通过 Secret 管理服务注入凭证。
- 前端公开变量只放地址和非敏感开关。
- 诊断日志不得打印完整连接串或 API Key。
