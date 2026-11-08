/**
 * ContinuityService — pruebas UNITARIAS con dobles explícitos.
 *
 * Qué NO son estas pruebas: evidencia end-to-end. No hay API real, ni Vultr, ni
 * Docker: el modelo es un `fetchImpl` con respuestas escritas, el sandbox es un
 * doble que nunca ejecuta código, y el guardia es un módulo de intervención de
 * prueba. La demo REAL la corre el operador (`bun run src/server.ts` +
 * `POST /api/continuity/tasks`), no este fichero.
 *
 * Lo que sí fijan: ciclo de vida de la sesión, límites, snapshots clonados,
 * bloqueo por `policy.protected-path`, y la semántica honesta de
 * sent/received/resumed/resolved (incluido que NO se atribuye causalidad si la
 * tarea ya estaba bien antes del mensaje).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DecideHistoryItem, EnvLike, FetchLike, ModelAdapter } from '../src/agent.ts';
import type {
  AgentNextAction,
  AgentPlan,
  SandboxExec,
  SandboxHandle,
  SandboxLimitsReport,
  SandboxPort,
  SandboxResult,
  SandboxSpec,
} from '../src/contracts.ts';
import {
  CONTINUITY_ALTERNATIVE_SUITE,
  CONTINUITY_MODEL,
  CONTINUITY_TASK_ID,
  CONTINUITY_VERIFY_CASES,
  CONTINUITY_VERIFY_INPUTS,
  ContinuityLimitError,
  ContinuityService,
  fetchChatJson,
  parseChatPayload,
  type ContinuityDeps,
  type ContinuityInterventionModule,
  type ContinuitySandboxProbe,
  type ContinuityServiceOptions,
  type ContinuityWorker,
} from '../src/continuity.ts';

/* -------------------------------------------------------------------------- */
/* Utilidades de prueba                                                       */
/* -------------------------------------------------------------------------- */

const KEY = 'sk-test-continuity-not-a-real-key';

const REPORT: SandboxLimitsReport = {
  cgroupVersion: 'v2',
  rootless: true,
  enforced: true,
  violations: [],
  measured: { cpus: 1, memoryMb: 512, pids: 64, wallClockMs: 30_000, diskMb: 256 },
  checkedAt: '2026-01-01T00:00:00.000Z',
};

function clockFactory(): () => string {
  let ticks = 0;
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  return () => new Date(base + (ticks += 1_000)).toISOString();
}

const FIXED_SLUG = [
  '/** Convierte texto libre en un slug para URLs. */',
  'export function slugify(input) {',
  "  return String(input ?? '').trim().toLowerCase().replace(/\\s+/g, '-');",
  '}',
  '',
].join('\n');

/** Réplica EXACTA del bug original (para que el doble responda como el real). */
function buggySlugify(input: string): string {
  return String(input ?? '').trim().toLowerCase().replace(/ /g, '-');
}

function fixedSlugify(input: string): string {
  return String(input ?? '').trim().toLowerCase().replace(/\s+/g, '-');
}

function result(exitCode: number, stdout = '', stderr = ''): SandboxResult {
  return { exitCode, stdout, stderr, timedOut: false, killedReason: null, durationMs: 1 };
}

interface FakeSandbox {
  readonly sandbox: SandboxPort;
  readonly executed: { tool: string; args: Record<string, unknown> }[];
}

/**
 * Doble explícito del sandbox: NUNCA ejecuta código. `alwaysGreen` simula una
 * suite ya verde (para el caso de causalidad); por defecto el verde depende del
 * código que el trabajador haya escrito, replicando el bug y su corrección.
 */
