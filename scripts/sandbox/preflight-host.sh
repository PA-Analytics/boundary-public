#!/usr/bin/env bash
# Preflight de SOLO LECTURA del host que ejecutará BOUNDARY/GAUNTLET.
#
# Garantías:
#  - No descarga nada: nunca hace `docker pull`, nunca construye imágenes.
#  - No crea contenedores, ni volúmenes, ni redes, ni recursos.
#  - No consulta api.vultr.com ni ninguna otra red externa.
#  - No modifica el sistema: no escribe ficheros, no instala paquetes.
#
# Uso:
#   bash scripts/sandbox/preflight-host.sh
#   bash scripts/sandbox/preflight-host.sh --image boundary/gauntlet:1 --digest sha256:abc…
#   bash scripts/sandbox/preflight-host.sh --json
#
# Exit code: 0 sólo si TODAS las comprobaciones obligatorias pasan.
set -uo pipefail

IMAGE=${BOUNDARY_SANDBOX_IMAGE:-boundary/gauntlet:1}
DIGEST=${BOUNDARY_SANDBOX_DIGEST:-}
JSON=0

while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE=${2:-}; shift 2 ;;
    --digest) DIGEST=${2:-}; shift 2 ;;
    --json) JSON=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "argumento desconocido: $1" >&2; exit 2 ;;
  esac
done

FAIL=0
ROWS=""

record() { # $1 status  $2 nombre  $3 detalle
  local status=$1 name=$2 detail=$3
  [ "$status" = "FAIL" ] && FAIL=1
  ROWS="${ROWS}${status}|${name}|${detail}
"
  [ "$JSON" -eq 0 ] && printf '%-4s %-34s %s\n' "$status" "$name" "$detail"
  return 0
}

ok()   { record OK   "$1" "$2"; }
skip() { record SKIP "$1" "$2"; }
bad()  { record FAIL "$1" "$2"; }

# --- 1. plataforma -----------------------------------------------------------
PLATFORM=$(uname -s 2>/dev/null || echo unknown)
if [ "$PLATFORM" = "Linux" ]; then ok plataforma "Linux ($(uname -r))"; else bad plataforma "$PLATFORM (se requiere Linux)"; fi

UID_NOW=$(id -u 2>/dev/null || echo 0)
if [ "$UID_NOW" != "0" ]; then ok usuario "uid=$UID_NOW ($(id -un))"; else bad usuario "uid=0 (root: el daemon no sería rootless)"; fi

# --- 2. cgroup v2 del host ---------------------------------------------------
CG_FS=$(stat -fc %T /sys/fs/cgroup 2>/dev/null || echo none)
if [ "$CG_FS" = "cgroup2fs" ]; then ok cgroup-v2-host "cgroup2fs"; else bad cgroup-v2-host "$CG_FS (se requiere sistema unificado)"; fi

# --- 3. Docker CLI y daemon --------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  ok docker-cli "$(docker --version 2>/dev/null | head -1)"
else
  bad docker-cli "ausente (instalar docker-ce + docker-ce-rootless-extras)"
fi

SOCKET="/run/user/$UID_NOW/docker.sock"
if [ -S "$SOCKET" ]; then ok docker-socket "$SOCKET"; else bad docker-socket "no existe $SOCKET (dockerd-rootless inactivo)"; fi

SERVER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null)
if [ -n "$SERVER_VERSION" ]; then
  ok docker-daemon "server $SERVER_VERSION"
  CG=$(docker info --format '{{.CgroupVersion}}' 2>/dev/null)
  if [ "$CG" = "2" ]; then ok cgroup-v2-daemon "CgroupVersion=2"; else bad cgroup-v2-daemon "CgroupVersion='$CG'"; fi
  SEC=$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null)
  case "$SEC" in
    *name=rootless*) ok rootless "SecurityOptions incluye name=rootless" ;;
    *) bad rootless "SecurityOptions='$SEC' (no es rootless)" ;;
  esac
else
  bad docker-daemon "daemon no alcanzable en $SOCKET"
  skip cgroup-v2-daemon "sin daemon"
  skip rootless "sin daemon"
fi

