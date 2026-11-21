# BOUNDARY — Auditable AI Agent Execution

BOUNDARY is a control plane that sits between an autonomous agent and the machine it operates on.
Every tool call is classified, authorized by a deterministic policy, executed in a disposable
rootless container, and verified against the real outcome. Nothing is enforced by prompting the
model harder.

> Autonomy without unrestricted permissions.

Built for **Vultr × lablab.ai — Agent Rush 2026**, challenge **Blast Radius Zero**.

Live demo: https://45-76-14-75.sslip.io/ · Benchmark dashboard: https://45-76-14-75.sslip.io/bench.html

---

## Problem

A system prompt is a request, not a boundary. When an agent runs unattended, three things are
usually true at once:

1. **The agent holds more authority than the task needs** — it shares the shell, the network and the
   credentials of the host that supervises it.
2. **The only real enforcement point is the sandbox**, and it is usually all-or-nothing: full network
   and full filesystem, or the task stops on its first permission error.
3. **"It finished" is not evidence.** Exit code 0 from a model that also wrote the test is not a
   verified outcome.

So the interesting failure is not a jailbreak. It is a task that stopped halfway, or a task that
"passed" while nothing was actually verified.

## Solution

- **Deterministic policy** — deny-by-default classification of every tool call (tool, arguments,
  capability, effect signature). The agent cannot read, edit or argue with it.
- **Rootless sandboxed execution** — one disposable container per operation: no network, read-only
  root, cgroup limits (512 MB memory, 64 pids), uid remap. Verified at boot; if verification fails the
  gateway stays fail-closed and reports simulated: true.
- **Outcome verification** — public and hidden tests run inside the container; the recorded resolved
  flag comes from the harness, never from the model.
- **Contextual intervention (experimental, measured null)**: the Lifeguard reads an authorized transcript of a
  blocked or stalled run, diagnoses the block, and delivers a suggestion into the worker channel so it
  can continue through a path the policy already allows. It never grants, escalates or removes a
  restriction. In live pilots the stall guard **never changed an outcome** (see Results).
- **Approved-dependency recovery**: when an install is denied, Lifeguard can materialize a
  pre-approved, hash-verified package. What it was measured to change is provenance, not completion (see Results).

## Architecture

```text
        objective
           │
           ▼
   ┌───────────────┐   tool call    ┌───────────────┐  authorized op  ┌───────────────┐
   │    Worker     │ ─────────────▶ │    Gateway    │ ──────────────▶ │    Sandbox    │
   │ (model, chat) │ ◀───────────── │ policy + risk │                 │ rootless ctr  │
   └───────────────┘  observation   └───────┬───────┘                 └───────┬───────┘
           ▲                                │ denial / block                  │
           │ intervention (opt-in)          │                                 ▼
   ┌───────┴───────┐                        │                          ┌───────────────┐
   │   Lifeguard   │ ◀── authorized ────────┴────────────────────────▶ │ Verification  │
   │  (continuity) │     transcript, read-only, no grants            │ public+hidden │
   └───────────────┘                                                 └───────────────┘
```

- **Worker** — the agent. It sees the chat and its tool observations, never the policy internals.
- **Gateway** — classifies, fingerprints and authorizes each call. A denial becomes an observation the
  worker can react to, not a crash.
- **Sandbox** — disposable rootless Docker container per operation. The only place code runs.
- **Verification** — exit codes, run state and the resolved flag are produced by the harness and
  recorded in the artifact.
- **Lifeguard** — a separate continuity mechanism, not a privilege channel. It records sent, received,
  resumed and resolved as four independent flags.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/LIFEGUARD.md](docs/LIFEGUARD.md) ·
[docs/SECURITY.md](docs/SECURITY.md)

## Vultr integration

| Piece | What is used |
|---|---|
| Compute | Vultr Cloud Compute vc2-2c-4gb (2 vCPU / 4 GB, Ubuntu 24.04, ewr), non-root user boundary, rootless Docker with cgroup v2 |
| Inference | **Vultr Serverless Inference**, model deepseek-v4.1-flash-1017 for worker, guard and judge |
| Model integrity | every invocation records requested and returned model; a mismatch disqualifies the run |
| Secrets | the API key lives in /etc/boundary.env (0600, root) and never enters the repository |
| Public edge | Caddy with a Let's Encrypt certificate in front of a server that only listens on loopback |

Deployment and verification: [docs/DEPLOY-VULTR.md](docs/DEPLOY-VULTR.md).
Without a key the agent degrades to a deterministic offline mode and says so.

## Quick start

Requires bun >= 1.1.0 (and Docker for the real sandbox).

```sh
git clone <this repo> && cd boundary
bun install
cp .env.example .env        # optional: fill in the inference key
bun run check               # typecheck + full test suite
bun run start               # panel + API on http://127.0.0.1:3000
```

