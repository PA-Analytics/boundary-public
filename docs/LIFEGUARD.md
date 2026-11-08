# Lifeguard (experimental)

The Lifeguard is the continuity half of BOUNDARY: when a worker stalls or is refused, it does not open
a door, it writes a sentence.

## Principle

A guard with granting powers is a second policy, running inside a model. So the Lifeguard has exactly
one output: a message delivered into the worker's own channel, built only from evidence the operator
authorized it to read.

- **Reads**: the task objective, the transcript the operator marked as authorized, the block or stall
  evidence, the capability restriction.
- **Writes**: an intervention message, with `evidenceRefs` pointing at the observations it used.
- **Cannot**: grant, escalate, retry a denied operation, modify policy, or read hidden tests.

## Detection

`src/stall.ts` classifies a stall from the observable contract rather than from model prose: repeated
identical tool calls, a deterministic contract rejection, an exhausted attempt budget. Each signal
carries the evidence that produced it, so the diagnosis can be checked afterwards.

## Channels

An intervention is delivered into a channel file that the worker reads on its next turn. The artifact
records four independent flags:

| Flag | Meaning |
|---|---|
| `sent` | the message was written to the channel with its id |
| `received` | the worker actually read it on its next request |
| `resumed` | the worker performed a new allowed action after reading it |
| `resolved` | the run closed as resolved according to the harness |

Generating a reply is not an intervention. That distinction is why the four flags exist and why the
benchmark reports `received` and `resolved` separately.

## Status

Experimental. The mechanism works end to end in the demo (see the continuity flow in `src/continuity.ts`
and the runner `scripts/run-continuity.ts`), but the pilot provides no evidence of an incremental
benefit. The repository reports it that way.