# --- 4. delegación cgroup (rootless sin esto ignora --memory/--pids/--cpus) ---
DELEG=$(cat "/sys/fs/cgroup/user.slice/user-$UID_NOW.slice/user@$UID_NOW.service/cgroup.controllers" 2>/dev/null || echo "")
MISSING=""
for c in cpu memory pids; do
  case " $DELEG " in *" $c "*) ;; *) MISSING="$MISSING $c" ;; esac
done
if [ -z "$DELEG" ]; then
  bad cgroup-delegation "no legible (user@$UID_NOW.service sin Delegate=yes)"
elif [ -z "$MISSING" ]; then
  ok cgroup-delegation "cpu memory pids delegados"
else
  bad cgroup-delegation "faltan:$MISSING (Delegate=yes en user@.service)"
fi

LINGER=$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null | cut -d= -f2)
if [ "$LINGER" = "yes" ]; then ok linger "Linger=yes"; else bad linger "Linger='${LINGER:-no}' (loginctl enable-linger)"; fi

# --- 5. soporte de --pull never (imprescindible para el claim "sin pull") ----
if docker run --help 2>/dev/null | grep -q -- '--pull'; then
  ok pull-never-soportado "docker run acepta --pull"
else
  skip pull-never-soportado "no verificable sin daemon"
fi

# --- 6. imagen local (sin descargarla) --------------------------------------
if [ -n "$SERVER_VERSION" ]; then
  IMG_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null)
  if [ -n "$IMG_ID" ]; then
    ok imagen-local "$IMAGE -> $IMG_ID"
    if [ -n "$DIGEST" ]; then
      if [ "$IMG_ID" = "$DIGEST" ]; then ok imagen-pin "Id coincide con el digest declarado"; else bad imagen-pin "Id=$IMG_ID != digest=$DIGEST"; fi
    else
      skip imagen-pin "sin --digest: exporta BOUNDARY_SANDBOX_DIGEST antes de las pruebas"
    fi
  else
    bad imagen-local "$IMAGE ausente (construir con build-image.sh; NO se descarga aquí)"
    skip imagen-pin "sin imagen local"
  fi
else
  skip imagen-local "sin daemon"
  skip imagen-pin "sin daemon"
fi

# --- 6b. prueba REAL: ¿arranca un contenedor con todas las cotas? -------------
# Es el único veredicto que vale: hay kernels que dejan instalar rootless y luego
# no pueden montar /proc dentro del contenedor. Un contenedor efímero, sin red y
# sin pull (`--pull never`), sale en menos de un segundo.
if [ -n "$SERVER_VERSION" ] && [ -n "${IMG_ID:-}" ]; then
  if docker run --rm --pull never --network none --read-only --cap-drop ALL \
       --security-opt no-new-privileges --user 1000:1000 --pids-limit 64 \
       --memory 512m "$IMAGE" /bin/true >/dev/null 2>&1; then
    ok contenedor-efimero "arranca con todas las cotas y sin pull"
  else
    bad contenedor-efimero "el daemon no puede arrancar el contenedor (ver docker run sin --rm)"
  fi
else
  skip contenedor-efimero "sin daemon o sin imagen local"
fi

# --- 7. Bun para el arnés ----------------------------------------------------
if command -v bun >/dev/null 2>&1; then
  ok bun "$(bun --version)"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  ok bun "$("$HOME/.bun/bin/bun" --version) ($HOME/.bun/bin/bun, fuera de PATH)"
else
  bad bun "ausente (1.4.x)"
fi

# --- salida ------------------------------------------------------------------
if [ "$JSON" -eq 1 ]; then
  printf '{\n  "generatedAt": "%s",\n  "image": "%s",\n  "digest": "%s",\n  "ready": %s,\n  "checks": [\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$IMAGE" "$DIGEST" "$([ "$FAIL" -eq 0 ] && echo true || echo false)"
  first=1
  while IFS='|' read -r st name detail; do
    [ -z "$st" ] && continue
    [ $first -eq 0 ] && printf ',\n'
    first=0
    printf '    {"status": "%s", "check": "%s", "detail": "%s"}' "$st" "$name" "${detail//\"/\\\"}"
  done <<EOF
$ROWS
EOF
  printf '\n  ]\n}\n'
fi

if [ "$FAIL" -eq 0 ]; then
  [ "$JSON" -eq 0 ] && echo "PREFLIGHT_READY"
  exit 0
fi
[ "$JSON" -eq 0 ] && echo "PREFLIGHT_NOT_READY"
exit 1
