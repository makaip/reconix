# vLLM servers as named profiles. One env file per servable model:
#   serving/profiles/<name>.env: MODEL, PORT, SERVED_NAME, GPU_FRACTION, MAX_LEN, EXTRA_ARGS
#   optional per profile:        BIND_HOST (default 127.0.0.1), TOOL_PARSER (e.g. hermes)
# `stop` kills only the PID this script started (recorded in $DATA_ROOT/logs/serving/<name>.pid),
# Usage:
#   ./serve.sh serve  <profile>
#   ./serve.sh stop   <profile|all>
#   ./serve.sh status [profile]
#   ./serve.sh logs   <profile>        # tail -f the log
#   ./serve.sh test   <profile>        # list models + one chat completion
#
#   BIND_HOST   use 0.0.0.0 so a container can reach it

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILES="$ROOT/profiles"
DATA_ROOT="${DATA_ROOT:-$ROOT/../data}"
LOGS="$DATA_ROOT/logs/serving"
HEALTH_TRIES="${HEALTH_TRIES:-180}"
export CUDA_HOME=/usr/local/cuda-13.0
export PATH=$CUDA_HOME/bin:$PATH
export VLLM_ATTENTION_BACKEND=TRITON_ATTN

die()   { echo "$*" >&2; exit 2; }
usage() { sed -n '8,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

profile_file() { echo "$PROFILES/$1.env"; }

# Read one variable from a profile without polluting the current shell.
profile_var() { ( set -a; source <(sed 's/\r$//' "$(profile_file "$1")"); set +a; echo "${!2:-}" ); }

# Address to curl for a given bind host: wildcard binds are reachable on loopback.
probe_host() {
  case "$1" in
    0.0.0.0|"") echo "127.0.0.1" ;;
    *)          echo "$1" ;;
  esac
}

# Effective bind host for a profile: env override > profile > 127.0.0.1.
bind_host_for() {
  local h="${BIND_HOST:-}"
  [[ -n "$h" ]] || h="$(profile_var "$1" BIND_HOST)"
  echo "${h:-127.0.0.1}"
}

# Running = pidfile exists, process alive, AND its cmdline mentions vllm
# (guards against a recycled PID belonging to someone else's process).
is_running() {
  local pidf="$LOGS/$1.pid" pid
  [[ -f "$pidf" ]] || return 1
  pid="$(cat "$pidf")"
  kill -0 "$pid" 2>/dev/null || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q vllm
}

