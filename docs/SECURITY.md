# Security model

## Trust boundaries

| Party | Trusted? | Why |
|---|---|---|
| Operator (human) | yes | configures policy, provides tests and credentials |
| Policy + gateway | yes | deterministic, audited, not writable by the agent |
| Worker (model) | **no** | it may be wrong, confused or manipulated |
| Tool arguments | **no** | every argument is normalized and validated |
| Test output | only as evidence | exit codes are recorded, never interpreted as intent |

## What the agent cannot do

- Change policy, capabilities or the approved mechanism catalog.
- Reach the network from inside the sandbox (`network=none`).
- Write outside the mounted workspace (read-only root, path normalization, symlink checks).
- Grant itself an approval. Approvals are external facts with a fingerprint and a TTL.
- Read the hidden tests or the expected answers.

## Sandbox

Rootless Docker with cgroup v2, verified at boot: uid remap, `no-new-privileges`, memory and pids
limits, tmpfs of fixed size, no network interface. A container is disposed of after its operation.
The boot verification is not decorative: if it fails, `/healthz` reports `simulated: true` and the
gateway refuses to claim enforcement.

## API surface

- `GET /healthz`, `GET /api/state`, `GET /` and the dashboard: read-only, no secrets.
- `POST /api/tasks` and other mutations: require `Authorization: Bearer <token>` when
  `BOUNDARY_API_TOKEN` is configured; without a token the server refuses mutations.

## Secrets

- The inference key is read from the environment (`/etc/boundary.env`, 0600, root on the VM).
- Nothing in this repository contains a key; `.env.example` holds empty values only.
- Verification scripts read the token from the environment and abort if it is missing.

## Known limits

- Verification inherits the strength of the operator-supplied tests. Weak tests give weak evidence.
- A single-VM demo deployment is not a multi-tenant boundary.
- The model can still produce a *wrong* but *allowed* action; the boundary limits blast radius, not
  correctness.

