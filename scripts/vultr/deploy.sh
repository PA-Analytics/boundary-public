#!/usr/bin/env bash
# Despliegue de BOUNDARY en la VM: unidad systemd + código + arranque.
set -euo pipefail
UID_B=$(id -u boundary)

echo "== unidad =="
cat > /etc/systemd/system/boundary.service <<UNIT
[Unit]
Description=BOUNDARY middleware
After=network-online.target
Wants=network-online.target

[Service]
User=boundary
Environment=HOME=/home/boundary
Environment=PORT=8080
Environment=DOCKER_HOST=unix:///run/user/UID_B_PLACEHOLDER/docker.sock
Environment=BOUNDARY_SANDBOX=docker
Environment=BOUNDARY_WORKSPACE_ROOT=/var/lib/boundary/workspaces
EnvironmentFile=-/etc/boundary.env
Environment=PATH=/home/boundary/.bun/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/opt/boundary
ExecStart=/home/boundary/.bun/bin/bun run src/server.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
ReadWritePaths=/opt/boundary

[Install]
WantedBy=multi-user.target
UNIT
sed -i "s/UID_B_PLACEHOLDER/$UID_B/" /etc/systemd/system/boundary.service

echo "== codigo =="
rm -rf /opt/boundary
mkdir -p /opt/boundary
tar -xzf /tmp/boundary.tgz -C /opt/boundary
chown -R boundary:boundary /opt/boundary
su - boundary -c "cd /opt/boundary && /home/boundary/.bun/bin/bun install --no-save 2>&1 | tail -3"

echo "== workspace escribible =="
mkdir -p /var/lib/boundary/workspaces
chmod 0777 /var/lib/boundary/workspaces

echo "== entorno (claves fuera del repo) =="
if [ -f /tmp/boundary.env ]; then
  install -m 600 -o root -g root /tmp/boundary.env /etc/boundary.env
  rm -f /tmp/boundary.env
fi
if [ -f /etc/boundary.env ]; then
  echo "env: $(grep -c VULTR /etc/boundary.env) variables de inferencia"
fi

echo "== caddy =="
HOST_DOMAIN=$(curl -s -m 5 ifconfig.me >/dev/null 2>&1 && echo ok || true)
PUBLIC_IP=$(curl -4 -s -m 8 https://ifconfig.me/ip | tr -d "\r")
DOMAIN=$(echo "$PUBLIC_IP" | tr "." "-").sslip.io
echo "dominio: $DOMAIN"
cat > /etc/caddy/Caddyfile <<CADDY
"$DOMAIN" {
  reverse_proxy 127.0.0.1:8080
}
http://"$PUBLIC_IP" {
  reverse_proxy 127.0.0.1:8080
}
CADDY
systemctl reload caddy || systemctl restart caddy

echo "== arranque =="
systemctl daemon-reload
systemctl enable boundary.service
systemctl restart boundary.service
sleep 6
systemctl is-active boundary.service || true
echo "== health local =="
curl -s -m 5 http://127.0.0.1:8080/healthz || echo NO_HEALTH
echo
echo "== desde fuera (proxy) =="
curl -s -m 5 -o /dev/null -w "http=%{http_code}\n" http://127.0.0.1:80/ || true
echo DEPLOY_DONE