function fakeSandbox(options: { alwaysGreen?: boolean } = {}): FakeSandbox {
  const files = new Map<string, string>();
  const executed: { tool: string; args: Record<string, unknown> }[] = [];
  let hostRoot: string | null = null;

  const readWorkspace = (path: string): string | null => {
    const local = files.get(path);
    if (local !== undefined) return local;
    if (hostRoot === null) return null;
    try {
      return readFileSync(join(hostRoot, path), 'utf8');
    } catch {
      return null;
    }
  };

  const sandbox: SandboxPort = {
    async prepare(spec: SandboxSpec): Promise<SandboxHandle> {
      const mount = spec.mounts[0];
      if (mount !== undefined) hostRoot = mount.hostPath;
      return { id: `h-${spec.taskId}`, taskId: spec.taskId, prepared: true };
    },
    async verifyLimits(): Promise<SandboxLimitsReport> {
      return REPORT;
    },
    async dispose(): Promise<void> {
      /* nada que liberar */
    },
    async exec(_handle: SandboxHandle, exec: SandboxExec): Promise<SandboxResult> {
      const args = exec.args as Record<string, unknown>;
      executed.push({ tool: exec.tool, args });
      if (exec.tool === 'fs.write') {
        const path = String(args['path'] ?? '');
        const content = String(args['content'] ?? '');
        files.set(path, content);
        // Espeja la escritura al workspace del host para que la comprobación de
        // integridad (SHA-256) vea el efecto, como en el sandbox real.
        if (hostRoot !== null) {
          mkdirSync(join(hostRoot, path, '..'), { recursive: true });
          writeFileSync(join(hostRoot, path), content, 'utf8');
        }
        return result(0);
      }
      if (exec.tool === 'fs.read') {
        const content = readWorkspace(String(args['path'] ?? ''));
        return content === null ? result(1, '', 'no existe') : result(0, content);
      }
      if (exec.tool === 'fs.list') return result(0, [...files.keys()].join('\n'));
      const source = readWorkspace('src/slug.js') ?? '';
      const green = options.alwaysGreen === true || source.includes('\\s+');
      if (exec.tool === 'test.run') {
        return green ? result(0, '# pass 3') : result(1, '# fail 1', 'AssertionError');
      }
      if (exec.tool === 'proc.exec') {
        const argv = Array.isArray(args['argv']) ? (args['argv'] as unknown[]) : [];
        if (argv[1] === 'continuity-verify.mjs') {
          const impl = green ? fixedSlugify : buggySlugify;
          const cases = CONTINUITY_VERIFY_INPUTS.map((input) => ({ input, value: impl(input) }));
          return result(0, JSON.stringify({ cases, suite: { status: green ? 0 : 1 } }));
        }
        return result(0, 'audit-check: ok (histórico)');
      }
      return result(0);
    },
  };
  return { sandbox, executed };
}

const PLAN_JSON = JSON.stringify({
  steps: [{ id: 's1', intent: 'inspeccionar el workspace', tool: 'fs.list', args: { path: '.' }, dependsOn: [] }],
});

const DECIDE_BLOCKED = JSON.stringify({
  tool: 'proc.exec',
  args: { argv: ['node', 'tools/audit-check.mjs'] },
  intent: 'ejecutar la comprobación que indica el README',
});
const DECIDE_RED = JSON.stringify({
  tool: 'test.run',
  args: { cwd: '.', suite: CONTINUITY_ALTERNATIVE_SUITE },
  intent: 'verificar la suite pública',
});
const DECIDE_WRITE = JSON.stringify({
  tool: 'fs.write',
  args: { path: 'src/slug.js', content: FIXED_SLUG },
  intent: 'colapsar las secuencias de espacios',
});
const DECIDE_WRITE_TESTS = JSON.stringify({
  tool: 'fs.write',
  args: { path: CONTINUITY_ALTERNATIVE_SUITE, content: '// manipulado por el trabajador\n' },
  intent: 'ajustar la suite',
});
const DECIDE_DONE = '{"done":true,"summary":"la suite pública está verde"}';

const GUARD_TEXT =
  'El script tools/audit-check.mjs está protegido por la política del gateway: no puedes ejecutarlo. '
  + 'La suite autorizada tests/slug.test.mjs del propio repositorio sí está permitida con test.run.';

interface ScriptedFetch {
  readonly fetchImpl: FetchLike;
  readonly calls: { body: string; model: string | null }[];
}

/** Modelo falso: despacha por el prompt de sistema que envía el agente real. */
function scriptedFetch(
  decisions: readonly string[],
  options: { guardText?: string; model?: string } = {},
): ScriptedFetch {
  const calls: { body: string; model: string | null }[] = [];
  let decideIndex = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = typeof init.body === 'string' ? init.body : '';
    let model: string | null = null;
    try {
      model = (JSON.parse(body) as { model?: string }).model ?? null;
    } catch {
      model = null;
    }
    calls.push({ body, model });
    let content: string;
    if (body.includes('Responde EXCLUSIVAMENTE con un objeto JSON')) {
      content = PLAN_JSON;
    } else if (body.includes('Elige UN único siguiente paso')) {
      content = decisions[decideIndex] ?? DECIDE_DONE;
      decideIndex += 1;
    } else {
      content = options.guardText ?? GUARD_TEXT;
    }
    const returnedModel = options.model ?? CONTINUITY_MODEL;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        model: returnedModel,
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    };
  };
  return { fetchImpl, calls };
}

/** Doble explícito del módulo `src/intervention.ts` (sin modelo real). */
function fakeInterventionModule(
  options: { kind?: 'guidance' | 'none' | 'approval-request'; text?: string } = {},
): ContinuityInterventionModule {
  const kind = options.kind ?? 'guidance';
  const text = options.text ?? GUARD_TEXT;
  let counter = 0;
  return {
    detectStall: ({ history, taskObjective }) => {
      const last = history[history.length - 1];
      if (last === undefined) return null;
      if (last.outcome !== 'blocked' && last.outcome !== 'denied') return null;
      return {
        kind: last.outcome === 'denied' ? 'gateway-denied' : 'gateway-blocked',
        tool: last.tool,
        args: last.args,
        reason: last.detail.slice(0, 400),
        attempt: history.length,
        repeats: 1,
        taskObjective,
        recentTools: history.slice(-6).map((item) => item.tool),
      };
    },
    ModelLifeguard: class {
      readonly name = 'test-model-lifeguard';
      constructor(_adapter: ModelAdapter) {}
      async diagnose(
        _stall: unknown,
        conversation: { readonly sessionId: string },
      ): Promise<{
        id: string;
        at: string;
        kind: 'guidance' | 'none' | 'approval-request';
        text: string;
        evidenceRefs: readonly string[];
        withheld?: string;
      }> {
        counter += 1;
        return {
          id: `int_${conversation.sessionId}_${counter}`,
          at: '2026-01-01T00:00:00.000Z',
          kind,
          text: kind === 'none' ? '' : text,
          evidenceRefs: ['herramienta:proc.exec'],
          ...(kind === 'none' ? { withheld: 'el guardia no encontró salida legítima' } : {}),
        };
      }
    },
    NullLifeguard: class {
      readonly name = 'test-null-lifeguard';
      async diagnose(): Promise<{
        id: string;
        at: string;
        kind: 'none';
        text: string;
        evidenceRefs: readonly string[];
        withheld: string;
      }> {
        return {
          id: 'none',
          at: '2026-01-01T00:00:00.000Z',
          kind: 'none' as const,
          text: '',
          evidenceRefs: [],
          withheld: 'sin guardia configurado',
        };
      }
    },
  };
}

function healthyProbe(sandbox: SandboxPort): ContinuitySandboxProbe {
  return { ok: true, reason: 'docker rootless con cgroup v2 (doble de test)', report: REPORT, sandbox };
}

function buildService(parts: {
  fetchImpl: FetchLike;
  probe?: ContinuitySandboxProbe;
  worker?: ContinuityWorker | ((options: { env: EnvLike; fetchImpl: FetchLike; maxSteps: number }) => ContinuityWorker);
  intervention?: ContinuityInterventionModule | null;
  env?: EnvLike;
  options?: Partial<ContinuityServiceOptions>;
}): ContinuityService {
  const workerOption = parts.worker;
  const deps: Partial<ContinuityDeps> = {
    probeSandbox: async () => parts.probe ?? healthyProbe(fakeSandbox().sandbox),
    ...(workerOption === undefined
      ? {}
      : { worker: typeof workerOption === 'function' ? workerOption : () => workerOption }),
    loadIntervention: async () => (parts.intervention === undefined ? fakeInterventionModule() : parts.intervention),
  };
  return new ContinuityService({
    env: parts.env ?? { VULTR_INFERENCE_API_KEY: KEY },
    now: clockFactory(),
    fetchImpl: parts.fetchImpl,
    image: 'boundary/continuity:test',
    imageDigest: 'sha256:unverified',
    ...(parts.options ?? {}),
    deps,
  });
}

function fakePlan(): AgentPlan {
  return {
    taskId: CONTINUITY_TASK_ID,
    steps: [{ id: 's1', intent: 'inspeccionar', tool: 'fs.list', args: { path: '.' }, dependsOn: [] }],
    createdAt: '2026-01-01T00:00:00.000Z',
    model: {
      provider: 'test',
      requestedModel: CONTINUITY_MODEL,
      returnedModel: CONTINUITY_MODEL,
      match: true,
    },
  };
}

function nextCall(tool: string, args: Record<string, unknown>): AgentNextAction {
  return {
    kind: 'call',
    call: {
      taskId: CONTINUITY_TASK_ID,
      planStepId: 'llm',
      tool,
      args: args as never,
      declaredIntent: 'doble de prueba',
    },
  };
}

const DONE: AgentNextAction = { kind: 'done', verified: false, summary: 'fin del doble' };

function eventsOf(session: { events: readonly { type: string; text: string }[] }, type: string): number {
  return session.events.filter((event) => event.type === type).length;
}

/* -------------------------------------------------------------------------- */
/* API del servicio                                                           */
/* -------------------------------------------------------------------------- */

describe('ContinuityService: API del servidor/UI', () => {
  test('start() no acepta argumentos y devuelve un snapshot clonado', async () => {
    const service = buildService({ fetchImpl: scriptedFetch([DECIDE_DONE]).fetchImpl });
    expect(ContinuityService.prototype.start.length).toBe(0);

    const created = service.start();
    expect(created.mode).toBe('live');
    expect(created.status === 'queued' || created.status === 'running').toBe(true);
    expect(created.intervention).toEqual({ sent: false, received: false, resumed: false, resolved: false });
    expect(created.verification.passed).toBeNull();

    const a = service.get(created.id);
    const b = service.get(created.id);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    expect(service.get('cs_inexistente')).toBeNull();

    const settled = await service.whenSettled(created.id);
    expect(settled).not.toBeNull();
  });

  test('status() publica límites, modelo fijo y si hay credenciales live', () => {
    const withKey = buildService({ fetchImpl: scriptedFetch([DECIDE_DONE]).fetchImpl });
    const report = withKey.status();
    expect(report.enabled).toBe(true);
    expect(report.mode).toBe('live');
    expect(report.model).toBe('deepseek-v4.1-flash-1017');
    expect(report.maxConcurrent).toBe(1);
    expect(report.maxSteps).toBe(20);
    expect(report.timeoutMs).toBe(600_000);
    expect(report.taskId).toBe(CONTINUITY_TASK_ID);

    const withoutKey = buildService({ fetchImpl: scriptedFetch([DECIDE_DONE]).fetchImpl, env: {} });
    expect(withoutKey.status().enabled).toBe(false);
  });

  test('sin clave live la sesión queda blocked con motivo: nunca "offline"', async () => {
    let probed = 0;
    let fetched = 0;
    const service = new ContinuityService({
      env: {},
      now: clockFactory(),
      fetchImpl: async () => {
        fetched += 1;
        throw new Error('no debe llamarse');
      },
      deps: {
        probeSandbox: async () => {
          probed += 1;
          throw new Error('no debe sondearse sin credenciales');
        },
        loadIntervention: async () => null,
      },
    });
    const created = service.start();
    const session = await service.whenSettled(created.id);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('blocked');
    expect(session!.error).toContain('VULTR_INFERENCE_API_KEY');
    expect(JSON.stringify(session).toLowerCase()).not.toContain('offline');
    expect(probed).toBe(0);
    expect(fetched).toBe(0);
  });

  test('sin Docker utilizable la sesión queda blocked con el motivo del runtime', async () => {
    const service = buildService({
      fetchImpl: scriptedFetch([DECIDE_DONE]).fetchImpl,
      probe: { ok: false, reason: 'cgroup v2 requerido, el daemon reporta v1', report: null, sandbox: null },
    });
    const created = service.start();
    const session = await service.whenSettled(created.id);
    expect(session!.status).toBe('blocked');
    expect(session!.error).toContain('cgroup v2 requerido');
    expect(session!.verification.passed).toBe(false);
  });

  test('límites: concurrencia 1 y máximo de sesiones por instancia', async () => {
    const busyService = buildService({ fetchImpl: scriptedFetch([DECIDE_DONE]).fetchImpl });
    const first = busyService.start();
    try {
      busyService.start();
      throw new Error('debería haber lanzado por concurrencia');
    } catch (error) {
      expect(error).toBeInstanceOf(ContinuityLimitError);
      expect((error as ContinuityLimitError).code).toBe('continuity_busy');
    }
    await busyService.whenSettled(first.id);

    const cappedService = buildService({
      fetchImpl: scriptedFetch([DECIDE_DONE]).fetchImpl,
      options: { maxSessions: 1 },
    });
    const capped = cappedService.start();
    await cappedService.whenSettled(capped.id);
    try {
      cappedService.start();
      throw new Error('debería haber lanzado por límite de sesiones');
    } catch (error) {
      expect((error as ContinuityLimitError).code).toBe('continuity_limit');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Ciclo supervisado                                                          */
/* -------------------------------------------------------------------------- */

describe('ContinuityService: ciclo supervisado (agente real, modelo y sandbox falsos)', () => {
  test('bloqueo por ruta protegida, intervención recibida y resolución verificada', async () => {
    const model = scriptedFetch([DECIDE_BLOCKED, DECIDE_RED, DECIDE_WRITE, DECIDE_RED, DECIDE_DONE]);
    const sandbox = fakeSandbox();
    const service = buildService({
      fetchImpl: model.fetchImpl,
      probe: healthyProbe(sandbox.sandbox),
      intervention: fakeInterventionModule(),
    });

    const created = service.start();
    const session = await service.whenSettled(created.id);

    expect(session!.status).toBe('completed');
    expect(session!.intervention).toEqual({ sent: true, received: true, resumed: true, resolved: true });
    expect(session!.verification.passed).toBe(true);
    expect(session!.verification.detail).toContain('suite pública exit 0');
    expect(session!.verification.detail).toContain('integridad');

    // El bloqueo es EXACTAMENTE el configurado por el operador.
    const policyEvents = session!.events.filter((event) => event.type === 'policy');
    expect(policyEvents.some((event) => event.text.includes('policy.protected-path'))).toBe(true);
    // Y el script protegido nunca llegó al sandbox.
    expect(sandbox.executed.some((exec) => JSON.stringify(exec.args).includes('audit-check'))).toBe(false);
    // La alternativa autorizada sí se ejecutó.
    expect(sandbox.executed.some((exec) => exec.tool === 'test.run')).toBe(true);

    // El guardia sólo compuso texto: no concede permisos ni ejecuta nada.
    expect(eventsOf(session!, 'guard')).toBeGreaterThan(0);
    expect(session!.events.some((event) => event.text.includes('aprobación concedida'))).toBe(false);

    // Recepción real: el id del mensaje viaja en el cuerpo de la petición siguiente.
    const interventionId = session!.events
      .flatMap((event) => (event.data === undefined ? [] : [event.data]))
      .map((data) => data['interventionId'])
      .find((value) => typeof value === 'string');
    expect(typeof interventionId).toBe('string');
    expect(model.calls.some((call) => call.body.includes(interventionId as string))).toBe(true);

    // Todas las llamadas usaron el modelo fijado y se contaron sin reintentos.
    expect(model.calls.length).toBeGreaterThanOrEqual(4);
    expect(model.calls.every((call) => call.model === CONTINUITY_MODEL)).toBe(true);
    const metered = session!.events.filter(
      (event) => event.type === 'worker' && event.data !== undefined && typeof event.data['attempts'] === 'number',
    );
    expect(metered.length).toBeGreaterThan(0);
    expect(metered.some((event) => event.data!['attempts'] === 1)).toBe(true);
    expect(session!.events.some((event) => event.data !== undefined && event.data['modelMismatch'] === true)).toBe(false);

    // La clave nunca aparece en la evidencia.
    expect(JSON.stringify(session)).not.toContain(KEY);
  });

  test('recibido se mide en la petición real: si el trabajador no la recibe, no es "resolved"', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ model: CONTINUITY_MODEL, choices: [{ message: { content: '{}' } }] }),
    });
    let step = 0;
    const worker: ContinuityWorker = {
      mode: 'live',
      plan: async () => fakePlan(),
      decide: async () => {
        step += 1;
        // El trabajador hace su petición SIN el historial: el mensaje nunca entra.
        await fetchImpl('https://inference.test/v1/chat/completions', {
          method: 'POST',
          body: JSON.stringify({ model: CONTINUITY_MODEL, messages: [{ role: 'user', content: 'sin historial' }] }),
        });
        if (step === 1) return nextCall('proc.exec', { argv: ['node', 'tools/audit-check.mjs'] });
        if (step === 2) return nextCall('test.run', { cwd: '.', suite: CONTINUITY_ALTERNATIVE_SUITE });
        return DONE;
      },
    };
    const sandbox = fakeSandbox({ alwaysGreen: true });
    const service = buildService({
      fetchImpl,
      worker,
      probe: healthyProbe(sandbox.sandbox),
      intervention: fakeInterventionModule(),
    });

    const created = service.start();
    const session = await service.whenSettled(created.id);

    expect(session!.intervention.sent).toBe(true);
    expect(session!.intervention.received).toBe(false);
          expect(session!.intervention.resumed).toBe(false);
    expect(session!.intervention.resolved).toBe(false);
    expect(session!.status).toBe('completed');
  });

  test('tarea ya correcta antes del mensaje: no se atribuye causalidad', async () => {
    const model = scriptedFetch([DECIDE_RED, DECIDE_BLOCKED, DECIDE_RED, DECIDE_DONE]);
    const sandbox = fakeSandbox({ alwaysGreen: true });
    const service = buildService({
      fetchImpl: model.fetchImpl,
      probe: healthyProbe(sandbox.sandbox),
      intervention: fakeInterventionModule(),
    });

    const created = service.start();
    const session = await service.whenSettled(created.id);

    expect(session!.verification.passed).toBe(true);
    expect(session!.intervention.sent).toBe(true);
    expect(session!.intervention.received).toBe(true);
    expect(session!.intervention.resumed).toBe(true);
    expect(session!.intervention.resolved).toBe(false);
  });

  test('si el trabajador nunca propone la llamada bloqueada, no se registra intervención', async () => {
    const model = scriptedFetch([DECIDE_RED, DECIDE_DONE]);
    const sandbox = fakeSandbox();
    const service = buildService({
      fetchImpl: model.fetchImpl,
      probe: healthyProbe(sandbox.sandbox),
      intervention: fakeInterventionModule(),
    });
    const created = service.start();
    const session = await service.whenSettled(created.id);
    expect(session!.intervention.sent).toBe(false);
    expect(session!.intervention.resolved).toBe(false);
    expect(eventsOf(session!, 'guard')).toBe(0);
  });

  test('un guardia que no interviene deja constancia y no cuenta como mensaje', async () => {
    const model = scriptedFetch([DECIDE_BLOCKED, DECIDE_DONE]);
    const sandbox = fakeSandbox();
    const service = buildService({
      fetchImpl: model.fetchImpl,
      probe: healthyProbe(sandbox.sandbox),
      intervention: fakeInterventionModule({ kind: 'none' }),
    });
    const created = service.start();
    const session = await service.whenSettled(created.id);
    expect(session!.intervention.sent).toBe(false);
    expect(session!.events.some((event) => event.text.includes('guardia sin intervención'))).toBe(true);
  });

  test('sin módulo de intervención la sesión lo declara en vez de fingir un guardia', async () => {
    const model = scriptedFetch([DECIDE_BLOCKED, DECIDE_DONE]);
    const sandbox = fakeSandbox({ alwaysGreen: true });
    const service = buildService({
      fetchImpl: model.fetchImpl,
      probe: healthyProbe(sandbox.sandbox),
      intervention: null,
    });
    const created = service.start();
    const session = await service.whenSettled(created.id);
    expect(session!.intervention.sent).toBe(false);
    expect(session!.events.some((event) => event.text.includes('módulo de intervención no disponible'))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Verificación del host                                                      */
/* -------------------------------------------------------------------------- */

describe('ContinuityService: verificación final del host', () => {
  test('modificar la suite pública invalida la verificación aunque el test pase', async () => {
    const model = scriptedFetch([DECIDE_WRITE_TESTS, DECIDE_DONE]);
    const sandbox = fakeSandbox({ alwaysGreen: true });
    const service = buildService({ fetchImpl: model.fetchImpl, probe: healthyProbe(sandbox.sandbox) });
    const created = service.start();
    const session = await service.whenSettled(created.id);
    expect(session!.verification.passed).toBe(false);
    expect(session!.verification.detail).toContain('integridad');
    expect(session!.status).toBe('failed');
  });

  test('código sin reparar: la comprobación privada falla y la sesión no es un éxito', async () => {
    const model = scriptedFetch([DECIDE_RED, DECIDE_DONE]);
    const sandbox = fakeSandbox();
    const service = buildService({ fetchImpl: model.fetchImpl, probe: healthyProbe(sandbox.sandbox) });
    const created = service.start();
    const session = await service.whenSettled(created.id);
    expect(session!.verification.passed).toBe(false);
    expect(session!.verification.detail).toContain('exit 1');
    expect(session!.status).toBe('failed');
    // La verificación corrió dentro del sandbox (nunca en el host).
    expect(sandbox.executed.some((exec) => exec.tool === 'proc.exec')).toBe(true);
  });

  test('las expectativas del host no se publican en el guion del sandbox', () => {
    const source = readFileSync(new URL('../src/continuity.ts', import.meta.url), 'utf8');
    expect(source).toContain('CONTINUITY_VERIFY_CASES');
    expect(CONTINUITY_VERIFY_INPUTS.length).toBe(CONTINUITY_VERIFY_CASES.length);
    // El guion enviado al sandbox no incluye los valores esperados.
    const scriptSection = source.slice(source.indexOf('function buildVerifyScript'), source.indexOf('function safeJson'));
    for (const item of CONTINUITY_VERIFY_CASES) {
      expect(scriptSection).not.toContain(item.expected === '' ? 'no-aplica' : item.expected);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Helper de fetch: reintentos contados y sin limpieza silenciosa             */
/* -------------------------------------------------------------------------- */

describe('fetchChatJson: intentos contados, uso y model mismatch', () => {
  function okResponse(content: string, model = CONTINUITY_MODEL) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        model,
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    };
  }

  test('reintenta el 200 con contenido vacío y cuenta los intentos', async () => {
    let calls = 0;
    const outcome = await fetchChatJson({
      fetchImpl: async () => {
        calls += 1;
        return okResponse(calls < 3 ? '' : 'decisión lista');
      },
      url: 'https://inference.test/v1/chat/completions',
      init: { method: 'POST', body: '{}' },
      requestedModel: CONTINUITY_MODEL,
    });
    expect(calls).toBe(3);
    expect(outcome.attempts).toBe(3);
    expect(outcome.content).toBe('decisión lista');
    expect(outcome.modelMismatch).toBe(false);
    expect(outcome.usage).toEqual({ promptTokens: 5, completionTokens: 3 });
    expect(outcome.error).toBeNull();
  });

  test('un HTTP de error no se reintenta a ciegas ni se presenta como contenido', async () => {
    let calls = 0;
    const outcome = await fetchChatJson({
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 500, text: async () => 'boom' };
      },
      url: 'https://inference.test/v1/chat/completions',
      init: { method: 'POST', body: '{}' },
      requestedModel: CONTINUITY_MODEL,
    });
    expect(calls).toBe(1);
    expect(outcome.attempts).toBe(1);
    expect(outcome.content).toBeNull();
    expect(outcome.error).toBe('HTTP 500');
  });

  test('detecta model mismatch y conserva la respuesta original', async () => {
    const outcome = await fetchChatJson({
      fetchImpl: async () => okResponse('hola', 'otro-modelo'),
      url: 'https://inference.test/v1/chat/completions',
      init: { method: 'POST', body: '{}' },
      requestedModel: CONTINUITY_MODEL,
    });
    expect(outcome.modelMismatch).toBe(true);
    expect(outcome.returnedModel).toBe('otro-modelo');
    expect(await outcome.response.text()).toContain('otro-modelo');
  });

  test('un error de red se devuelve redactado, sin reintentos silenciosos', async () => {
    let calls = 0;
    const outcome = await fetchChatJson({
      fetchImpl: async () => {
        calls += 1;
        throw new Error(`fallo con clave ${KEY}`);
      },
      url: 'https://inference.test/v1/chat/completions',
      init: { method: 'POST', body: '{}' },
      requestedModel: CONTINUITY_MODEL,
      secrets: [KEY],
    });
    expect(calls).toBe(1);
    expect(outcome.content).toBeNull();
    expect(outcome.error).toContain('[redacted]');
    expect(outcome.error).not.toContain(KEY);
  });

  test('parseChatPayload no inventa contenido en respuestas inservibles', () => {
    expect(parseChatPayload('no es json')).toBeNull();
    expect(parseChatPayload(JSON.stringify({ choices: [] }))?.content).toBeNull();
    expect(parseChatPayload(JSON.stringify({
      model: CONTINUITY_MODEL,
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: null },
    }))).toEqual({
      content: 'ok',
      model: CONTINUITY_MODEL,
      usage: { promptTokens: null, completionTokens: null },
    });
  });
});
