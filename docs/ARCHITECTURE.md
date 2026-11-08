# Architecture

BOUNDARY is a thin, deterministic layer between an agent and the machine. The agent is treated as
an untrusted caller: it may ask, it may not decide.

## Request path

```text
Worker.chat()  ──▶  Gateway.authorize(request)  ──▶  Sandbox.execute(op)  ──▶  Verification
     ▲                      │                                                      │
     └──── observation ─────┴──────────────────────────────────────────────────────┘
```

1. **Classification** (`src/policy.ts`). Every tool call becomes an `OperationRequest`: tool name,
   normalized arguments, capability, effect signature and a sha256 fingerprint. Unknown tools and
   unparsable arguments are rejected before anything else happens.
2. **Authorization**. The policy is a pure function of (request, scope, environment). It returns an
   allow or a denial code. Nothing the model writes can change it; there is no tool that edits policy.
3. **Execution** (`src/sandbox-docker.ts`). One disposable container per operation: no network,
   read-only root with an explicit writable workspace mount, uid remap, `no-new-privileges`, cgroup
   limits. If the boot check fails, the gateway falls back to *simulation-only* and says so in
   `/healthz` (`simulated: true`) instead of pretending to enforce.
4. **Verification**. Public and hidden test suites run inside the container. Exit codes, run state and
   the `resolved` flag are recorded by the harness. The page that displays them never recomputes a
   value and prints `not recorded` for anything the artifact does not carry.

## Two separate mechanisms

| | Gateway | Lifeguard |
|---|---|---|
| Question | may this call run? | how does the task continue? |
| Power | denies or allows | none: it only writes a message |
| Failure mode | fail-closed | silence, recorded as `withheld` |
| Output | an observation the worker reads | a message in the worker channel |

Keeping them separate is the point. A guard that can grant things is a second, unaudited policy.

## Continuity

`src/continuity.ts` runs the full cycle for one task: objective → worker steps → tool calls through
the gateway → verification → artifact. It records `sent`, `received`, `resumed` and `resolved` as
four independent facts, because a message that was generated but never delivered is not an
intervention.

## Artifacts

Every run ends with a JSON artifact: observations, interventions, tally, cost, exit codes and the
run state. The dashboard in `web/bench.html` renders one such artifact
(`web/bench/sprint-report.json`) and executes nothing.

## Files

| Path | Responsibility |
|---|---|
| `src/policy.ts` | capabilities, fingerprints, denial codes, approved mechanisms |
| `src/gateway.ts` | mediation, risk, approvals, fail-closed behaviour |
| `src/sandbox.ts` / `src/sandbox-docker.ts` | sandbox port and the rootless Docker implementation |
| `src/agent.ts` | worker loop, inference adapter, tool mediation |
| `src/judge.ts` | diagnosis of a block or failure; never authorizes |
| `src/lifeguard.ts` | intervention proposals restricted to approved mechanisms |
| `src/intervention.ts` / `src/stall.ts` | message construction and stall detection |
| `src/continuity.ts` | end-to-end cycle and artifact |
| `src/server.ts` | HTTP surface, static panel, task API |

