# Deploy on Vultr

What is actually running at https://45-76-14-75.sslip.io, and how to rebuild it.

## Shape

```text
client ──▶ Caddy (443, Let's Encrypt) ──▶ 127.0.0.1:8080 (boundary.service)
                                          │
                                          └──▶ rootless dockerd (unix:///run/user/<uid>/docker.sock)
                                                  └──▶ one disposable container per operation
```

- Vultr Cloud Compute `vc2-2c-4gb` (2 vCPU / 4 GB, Ubuntu 24.04, region `ewr`).
- Non-root user `boundary`; systemd unit `boundary.service` runs the server.
- Rootless Docker with cgroup v2; verified at boot before the gateway claims enforcement.
- Inference through **Vultr Serverless Inference**, model `deepseek-v4.1-flash-1017`.

## Configuration

The unit reads `/etc/boundary.env` (0600, owned by root). Nothing secret is in this repository.

```text
BOUNDARY_INFERENCE_BASE_URL=https://api.vultrinference.com/v1
BOUNDARY_INFERENCE_MODEL=deepseek-v4.1-flash-1017
BOUNDARY_INFERENCE_API_KEY=<key>
PORT=8080
BOUNDARY_SANDBOX=docker
BOUNDARY_WORKSPACE_ROOT=/var/lib/boundary/workspaces
BOUNDARY_API_TOKEN=<token for mutating calls>
DOCKER_HOST=unix:///run/user/<uid>/docker.sock
```

## Steps

1. **Host preparation** — `scripts/sandbox/install-rootless-docker.sh` (or
   `scripts/vultr/setup-rootless.sh`) installs Docker, enables the rootless socket and validates cgroup
   v2 limits.
2. **Sandbox image** — `scripts/sandbox/build-image.sh` builds the minimal image the operations run in.
3. **Provisioning** — `scripts/vultr/provision.ps1` creates the instance and firewall from a Vultr API
   key read from the environment, the registry or `.secrets/vultr.key` (never from the script).
4. **Deployment** — `scripts/vultr/deploy.sh` packs the server, installs it under `/opt/boundary`,
   writes the systemd unit and restarts the service. `scripts/vultr/deploy-product.sh` is the shorter
   path used for the demo VM.
5. **Verification** — `scripts/vultr/verify-e2e.ps1` checks `/healthz`, the panel and one
   authorization path; `scripts/vultr/verify-security.ps1` checks that mutations are refused without a
   token. Both read the token from `BOUNDARY_API_TOKEN`.

## Health

`GET /healthz` is the single source of truth:

```json
{"ok":true,"simulated":false,"sandboxAvailable":true,
 "sandboxNote":"sandbox real: cgroup v2, rootless=true, mem=512MB, pids=64"}
```

`simulated: true` means the rootless sandbox could not be verified and the gateway is fail-closed. The
server never claims enforcement it cannot prove.

## Notes

- The demo VM is a single node, sized for a demonstration, not a multi-tenant service.
- TLS is terminated by Caddy; the application port stays on loopback.
- Rotate the inference key and `BOUNDARY_API_TOKEN` if the host is rebuilt.

