/**
 * SPRINT CYCLE — ciclo completo de supervisión con DOBLES INYECTADOS [dobles].
 *
 * Qué NO son estas pruebas: evidencia end-to-end real. Aquí NO hay red, NO hay
 * Vultr y NO hay Docker: el modelo es un `fetchImpl` con respuestas escritas, el
 * sandbox es un doble que nunca ejecuta código y el guardia es un módulo de
 * intervención de prueba. La demo real la corre el operador.
 *
 * Lo que fijan, y que antes era un DEFECTO: el mensaje del supervisor viajaba al
 * historial como `{tool:'lifeguard.intervention', outcome:'allowed'}`, dentro de
 * la lista de resultados de herramientas. El modelo lo leía como «mi llamada
 * anterior salió bien». Ahora el item lleva `role:'guard'`, `outcome:'guard'` y
 * se renderiza en una sección PROPIA del turno `user` (`supervisor`), separada
 * del historial y con encabezado explícito.
 *
 * Casos: (a) detección→guardia→item `guard` en el historial; (b) la siguiente
 * petición lleva la sección del supervisor y ningún `outcome:'allowed'` para ese
 * item; (c) recepción medida en el cuerpo real → `received:true`; (d) guardia
 * `kind:'none'` → `detected:true` + `withheld` + la corrida continúa; (e) guardia
 * que lanza → la corrida NO se cae y el fallo queda registrado; (f) sin atasco →
 * `NO_INTERVENTION_NEEDED` y cero llamadas al guardia; (g) una sola intervención
 * por sesión aunque haya dos atascos.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GUARD_MESSAGE_HEADER,
  type DecideHistoryItem,
  type EnvLike,
  type FetchLike,
  type ModelAdapter,
} from '../src/agent.ts';
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
  CONTINUITY_VERIFY_INPUTS,
  ContinuityService,
  GUARD_WITHHELD_NONE_NEEDED,
  type ContinuityConversationAdapter,
  type ContinuityDeps,
  type ContinuityInterventionMessage,
  type ContinuityInterventionModule,
  type ContinuitySandboxProbe,
  type ContinuityServiceOptions,
  type ContinuityStallEvidence,
  type ContinuityWorker,
} from '../src/continuity.ts';

/* -------------------------------------------------------------------------- */
/* Utilidades de prueba (dobles explícitos)                                   */
/* -------------------------------------------------------------------------- */

const KEY = 'sk-test-sprint-cycle-not-a-real-key';

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

/** Réplica del bug original: el doble responde como respondería el real. */
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

/** Doble del sandbox: NUNCA ejecuta código; replica el bug y su corrección. */
function fakeSandbox(): FakeSandbox {
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
      const green = source.includes('\\s+');
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
const DECIDE_DONE = '{"done":true,"summary":"la suite pública está verde"}';

const GUARD_TEXT =
  'El script tools/audit-check.mjs está protegido por la política del gateway: no puedes ejecutarlo. '
  + 'La suite autorizada tests/slug.test.mjs del propio repositorio sí está permitida con test.run.';

interface ScriptedFetch {
  readonly fetchImpl: FetchLike;
  readonly calls: { body: string; model: string | null }[];
}

/** Modelo falso: despacha por el prompt de sistema que envía el agente real. */
function scriptedFetch(decisions: readonly string[]): ScriptedFetch {
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
      content = GUARD_TEXT;
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        model: CONTINUITY_MODEL,
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    };
  };
  return { fetchImpl, calls };
}

interface GuardBehaviour {
  readonly kind?: 'guidance' | 'none';
  readonly text?: string;
  readonly withheld?: string;
  readonly throws?: boolean;
  /** El guardia CONSUME el modelo del servicio (para medir guardCalls/guardTokens). */
  readonly useModel?: boolean;
}

interface GuardDouble {
  readonly module: ContinuityInterventionModule;
  readonly probe: { diagnoses: number };
}

