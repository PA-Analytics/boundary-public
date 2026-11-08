# Host de sandbox — reparto de máquinas

Tres máquinas, tres papeles que no se solapan. Ninguna prueba toca la API de
Vultr ni el MVP desplegado.

| Máquina | Papel | Qué se ejecuta | Qué NO se ejecuta |
|---|---|---|---|
| **PC (Windows, esta)** | Autoría y control | `bun test` unitario/contractual con `SpySandbox`, edición de código, `git` | Cualquier prueba de contención OS: no hay Docker ni WSL |
| **VM instabox (Linux)** | **Host de sandbox** — única fuente de evidencia OS | `preflight-host.sh`, `build-image.sh`, contenedores reales del gate | Nada de secretos reales ni datos privados dentro |
| **Vultr** | MVP desplegado (Caddy + `boundary.service`) | Sólo `systemctl status` / `/healthz` | Probes, gauntlet, `api.vultr.com`, cambios de configuración |

Regla dura: **Vultr no ejecuta el gauntlet.** Ahí vive el servicio en 8080; un
`docker pull` o un contenedor de prueba contamina la única cosa que hay que
mantener intacta. Y `scripts/vultr/probe-containment.sh` **no se ejecuta tal
cual**: hace `docker pull` y consulta `api.vultr.com`, contra las restricciones
del dataset.

## Requisitos del host de sandbox

Linux (Debian/Ubuntu 22.04+), cgroup v2 unificado, Docker **rootless** con
socket de usuario, delegación `cpu memory pids` y la imagen local fijada por Id.
Un `docker info` que diga cgroup v2 **no basta**: sin `Delegate=yes` en
`user@.service`, rootless acepta `--memory` y no lo aplica. `docker-real.test.ts`
falla cerrado (`enforced=false`) en ese caso, que es lo correcto.

## PC como tercer host (WSL2)

La PC es Intel Ultra 5 250KF, 18 núcleos / 18 hilos, 32 GB de RAM, Windows 11 build
26300, hipervisor activo. Más capacidad que las dos VMs juntas, gratis.

```powershell
# 1) PowerShell COMO ADMINISTRADOR
powershell -ExecutionPolicy Bypass -File scripts/sandbox/install-wsl.ps1 -Enable
#    escribe .wslconfig (16 GB / 14 CPUs para WSL, no 32), activa WSL y el kernel.
# 2) REINICIA Windows
# 3) sin admin, ya con WSL dentro:
powershell -ExecutionPolicy Bypass -File scripts/sandbox/install-wsl.ps1 -PostReboot
```

La fase 2 instala Ubuntu 24.04, activa systemd, crea `boundary`, monta Docker
rootless, construye la imagen y corre el preflight. El `.wslconfig` limita WSL a
16 GB y 14 CPUs a propósito: dejarlo sin tope deja la PC sin memoria para Windows.

## Hosts activos (Vultr, verificados)

| Etiqueta | IP | Tamaño | Contenedores | Coste 3 días |
|---|---|---|---|---|
| `boundary-sandbox` | 45.63.20.174 | 2 vCPU / 2 GB | 2 | ~1,50 USD |
| `boundary-worker` | 45.63.3.238 | 4 vCPU / 8 GB | 8 | ~4,00 USD |
| `boundary-power` | 104.207.128.58 | 12 vCPU / 24 GB | **24 probados** | ~14,40 USD |
| **PC (WSL2)** | local | 14 vCPU / 16 GB asignados | **16 cómodos, 28 probados** | 0 |

Medido, no estimado: 24 contenedores vivos a la vez en `boundary-power` con
1,3 GB en uso; 28 arrancados en 865 ms en el PC y 16 sostenidos con 1,1 GB. El
techo práctico es la CPU (un contenedor = 1 vCPU), no la memoria.

Los cuatro hosts comparten la MISMA imagen (`sha256:6799c86d…`); `boundary-power`
se copió con `docker save` desde `boundary-worker`, no se reconstruyó.

Ubuntu 24.04 en ambos, sólo SSH abierto. Provisionados con `provision-vultr.ps1`;
clave en `.secrets/ssh/boundary_ed25519`, usuario `boundary` con sudo.

### Concurrencia medida del proveedor de modelo

`deepseek-v4.1-flash-1017` vía `api.vultrinference.com`: 1 petición ≈ 0,4–0,6 s;
**32 en paralelo en 1,4 s, 32/32 con HTTP 200, cero errores**. El rate limit no
es el techo hasta 32 concurrentes, así que abrir workers sí acelera las corridas
B/C. El cuello es cuántos contenedores caben, no la API.

```
PREFLIGHT_READY   (15/15 en OK en AMBOS hosts: cgroup v2, rootless,
                   delegación, linger, imagen fijada por Id, contenedor sin pull)
BOUNDARY_SANDBOX_IMAGE=boundary/gauntlet:1
BOUNDARY_SANDBOX_DIGEST=sha256:6799c86df9f83e2073cdd002d817138fce21c0a3e036b0a3c2edebc4bba6f311
```

