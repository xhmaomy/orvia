# Orvia

Orvia 是一个在本机运行的多 Agent 协作编排工具。你在画布上把多个 Agent 连成一条工作流，由 Orvia 按连线把上游产出交给下一个 Agent，并在需要时停下来让人决定。真正执行任务的是本机的 Pi CLI。Orvia 负责编排、目录、对话和人工复核，不替代模型本身。

当前版本按本机双进程运行：API 在 `4100`，控制台在 `3000`。

## 能做什么

### 画布与执行

- 在 Workflow 画布上添加 **开始 / Agent / 人工复核 / 结束**，连线、拖动、调整大小。
- **连线决定依赖**：谁等谁、退回给谁，看边不看位置。未接到开始节点的孤立节点不会执行。
- 每个 Agent 配置任务说明、产出要求、**模型**、能力与可选 **Skill**。
- 产物落在 `~/.orvia/workflows/{工作流名称}/`，按执行轮次与节点名称分目录。
- 每个 Workflow 一条 Run。未运行时可再次执行，并选择 **从头开始** 或 **从停下的节点继续**。
- 支持把一段 Agent + 人工复核配成 **循环**。

### 人工复核

- 流程走到人工节点会停住，等待批准 / 退回 / 拒绝。
- **按上游节点分别复核**：每个上游一张卡片，可写说明、打开交付物、单独退回。
- **退回此节点**：只重跑被点名的上游 Agent；不能退回到人工节点。
- **全部批准**：各节点说明可选；未填则记为「批准」。
- 每次操作的说明按节点写入历史，可在复核面板查看。

### 上游产物校验

- Agent 上可按条配置不合格条件；满足任意一条则不合格。
- 不合格时自动退回给出内容的节点；次数用尽后停下来等人确认。
- 人工确认时说明可选：不填则「批准继续」或「按原判定退回」。
- 校验会**穿过人工节点**，只检查真正有产物的上游 Agent（避免把人工节点当文件源误判）。

### 对话与 Skill

- 点 Agent 节点可在侧栏对话。执行中也可对话：不会改写正在跑的那次 Pi，新指导留给之后的执行。
- **Skill 管理**：维护 Skill 包；节点可勾选（如联网访问）。执行时物化到工作区并交给 Pi。

## 运行

### 1. 安装环境和依赖

在仓库根目录执行：

```bash
bash scripts/install-env.sh
```

这条命令会安装或复用 Node.js 22、pnpm 9 和 Pi CLI，并安装本仓库的依赖。在 macOS（已有 Homebrew）或 Debian/Ubuntu 上，还会安装并尝试启动 Redis 和 MySQL，并创建名为 `orvia` 的数据库。

Windows 请先自行安装 Node.js 20+、pnpm 9、Redis、MySQL 和 Pi CLI，然后执行：

```bash
pnpm install
pnpm --dir web install --ignore-workspace
copy .env.example .env
copy web\.env.example web\.env.local
```

### 2. 填写配置

编辑仓库根目录的 `.env`：

```env
DATABASE_URL=mysql://用户名:密码@127.0.0.1:3306/orvia
REDIS_URL=redis://127.0.0.1:6379
WEB_ORIGIN=http://localhost:3000
```

Redis 有密码时写成 `redis://:密码@127.0.0.1:6379`。不要把 `.env` 提交到 Git。

`.env` 里的 `PI_COMMAND` 默认是 `pi`。启动 API 的终端必须能执行这个命令。命令不在 `PATH` 里时，改成它的完整路径。

### 3. 配置 Pi

Orvia 执行节点、校验上游产物、以及侧栏对话时，都在 API 所在机器上启动 Pi。启动命令不带 `--provider` 和 `--model`：

```bash
pi --print --mode json --no-session -- <任务提示>
```

先确认命令可用：

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


Pi 自带目录里没有的接口，写到 `~/.pi/agent/models.json`。下面是一个兼容 OpenAI 接口的例子：

```json
{
  "providers": {
    "example": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$EXAMPLE_API_KEY",
      "models": [
        { "id": "your-model-id" }
      ]
    }
  }
}
```

保存后重新打开 Pi，用 `/model` 选中该模型并按 `Ctrl+S`。也可以在 `~/.pi/agent/settings.json` 里直接写 `defaultProvider` 和 `defaultModel`。

配置目录默认是 `~/.pi/agent`，可以用环境变量 `PI_CODING_AGENT_DIR` 改到别处。更完整的厂商列表见 [Pi 文档](https://pi.dev)。

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

确认 API：

```bash
curl http://127.0.0.1:4100/health
```

本机默认账号是 `admin@local.orvia` / `orvia-local`。开发环境不登录也可以使用默认租户。

### 5. 生产启动

```bash
pnpm build
pnpm start
```

```bash
pnpm web:build
pnpm web:start
```

生产环境必须设置 `NODE_ENV=production` 和 `ORVIA_API_TOKEN`。更完整的升级、回滚和排障见 [部署文档](docs/DEPLOYMENT.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [部署](docs/DEPLOYMENT.md) | 安装、启动、升级和回滚 |
| [环境](docs/ENVIRONMENT.md) | 端口、环境变量、Pi 和数据库约定 |
| [项目设计](docs/PROJECT_DESIGN.md) | 编排、Agent、Workflow 和 Runtime 的关系 |
| [功能说明](docs/STATUS.md) | 当前控制台和已完成能力 |
| [API](docs/API.md) | HTTP 接口 |

## 开发

```bash
pnpm typecheck
pnpm test
pnpm seed
```

`pnpm seed` 会补齐 `ov_` 表并写入一份可重复的示例数据。Orvia 只使用 `ov_` 前缀的表。