/** Doble del módulo `src/intervention.ts`: sólo texto, ningún permiso. */
function guardModule(behaviour: GuardBehaviour = {}): GuardDouble {
  const probe = { diagnoses: 0 };
  const kind = behaviour.kind ?? 'guidance';
  const text = behaviour.text ?? GUARD_TEXT;
  let counter = 0;
  const module: ContinuityInterventionModule = {
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
      readonly name = 'sprint-test-model-lifeguard';
      private readonly adapter: ModelAdapter;

      constructor(adapter: ModelAdapter) {
        this.adapter = adapter;
      }

      async diagnose(
        _stall: ContinuityStallEvidence,
        conversation: ContinuityConversationAdapter,
      ): Promise<ContinuityInterventionMessage> {
        probe.diagnoses += 1;
        if (behaviour.throws === true) throw new Error('el modelo del guardia no respondió (doble)');
        let body = kind === 'none' ? '' : text;
        if (behaviour.useModel === true) {
          const answer = await this.adapter.complete({
            purpose: 'judge',
            system: 'supervisor externo (doble)',
            user: '{"stall":"gateway-denied"}',
          });
          body = answer.content;
        }
        counter += 1;
        return {
          id: `int_${conversation.sessionId}_${counter}`,
          at: '2026-01-01T00:00:00.000Z',
          kind,
          text: body,
          evidenceRefs: ['herramienta:proc.exec'],
          ...(kind === 'none'
            ? { withheld: behaviour.withheld ?? 'el guardia no encontró salida legítima' }
            : {}),
        };
      }
    },
    NullLifeguard: class {
      readonly name = 'sprint-test-null-lifeguard';
      async diagnose(): Promise<ContinuityInterventionMessage> {
        return {
          id: 'none',
          at: '2026-01-01T00:00:00.000Z',
          kind: 'none',
          text: '',
          evidenceRefs: [],
          withheld: 'sin guardia configurado',
        };
      }
    },
  };
  return { module, probe };
}

function healthyProbe(sandbox: SandboxPort): ContinuitySandboxProbe {
  return { ok: true, reason: 'docker rootless con cgroup v2 (doble de test)', report: REPORT, sandbox };
}