# Refuse to start if fractions of already-running profiles + this one exceed 1.0.
check_budget() {
  local name="$1" new="$2" total="$2" f p frac
  for f in "$LOGS"/*.pid; do
    [[ -e "$f" ]] || continue
    p="$(basename "$f" .pid)"
    [[ "$p" == "$name" ]] && continue
    is_running "$p" || continue
    frac="$(profile_var "$p" GPU_FRACTION)"
    total="$(awk -v a="$total" -v b="${frac:-0}" 'BEGIN{print a+b}')"
  done
  if awk -v t="$total" 'BEGIN{exit !(t > 1.0)}'; then
    [[ "${FORCE:-0}" == "1" ]] && { echo "warning: GPU budget $total > 1.0 (FORCE=1)"; return 0; }
    die "GPU budget exceeded: running profiles + $name = $total > 1.0 (FORCE=1 to override)"
  fi
}

# Refuse a port already in use (another profile, or someone else's server).
check_port() {
  local port="$1"
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    die "port $port is already in use"
  fi
}

cmd_serve() {
  local name="${1:-}"; [[ -n "$name" ]] || usage
  [[ -f "$(profile_file "$name")" ]] || die "no $(profile_file "$name")"

  # Remember any caller-provided BIND_HOST so it beats the profile's value.
  local bind_override="${BIND_HOST:-}"
  set -a; source <(sed 's/\r$//' "$(profile_file "$name")"); set +a
  : "${MODEL:?profile missing MODEL}" "${PORT:?missing PORT}" "${SERVED_NAME:?missing SERVED_NAME}"
  : "${GPU_FRACTION:?missing GPU_FRACTION}" "${MAX_LEN:?missing MAX_LEN}"
  EXTRA_ARGS="${EXTRA_ARGS:-}"
  BIND_HOST="${bind_override:-${BIND_HOST:-127.0.0.1}}"
  TOOL_PARSER="${TOOL_PARSER:-}"

  # Tool calling
  if [[ -n "$TOOL_PARSER" && "$EXTRA_ARGS" != *"--tool-call-parser"* ]]; then
    EXTRA_ARGS="$EXTRA_ARGS --enable-auto-tool-choice --tool-call-parser $TOOL_PARSER"
  fi

  mkdir -p "$LOGS"
  local pidf="$LOGS/$name.pid" logf="$LOGS/$name.log"

  if is_running "$name"; then
    echo "$name already running (pid $(cat "$pidf"))"; return 0
  fi
  rm -f "$pidf"   # stale

  check_budget "$name" "$GPU_FRACTION"
  check_port "$PORT"

  if [[ "$BIND_HOST" != "127.0.0.1" && -z "${VLLM_API_KEY:-}" ]]; then
    echo "warning: binding to $BIND_HOST with no VLLM_API_KEY; anyone who can reach :$PORT can use this server" >&2
  fi

  local probe auth=()
  probe="$(probe_host "$BIND_HOST")"
  [[ -n "${VLLM_API_KEY:-}" ]] && auth=(-H "Authorization: Bearer $VLLM_API_KEY")

  echo "starting $name: $MODEL on $BIND_HOST:$PORT at fraction $GPU_FRACTION"
  # setsid makes the server its own session/process-group leader, so pid == pgid
  # and `stop` can take down vLLM's worker children along with it.
  # shellcheck disable=SC2086
  nohup setsid vllm serve "$MODEL" --host "$BIND_HOST" --port "$PORT" \
    --served-model-name "$SERVED_NAME" --gpu-memory-utilization "$GPU_FRACTION" \
    --max-model-len "$MAX_LEN" $EXTRA_ARGS > "$logf" 2>&1 &
  local pid=$!
  echo "$pid" > "$pidf"

  local i
  for ((i = 0; i < HEALTH_TRIES; i++)); do
    if curl -sf "http://$probe:$PORT/health" >/dev/null; then
      echo "$name healthy (pid $pid, log $logf)"
      echo "  endpoint (host):      http://$probe:$PORT/v1"
      echo "  endpoint (container): http://host.docker.internal:$PORT/v1   model: $SERVED_NAME"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$name exited during startup; tail of log:"; tail -20 "$logf"
      rm -f "$pidf"; return 1
    fi
    sleep 5
  done
  echo "$name failed to become healthy; tail of log:"; tail -20 "$logf"
  return 1
}

stop_one() {
  local name="$1" pidf="$LOGS/$1.pid" pid i
  [[ -f "$pidf" ]] || { echo "$name: not running"; return 0; }
  if ! is_running "$name"; then
    rm -f "$pidf"; echo "$name: stale pidfile removed"; return 0
  fi
  pid="$(cat "$pidf")"
  echo "stopping $name (pid $pid)"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for ((i = 0; i < 30; i++)); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then
    echo "$name: still alive after 30s, sending SIGKILL"
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pidf"
  echo "$name stopped"
}

cmd_stop() {
  local name="${1:-}"; [[ -n "$name" ]] || usage
  if [[ "$name" == "all" ]]; then
    local f
    for f in "$LOGS"/*.pid; do
      [[ -e "$f" ]] && stop_one "$(basename "$f" .pid)"
    done
    return 0
  fi
  stop_one "$name"
}

status_one() {
  local name="$1" port frac host state="stopped" health="-"
  port="$(profile_var "$name" PORT)"; frac="$(profile_var "$name" GPU_FRACTION)"
  host="$(probe_host "$(bind_host_for "$name")")"
  if is_running "$name"; then
    state="running(pid $(cat "$LOGS/$name.pid"))"
    curl -sf "http://$host:$port/health" >/dev/null && health="healthy" || health="starting/unhealthy"
  fi
  printf '%-14s %-22s port=%-6s frac=%-5s %s\n' "$name" "$state" "$port" "$frac" "$health"
}

cmd_status() {
  if [[ -n "${1:-}" ]]; then status_one "$1"; return; fi
  local f total=0
  for f in "$PROFILES"/*.env; do
    [[ -e "$f" ]] || continue
    status_one "$(basename "$f" .env)"
  done
  for f in "$LOGS"/*.pid; do
    [[ -e "$f" ]] || continue
    is_running "$(basename "$f" .pid)" || continue
    total="$(awk -v a="$total" -v b="$(profile_var "$(basename "$f" .pid)" GPU_FRACTION)" 'BEGIN{print a+b}')"
  done
  echo "GPU budget in use: $total / 1.0"
}

cmd_logs() {
  [[ -n "${1:-}" ]] || usage
  tail -f "$LOGS/$1.log"
}

# Smoke test the OpenAI-compatible API the same way OpenCode will call it.
cmd_test() {
  local name="${1:-}"; [[ -n "$name" ]] || usage
  is_running "$name" || die "$name is not running"
  local port served host auth=()
  port="$(profile_var "$name" PORT)"; served="$(profile_var "$name" SERVED_NAME)"
  host="$(probe_host "$(bind_host_for "$name")")"
  [[ -n "${VLLM_API_KEY:-}" ]] && auth=(-H "Authorization: Bearer $VLLM_API_KEY")

  echo "== GET /v1/models"
  curl -sf "${auth[@]}" "http://$host:$port/v1/models" || die "models request failed (bad key?)"
  echo; echo "== POST /v1/chat/completions"
  curl -sf "${auth[@]}" -H "Content-Type: application/json" \
    "http://$host:$port/v1/chat/completions" \
    -d "{\"model\":\"$served\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"Say hi.\"}]}" \
    || die "chat completion failed"
  echo
}

case "${1:-}" in
  serve)  shift; cmd_serve "$@" ;;
  stop)   shift; cmd_stop "$@" ;;
  status) shift; cmd_status "$@" ;;
  logs)   shift; cmd_logs "$@" ;;
  test)   shift; cmd_test "$@" ;;
  *)      usage ;;
esac