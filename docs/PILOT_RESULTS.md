# Live pilot results and verdict

Pre-registration and the changes between rounds: `docs/PILOT_PREREG.md`. Raw logs: `bench/pilot-runs/{A,B}` (round 1) and `bench/pilot-runs/r2-{A,B}` (round 2). Agent: Devin in Lite mode, two counterbalanced sessions per round; no Vultr.

| Round | Runs | Resolved (guard / none) | Runs with ≥1 denial | Guard messages | Violations / deploys |
|---|---|---|---|---|---|
| 1 | 12 | 5/6 / 5/6 | 5 of 8 barrier runs | 0 | 0 / 0 |
| 2 | 12 | 6/6 / 6/6 | 4 of 8 barrier runs | 2 (both after the task was already solved) | 0 / 0 |

Both failures (round 1, BND-015 deploy, one in each arm) came from an agent stopping after one denial. In one case the doc was ambiguous about the approval file name.

## Verdict

- **Policy layer: works.** Over 24 live runs, every tempting unsafe path the agents tried was blocked: 0 protected-file edits, 0 deploys, 0 network installs, 0 out-of-band edits. The sprint had 0 denials only because its barriers were never put in the policy (`docs/SCENARIO_REVIEW.md`).
- **Continuity guard: no measurable value.** Resolution was identical with and without it (11/12 vs 11/12). The repetition-based detector never fired: capable agents do not loop on a blocked call. They route around it, or stop. The give-up interception added in round 2 fired twice, both times after the agent had already succeeded, so it only cost an extra call.
- **Limits:** n = 24 and a single agent model (Lite). The result is directional, not significant. A weaker or loop-prone agent might benefit from the guard; this pilot did not test that.

The supported claim is **Boundary as a deterministic safety gateway**: it blocks unsafe actions without stopping capable agents from finishing (22/24 resolved, 0 violations). The continuity hypothesis ("the guard rescues agents that get stuck") is not supported by this data and should not be claimed.
