#!/usr/bin/env bun
/** Verifies captured REAL HTTP events. Does not synthesize a worker turn or start a task. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const url = new URL(process.argv[2] ?? '');
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid session URL');
if (!/^\/api\/continuity\/tasks\/cs_[A-Za-z0-9_-]{1,90}$/.test(url.pathname)) throw new Error('Expected a continuity session URL');
const out = resolve(process.argv[3] ?? 'gauntlet/reports/final-sprint/live-local.json');
const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const { session } = await response.json() as { session: { id: string; status: string; startedAt: string; finishedAt: string | null; mode: string; intervention: Record<string, boolean>; verification: { passed: boolean | null; detail: string }; events: { id: string; at: string; sessionId: string; type: string; text: string; data?: Record<string, unknown> }[] } };
const events = session.events;
const blocked = events.findIndex(e => e.type === 'policy' && e.data?.outcome === 'blocked');
const sent = events.findIndex(e => e.text.includes('mensaje entregado al canal'));
const received = events.findIndex(e => e.type === 'worker' && e.text.includes('recibió el mensaje'));
const repaired = events.findIndex((e, i) => i > received && e.type === 'tool' && e.data?.tool === 'fs.write' && e.data?.exitCode === 0);
const checked = events.findIndex((e, i) => i > received && e.type === 'tool' && e.data?.tool === 'test.run' && e.data?.exitCode === 0);
const finalCheck = events.findIndex(e => e.type === 'verification' && e.data?.cases === 5 && e.data?.suiteStatus === 0 && e.data?.exitCode === 0 && Array.isArray(e.data?.failures) && e.data.failures.length === 0);
const hashes = events.find(e => e.type === 'verification' && e.data?.sourceBefore)?.data;
const calls = events.filter(e => ['worker', 'guard'].includes(e.type) && typeof e.data?.model === 'string');
const checks = {
  live: session.mode === 'live',
  sameSession: events.every(e => e.sessionId === session.id),
  uniqueEventIds: new Set(events.map(e => e.id)).size === events.length,
  realGatewayBlock: blocked >= 0,
  guardMessageAfterBlock: sent > blocked && events.some((e, i) => i > blocked && i < sent && e.type === 'guard' && e.data?.kind === 'guidance'),
  receivedAfterSend: received > sent,
  sourceWrittenAfterReception: repaired > received,
  alternativeTestAfterReception: checked > received,
  independentVerification: finalCheck > checked,
  sourceChanged: hashes?.sourceBefore !== hashes?.sourceAfter,
  testsUnchanged: typeof hashes?.testsBefore === 'string' && hashes.testsBefore === hashes.testsAfter,
  exclusivelyVultrDeepSeek: calls.length > 0 && calls.every(e => e.data?.model === 'deepseek-v4.1-flash-1017' && e.data?.modelMismatch === false),
  sent: session.intervention.sent === true,
  received: session.intervention.received === true,
  resumed: session.intervention.resumed === true,
  resolved: session.intervention.resolved === true,
  completed: session.status === 'completed' && session.verification.passed === true,
};
const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
mkdirSync(dirname(out), { recursive: true });
const localHost = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
const scope = localHost
  ? 'Controlled task; real Vultr worker and guard, real local Docker; not public deployment evidence or counterfactual superiority'
  : 'Controlled fixed task; real Vultr worker and guard, real Docker sandbox on the deployed Vultr VM serving this URL; not evidence of counterfactual superiority';
writeFileSync(out, JSON.stringify({ capturedAt: new Date().toISOString(), sourceUrl: url.toString(), scope, sandboxHost: localHost ? 'local' : 'vultr-vm', passed: failed.length === 0, checks, failed, session }, null, 2) + '\n');
console.log(JSON.stringify({ artifact: out, session: session.id, status: session.status, passed: failed.length === 0, failed, eventCount: events.length, durationMs: session.finishedAt ? Date.parse(session.finishedAt) - Date.parse(session.startedAt) : null }));
process.exitCode = failed.length ? 1 : 0;
