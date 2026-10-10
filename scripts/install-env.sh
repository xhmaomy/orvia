#!/usr/bin/env bash
# Install Node.js 22, pnpm 9, Pi CLI, project dependencies, and when possible Redis and MySQL.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${HOME}/.local"
NODE_VERSION="22.21.0"
PNPM_VERSION="9.15.9"

log() { printf '==> %s\n' "$*"; }

node_major() {
  node -p "process.versions.node.split('.')[0]"
}

have_node() {
  command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge 20 ]
}

platform_slug() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) echo "不支持的系统: $os" >&2; exit 1 ;;
  esac
  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64) arch="x64" ;;
    *) echo "不支持的架构: $arch" >&2; exit 1 ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

install_node() {
  local slug archive url
  slug="$(platform_slug)"
  archive="node-v${NODE_VERSION}-${slug}.tar.gz"
  mkdir -p "$PREFIX/bin" /tmp/orvia-node
  for url in \
    "https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${archive}" \
    "https://nodejs.org/dist/v${NODE_VERSION}/${archive}"
  do
    log "下载 Node.js ${NODE_VERSION} ($url)"
    if curl -fL --retry 3 --connect-timeout 20 -o "/tmp/orvia-node/${archive}" "$url"; then
      tar -xzf "/tmp/orvia-node/${archive}" -C "$PREFIX"
      rm -rf "$PREFIX/node"
      mv "$PREFIX/node-v${NODE_VERSION}-${slug}" "$PREFIX/node"
      ln -sfn "$PREFIX/node/bin/node" "$PREFIX/bin/node"
      ln -sfn "$PREFIX/node/bin/npm" "$PREFIX/bin/npm"
      ln -sfn "$PREFIX/node/bin/npx" "$PREFIX/bin/npx"
      ln -sfn "$PREFIX/node/bin/corepack" "$PREFIX/bin/corepack"
      return 0
    fi
  done
  echo "Node.js 下载失败" >&2
  exit 1
}

export PATH="${PREFIX}/bin:${PATH}"

if have_node; then
  log "已有 Node.js $(node --version)"
else
  install_node
  hash -r
  log "已安装 Node.js $(node --version)"
fi

if ! command -v pnpm >/dev/null 2>&1 || ! pnpm --version >/dev/null 2>&1; then
  log "安装 pnpm ${PNPM_VERSION}"
  rm -f "${PREFIX}/bin/pnpm" "${PREFIX}/bin/pnpx"
  corepack enable
  corepack prepare "pnpm@${PNPM_VERSION}" --activate
fi
log "pnpm $(pnpm --version)"

if ! command -v pi >/dev/null 2>&1; then
  log "安装 Pi CLI"
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
fi
log "pi $(pi --version)"

os_name="$(uname -s)"
if [ "$os_name" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
  if ! command -v redis-cli >/dev/null 2>&1; then
    log "安装 Redis"
    brew install redis
  fi
  if ! command -v mysql >/dev/null 2>&1; then
    log "安装 MySQL"
    brew install mysql
  fi
  brew services start redis || log "Redis 未能自动启动，请执行 brew services start redis"
  brew services start mysql || log "MySQL 未能自动启动，请执行 brew services start mysql"
elif [ "$os_name" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
  if ! command -v redis-cli >/dev/null 2>&1; then
    log "安装 Redis"
    sudo apt-get update
    sudo apt-get install -y redis-server
  fi
  if ! command -v mysql >/dev/null 2>&1; then
    log "安装 MySQL"
    sudo apt-get update
    sudo apt-get install -y mysql-server
  fi
  sudo systemctl enable --now redis-server || log "Redis 未能自动启动，请执行 sudo systemctl start redis-server"
  sudo systemctl enable --now mysql || log "MySQL 未能自动启动，请执行 sudo systemctl start mysql"
else
  log "当前系统没有 Homebrew 或 apt，请自行安装并启动 Redis 和 MySQL"
fi

if command -v mysql >/dev/null 2>&1; then
  if mysql -u root -e "CREATE DATABASE IF NOT EXISTS orvia CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"; then
    log "已创建数据库 orvia"
  else
    log "没能用 root 自动建库。请创建数据库 orvia，并把连接串写入 .env 的 DATABASE_URL"
  fi
fi

if [ ! -f "${ROOT}/.env" ]; then
  cp "${ROOT}/.env.example" "${ROOT}/.env"
  log "已从 .env.example 生成 .env，请填写 DATABASE_URL 和 REDIS_URL"
fi

if [ ! -f "${ROOT}/web/.env.local" ]; then
  cp "${ROOT}/web/.env.example" "${ROOT}/web/.env.local"
  log "已生成 web/.env.local"
fi

log "安装项目依赖"
cd "$ROOT"
CI=1 pnpm install
CI=1 pnpm --dir web install --ignore-workspace

case ":${PATH}:" in
  *":${PREFIX}/bin:"*) ;;
  *) log "请把 ${PREFIX}/bin 加到 shell 的 PATH" ;;
esac

log "环境已就绪。下一步：在仓库根目录执行 pnpm dev，另开终端执行 cd web && pnpm dev"
log "控制台打开 http://localhost:3000。执行 Agent 前再配置模型 API Key，或在 pi 里执行 /login"
