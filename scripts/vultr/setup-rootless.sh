#!/usr/bin/env bash
# BOUNDARY - instala Bun y Docker rootless en la VM y verifica cgroup v2.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== bun =="
if [ ! -x /home/boundary/.bun/bin/bun ]; then
  su - boundary -c 'curl -fsSL https://bun.sh/install | bash' >/tmp/bun-install.log 2>&1 || { tail -20 /tmp/bun-install.log; exit 1; }
fi
/home/boundary/.bun/bin/bun --version

echo "== docker =="
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh >/tmp/docker-install.log 2>&1 || { tail -30 /tmp/docker-install.log; exit 1; }
fi
apt-get install -y docker-ce-rootless-extras >/dev/null 2>&1 || true
docker --version

echo "== rootless =="
loginctl enable-linger boundary
UID_B=$(id -u boundary)
export XDG_RUNTIME_DIR=/run/user/$UID_B
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID_B/bus
su - boundary -c "export XDG_RUNTIME_DIR=/run/user/$UID_B; export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID_B/bus; if [ ! -x \$HOME/bin/dockerd-rootless.sh ]; then dockerd-rootless-setuptool.sh install || true; fi; systemctl --user enable --now docker 2>&1 | tail -3; sleep 4; docker info --format 'cgroup={{.CgroupVersion}} security={{.SecurityOptions}}' 2>&1 | head -3"

echo "== socket =="
ls -l /run/user/$UID_B/docker.sock 2>/dev/null || echo NO_SOCKET

echo "== delegation =="
cat /sys/fs/cgroup/user.slice/user-$UID_B.slice/cgroup.controllers 2>/dev/null || echo NO_DELEGATION
echo "INSTALL_DONE"
