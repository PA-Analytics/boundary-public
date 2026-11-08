#!/usr/bin/env bash
# Construye LA imagen del sandbox y fija su digest.
#
# Único paso con red: `docker build --pull` descarga la base. Después de esto,
# todas las pruebas usan `--pull never` y el digest fijado.
#
# Uso:
#   bash scripts/sandbox/build-image.sh --yes [--tag boundary/gauntlet:1]
# Salida: imprime BOUNDARY_SANDBOX_IMAGE y BOUNDARY_SANDBOX_DIGEST listos para exportar.
set -euo pipefail

TAG=${BOUNDARY_SANDBOX_IMAGE:-boundary/gauntlet:1}
if [ "${1:-}" != "--yes" ]; then
  echo "esto descarga la imagen base (red). Confirma con: $0 --yes" >&2
  exit 2
fi

HERE=$(cd "$(dirname "$0")" && pwd)
UID_NOW=$(id -u)
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$UID_NOW}
export DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/$UID_NOW/docker.sock}

echo "== build $TAG =="
docker build --pull -f "$HERE/Dockerfile.sandbox" -t "$TAG" "$HERE"

ID=$(docker image inspect --format '{{.Id}}' "$TAG")
SIZE=$(docker image inspect --format '{{.Size}}' "$TAG")
CREATED=$(docker image inspect --format '{{.Created}}' "$TAG")

echo
echo "BOUNDARY_SANDBOX_IMAGE=$TAG"
echo "BOUNDARY_SANDBOX_DIGEST=$ID"
echo "tamaño=$SIZE creada=$CREATED"
echo
echo "export BOUNDARY_SANDBOX_IMAGE=$TAG"
echo "export BOUNDARY_SANDBOX_DIGEST=$ID"
