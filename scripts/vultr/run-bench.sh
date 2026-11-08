#!/usr/bin/env bash
# Benchmark B/D/E del Lifeguard DENTRO de la VM (no en el host del operador).
# Deja producción intacta: usa /srv/bench, un socket fuera del repo y copias en
# /srv/bench/copies. No imprime claves: sólo su presencia.
#
#   bash scripts/vultr/run-bench.sh --ids GAU-012 --arms B --reps 1 --out /srv/bench/out/smoke
#   bash scripts/vultr/run-bench.sh --ids GAU-001,GAU-012 --arms B,D,E --reps 1 --out /srv/bench/out/pilot
#
# Etapas: `preflight` (sin modelo, sin agente) y `run` (agente real).
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

STAGE=run
IDS=''
ARMS='B'
CONFIGS='B'
REPS=1
CONCURRENCY=1
MAX_STEPS=14
OUT=''
SECRETS_FILE="${BOUNDARY_SECRETS_FILE:-/etc/boundary.env}"

while [ $# -gt 0 ]; do
  case "$1" in
    --ids) IDS=$2; shift 2 ;;
    --arms) ARMS=$2; shift 2 ;;
    --configs) CONFIGS=$2; shift 2 ;;
    --reps) REPS=$2; shift 2 ;;
    --concurrency) CONCURRENCY=$2; shift 2 ;;
    --max-steps) MAX_STEPS=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --stage) STAGE=$2; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "flag desconocido: $1" >&2; exit 2 ;;
  esac
done
[ -n "$IDS" ] || { echo 'falta --ids' >&2; exit 2; }
[ -n "$OUT" ] || { echo 'falta --out' >&2; exit 2; }
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

read_env_value() {
  local name=$1 file=$2 line value
  [ -r "$file" ] || return 1
  line=$(grep -m1 -E "^[[:space:]]*(export[[:space:]]+)?${name}[[:space:]]*=" -- "$file" 2>/dev/null || true)
  [ -n "$line" ] || return 1
  value=${line#*=}
  value=${value%$'\r'}
  value=${value#"${value%%[![:space:]]*}"}
  case $value in \"*\") value=${value#\"}; value=${value%\"} ;; \'*\') value=${value#\'}; value=${value%\'} ;; esac
  printf '%s' "$value"
}

for name in VULTR_INFERENCE_API_KEY VULTR_INFERENCE_MODEL VULTR_INFERENCE_BASE_URL; do
  value=$(read_env_value "$name" "$SECRETS_FILE" || true)
  if [ -z "${value:-}" ]; then echo "falta $name en $SECRETS_FILE" >&2; exit 2; fi
  export "$name=$value"
  unset value
done

BUN=${BUN_BIN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}
[ -x "$BUN" ] || { echo "falta bun" >&2; exit 2; }
UID_B=$(id -u)
export DOCKER_HOST="unix:///run/user/${UID_B}/docker.sock"
export BOUNDARY_ALLOW_LOCAL_WORKER=1
export BOUNDARY_SANDBOX_IMAGE="${BOUNDARY_SANDBOX_IMAGE:-boundary/gauntlet:1}"
export BOUNDARY_SANDBOX_DIGEST="${BOUNDARY_SANDBOX_DIGEST:-$(DOCKER_HOST=$DOCKER_HOST docker image inspect -f '{{.Id}}' "$BOUNDARY_SANDBOX_IMAGE")}"

SESSION=$OUT/session
mkdir -p -m 0777 "$SESSION/copies"
export TMPDIR="$SESSION/copies"
export BOUNDARY_EVAL_SOCKET="/run/user/${UID_B}/boundary-bench.sock"
EVAL_TOKEN=$("$BUN" -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
export BOUNDARY_EVAL_TOKEN="$EVAL_TOKEN"
unset EVAL_TOKEN

EVAL_PID=''
cleanup() {
  if [ -n "$EVAL_PID" ] && kill -0 "$EVAL_PID" 2>/dev/null; then
    kill "$EVAL_PID" 2>/dev/null || true
    wait "$EVAL_PID" 2>/dev/null || true
  fi
  unset BOUNDARY_EVAL_TOKEN
}
trap cleanup EXIT INT TERM

ARGS=()
IFS=',' read -r -a SELECTED <<< "$IDS"
for id in "${SELECTED[@]}"; do ARGS+=(--scenario "$id"); done

rm -f "$BOUNDARY_EVAL_SOCKET"
"$BUN" scripts/sandbox/harness/evaluator-launch.ts \
  --socket "$BOUNDARY_EVAL_SOCKET" --workspace-root "$SESSION/copies" \
  --image "$BOUNDARY_SANDBOX_IMAGE" --digest "$BOUNDARY_SANDBOX_DIGEST" \
  --docker-host "$DOCKER_HOST" "${ARGS[@]}" > "$OUT/evaluator.log" 2>&1 &
EVAL_PID=$!
for _ in $(seq 1 150); do
  kill -0 "$EVAL_PID" 2>/dev/null || { echo 'el evaluador murió al arrancar; ver evaluator.log' >&2; tail -20 "$OUT/evaluator.log" >&2 || true; exit 3; }
  [ -S "$BOUNDARY_EVAL_SOCKET" ] && break
  sleep 0.1
done
[ -S "$BOUNDARY_EVAL_SOCKET" ] || { echo 'socket del evaluador no listo' >&2; exit 3; }

echo "== preflight (sin modelo) =="
"$BUN" scripts/sandbox/queue.ts --preflight-only --ids "$IDS" --configs "$CONFIGS" --arms "$ARMS" \
  --reps "$REPS" --concurrency "$CONCURRENCY" --max-steps "$MAX_STEPS" --out "$OUT" 2>&1 | tee "$OUT/preflight.log" | tail -25

if [ "$STAGE" = "preflight" ]; then
  echo PREFLIGHT_ONLY_DONE
  exit 0
fi

echo "== ejecución real (agente + Docker + evaluador aislado) =="
"$BUN" scripts/sandbox/queue.ts --execute --ids "$IDS" --configs "$CONFIGS" --arms "$ARMS" \
  --reps "$REPS" --concurrency "$CONCURRENCY" --max-steps "$MAX_STEPS" --out "$OUT" 2>&1 | tee "$OUT/runner.log" | tail -40
echo BENCH_DONE
