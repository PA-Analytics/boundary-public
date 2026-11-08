#!/usr/bin/env bash
# Ejecutado EN la VM por scripts/vultr/release.ps1 — no se invoca desde el host.
# Idempotente y reversible: respalda /opt/boundary antes de copiar y no toca
# /etc/boundary.env salvo para fusionar las variables de este despliegue.
set -euo pipefail

TGZ=${TGZ:-/tmp/boundary-deploy.tgz}
APP=/opt/boundary
BOUNDARY_UID=$(id -u boundary)
DOCKER_HOST_USER="unix:///run/user/$BOUNDARY_UID/docker.sock"

echo "== respaldo =="
TS=$(date -u +%Y%m%dT%H%M%SZ)
BAK="$APP.bak-$TS"
cp -a "$APP" "$BAK"
echo "backup=$BAK"

echo "== imagen del sandbox (una vez) =="
mkdir -p /tmp/sbbuild
tar -xzf "$TGZ" -C /tmp/sbbuild scripts/sandbox/Dockerfile.sandbox
chmod -R a+rX /tmp/sbbuild
if su - boundary -c "DOCKER_HOST=$DOCKER_HOST_USER docker image inspect boundary/gauntlet:1 >/dev/null 2>&1"; then
  echo "imagen: ya presente"
else
  echo "imagen: construyendo desde Dockerfile.sandbox (requiere red, una vez)"
  su - boundary -c "cd /tmp/sbbuild/scripts/sandbox && DOCKER_HOST=$DOCKER_HOST_USER docker build -f Dockerfile.sandbox -t boundary/gauntlet:1 ." >/tmp/sandbox-build.log 2>&1 \
    || { echo "FALLO el build; log:"; tail -30 /tmp/sandbox-build.log; exit 1; }
  echo "imagen: construida"
fi
IMAGE_ID=$(su - boundary -c "DOCKER_HOST=$DOCKER_HOST_USER docker image inspect -f '{{.Id}}' boundary/gauntlet:1")
echo "imageId=$IMAGE_ID"

echo "== codigo =="
tar -xzf "$TGZ" -C "$APP"
chown -R boundary:boundary "$APP"
su - boundary -c "cd $APP && /home/boundary/.bun/bin/bun install --no-save 2>&1 | tail -3"

echo "== workspaces =="
mkdir -p /var/lib/boundary/workspaces
chown boundary:boundary /var/lib/boundary/workspaces
chmod 0777 /var/lib/boundary/workspaces

echo "== entorno =="
if [ -f /tmp/boundary-product.env ]; then
  install -m 600 -o root -g root /tmp/boundary-product.env /tmp/boundary-product.env.staged
  touch /etc/boundary.env
  chmod 600 /etc/boundary.env
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    name=${line%%=*}
    grep -v "^$name=" /etc/boundary.env > /etc/boundary.env.new || true
    mv /etc/boundary.env.new /etc/boundary.env
    printf '%s\n' "$line" >> /etc/boundary.env
  done < /tmp/boundary-product.env.staged
  rm -f /tmp/boundary-product.env /tmp/boundary-product.env.staged
  chmod 600 /etc/boundary.env
  echo "env: fusionado ($(grep -c . /etc/boundary.env) lineas)"
fi
if ! grep -q '^BOUNDARY_SANDBOX_DIGEST=' /etc/boundary.env; then
  printf 'BOUNDARY_SANDBOX_IMAGE=boundary/gauntlet:1\nBOUNDARY_SANDBOX_DIGEST=%s\n' "$IMAGE_ID" >> /etc/boundary.env
fi
grep -q '^BOUNDARY_WORKSPACE_ROOT=' /etc/boundary.env || printf 'BOUNDARY_WORKSPACE_ROOT=/var/lib/boundary/workspaces\n' >> /etc/boundary.env
chmod 600 /etc/boundary.env

echo "== servicio =="
systemctl daemon-reload
systemctl restart boundary.service
sleep 8
systemctl is-active boundary.service || true
echo "== health local =="
curl -s -m 5 http://127.0.0.1:8080/healthz || echo NO_HEALTH
echo
echo "== continuity local =="
curl -s -m 5 http://127.0.0.1:8080/api/continuity/status || echo NO_CONTINUITY
echo
echo "== ultimas lineas del journal =="
journalctl -u boundary.service -n 12 --no-pager || true
echo DEPLOY_PRODUCT_DONE
