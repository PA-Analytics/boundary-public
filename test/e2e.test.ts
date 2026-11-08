/**
 * Integración mínima (MVP local, offline, sin credenciales).
 *
 * Arranca el servidor en loopback con puerto efímero y recorre el flujo
 * real: salud → estado → crear tarea (preflight + plan del agente) →
 * paso permitido (simulado) → bloqueo terminal (crítica) → aprobación
 * humana de un solo uso → recuperación simulada desde el almacén
 * preaprobado. Todo sin ejecución real, sin red y sin afirmar sandbox.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { CONTRACT_VERSION, SERVER_LIMITS, type PolicyVerdict, type RecoveryProposal } from '../src/contracts.ts';
import { approvedPackageSha256, APPROVED_PACKAGE_NAME, APPROVED_PACKAGE_VERSION } from '../src/policy.ts';
import {
  LocalLifeguard,
  RECOVERY_AUTHORIZATION_TTL_MS,
  startServer,
  type SimulatedRecoveryRecord,
  type StartedServer,
} from '../src/server.ts';

let server: StartedServer;
let base: string;
/** Propuesta real capturada del flujo HTTP, para las regresiones de `apply`. */
let approvedProposal: RecoveryProposal | null = null;

function verdictFor(proposal: RecoveryProposal, decidedAt: string): PolicyVerdict {
  return {
    decision: 'allow',
    criticalViolations: [],
    risk: { score: 10, band: 'auto', factors: [], threshold: 65, provisional: true },
    reasons: [],
    policyVersion: 'deterministic-policy-1.0.0',
    fingerprint: `fp_${proposal.id}`,
    decidedAt,
  };
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

beforeAll(async () => {
  server = await startServer({ port: 0 });
  base = server.url;
});

afterAll(async () => {
  await server.close();
});

describe('servidor local (loopback, simulado)', () => {
  test('escucha sólo en loopback', () => {
    expect(server.hostname).toBe('127.0.0.1');
    expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  test('rechaza arrancar fuera de loopback', async () => {
    await expect(startServer({ port: 0, hostname: '0.0.0.0' })).rejects.toThrow(/loopback/);
  });

  test('GET /healthz declara simulado y sin sandbox', async () => {
    const { status, body } = await api('/healthz');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.contractVersion).toBe(CONTRACT_VERSION);
    expect(body.simulated).toBe(true);
    expect(body.sandboxAvailable).toBe(false);
  });

  test('GET / sirve el panel de sólo lectura en el mismo origen', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    // El panel sirve la sesión de continuidad (`POST /api/continuity/tasks`,
    // `GET /api/continuity/tasks/:id`): es la única fuente que `web/app.js` lee
    // (`docs/sprint/panel-contract.md` §1). Afirmar `/api/state` aquí dejó de ser
    // cierto cuando el panel se reescribió en este sprint.
    expect(html).toContain('/api/continuity');
  });

  test('GET /api/state expone el contrato del panel sin inventar tarea', async () => {
    const { status, body } = await api('/api/state');
    expect(status).toBe(200);
    expect(body.contractVersion).toBe(CONTRACT_VERSION);
    expect(typeof body.generatedAt).toBe('string');
    expect(body.simulated).toBe(true);
    expect(body.sandbox?.available).toBe(false);
    expect(Array.isArray(body.controls?.criticalRules)).toBe(true);
    expect(body.controls.criticalRules.length).toBeGreaterThan(0);
    expect(Array.isArray(body.events)).toBe(true);
  });
});

describe('tarea: preflight, agente y gateway', () => {
  let taskId: string;

  test('POST /api/tasks crea tarea con manifiesto que no concede privilegios', async () => {
    const { status, body } = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ objective: 'reparar el fixture sin salir del workspace', declaredSteps: 5 }),
    });
    expect(status).toBe(201);
    taskId = body.task.taskId as string;
    expect(typeof taskId).toBe('string');
    expect(body.preflight.manifest.grantsNewPrivileges).toBe(false);
    expect(body.preflight.decision.provisional).toBe(true);
    expect(Array.isArray(body.plan.steps)).toBe(true);
    expect(body.plan.steps.length).toBeGreaterThan(0);
  });

  test('el estado refleja la tarea y el manifiesto', async () => {
    const { body } = await api('/api/state');
    expect(body.task.taskId).toBe(taskId);
    expect(body.task.independentWorkContinues).toBe(true);
    expect(body.preflight.manifest.taskId).toBe(taskId);
    expect(body.controls.scope.taskId).toBe(taskId);
  });

  test('paso permitido (fs.read) se declara simulado sin ejecutar', async () => {
    const { status, body } = await api(`/api/tasks/${taskId}/steps`, {
      method: 'POST',
      body: JSON.stringify({ tool: 'fs.read', args: { path: 'index.js' }, declaredIntent: 'leer el módulo' }),
    });
    expect(status).toBe(200);
    expect(body.kind).toBe('allowed');
    expect(body.executed).toBe(false);
    expect(body.simulated).toBe(true);
    expect(body.result.killedReason).toBe('simulation-only');
    expect(body.result.stdout).toBe('');
  });

  test('herramienta de host (bash) bloquea terminalmente sin recuperación', async () => {
    const { status, body } = await api(`/api/tasks/${taskId}/steps`, {
      method: 'POST',
      body: JSON.stringify({ tool: 'bash', args: { command: 'id' }, declaredIntent: 'intento no mediado' }),
    });
    expect(status).toBe(200);
    expect(body.kind).toBe('blocked_terminal');
    expect(body.criticalRules).toContain('sandbox.escape');
    expect(body.recoverable).toBe(false);
    expect(body.incident.status).toBe('blocked');
    // El Judge diagnostica sin autorizar.
    expect(body.diagnosis.canGrantPermissions).toBe(false);
    expect(body.diagnosis.authority).toBe('none');
    expect(body.diagnosis.advisory).toBe(true);
  });

  test('flujo de aprobación: deploy.request requiere, grant concede un solo uso', async () => {
    const first = await api(`/api/tasks/${taskId}/steps`, {
      method: 'POST',
      body: JSON.stringify({ tool: 'deploy.request', args: { target: 'staging', ref: 'main' }, declaredIntent: 'despliegue a staging' }),
    });
    expect(first.body.kind).toBe('approval_required');
    const approvalId = first.body.approval.id as string;
    expect(first.body.independentWorkAllowed).toBe(true);

    const grant = await api(`/api/approvals/${approvalId}/grant`, { method: 'POST', body: JSON.stringify({}) });
    expect(grant.status).toBe(200);
    expect(grant.body.grant.singleUse).toBe(true);
    expect(grant.body.grant.grantedBy).toBe('human');

    const retry = await api(`/api/tasks/${taskId}/steps`, {
      method: 'POST',
      body: JSON.stringify({ tool: 'deploy.request', args: { target: 'staging', ref: 'main' }, declaredIntent: 'despliegue a staging', approvalId }),
    });
    expect(retry.body.kind).toBe('allowed');
    expect(retry.body.executed).toBe(false);

    // Segundo uso de la misma aprobación: ya consumida, vuelve a pedir.
    const reuse = await api(`/api/tasks/${taskId}/steps`, {
      method: 'POST',
      body: JSON.stringify({ tool: 'deploy.request', args: { target: 'staging', ref: 'main' }, declaredIntent: 'reintento', approvalId }),
    });
    expect(reuse.body.kind).toBe('approval_required');
  });

  test('una solicitud con reglas críticas jamás se concede', async () => {
    const created = await api('/api/approvals', {
      method: 'POST',
      body: JSON.stringify({
        taskId,
        fingerprint: 'fp_critica',
        capability: 'proc.exec',
        reason: 'intento crítico',
        criticalRules: ['sandbox.escape'],
      }),
    });
    expect(created.status).toBe(422);
  });

  test('pkg.install denegado se recupera de forma simulada desde el almacén', async () => {
    // Tarea que declara la dependencia aprobada (hash verificado, sin red):
    // sólo así el alcance autoriza registro + referencia y la denegación
    // por capacidad es recuperable en lugar de terminal.
    const created = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        objective: 'instalar dependencia preaprobada',
        declaredDependencies: [
          { name: APPROVED_PACKAGE_NAME, version: APPROVED_PACKAGE_VERSION, sha256: approvedPackageSha256() },
        ],
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.preflight.preparation.prepared.length).toBe(1);
    const depTaskId = created.body.task.taskId as string;
    const { body } = await api(`/api/tasks/${depTaskId}/steps`, {
      method: 'POST',
      body: JSON.stringify({
        tool: 'pkg.install',
        args: { name: 'boundary-cost-tools', version: '1.4.2' },
        declaredIntent: 'instalar dependencia aprobada',
      }),
    });
    expect(body.kind).toBe('recovered');
    expect(body.executed).toBe(false);
    expect(body.simulated).toBe(true);
    expect(body.recovery.outcome).toBe('applied');
    expect(body.recovery.mechanismId).toBe('approved-dependency-store');
    // La simulación queda declarada en el propio registro, no sólo en la respuesta.
    expect(body.recovery.simulated).toBe(true);
    expect(String(body.recovery.detail)).toContain('SIMULADO');
    expect(body.diagnosis.canGrantPermissions).toBe(false);
    approvedProposal = body.recovery.proposal as RecoveryProposal;

    const state = await api('/api/state');
    expect(state.body.recovery.length).toBeGreaterThan(0);
    expect(state.body.recovery[0].simulated).toBe(true);
    expect(state.body.incidents.length).toBeGreaterThan(0);
    expect(state.body.risk.length).toBeGreaterThan(0);
    expect(Array.isArray(state.body.approvals)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Regresiones de LocalLifeguard.apply: sólo se registra lo realmente         */
/* autorizado, contenido, vigente y no aplicado antes.                        */
/* -------------------------------------------------------------------------- */

const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

function capturedProposal(): RecoveryProposal {
  if (!approvedProposal) throw new Error('la propuesta aprobada no se capturó del flujo e2e');
  return approvedProposal;
}

describe('LocalLifeguard.apply falla cerrado', () => {
  test('authorization "deny" no registra recuperación aplicada', async () => {
    const lifeguard = new LocalLifeguard();
    const outcome = await lifeguard.apply(capturedProposal(), { ...verdictFor(capturedProposal(), iso()), decision: 'deny' });
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') expect(outcome.reasons).toContain('effect_not_allowed');
    expect(lifeguard.appliedRecoveryIds.length).toBe(0);
  });

  test('authorization "require_approval" sin aprobación utilizable no aplica', async () => {
    const lifeguard = new LocalLifeguard();
    const outcome = await lifeguard.apply(capturedProposal(), {
      ...verdictFor(capturedProposal(), iso()),
      decision: 'require_approval',
    });
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.reasons).toContain('approval_required');
      expect(outcome.reasons).toContain('approval_missing');
    }
    expect(lifeguard.appliedRecoveryIds.length).toBe(0);
  });

  test('una violación crítica anula incluso un veredicto "allow"', async () => {
    const lifeguard = new LocalLifeguard();
    const outcome = await lifeguard.apply(capturedProposal(), {
      ...verdictFor(capturedProposal(), iso()),
      criticalViolations: ['sandbox.escape'],
    });
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') expect(outcome.reasons).toContain('critical_rule');
    expect(lifeguard.appliedRecoveryIds.length).toBe(0);
  });

  test('un efecto equivalente al prohibido no se aplica por la ruta de recuperación', async () => {
    const lifeguard = new LocalLifeguard();
    const proposal = capturedProposal();
    const outcome = await lifeguard.apply(
      { ...proposal, blockedEffect: proposal.proposedEffect },
      verdictFor(proposal, iso()),
    );
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') expect(outcome.reasons).toContain('effect_equivalent_to_prohibited');
    expect(lifeguard.appliedRecoveryIds.length).toBe(0);
  });

  test('un mecanismo fuera del registro aprobado no se aplica', async () => {
    const lifeguard = new LocalLifeguard();
    const proposal = capturedProposal();
    const rogue = { ...proposal, mechanism: { ...proposal.mechanism, id: 'rogue-mechanism' as typeof proposal.mechanism.id } };
    const outcome = await lifeguard.apply(rogue, verdictFor(proposal, iso()));
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') expect(outcome.reasons).toContain('mechanism_not_authorized');
    expect(lifeguard.appliedRecoveryIds.length).toBe(0);
  });

  test('un efecto fuera del sandbox (producción) no se aplica', async () => {
    const lifeguard = new LocalLifeguard();
    const proposal = capturedProposal();
    const outcome = await lifeguard.apply(
      { ...proposal, proposedEffect: { ...proposal.proposedEffect, environment: 'production' } },
      verdictFor(proposal, iso()),
    );
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') expect(outcome.reasons).toContain('effect_not_allowed');
    expect(lifeguard.appliedRecoveryIds.length).toBe(0);
  });

  test('un paquete no preaprobado no se materializa', async () => {
    const lifeguard = new LocalLifeguard();
    const proposal = capturedProposal();
    const outcome = await lifeguard.apply(
      { ...proposal, proposedEffect: { ...proposal.proposedEffect, targets: ['evil-pkg@9.9.9'] } },
      verdictFor(proposal, iso()),
    );
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') expect(outcome.reasons).toContain('effect_not_allowed');
    expect(lifeguard.appliedRecoveryIds.length).toBe(0);
  });

  test('una autorización caducada se trata como inexistente', async () => {
    const lifeguard = new LocalLifeguard();
    const proposal = capturedProposal();
    const stale = verdictFor(proposal, iso(-(RECOVERY_AUTHORIZATION_TTL_MS + 5_000)));
    const outcome = await lifeguard.apply(proposal, stale);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') expect(outcome.reasons).toContain('approval_missing');
    expect(lifeguard.appliedRecoveryIds.length).toBe(0);
  });

  test('una autorización emitida en el futuro no se acepta', async () => {
    const lifeguard = new LocalLifeguard();
    const proposal = capturedProposal();
    const outcome = await lifeguard.apply(proposal, verdictFor(proposal, iso(10 * 60 * 1000)));
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') expect(outcome.reasons).toContain('approval_missing');
    expect(lifeguard.appliedRecoveryIds.length).toBe(0);
  });

  test('autorización vigente aplica una sola vez (unicidad + simulación explícita)', async () => {
    const lifeguard = new LocalLifeguard();
    const proposal = capturedProposal();
    const first = await lifeguard.apply(proposal, verdictFor(proposal, iso()), { now: iso() });
    expect(first.kind).toBe('applied');
    if (first.kind === 'applied') {
      expect(first.record.outcome).toBe('applied');
      expect((first.record as SimulatedRecoveryRecord).simulated).toBe(true);
      expect(first.record.approvalId).toBeNull();
      expect(first.record.detail).toContain('SIMULADO');
      expect(first.record.authorization.decision).toBe('allow');
    }

    const second = await lifeguard.apply(proposal, verdictFor(proposal, iso()), { now: iso() });
    expect(second.kind).toBe('rejected');
    if (second.kind === 'rejected') expect(second.reasons).toContain('approval_missing');
    expect(lifeguard.appliedRecoveryIds.length).toBe(1);
    expect(lifeguard.appliedRecoveryIds[0]).toBe(proposal.id);
  });
});

