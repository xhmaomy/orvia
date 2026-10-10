# Orvia 部署

本机运行 API 和控制台。功能说明见 [STATUS.md](STATUS.md)，变量说明见 [ENVIRONMENT.md](ENVIRONMENT.md)。

```text
浏览器
  └── 控制台 http://localhost:3000
        └── API http://127.0.0.1:4100
              ├── MySQL
              ├── Redis 127.0.0.1:6379
              └── Pi CLI（和 API 在同一台机器）
```

## 一、安装环境和依赖

在仓库根目录执行：

```bash
bash scripts/install-env.sh
```

脚本会处理这些事：

- 没有 Node.js 20+ 时，安装 Node.js 22 到 `~/.local`
- 安装或启用 pnpm 9
- 没有 `pi` 时，安装 `@earendil-works/pi-coding-agent`
- 安装仓库根目录和 `web/` 的依赖
- 生成 `.env` 和 `web/.env.local`（文件已存在则不覆盖）
- macOS 上如果有 Homebrew，安装并启动 Redis、MySQL
- Debian/Ubuntu 上如果有 apt，安装并启动 Redis、MySQL
- 能用 `mysql -u root` 连上时，创建数据库 `orvia`

Windows 不走这个脚本。请安装 Node.js 20+、pnpm 9、Redis、MySQL 和 Pi CLI 后执行：

```bash
pnpm install
pnpm --dir web install --ignore-workspace
copy .env.example .env
copy web\.env.example web\.env.local
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

## 二、填写连接

编辑 `.env`，至少改这两项：

```env
DATABASE_URL=mysql://用户名:密码@127.0.0.1:3306/orvia
REDIS_URL=redis://127.0.0.1:6379
```

自动建库失败时，先创建库再填写 `DATABASE_URL`：

```bash
mysql -u root -e "CREATE DATABASE IF NOT EXISTS orvia CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

密码里有 `@`、`#`、`?` 时要做 URL 编码。不要把真实密码写进 Git。

执行 Agent 之前，先在 Pi 里登录厂商并保存默认模型。Orvia 启动 Pi 时不传 `--provider` 和 `--model`。步骤见 [README 的「配置 Pi」](../README.md#3-配置-pi)。

```bash
pi --version
```

## 三、启动

两个终端都从仓库根目录开始。

```bash
pnpm dev
```

```bash
cd web && pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)。健康检查：

```bash
curl http://127.0.0.1:4100/health
```

返回里 `database` 和 `redis.status` 都应为 `ok`。

## 四、生产

```bash
pnpm build
NODE_ENV=production ORVIA_API_TOKEN=你的令牌 pnpm start
```

```bash
pnpm web:build
pnpm web:start
```

用系统服务或进程管理器分别托管这两个进程。`WEB_ORIGIN` 必须和浏览器打开控制台的地址一致。

## 五、升级和回滚

升级：

1. 停掉 API 和控制台，备份 MySQL。
2. 拉到目标版本后执行 `pnpm install --frozen-lockfile` 和 `pnpm --dir web install --ignore-workspace --frozen-lockfile`。
3. 执行 `pnpm typecheck`、`pnpm test`、`pnpm build`。
4. 启动后检查 `/health`、画布执行和节点对话。

回滚：停掉进程，用升级前的数据库备份恢复，再部署对应的代码版本。

## 六、常见问题

| 现象 | 处理 |
|---|---|
| `/health` 里数据库失败 | 检查 `DATABASE_URL`、MySQL 是否在听 3306、账号能否建 `ov_` 表 |
| `/health` 里 Redis 失败 | 检查 Redis 是否在听 6379，以及 `REDIS_URL` 是否带对密码 |
| 控制台打不开接口 | 用 `localhost:3000` 打开；核对 `WEB_ORIGIN` 和 `NEXT_PUBLIC_ORVIA_API_URL` |
| 节点没有回复 | 在 API 所在机器执行 `pi --version`，并确认 Pi 已经能访问模型 |