Misma imagen en los dos hosts, byte a byte: se construyó una vez en el worker y
se copió con `docker save | gzip` + `scp` + `docker load`. Reconstruir en cada
máquina da Ids distintos (BuildKit incluye manifiestos de attestation), y dos
digests para la misma imagen invalidan cualquier comparación entre workers.

```bash
# estado / crear / destruir
powershell -File scripts/sandbox/provision-vultr.ps1 -Plan
powershell -File scripts/sandbox/provision-vultr.ps1 -Apply
powershell -File scripts/sandbox/provision-vultr.ps1 -Destroy
```

Este host es **control del arnés**, no evidencia sobre el producto: verifica que
existe un entorno capaz de aplicar las cotas y de no descargar imágenes. No
demuestra que `DockerSandbox` (`src/sandbox-docker.ts`) emita `--pull never` — no
lo emite, y por eso el kernel-gate sigue en `BLOCKED_UNSAFE_IMPLICIT_PULL` y
aborta antes de `prepare/run`. Si algún día se usa un envoltorio sin pull, hay que
etiquetarlo como control adicional, aplicarlo igual a B y a C, y no presentarlo
como propiedad del adaptador original.

## Medición del host InstaBox

Instalado y probado en la VM `try-001` el 2026-11-06: Docker rootful aplica todos
los límites, pero **Docker rootless es imposible en ese kernel** (deniega montar
procfs en un user namespace). Detalle y comandos exactos en
HOST-FINDINGS.md (internal note, not published). `preflight-host.sh` incluye ya esa prueba
(`userns-proc-mount`) para descartar un host en segundos.

## Evaluador y registro de consumo

El gate no basta con aislar red y rootfs. El canal del evaluador y el registro
de consumo viven **fuera** del contenedor:

- Proceso evaluador aparte, con su propio usuario, que sirve RPC sobre un socket
  Unix propio. Ese socket **nunca** aparece en `spec.mounts`: el agente no puede
  verlo, ni abrirlo, ni suplantarlo.
- El contenedor sólo recibe un workspace público, fresco y por caso. Nada de
  `private-evaluation`, oráculos, salidas esperadas, `.git` ni material de clave.
  `workspace-guard.sh` falla si algo de eso está dentro.
- El registro de consumo lo escribe el proceso padre (host), no el código que
  corre dentro del sandbox: lo que el agente declare sobre sí mismo no cuenta.

```bash
bash scripts/sandbox/workspace-guard.sh --workspace /srv/boundary/cases/C-001
# WORKSPACE_OK | WORKSPACE_UNSAFE (rc=1)
```

## Orden de ejecución


```bash
# 0) en instabox, una vez (usa red: apt, get.docker.com, bun.sh)
bash scripts/sandbox/install-rootless-docker.sh --yes

# 1) una imagen, una vez (usa red: docker build --pull)
bash scripts/sandbox/build-image.sh --yes
#    → exporta BOUNDARY_SANDBOX_IMAGE y BOUNDARY_SANDBOX_DIGEST

# 2) auditoría readonly, sin red, repetible
bash scripts/sandbox/preflight-host.sh --image "$BOUNDARY_SANDBOX_IMAGE" --digest "$BOUNDARY_SANDBOX_DIGEST"
#    PREFLIGHT_READY = listo para el gate. PREFLIGHT_NOT_READY = aún no.

# 3) sólo con PREFLIGHT_READY (rc=0)
BOUNDARY_CRITICAL_DOCKER_OPTIN=1 BOUNDARY_CRITICAL_ISOLATED=1 \
  bun run gauntlet/critical-probes/run.ts
```

`preflight-host.sh` no descarga, no crea contenedores, no escribe en el sistema
y no consulta ninguna red: es seguro en cualquier host, incluido el PC (allí
simplemente devuelve `NOT_READY` con el motivo).

## Lo que se puede preparar sin esperar a los 200 escenarios

1. Host instalado y verificado (`install-rootless-docker.sh` + `preflight-host.sh`).
2. Imagen construida y digest fijado (`build-image.sh`).
3. Suite contractual en el PC: `bun test` sobre `test/` no necesita Docker.
4. Los dos defectos abiertos del core, que son del repo, no del entorno:
   - `src/sandbox-docker.ts:126-162` — `buildDockerRunArgs` no emite
     `--pull never`; el daemon podría descargar, contrario al claim "sin pull".
   - `src/sandbox.ts:68-112` — `controlsFromSnapshot` devuelve `enforced:false`
     siempre; `probeDockerRuntime` existe pero el probe que se consulta en el
     gauntlet es el sintético. Conectar uno con otro es una decisión de producto.

Ninguno de los dos se toca sin autorización explícita: cambian el core bajo
evaluación y la cadena de evidencia de la otra pestaña.