/* -------------------------------------------------------------------------- */
/* Regresiones de aprobaciones: vigencia acotada y uso único                  */
/* -------------------------------------------------------------------------- */

describe('aprobaciones: concesión acotada y de un solo uso', () => {
  let approvalTaskId = '';

  beforeAll(async () => {
    const created = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ objective: 'tarea para probar la vigencia de aprobaciones' }),
    });
    approvalTaskId = created.body.task.taskId as string;
  });

  async function newApproval(fingerprint: string): Promise<{ status: number; body: any }> {
    return api('/api/approvals', {
      method: 'POST',
      body: JSON.stringify({ taskId: approvalTaskId, fingerprint, capability: 'deploy.staging', reason: 'prueba de vigencia' }),
    });
  }

  test('un expiresAt lejano se acota al TTL del servidor', async () => {
    const created = await newApproval('fp_ttl');
    expect(created.status).toBe(201);
    const id = created.body.approval.id as string;
    const far = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const before = Date.now();
    const grant = await api(`/api/approvals/${id}/grant`, { method: 'POST', body: JSON.stringify({ expiresAt: far }) });
    expect(grant.status).toBe(200);
    expect(grant.body.grant.singleUse).toBe(true);
    expect(Date.parse(grant.body.grant.expiresAt)).toBeLessThanOrEqual(before + SERVER_LIMITS.approvalTtlMs + 1_000);
    expect(Date.parse(grant.body.grant.expiresAt)).toBeGreaterThan(Date.parse(grant.body.grant.grantedAt));

    const again = await api(`/api/approvals/${id}/grant`, { method: 'POST', body: JSON.stringify({}) });
    expect(again.status).toBe(409);
  });

  test('una aprobación no puede concederse ya caducada', async () => {
    const created = await newApproval('fp_past');
    expect(created.status).toBe(201);
    const id = created.body.approval.id as string;
    const past = new Date(Date.now() - 60_000).toISOString();
    const grant = await api(`/api/approvals/${id}/grant`, { method: 'POST', body: JSON.stringify({ expiresAt: past }) });
    expect(grant.status).toBe(400);
    expect(grant.body.code).toBe('bad_expiry');
  });
});
