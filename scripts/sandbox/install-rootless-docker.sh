#!/usr/bin/env bash
# Instalación del host de sandbox (Docker rootless + delegación cgroup + Bun).
#
# REQUIERE RED SOLO AQUÍ (apt + get.docker.com + bun.sh). Las pruebas posteriores
# no usan red: la imagen se construye una vez y se fija por Id.
#
# No crea recursos Vultr, no toca el MVP desplegado, no abre puertos.
# Idempotente: repetirlo no rompe nada.
#
# Uso (en la VM de sandbox, como usuario con sudo):
#   bash scripts/sandbox/install-rootless-docker.sh --yes
set -euo pipefail

KEEP_USER=${SUDO_USER:-$(id -un)}
if [ "$(id -u)" = "0" ] && [ -z "${SUDO_USER:-}" ]; then
  echo "ejecuta como usuario normal con sudo, no como root directo" >&2
  exit 2
fi
if [ "${1:-}" != "--yes" ]; then
  echo "esto instala paquetes y habilita servicios. Confirma con: $0 --yes" >&2
  exit 2
fi

as_root() { if [ "$(id -u)" = "0" ]; then "$@"; else sudo "$@"; fi; }

echo "== usuario objetivo: $KEEP_USER =="
UID_B=$(id -u "$KEEP_USER")

echo "== cgroup v2 =="
CG=$(stat -fc %T /sys/fs/cgroup || true)
if [ "$CG" != "cgroup2fs" ]; then
  echo "FATAL: el host no usa cgroup v2 ($CG). Cambia de VM o de distro." >&2
  exit 3
fi

echo "== paquetes base =="
as_root apt-get update -y
# unzip: lo exige el instalador de Bun.
as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl gnupg unzip uidmap dbus-user-session slirp4netns fuse-overlayfs

echo "== docker + extras rootless =="
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  as_root sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
fi
as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce-rootless-extras

echo "== userns sysctls =="
as_root tee /etc/sysctl.d/99-boundary-sandbox.conf >/dev/null <<'SYSCTL'
kernel.unprivileged_userns_clone=1
user.max_user_namespaces=28633
SYSCTL
as_root sysctl --system >/dev/null

echo "== linger (el daemon de usuario sobrevive al logout) =="
as_root loginctl enable-linger "$KEEP_USER"

echo "== delegación cgroup para el daemon rootless =="
# Sin Delegate=yes en user@.service, rootless ignora --memory/--pids/--cpus
# y los límites NO se aplican aunque docker info diga cgroup v2.
USER_HOME=$(getent passwd "$KEEP_USER" | cut -d: -f6)
as_root mkdir -p "/etc/systemd/system/user@$UID_B.service.d"
as_root tee "/etc/systemd/system/user@$UID_B.service.d/delegate.conf" >/dev/null <<'UNIT'
[Service]
Delegate=yes
UNIT
as_root systemctl daemon-reload

echo "== dockerd rootless =="
export XDG_RUNTIME_DIR="/run/user/$UID_B"
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$UID_B/bus"
if [ ! -x "$USER_HOME/bin/dockerd-rootless.sh" ]; then
  as_root -u "$KEEP_USER" -- env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
    dockerd-rootless-setuptool.sh install
fi
as_root -u "$KEEP_USER" -- env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
  systemctl --user enable --now docker || true

echo "== bun =="
if [ ! -x "$USER_HOME/.bun/bin/bun" ]; then
  as_root -u "$KEEP_USER" -- env HOME="$USER_HOME" bash -c 'curl -fsSL https://bun.sh/install | bash'
fi
"$USER_HOME/.bun/bin/bun" --version

echo "== verificación (readonly) =="
DOCKER_HOST="unix:///run/user/$UID_B/docker.sock" docker info --format 'cgroup={{.CgroupVersion}} security={{.SecurityOptions}}'
echo "INSTALL_DONE"
echo "siguiente: bash scripts/sandbox/build-image.sh --yes   (una sola vez, usa red)"
echo "          bash scripts/sandbox/preflight-host.sh       (readonly, sin red)"