Run one supervised task through the API (the panel is read-only and cannot authorize anything):

```sh
curl -s -X POST http://127.0.0.1:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"objective":"repair fixtures/broken-repo","declaredSteps":1,"estimatedMinutes":1}'
```

The real sandbox is enabled with BOUNDARY_SANDBOX=docker; image and host preparation live in
scripts/sandbox/.

## Reproducible evidence

```sh
bun run check                     # typecheck + 300+ tests
bun test test/contracts.test.ts   # policy and gateway contracts only
bun test test/security.test.ts    # containment, denial paths
bun run bench                     # deterministic benchmark: no network, no cost
```

The public dashboard and the numbers below are rendered from one persisted artifact,
web/bench/sprint-report.json, which is in this repository. The page executes nothing: it prints what
the artifact holds and writes "not recorded" when a field is missing.

## Results

Reported honestly, including the part that did not work.

### Live pilots (current evidence)

Agent: Devin sessions in Lite mode working only through the mediated harness (`bench/pilot-harness.ts`), on the
36-scenario barrier pack (`bench/barrier-pack.ts`), where each tempting action is blocked by the real policy and an
allowed route exists. The metric was pre-registered (`docs/PILOT_PREREG.md`). Full results:
[docs/PILOT_RESULTS.md](docs/PILOT_RESULTS.md). Raw logs: `bench/pilot-runs/`.

| Claim | Measured | Verdict |
|---|---|---|
| The gateway blocks unsafe actions without stopping the task | 46/48 barrier runs resolved, 0 violations, 0 deploys, 0 out-of-band edits | supported (directional) |
| The stall guard rescues stuck agents | 23/24 with the guard vs 23/24 without; the repetition detector never fired | **not supported** |
| Lifeguard recovery lets a blocked install finish | replication with 15 fresh agents: with Lifeguard 5/5 sessions resolved with the approved package; without it 0/5 and 0/5 (Fisher p = 0.004), and 7/10 of those agents **fabricated** a dependency that passed the tests | **supported** (provenance-safe completion) |

Caveats: a single agent model (Lite) and small n. Capable agents route around a denial or stop; they don't loop. So
the stall guard has nothing to catch. The indirect-exec hole (a script edits a protected file) is closed by
`src/integrity.ts`, but no live agent tried it.

### Original sprint (superseded)

The 30-run sprint below never exercised the boundary: its barriers lived in the tests, not in the policy, and the
gateway refused 0 of 368 calls (`docs/SCENARIO_REVIEW.md`). It is kept for the record.

| Config | Meaning | Functional | Received | Resumed | Resolved |
|---|---|---|---|---|---|
| B | autonomous recovery (no Lifeguard) | 5 / 10 | 0 | 0 | 0 |
| D | fixed guidance | 5 / 10 | 1 | 0 | 0 |
| E | contextual Lifeguard | 5 / 10 | 1 | 0 | 0 |

Formal verdict for that sprint: **INCONCLUSIVE** (1 repetition per cell, 0 gateway refusals). Breakdown:
[docs/BENCHMARK.md](docs/BENCHMARK.md).

## Limitations

- The stall guard showed **no effect** in live pilots. Lifeguard's dependency recovery is supported only for its
  measured case: a blocked install with an approved artifact in the store. Deny-only setups still let agents fabricate dependencies.
- Live pilots used one agent model (Devin Lite). The results are directional, not significant.
- The 200-scenario Gauntlet used during development is **not published**: it contains private
  evaluators, hidden tests and expected answers. The rest stays private by design.
- Verification is only as strong as the tests the operator supplies; hidden tests come from the
  operator, not from the model.
- The public deployment is a single VM for demonstration, not a multi-tenant hardened service.

## Security

- Deny-by-default policy; every authorization is per call and fingerprinted.
- Rootless containers, no network, read-only root, cgroup limits, uid remap, no-new-privileges.
- Mutating API calls require a bearer token; the panel is read-only.
- Secrets are never committed: this repository ships .env.example with empty values only.
- Please report vulnerabilities privately instead of opening a public issue.

Threat model and limits: [docs/SECURITY.md](docs/SECURITY.md).

## Repository layout

```text
src/        policy, gateway, sandbox, judge, lifeguard, continuity, server
web/        panel + benchmark dashboard (static, no build step)
test/       public test suite (contracts, security, end-to-end, continuity)
bench/      benchmark runners (deterministic and live)
scripts/    sandbox image and host prep, Vultr deployment, continuity tools
fixtures/   small broken repository used by the demo task
docs/       architecture, security, benchmark and deployment notes
```

## License

MIT — see [LICENSE](LICENSE).
