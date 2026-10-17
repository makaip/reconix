# Start/stop the headless OpenCode server that Main (Dev 2) talks to.
#   ./opencode-server.sh start | stop | status | logs
# Needs (from reconix.env): OPENCODE_SERVER_PASSWORD, VLLM_API_KEY
# Env: OPENCODE_MODE=local|docker (default local)   OPENCODE_PORT (default 4096)
#      VLLM_PORT (default 8000)   OPENCODE_IMAGE (docker mode, required)
#      OPENCODE_WORKDIR (default: current dir)   RECONIX_MCP_URL (Dev 3's tool server)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a; [[ -f "$ROOT/reconix.env" ]] && source "$ROOT/reconix.env"; set +a

MODE="${OPENCODE_MODE:-local}"
PORT="${OPENCODE_PORT:-4096}"
VLLM_PORT="${VLLM_PORT:-8000}"
: "${OPENCODE_SERVER_PASSWORD:?set OPENCODE_SERVER_PASSWORD (run init-env.sh, then source reconix.env)}"
: "${VLLM_API_KEY:=}"
WORKDIR="${OPENCODE_WORKDIR:-$PWD}"
LOGS="$ROOT/logs"; mkdir -p "$LOGS"
PIDF="$LOGS/opencode.pid"; LOGF="$LOGS/opencode.log"
NAME="reconix-opencode"
URL="http://127.0.0.1:$PORT"

# Where the model server / tool server are, as seen from where OpenCode runs.
if [[ "$MODE" == "docker" ]]; then HOSTREF="host.docker.internal"; else HOSTREF="127.0.0.1"; fi
export VLLM_BASE_URL="${VLLM_BASE_URL:-http://$HOSTREF:$VLLM_PORT/v1}"
export RECONIX_MCP_URL="${RECONIX_MCP_URL:-http://$HOSTREF:7000/mcp}"   # placeholder until Dev 3's port is known
export VLLM_API_KEY

# OpenCode's real auth is HTTP Basic (user "opencode"), and health is /global/health.
health() { curl -fsS -u "opencode:$OPENCODE_SERVER_PASSWORD" "$URL/global/health" 2>/dev/null; }

wait_healthy() {
  local i
  for ((i = 0; i < 60; i++)); do
    health >/dev/null && { echo "opencode healthy at $URL"; health; echo; return 0; }
    sleep 2
  done
  echo "opencode did not become healthy; see: ./opencode-server.sh logs" >&2; return 1
}

cmd_start() {
  if [[ "$MODE" == "docker" ]]; then
    : "${OPENCODE_IMAGE:?set OPENCODE_IMAGE (the image Dev 4 builds)}"
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" \
      --add-host=host.docker.internal:host-gateway \
      -p "127.0.0.1:$PORT:4096" \
      -e OPENCODE_SERVER_PASSWORD -e VLLM_API_KEY -e VLLM_BASE_URL -e RECONIX_MCP_URL \
      -e OPENCODE_CONFIG=/config/opencode.json \
      -v "$ROOT/opencode.json:/config/opencode.json:ro" \
      -v "$WORKDIR:/workspace" -w /workspace \
      "$OPENCODE_IMAGE" opencode serve --hostname 0.0.0.0 --port 4096 >/dev/null
  else
    command -v opencode >/dev/null || { echo "opencode not found on PATH" >&2; exit 2; }
    if [[ -f "$PIDF" ]] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
      echo "already running (pid $(cat "$PIDF"))"; return 0
    fi
    (cd "$WORKDIR" && OPENCODE_CONFIG="$ROOT/opencode.json" \
      nohup setsid opencode serve --hostname 127.0.0.1 --port "$PORT" > "$LOGF" 2>&1 &
      echo $! > "$PIDF")
  fi
  wait_healthy
}

cmd_stop() {
  if [[ "$MODE" == "docker" ]]; then docker rm -f "$NAME" >/dev/null 2>&1 || true; echo "stopped"; return; fi
  [[ -f "$PIDF" ]] || { echo "not running"; return 0; }
  kill -TERM -- "-$(cat "$PIDF")" 2>/dev/null || kill -TERM "$(cat "$PIDF")" 2>/dev/null || true
  rm -f "$PIDF"; echo "stopped"
}

cmd_status() {
  if health >/dev/null; then echo "healthy: $(health)"; else echo "not reachable at $URL"; fi
}

cmd_logs() {
  if [[ "$MODE" == "docker" ]]; then docker logs -f "$NAME"; else tail -f "$LOGF"; fi
}

case "${1:-}" in
  start) cmd_start ;; stop) cmd_stop ;; status) cmd_status ;; logs) cmd_logs ;;
  *) sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac