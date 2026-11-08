#!/usr/bin/env bash
# Ejecuta el benchmark LIVE en la VM con la clave de inferencia del entorno del servicio.
set -euo pipefail
cd /opt/boundary
export HOME=/home/boundary
export PATH=/home/boundary/.bun/bin:/usr/local/bin:/usr/bin:/bin
export DOCKER_HOST="unix:///run/user/$(id -u boundary)/docker.sock"
export BOUNDARY_SANDBOX=docker
export BOUNDARY_LIVE_REPS="${BOUNDARY_LIVE_REPS:-5}"
export BOUNDARY_LIVE_MAX_STEPS="${BOUNDARY_LIVE_MAX_STEPS:-5}"
set -a
. /etc/boundary.env
set +a
exec su boundary -s /bin/bash -c '/home/boundary/.bun/bin/bun run bench/live-run.ts'