function buildService(parts: {
  fetchImpl: FetchLike;
  probe: ContinuitySandboxProbe;
  intervention: ContinuityInterventionModule;
  worker?: ContinuityWorker;
  options?: Partial<ContinuityServiceOptions>;
}): ContinuityService {
  const deps: Partial<ContinuityDeps> = {
    probeSandbox: async () => parts.probe,
    ...(parts.worker === undefined ? {} : { worker: () => parts.worker as ContinuityWorker }),
    loadIntervention: async () => parts.intervention,
  };
  return new ContinuityService({
    env: { VULTR_INFERENCE_API_KEY: KEY } as EnvLike,
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

const blockedCall = () => nextCall('proc.exec', { argv: ['node', 'tools/audit-check.mjs'] });
const redCall = () => nextCall('test.run', { cwd: '.', suite: CONTINUITY_ALTERNATIVE_SUITE });
const writeCall = () => nextCall('fs.write', { path: 'src/slug.js', content: FIXED_SLUG });

interface RecordingWorker {
  readonly worker: ContinuityWorker;
  /** Copia del historial EXACTO que el servicio entregó en cada decisión. */
  readonly histories: DecideHistoryItem[][];
}

function recordingWorker(script: readonly (() => AgentNextAction)[]): RecordingWorker {
  const histories: DecideHistoryItem[][] = [];
  let step = 0;
  const worker: ContinuityWorker = {
    mode: 'live',
    plan: async () => fakePlan(),
    decide: async (input) => {
      histories.push([...input.history]);
      const next = script[step] ?? (() => DONE);
      step += 1;
      return next();
    },
  };
  return { worker, histories };
}

/* ---------------------------- inspección de cuerpos ----------------------- */

interface DecidedEnvelope {
  readonly body: string;
  readonly messages: { role: string; content: string }[];
  readonly user: Record<string, unknown>;
}

/** Extrae los cuerpos de `decide` del trabajador y deserializa el turno `user`. */
function decideEnvelopes(bodies: readonly string[]): DecidedEnvelope[] {
  const out: DecidedEnvelope[] = [];
  for (const body of bodies) {
    let parsed: { messages?: { role: string; content: string }[] };
    try {
      parsed = JSON.parse(body) as { messages?: { role: string; content: string }[] };
    } catch {
      continue;
    }
    const messages = parsed.messages ?? [];
    const userMessage = messages.find((message) => message.role === 'user');
    if (userMessage === undefined) continue;
    let user: Record<string, unknown>;
    try {
      user = JSON.parse(userMessage.content) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (user['objective'] === undefined) continue;
    out.push({ body, messages, user });
  }
  return out;
}

/** Todos los objetos con `tool:'lifeguard.intervention'` del turno `user`. */
function interventionObjects(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) interventionObjects(item, found);
    return found;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (record['tool'] === 'lifeguard.intervention') found.push(record);
    for (const item of Object.values(record)) interventionObjects(item, found);
  }
  return found;
}

function supervisorOf(user: Record<string, unknown>): Record<string, unknown> | null {
  const supervisor = user['supervisor'];
  if (typeof supervisor !== 'object' || supervisor === null) return null;
  return supervisor as Record<string, unknown>;
}

function interventionIdOf(events: readonly { data?: Record<string, unknown> }[]): string {
  const id = events
    .flatMap((event) => (event.data === undefined ? [] : [event.data]))
    .map((data) => data['interventionId'])
    .find((value) => typeof value === 'string');
  return typeof id === 'string' ? id : '';
}

/* -------------------------------------------------------------------------- */
/* (a) bloqueo real → detección → guardia → item `guard` en el historial       */
/* -------------------------------------------------------------------------- */

describe('Sprint cycle [dobles]: intervención como canal externo', () => {
  test('[dobles] (a) el bloqueo real llega al guardia y su mensaje entra como role:guard', async () => {
    const model = scriptedFetch([]); // el trabajador es un doble: el modelo sólo lo usa el guardia
    const sandbox = fakeSandbox();
    const guard = guardModule({ useModel: true });
    const recorded = recordingWorker([blockedCall, () => DONE]);
    const service = buildService({
      fetchImpl: model.fetchImpl,
      probe: healthyProbe(sandbox.sandbox),
      intervention: guard.module,
      worker: recorded.worker,
    });

    const created = service.start();
    const session = await service.whenSettled(created.id);

    // 1) El bloqueo es REAL: lo decide el gateway, no el doble del guardia.
    expect(session!.events.some((event) => event.text.includes('policy.protected-path'))).toBe(true);
    expect(sandbox.executed.some((exec) => JSON.stringify(exec.args).includes('audit-check'))).toBe(false);

    // 2) Detección + guardia consultado una vez.
    expect(session!.detected).toBe(true);
    expect(guard.probe.diagnoses).toBe(1);
    expect(session!.guardCalls).toBe(1);
    expect(session!.guardTokens).toBe(18);
    expect(session!.intervention.sent).toBe(true);

    // 3) El item de historial que ve el trabajador está marcado como EXTERNO.
    const afterDispatch = recorded.histories[1] ?? [];
    const guardItems = afterDispatch.filter((item) => item.role === 'guard');
    expect(guardItems.length).toBe(1);
    const item = guardItems[0]!;
    expect(item.tool).toBe('lifeguard.intervention');
    expect(item.outcome).toBe('guard');
    expect(item.outcome).not.toBe('allowed');
    expect(item.detail).toContain('tools/audit-check.mjs está protegido');
    expect(item.observation).toBeUndefined();

    // 4) La evidencia del evento lleva el texto ÍNTEGRO redactado.
    const delivered = session!.events.find(
      (event) => event.type === 'guard' && event.data !== undefined && event.data['interventionId'] !== undefined,
    );
    expect(delivered?.data?.['role']).toBe('guard');
    expect(delivered?.data?.['text']).toBe(GUARD_TEXT);

    // 5) El guardia no ejecuta, no concede permisos y no concede nada.
    expect(session!.events.some((event) => event.text.includes('aprobación concedida'))).toBe(false);
    expect(JSON.stringify(session)).not.toContain(KEY);
  });

  /* ------------------------------------------------------------------ */
  /* (b) y (c) con el AGENTE REAL: así se observa el cuerpo de petición  */
  /* ------------------------------------------------------------------ */

  test('[dobles] (b) la siguiente petición lleva la sección del supervisor y ningún outcome:allowed', async () => {
    const model = scriptedFetch([DECIDE_BLOCKED, DECIDE_RED, DECIDE_WRITE, DECIDE_RED, DECIDE_DONE]);
    const sandbox = fakeSandbox();
    const guard = guardModule();
    const service = buildService({
      fetchImpl: model.fetchImpl,
      probe: healthyProbe(sandbox.sandbox),
      intervention: guard.module,
    });

    const created = service.start();
    await service.whenSettled(created.id);

    const envelopes = decideEnvelopes(model.calls.map((call) => call.body));
    const withSupervisor = envelopes.filter((entry) => supervisorOf(entry.user) !== null);
    expect(withSupervisor.length).toBeGreaterThan(0);

    const entry = withSupervisor[0]!;
    // La forma de `messages` NO cambia: sigue siendo [system, user].
    expect(entry.messages.map((message) => message.role)).toEqual(['system', 'user']);

    const supervisor = supervisorOf(entry.user)!;
    expect(supervisor['header']).toBe(GUARD_MESSAGE_HEADER);
    expect(String(supervisor['header'])).toContain('MENSAJE DEL SUPERVISOR');
    expect(String(supervisor['header'])).toContain('no es un resultado tuyo');

    const supervisorMessages = supervisor['messages'] as Record<string, unknown>[];
    expect(supervisorMessages.length).toBe(1);
    expect(supervisorMessages[0]!['tool']).toBe('lifeguard.intervention');
    expect(supervisorMessages[0]!['outcome']).toBe('guard');

    // El historial de HERRAMIENTAS no contiene el mensaje del supervisor.
    const history = entry.user['history'] as Record<string, unknown>[];
    expect(history.some((item) => item['tool'] === 'lifeguard.intervention')).toBe(false);

    // En TODO el turno `user` no hay ningún item de intervención como `allowed`.
    const found = interventionObjects(entry.user);
    expect(found.length).toBe(1);
    expect(found[0]!['outcome']).not.toBe('allowed');
    expect(found[0]!['role'] ?? 'ausente-en-la-sección').not.toBe('allowed');
    expect(entry.body).not.toContain('"tool":"lifeguard.intervention","args":{"interventionId"'+',"kind":"guidance"},"outcome":"allowed"');
  });

  test('[dobles] (c) recepción medida en el cuerpo real → received:true', async () => {
    const model = scriptedFetch([DECIDE_BLOCKED, DECIDE_RED, DECIDE_WRITE, DECIDE_RED, DECIDE_DONE]);
    const sandbox = fakeSandbox();
    const guard = guardModule();
    const service = buildService({
      fetchImpl: model.fetchImpl,
      probe: healthyProbe(sandbox.sandbox),
      intervention: guard.module,
    });

    const created = service.start();
    const session = await service.whenSettled(created.id);

    const id = interventionIdOf(session!.events);
    expect(id.length).toBeGreaterThan(0);

    // id Y texto del supervisor viajan en el cuerpo de la petición siguiente.
    const reached = model.calls.filter((call) => call.body.includes(id) && call.body.includes(GUARD_TEXT));
    expect(reached.length).toBeGreaterThan(0);

    expect(session!.intervention.sent).toBe(true);
    expect(session!.intervention.received).toBe(true);
    expect(session!.verification.passed).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /* (d) guardia que devuelve kind:'none'                                */
  /* ------------------------------------------------------------------ */

  test('[dobles] (d) guardia con kind:none → detected + withheld y la corrida continúa', async () => {
    const model = scriptedFetch([]);
    const sandbox = fakeSandbox();
    const guard = guardModule({ kind: 'none', withheld: 'no hay alternativa autorizada en este hilo' });
    const recorded = recordingWorker([blockedCall, writeCall, redCall, () => DONE]);
    const service = buildService({
      fetchImpl: model.fetchImpl,
      probe: healthyProbe(sandbox.sandbox),
      intervention: guard.module,
      worker: recorded.worker,
    });

    const created = service.start();
    const session = await service.whenSettled(created.id);

    expect(session!.detected).toBe(true);
    expect(guard.probe.diagnoses).toBe(1);
    expect(session!.intervention.sent).toBe(false);
    expect(session!.withheld).toBe('no hay alternativa autorizada en este hilo');
    // La corrida NO se detiene en el atasco: el trabajador siguió trabajando.
    expect(recorded.histories.length).toBeGreaterThanOrEqual(3);
    expect(session!.verification.passed).toBe(true);
    expect(session!.status).toBe('completed');
  });

  /* ------------------------------------------------------------------ */
  /* (e) guardia que lanza                                               */
  /* ------------------------------------------------------------------ */

  test('[dobles] (e) un guardia que lanza no tumba la corrida y el fallo queda registrado', async () => {
    const model = scriptedFetch([]);
    const sandbox = fakeSandbox();
    const guard = guardModule({ throws: true });
    const recorded = recordingWorker([blockedCall, writeCall, redCall, () => DONE]);
    const service = buildService({
      fetchImpl: model.fetchImpl,
      probe: healthyProbe(sandbox.sandbox),
      intervention: guard.module,
      worker: recorded.worker,
    });

    const created = service.start();
    const session = await service.whenSettled(created.id);

    expect(session!.status).not.toBe('failed');
    expect(session!.status).toBe('completed');
    expect(session!.events.some((event) => event.text.includes('el guardia falló al diagnosticar'))).toBe(true);
    expect(String(session!.withheld)).toContain('GUARD_FAILED');
    expect(session!.intervention.sent).toBe(false);
    expect(session!.detected).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /* (f) caso sin atasco                                                 */
  /* ------------------------------------------------------------------ */

  test('[dobles] (f) sin atasco → detected:false, NO_INTERVENTION_NEEDED y cero llamadas al guardia', async () => {
    const model = scriptedFetch([]);
    const sandbox = fakeSandbox();
    const guard = guardModule();
    const recorded = recordingWorker([redCall, writeCall, redCall, () => DONE]);
    const service = buildService({
      fetchImpl: model.fetchImpl,
      probe: healthyProbe(sandbox.sandbox),
      intervention: guard.module,
      worker: recorded.worker,
    });

    const created = service.start();
    const session = await service.whenSettled(created.id);

    expect(session!.detected).toBe(false);
    expect(session!.withheld).toBe(GUARD_WITHHELD_NONE_NEEDED);
    expect(session!.withheld).toBe('NO_INTERVENTION_NEEDED');
    expect(guard.probe.diagnoses).toBe(0);
    expect(session!.guardCalls).toBe(0);
    expect(session!.guardTokens).toBe(0);
    expect(session!.intervention.sent).toBe(false);
    expect(session!.events.some((event) => event.type === 'guard')).toBe(false);
    expect(recorded.histories.every((history) => history.every((item) => item.role !== 'guard'))).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /* (g) una sola intervención por sesión                                */
  /* ------------------------------------------------------------------ */

  test('[dobles] (g) dos atascos en la misma sesión → una sola intervención', async () => {
    const model = scriptedFetch([]);
    const sandbox = fakeSandbox();
    const guard = guardModule();
    const recorded = recordingWorker([blockedCall, blockedCall, () => DONE]);
    const service = buildService({
      fetchImpl: model.fetchImpl,
      probe: healthyProbe(sandbox.sandbox),
      intervention: guard.module,
      worker: recorded.worker,
    });

    const created = service.start();
    const session = await service.whenSettled(created.id);

    // Dos denegaciones reales...
    const denials = session!.events.filter(
      (event) => event.type === 'policy' && event.text.includes('policy.protected-path'),
    );
    expect(denials.length).toBe(2);
    // ...pero UNA sola consulta al guardia y UN solo mensaje.
    expect(guard.probe.diagnoses).toBe(1);
    const finalHistory = recorded.histories.at(-1) ?? [];
    expect(finalHistory.filter((item) => item.role === 'guard').length).toBe(1);
    expect(
      session!.events.filter(
        (event) => event.type === 'guard' && event.data !== undefined && event.data['role'] === 'guard',
      ).length,
    ).toBe(1);
    expect(session!.detected).toBe(true);
    expect(session!.intervention.sent).toBe(true);
  });
});
