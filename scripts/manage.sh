#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
if [[ $# -gt 0 ]]; then
  shift
fi

BIND_ADDRESS="0.0.0.0"
PORT="1885"
FOLLOW="0"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
WEB_ROOT="$PROJECT_ROOT/public"
SERVER_SCRIPT="$PROJECT_ROOT/server/skill_share_server.py"
DATA_DIR="$PROJECT_ROOT/server/.data"
RUNTIME_DIR="$SCRIPT_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/server.linux.pid"
CONFIG_FILE="$RUNTIME_DIR/server.linux.env"
LOG_FILE="$RUNTIME_DIR/server.linux.log"

usage() {
  cat <<EOF
用法:
  bash scripts/manage.sh <命令> [选项]

命令:
  start      启动 Skill 共享站
  stop       停止 Skill 共享站
  restart    重启 Skill 共享站
  status     查看状态
  open       用浏览器打开本机地址
  logs       查看日志

选项:
  --host <地址>     监听地址，默认 0.0.0.0，局域网可访问
  --port <端口>     监听端口，默认 1885
  --follow          logs 命令持续跟随日志
  -h, --help        显示帮助

示例:
  bash scripts/manage.sh start
  bash scripts/manage.sh stop
  bash scripts/manage.sh restart --port 8080
  bash scripts/manage.sh logs --follow
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      BIND_ADDRESS="${2:?缺少 --host 参数值}"
      shift 2
      ;;
    --port)
      PORT="${2:?缺少 --port 参数值}"
      shift 2
      ;;
    --follow)
      FOLLOW="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage
      exit 1
      ;;
  esac
done

ensure_runtime_dir() {
  mkdir -p "$RUNTIME_DIR"
}

resolve_python() {
  if command -v python3 >/dev/null 2>&1; then
    echo "python3"
    return
  fi

  if command -v python >/dev/null 2>&1; then
    echo "python"
    return
  fi

  echo "未找到 Python。请先安装 Python 3，并确认 python3 或 python 命令可用。" >&2
  exit 1
}

read_config() {
  if [[ -f "$CONFIG_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$CONFIG_FILE"
  fi
}

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1
}

current_pid() {
  if [[ -f "$PID_FILE" ]]; then
    tr -d '[:space:]' < "$PID_FILE"
  fi
}

lan_urls() {
  local url_port="$1"
  echo "  http://127.0.0.1:$url_port"

  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | while read -r ip; do
      [[ -n "$ip" ]] && echo "  http://$ip:$url_port"
    done
  elif command -v ip >/dev/null 2>&1; then
    ip -4 addr show scope global | awk '/inet / {print $2}' | cut -d/ -f1 | while read -r ip; do
      [[ -n "$ip" ]] && echo "  http://$ip:$url_port"
    done
  fi
}

show_urls() {
  local url_port="$1"
  echo "访问地址："
  lan_urls "$url_port"
}

start_server() {
  if is_running; then
    read_config
    echo "服务已经在运行，PID: $(current_pid)"
    show_urls "${SAVED_PORT:-$PORT}"
    return
  fi

  ensure_runtime_dir
  if [[ ! -d "$WEB_ROOT" ]]; then
    echo "未找到网页目录：$WEB_ROOT" >&2
    exit 1
  fi
  if [[ ! -f "$SERVER_SCRIPT" ]]; then
    echo "未找到共享服务脚本：$SERVER_SCRIPT" >&2
    exit 1
  fi

  local python_bin
  python_bin="$(resolve_python)"

  echo "正在启动 Skill 共享站..."
  echo "项目目录：$PROJECT_ROOT"
  echo "网页目录：$WEB_ROOT"
  echo "数据目录：$DATA_DIR"

  nohup "$python_bin" "$SERVER_SCRIPT" --host "$BIND_ADDRESS" --port "$PORT" --public-dir "$WEB_ROOT" --data-dir "$DATA_DIR" >"$LOG_FILE" 2>&1 &
  local pid="$!"
  echo "$pid" > "$PID_FILE"
  cat > "$CONFIG_FILE" <<EOF
SAVED_PID="$pid"
SAVED_PORT="$PORT"
SAVED_BIND_ADDRESS="$BIND_ADDRESS"
SAVED_PROJECT_ROOT="$PROJECT_ROOT"
SAVED_WEB_ROOT="$WEB_ROOT"
SAVED_DATA_DIR="$DATA_DIR"
SAVED_STARTED_AT="$(date -Iseconds)"
SAVED_LOG_FILE="$LOG_FILE"
EOF

  sleep 1
  if ! is_running; then
    echo "服务启动失败，请查看日志：$LOG_FILE" >&2
    exit 1
  fi

  echo "启动成功，PID: $pid"
  show_urls "$PORT"
}

stop_server() {
  if ! is_running; then
    echo "服务没有运行。"
    rm -f "$PID_FILE"
    return
  fi

  local pid
  pid="$(current_pid)"
  echo "正在停止服务，PID: $pid..."
  kill "$pid" >/dev/null 2>&1 || true

  for _ in {1..20}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done

  if kill -0 "$pid" >/dev/null 2>&1; then
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi

  rm -f "$PID_FILE"
  echo "已停止。服务端备份文件不受影响。"
}

show_status() {
  read_config
  if is_running; then
    echo "状态：运行中"
    echo "PID：$(current_pid)"
    [[ -n "${SAVED_STARTED_AT:-}" ]] && echo "启动时间：$SAVED_STARTED_AT"
    show_urls "${SAVED_PORT:-$PORT}"
  else
    echo "状态：未运行"
  fi

  echo "运行目录：$PROJECT_ROOT"
  echo "网页目录：$WEB_ROOT"
  echo "数据目录：$DATA_DIR"
  echo "日志文件：$LOG_FILE"
}

open_site() {
  read_config
  local url="http://127.0.0.1:${SAVED_PORT:-$PORT}"
  echo "打开：$url"

  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 &
  else
    echo "当前系统没有可用的 open/xdg-open，请手动复制上面的地址。"
  fi
}

show_logs() {
  ensure_runtime_dir
  touch "$LOG_FILE"
  echo "日志文件：$LOG_FILE"
  if [[ "$FOLLOW" == "1" ]]; then
    tail -n 80 -f "$LOG_FILE"
  else
    tail -n 80 "$LOG_FILE"
  fi
}

case "$ACTION" in
  start)
    start_server
    ;;
  stop)
    stop_server
    ;;
  restart)
    stop_server
    start_server
    ;;
  status)
    show_status
    ;;
  open)
    open_site
    ;;
  logs)
    show_logs
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "未知命令: $ACTION" >&2
    usage
    exit 1
    ;;
esac
