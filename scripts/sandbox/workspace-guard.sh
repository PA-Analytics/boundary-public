#!/usr/bin/env bash
# Guardia de higiene del workspace que se monta DENTRO del contenedor.
#
# El agente nunca debe ver: evaluador, fixtures ocultos, salidas esperadas,
# claves sintéticas, el socket del daemon ni ningún socket de evaluación.
# Este script es de SOLO LECTURA: recorre y falla, no borra ni "limpia".
#
# Uso:
#   bash scripts/sandbox/workspace-guard.sh --workspace /srv/boundary/cases/C-001
#   bash scripts/sandbox/workspace-guard.sh --mounts 'type=bind,src=/x,dst=/workspace'
#
# Exit code: 0 sólo si el workspace es apto para montarse.
set -uo pipefail

WORKSPACE=""
MOUNTS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) WORKSPACE=${2:-}; shift 2 ;;
    --mounts) MOUNTS=${2:-}; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "argumento desconocido: $1" >&2; exit 2 ;;
  esac
done

FAIL=0
report() { # $1 status $2 check $3 detail
  local status=$1 name=$2 detail=$3
  [ "$status" = "FAIL" ] && FAIL=1
  printf '%-4s %-30s %s\n' "$status" "$name" "$detail"
  return 0
}

# --- 1. rutas prohibidas dentro del workspace ---------------------------------
FORBIDDEN_NAMES='private-evaluation|hidden-tests|expected|solutions|oracle|answer-key|secrets?|credential'
FORBIDDEN_FILES='(^|/)(\.env(\..*)?|[^/]*\.(pem|key|p12|pfx)|id_rsa|id_ed25519|\.netrc|\.npmrc)$'

if [ -n "$WORKSPACE" ]; then
  if [ ! -d "$WORKSPACE" ]; then
    report FAIL workspace "no existe o no es directorio: $WORKSPACE"
  else
    report OK workspace "$WORKSPACE"
    HITS=$(find "$WORKSPACE" \( -type d -o -type f \) 2>/dev/null \
      | grep -Ei "/(${FORBIDDEN_NAMES})(/|$)|${FORBIDDEN_FILES}" | head -20)
    if [ -n "$HITS" ]; then
      report FAIL rutas-prohibidas "$(echo "$HITS" | tr '\n' ' ')"
    else
      report OK rutas-prohibidas "sin evaluador, oráculos, claves ni .env"
    fi

    SOCKS=$(find "$WORKSPACE" -type s 2>/dev/null | head -10)
    if [ -n "$SOCKS" ]; then report FAIL sockets "socket dentro del workspace: $(echo "$SOCKS" | tr '\n' ' ')"; else report OK sockets "ninguno"; fi

    # Un symlink puede sacar al agente del workspace (bind mount): se resuelve
    # cada enlace y se compara contra la ruta canónica del workspace.
    REALWS=$(realpath -m "$WORKSPACE" 2>/dev/null || echo "$WORKSPACE")
    LINKED=$(find "$WORKSPACE" -type l 2>/dev/null | head -200)
    ESCAPES=""
    for l in $LINKED; do
      tgt=$(realpath -m "$l" 2>/dev/null || true)
      case "$tgt" in
        "$REALWS"/*) ;;
        "") ESCAPES="$ESCAPES $l(irresoluble)" ;;
        *) ESCAPES="$ESCAPES $l→$tgt" ;;
      esac
    done
    if [ -n "$ESCAPES" ]; then report FAIL symlinks "$ESCAPES"; else report OK symlinks "sin salidas del workspace"; fi

    GITDIR=$(find "$WORKSPACE" -maxdepth 3 -name .git -print -quit 2>/dev/null)
    if [ -n "$GITDIR" ]; then report FAIL historial ".git presente ($GITDIR): el historial filtra soluciones"; else report OK historial "sin .git"; fi
  fi
else
  report SKIP workspace "sin --workspace"
fi

# --- 2. especificación de montajes -------------------------------------------
if [ -n "$MOUNTS" ]; then
  BAD=""
  IFS=',' read -ra PARTS <<< "$MOUNTS"
  for p in "${PARTS[@]}"; do
    BAD="$BAD [${p}]"
  done
  report SKIP montajes "revisa a mano:${BAD}"
fi

if [ "$FAIL" -eq 0 ]; then echo "WORKSPACE_OK"; exit 0; fi
echo "WORKSPACE_UNSAFE"; exit 1
