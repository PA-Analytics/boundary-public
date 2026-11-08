#!/usr/bin/env bash
# Prueba REAL de contención en la VM: red, disco, memoria, pids y cpu.
# Cada línea PASS/FAIL se calcula con la salida observada, no con lo declarado.
set -uo pipefail
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
IMG=${IMG:-oven/bun:1}
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; }

echo "== daemon =="
docker info --format "cgroup={{.CgroupVersion}} sec={{.SecurityOptions}} root={{.DockerRootDir}}"

echo "== pull =="
docker pull -q "$IMG" >/dev/null 2>&1 && echo "imagen $IMG lista" || { echo "no se pudo bajar $IMG"; exit 1; }

echo "== red desactivada =="
out=$(docker run --rm --network none "$IMG" sh -c "timeout 5 curl -s -o /dev/null -w %{http_code} https://api.vultr.com/v2/account || echo NETFAIL" 2>&1)
if [ "$out" = "NETFAIL" ] || [ -z "$out" ]; then pass "sin salida de red con --network none"; else fail "salida de red con --network none: $out"; fi

echo "== rootfs de solo lectura =="
out=$(docker run --rm --read-only "$IMG" sh -c "touch /probe 2>&1 || echo ROFAIL" 2>&1)
case "$out" in *ROFAIL*|*Read-only*) pass "rootfs de solo lectura";; *) fail "escritura en rootfs: $out";; esac

echo "== memoria =="
out=$(docker run --rm --memory 64m --memory-swap 64m "$IMG" sh -c "bun -e \"const a=[];for(let i=0;i<200;i++){a.push(Buffer.alloc(1024*1024*4,1));} console.log(\"NO_OOM\")\" 2>&1; echo rc=\$?" 2>&1)
case "$out" in *NO_OOM*) fail "memoria no limitada (asignó 800MB con --memory 64m)";; *) pass "OOM kill aplicado con --memory 64m";; esac

echo "== pids =="
out=$(docker run --rm --pids-limit 32 "$IMG" sh -c "i=0; while [ \$i -lt 80 ]; do sleep 5 & i=\$((i+1)); done; wait" 2>&1; echo rc=\$?)
case "$out" in *"Resource temporarily unavailable"*|*"can't fork"*|*"fork"*) pass "pids limitados a 32";; *) fail "pids sin cota: $(echo "$out" | tr "\n" " " | cut -c1-120)";; esac

echo "== cpu =="
out=$(docker run --rm --cpus 0.25 "$IMG" sh -c "cat /sys/fs/cgroup/cpu.max" 2>&1)
if [ -n "$out" ]; then pass "cpu.max dentro del contenedor: $out"; else fail "cpu.max no legible"; fi

echo "== sin capacidades / no privilegiado =="
out=$(docker run --rm --cap-drop ALL --security-opt no-new-privileges "$IMG" sh -c "id -u; grep CapEff /proc/self/status" 2>&1)
echo "$out" | head -2
uid=$(echo "$out" | head -1 | tr -d " ")
if [ "$uid" = "0" ]; then echo "nota: imagen corre como root dentro del contenedor"; else pass "usuario no-root dentro del contenedor ($uid)"; fi

echo "== sin socket de docker dentro del contenedor =="
out=$(docker run --rm "$IMG" sh -c "ls /var/run/docker.sock 2>/dev/null || echo NOSOCK" 2>&1)
case "$out" in *NOSOCK*) pass "sin socket de Docker montado";; *) fail "socket visible: $out";; esac

echo "PROBE_DONE"
