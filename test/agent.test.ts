/**
 * Pruebas del agente — 100 % offline y deterministas.
 *
 * No hay llamadas a Vultr, ni red, ni sandbox, ni claves reales. Se verifica:
 *  - configuración por entorno sin dependencia de credenciales,
 *  - modo offline explícitamente simulado y determinista,
 *  - registro de modelo solicitado/devuelto y advertencia de discrepancia,
 *  - saneado de errores sin secretos,
 *  - catálogo cerrado de herramientas mediadas (sin rutas al host),
 *  - que la explicación nunca es autorización.
 *
 * Limitación declarada: esto NO prueba inferencia real, contención ni benchmark.
 */
import { describe, expect, test } from 'bun:test';

import {
  AgentUnavailableError,
  DECIDE_SYSTEM_PROMPT,
  DEFAULT_INFERENCE_TIMEOUT_MS,
  DEFAULT_MAX_PLAN_STEPS,
  FORBIDDEN_ARG_KEYS,
  HISTORY_LIMITS,
  MEDIATED_TOOLS,
  MEDIATED_TOOL_NAMES,
  OFFLINE_MODEL_ID,
  OFFLINE_PROVIDER,
  PLAN_SYSTEM_PROMPT,
  UNAVAILABLE_MODEL_ID,
  InferenceError,
  buildDecideHistoryItem,
  observationFromResult,
  OfflineModelAdapter,
  OpenAICompatibleModelAdapter,
  createAgent,
  createInferenceAdapter,
  defaultRepairSteps,
  deterministicExplanation,
  extractJsonObject,
  findMediatedTool,
  inferenceConfigured,
  isWorkspaceRelative,
  loadInferenceConfig,
  parsePlanPayload,
  redactSecrets,
  resolveWorkspacePath,
  safeErrorMessage,
  validateAgentToolCall,
  type DecideHistoryItem,
  type FetchLike,
  type FetchInitLike,
  type FetchResponseLike,
} from '../src/agent.ts';

import type { AgentPlan, AgentRunState, AgentTask, IncidentRecord, PolicyVerdict } from '../src/contracts.ts';

const API_KEY = 'sk-vultr-TESTVALUE-0001';
const REPO = '/work/repo';

interface CapturedCall {
  readonly url: string;
  readonly init: FetchInitLike;
}

function jsonResponse(payload: unknown, status = 200): FetchResponseLike {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function liveConfig(overrides: Record<string, string> = {}) {
  return loadInferenceConfig({
    VULTR_INFERENCE_MODEL: 'vultr/qwen3-32b',
    VULTR_INFERENCE_API_KEY: API_KEY,
    VULTR_INFERENCE_BASE_URL: 'https://inference.example/v1/',
    ...overrides,
  });
}

function chatPayload(content: string, model = 'vultr/qwen3-32b') {
  return {
    model,
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  };
}

function planJson(steps: readonly unknown[]): string {
  return JSON.stringify({ steps });
}

const task: AgentTask = { id: 'task-1', objective: 'Arregla el repositorio y deja los tests verdes', repoPath: REPO };

function verdict(overrides: Partial<PolicyVerdict> = {}): PolicyVerdict {
  return {
    decision: 'deny',
    criticalViolations: [],
    risk: { score: 70, band: 'approval', factors: [], threshold: 65, provisional: true },
    reasons: [{ code: 'net.denied', detail: 'egress no autorizado' }],
    policyVersion: 'test-1',
    fingerprint: 'fp-1',
    decidedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function incident(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  const request = {
    id: 'op-1',
    taskId: 'task-1',
    planStepId: 's3',
    tool: 'pkg.install',
    args: { name: 'lodash', version: '4.17.21' },
    declaredIntent: 'instalar dependencia que falta',
    capability: 'pkg.install' as const,
    effect: {
      kinds: ['network.egress'] as const,
      targets: ['registry.npmjs.org'],
      environment: 'sandbox' as const,
      irreversible: false,
      externalImpact: true,
    },
    fingerprint: 'fp-op-1',
    requestedAt: '2026-01-01T00:00:00.000Z',
    computedBy: 'gateway' as const,
  };
  const policyVerdict = verdict();
  return {
    id: 'inc-1',
    taskId: 'task-1',
    request,
    verdict: policyVerdict,
    restriction: { kind: 'policy_denied', detail: 'egress a registry.npmjs.org no autorizado' },
    evidence: {
      taskObjective: task.objective,
      plan: null,
      attemptedOperation: request,
      policyVerdict,
      sandboxLog: [],
      agentExplanation: null,
      priorEvents: [],
    },
    status: 'open',
    recoverable: true,
    openedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function stateFrom(plan: AgentPlan, completed: readonly string[] = []): AgentRunState {
  return { taskId: plan.taskId, plan, completedSteps: completed, pendingApprovals: [], lastOutcome: null };
}

/* -------------------------------------------------------------------------- */

describe('configuración de inferencia', () => {
  test('sin modelo ni clave cae en modo offline, sin error', () => {
    const config = loadInferenceConfig({});
    expect(config.model).toBeNull();
    expect(config.apiKey).toBeNull();
    expect(config.baseUrl).toBe('https://api.vultrinference.com/v1');
    expect(config.timeoutMs).toBe(DEFAULT_INFERENCE_TIMEOUT_MS);
    expect(config.maxSteps).toBe(DEFAULT_MAX_PLAN_STEPS);
    expect(inferenceConfigured(config)).toBe(false);
  });

  test('modelo sin clave no habilita el modo real', () => {
    const config = loadInferenceConfig({ VULTR_INFERENCE_MODEL: 'vultr/qwen3-32b' });
    expect(inferenceConfigured(config)).toBe(false);
    expect(createInferenceAdapter(config).simulated).toBe(true);
  });

  test('normaliza base, topa timeout y pasos, ignora valores inválidos', () => {
    const config = loadInferenceConfig({
      VULTR_INFERENCE_BASE_URL: 'https://inference.example/v1/',
      VULTR_INFERENCE_MODEL: '  vultr/qwen3-32b  ',
      VULTR_INFERENCE_API_KEY: API_KEY,
      VULTR_INFERENCE_TIMEOUT_MS: '999999999',
      AGENT_MAX_STEPS: '0',
    });
    expect(config.baseUrl).toBe('https://inference.example/v1');
    expect(config.model).toBe('vultr/qwen3-32b');
    expect(config.timeoutMs).toBe(120_000);
    expect(config.maxSteps).toBe(1);
    expect(inferenceConfigured(config)).toBe(true);

    const garbage = loadInferenceConfig({ VULTR_INFERENCE_TIMEOUT_MS: 'mucho', AGENT_MAX_STEPS: 'muchos' });
    expect(garbage.timeoutMs).toBe(DEFAULT_INFERENCE_TIMEOUT_MS);
    expect(garbage.maxSteps).toBe(DEFAULT_MAX_PLAN_STEPS);
  });

  test('createAgent elige offline sin credenciales y lo advierte', () => {
    const agent = createAgent({ env: {} });
    expect(agent.mode).toBe('offline');
    expect(agent.simulated).toBe(true);
    expect(agent.describe().provider).toBe(OFFLINE_PROVIDER);
    expect(agent.warnings().some((warning) => warning.code === 'offline_mode')).toBe(true);
  });
});

describe('modo offline determinista', () => {
  test('dos planes idénticos producen pasos idénticos', async () => {
    const first = await createAgent({ env: {} }).plan(task);
    const second = await createAgent({ env: {} }).plan(task);
    expect(first.steps).toEqual(second.steps);
    expect(first.steps.length).toBeGreaterThan(0);
    expect(first.model.returnedModel).toBe(OFFLINE_MODEL_ID);
    expect(first.model.match).toBe(true);
    expect(first.model.requestedModel).toBe(OFFLINE_MODEL_ID);
  });

  test('el plan solo usa herramientas mediadas y rutas relativas', async () => {
    const plan = await createAgent({ env: {} }).plan(task);
    for (const step of plan.steps) {
      expect(MEDIATED_TOOL_NAMES).toContain(step.tool);
      expect(validateAgentToolCall(step.tool, step.args as Record<string, unknown>, REPO)).toBeNull();
    }
  });

  test('el adaptador offline declara que es simulado', async () => {
    const adapter = new OfflineModelAdapter();
    expect(adapter.simulated).toBe(true);
    expect(adapter.provider).toBe(OFFLINE_PROVIDER);
    const response = await adapter.complete({ purpose: 'plan', system: 's', user: '{}' });
    expect(response.returnedModel).toBe(OFFLINE_MODEL_ID);
    expect(response.promptTokens).toBeNull();
  });
});

describe('identidad del modelo', () => {
  test('una discrepancia se advierte y descalifica el benchmark', async () => {
    const agent = createAgent({ env: {}, offlineRequestedModel: 'vultr/qwen3-32b', offlineReturnedModel: 'vultr/otro' });
    const plan = await agent.plan(task);

    expect(plan.model.match).toBe(false);
    expect(plan.model.requestedModel).toBe('vultr/qwen3-32b');
    expect(plan.model.returnedModel).toBe('vultr/otro');
    expect(agent.warnings().some((warning) => warning.code === 'model_mismatch')).toBe(true);
    expect(agent.benchmarkEligible()).toBe(false);
  });

  test('un ciclo simulado NUNCA es elegible para benchmark', async () => {
    const agent = createAgent({ env: {} });
    await agent.plan(task);
    const records = agent.invocations();
    expect(records).toHaveLength(1);
    expect(records[0]?.purpose).toBe('plan');
    expect(records[0]?.taskId).toBe('task-1');
    expect(records[0]?.provider).toBe(OFFLINE_PROVIDER);
    // Honesto: inferencia simulada no es evidencia de modelo real.
    expect(agent.benchmarkEligible()).toBe(false);
  });

  test('un ciclo live con identidad coincidente y sin fallos sí es elegible', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(chatPayload(planJson(defaultRepairSteps())));
    const agent = createAgent({
      env: { VULTR_INFERENCE_MODEL: 'vultr/qwen3-32b', VULTR_INFERENCE_API_KEY: API_KEY },
      fetchImpl,
    });
    await agent.plan(task);
    expect(agent.benchmarkEligible()).toBe(true);
  });
});

describe('adaptador compatible OpenAI (fetch simulado)', () => {
  test('construye la petición correcta y registra el modelo devuelto', async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(chatPayload('hola'));
    };
    const adapter = new OpenAICompatibleModelAdapter(liveConfig(), fetchImpl);
    expect(adapter.simulated).toBe(false);
    expect(adapter.provider).toBe('vultr-serverless-inference');

    const response = await adapter.complete({ purpose: 'plan', system: 'sys', user: '{"objective":"x"}' });
    expect(response.content).toBe('hola');
    expect(response.returnedModel).toBe('vultr/qwen3-32b');
    expect(response.promptTokens).toBe(11);
    expect(response.completionTokens).toBe(7);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://inference.example/v1/chat/completions');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers?.['authorization']).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(calls[0]?.init.body ?? '{}') as { model?: string; stream?: boolean };
    expect(body.model).toBe('vultr/qwen3-32b');
    expect(body.stream).toBe(false);
  });

  test('sin clave falla cerrado con not_configured y no llama a fetch', async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return jsonResponse(chatPayload('x'));
    };
    const adapter = new OpenAICompatibleModelAdapter(
      loadInferenceConfig({ VULTR_INFERENCE_MODEL: 'vultr/a' }),
      fetchImpl,
    );
    const error = await adapter.complete({ purpose: 'plan', system: 's', user: 'u' }).catch((reason) => reason);
    expect(error).toBeInstanceOf(InferenceError);
    expect((error as InferenceError).code).toBe('not_configured');
    expect(called).toBe(false);
  });

  test('en live un fallo de API es un error explícito: no ejecuta el plan de respaldo', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: 'boom' }, 500);
    const agent = createAgent({ env: { VULTR_INFERENCE_MODEL: 'vultr/a', VULTR_INFERENCE_API_KEY: API_KEY }, fetchImpl });
    const error = await agent.plan(task).catch((reason) => reason);
    expect(error).toBeInstanceOf(AgentUnavailableError);
    expect((error as AgentUnavailableError).code).toBe('plan_unavailable');
    expect(agent.warnings().some((warning) => warning.code === 'inference_error')).toBe(true);
    expect(agent.warnings().some((warning) => warning.code === 'fallback_refused')).toBe(true);
    expect(agent.warnings().some((warning) => warning.code === 'fallback_used')).toBe(false);
    expect(agent.benchmarkEligible()).toBe(false);
  });
});

describe('errores sin secretos', () => {
  test('401 con la clave en el cuerpo no la filtra y marca auth_error', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(`invalid api key: ${API_KEY} (Bearer ${API_KEY})`, 401);
    const adapter = new OpenAICompatibleModelAdapter(liveConfig(), fetchImpl);
    const error = (await adapter.complete({ purpose: 'plan', system: 's', user: 'u' }).catch((r) => r)) as InferenceError;
    expect(error).toBeInstanceOf(InferenceError);
    expect(error.code).toBe('auth_error');
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain('[redacted]');
    expect(safeErrorMessage(error, [API_KEY]).message).not.toContain(API_KEY);
  });

  test('5xx se reporta como http_error saneado', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(`upstream fallo con token=${API_KEY}`, 502);
    const adapter = new OpenAICompatibleModelAdapter(liveConfig(), fetchImpl);
    const error = (await adapter.complete({ purpose: 'plan', system: 's', user: 'u' }).catch((r) => r)) as InferenceError;
    expect(error.code).toBe('http_error');
    expect(error.message).not.toContain(API_KEY);
  });

  test('error de red se sanea y no incluye cabeceras', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error(`connect ECONNREFUSED (authorization: Bearer ${API_KEY})`);
    };
    const adapter = new OpenAICompatibleModelAdapter(liveConfig(), fetchImpl);
    const error = (await adapter.complete({ purpose: 'plan', system: 's', user: 'u' }).catch((r) => r)) as InferenceError;
    expect(error.code).toBe('network');
    expect(error.message).not.toContain(API_KEY);
  });

  test('el timeout se reporta como timeout', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise<FetchResponseLike>((_resolve, reject) => {
        const signal = init.signal as { addEventListener?: (type: string, listener: () => void) => void } | undefined;
        signal?.addEventListener?.('abort', () => {
          const aborted = new Error('aborted');
          (aborted as { name: string }).name = 'AbortError';
          reject(aborted);
        });
      });
    const adapter = new OpenAICompatibleModelAdapter(liveConfig({ VULTR_INFERENCE_TIMEOUT_MS: '100' }), fetchImpl);
    const error = (await adapter.complete({ purpose: 'plan', system: 's', user: 'u' }).catch((r) => r)) as InferenceError;
    expect(error).toBeInstanceOf(InferenceError);
    expect(error.code).toBe('timeout');
  });

  test('respuesta no JSON se reporta como invalid_response', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse('no soy json');
    const adapter = new OpenAICompatibleModelAdapter(liveConfig(), fetchImpl);
    const error = (await adapter.complete({ purpose: 'plan', system: 's', user: 'u' }).catch((r) => r)) as InferenceError;
    expect(error.code).toBe('invalid_response');
  });

  test('contenido sin texto se rechaza en lugar de inventarlo', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ model: 'vultr/qwen3-32b', choices: [{ message: {} }] });
    const adapter = new OpenAICompatibleModelAdapter(liveConfig(), fetchImpl);
    const error = (await adapter.complete({ purpose: 'plan', system: 's', user: 'u' }).catch((r) => r)) as InferenceError;
    expect(error.code).toBe('invalid_response');
  });

  test('los registros del agente nunca contienen la clave', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(chatPayload(planJson(defaultRepairSteps())));
    const agent = createAgent({
      env: { VULTR_INFERENCE_MODEL: 'vultr/qwen3-32b', VULTR_INFERENCE_API_KEY: API_KEY },
      fetchImpl,
    });
    await agent.plan(task);
    await agent.explain(incident());
    const serialized = JSON.stringify({ invocations: agent.invocations(), warnings: agent.warnings() });
    expect(serialized).not.toContain(API_KEY);
    expect(agent.benchmarkEligible()).toBe(true);
  });

  test('redactSecrets elimina claves y cabeceras', () => {
    expect(redactSecrets(`k=${API_KEY}`, [API_KEY])).not.toContain(API_KEY);
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [redacted]');
    expect(redactSecrets('sk-abcdef123456')).toBe('[redacted]');
  });
});

describe('catálogo cerrado: nada de llamadas directas al host', () => {
  test('no existe herramienta de shell ni de red arbitraria', () => {
    const names = MEDIATED_TOOL_NAMES.join(' ');
    expect(names).not.toMatch(/shell|bash|exec\.host|host\.|http|fetch/i);
    expect(findMediatedTool('host.exec')).toBeNull();
    expect(findMediatedTool('proc.shell')).toBeNull();
    expect(FORBIDDEN_ARG_KEYS).toContain('command');
    expect(FORBIDDEN_ARG_KEYS).toContain('env');
    for (const tool of MEDIATED_TOOLS) {
      for (const arg of tool.pathArgs) {
          expect([...tool.requiredArgs, ...tool.optionalArgs]).toContain(arg);
      }
    }
  });

  test('valida rutas relativas y rechaza escapes', () => {
    expect(isWorkspaceRelative('.')).toBe(true);
    expect(isWorkspaceRelative('src/index.js')).toBe(true);
    expect(isWorkspaceRelative('/etc/passwd')).toBe(false);
    expect(isWorkspaceRelative('C:\\Windows\\system32')).toBe(false);
    expect(isWorkspaceRelative('../secrets')).toBe(false);
    expect(isWorkspaceRelative('a/../../b')).toBe(false);
    expect(isWorkspaceRelative('~/clave')).toBe(false);
    expect(resolveWorkspacePath(REPO, 'src/index.js')).toBe('/work/repo/src/index.js');
    expect(resolveWorkspacePath(REPO, '../fuera')).toBeNull();
  });

  test('validateAgentToolCall rechaza comandos, secretos y herramientas desconocidas', () => {
    expect(validateAgentToolCall('fs.read', { path: 'index.js' }, REPO)).toBeNull();
    expect(validateAgentToolCall('fs.read', { path: '/etc/passwd' }, REPO)).toContain('ruta');
    expect(validateAgentToolCall('fs.read', { path: 'index.js', command: 'rm -rf /' }, REPO)).toContain('prohibido');
    expect(validateAgentToolCall('fs.read', { path: 'index.js', token: 'x' }, REPO)).toContain('prohibido');
    expect(validateAgentToolCall('shell.exec', { command: 'ls' }, REPO)).toContain('no mediada');
    expect(validateAgentToolCall('test.run', { cwd: '.', script: 'test --host' }, REPO)).toContain('formato');
    expect(validateAgentToolCall('pkg.install', { name: 'lodash', version: '4.17.21' }, REPO)).toBeNull();
    expect(validateAgentToolCall('pkg.install', { name: '../../etc', version: '1' }, REPO)).toContain('formato');
    expect(validateAgentToolCall('deploy.request', { target: 'app', ref: 'main' }, REPO)).toBeNull();
  });
});

describe('parseo del plan del modelo', () => {
  test('extrae JSON envuelto en prosa o fences', () => {
    expect(extractJsonObject('texto ```json\n{"steps":[]}\n``` fin')).toEqual({ steps: [] });
    expect(extractJsonObject('sin json')).toBeNull();
    expect(extractJsonObject('{roto')).toBeNull();
  });

  test('descarta pasos peligrosos y conserva los válidos', () => {
    const content = planJson([
      { id: 's1', intent: 'leer', tool: 'fs.read', args: { path: 'index.js' }, dependsOn: [] },
      { id: 's2', intent: 'escape', tool: 'shell.exec', args: { command: 'cat /etc/shadow' }, dependsOn: ['s1'] },
      { id: 's3', intent: 'absoluta', tool: 'fs.read', args: { path: '/etc/shadow' }, dependsOn: [] },
      { id: 's4', intent: 'traversal', tool: 'fs.read', args: { path: '../.env' }, dependsOn: [] },
      { id: 's5', intent: 'red', tool: 'fs.read', args: { path: 'x', url: 'http://evil' }, dependsOn: [] },
      { id: 's6', intent: 'dependencia futura', tool: 'fs.read', args: { path: 'x' }, dependsOn: ['s9'] },
      { id: 's1', intent: 'duplicado', tool: 'fs.read', args: { path: 'y' }, dependsOn: [] },
      { id: 's7', intent: 'listar', tool: 'fs.list', args: { path: '.' }, dependsOn: ['s1'] },
    ]);
    const parsed = parsePlanPayload(content, REPO, 12);
    expect(parsed).not.toBeNull();
    expect(parsed?.steps.map((step) => step.id)).toEqual(['s1', 's7']);
    expect(parsed?.rejected).toHaveLength(6);
    for (const rejection of parsed?.rejected ?? []) expect(rejection.reason.length).toBeGreaterThan(0);
  });

  test('devuelve null si no hay plan utilizable', () => {
    expect(parsePlanPayload('sin json', REPO, 12)).toBeNull();
    expect(parsePlanPayload(JSON.stringify({ steps: [] }), REPO, 12)).toBeNull();
    expect(parsePlanPayload(planJson([{ id: 's1', intent: 'x', tool: 'shell', args: {} }]), REPO, 12)).toBeNull();
  });

  test('respeta el máximo de pasos', async () => {
    const steps = Array.from({ length: 10 }, (_, index) => ({
      id: `s${index + 1}`,
      intent: `paso ${index + 1}`,
      tool: 'fs.read',
      args: { path: 'index.js' },
      dependsOn: index === 0 ? [] : [`s${index}`],
    }));
    const fetchImpl: FetchLike = async () => jsonResponse(chatPayload(planJson(steps)));
    const agent = createAgent({
      env: { VULTR_INFERENCE_MODEL: 'vultr/qwen3-32b', VULTR_INFERENCE_API_KEY: API_KEY },
      fetchImpl,
      maxSteps: 3,
    });
    const plan = await agent.plan(task);
    expect(plan.steps).toHaveLength(3);
    expect(agent.warnings().some((warning) => warning.code === 'plan_partial')).toBe(true);
  });

  test('en live un plan inválido es un error explícito tras reintento acotado', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(chatPayload('no puedo ayudarte con eso'));
    };
    const agent = createAgent({
      env: { VULTR_INFERENCE_MODEL: 'vultr/qwen3-32b', VULTR_INFERENCE_API_KEY: API_KEY },
      fetchImpl,
      maxRetries: 1,
    });
    const error = await agent.plan(task).catch((reason) => reason);
    expect(error).toBeInstanceOf(AgentUnavailableError);
    expect(calls).toBe(2); // 1 intento + 1 reintento acotado
    expect(agent.warnings().some((warning) => warning.code === 'plan_invalid')).toBe(true);
    expect(agent.warnings().some((warning) => warning.code === 'fallback_used')).toBe(false);
  });

  test('el plan de respaldo offline es determinista y NO escribe marcadores', async () => {
    const agent = createAgent({ env: {} });
    const plan = await agent.plan(task);
    expect(plan.steps).toEqual(defaultRepairSteps());
    for (const step of plan.steps) {
      expect(step.tool).not.toBe('fs.write');
      expect(JSON.stringify(step.args)).not.toContain('pendiente');
    }
  });
});

describe('next: emisión mediada', () => {
  test('emite el primer paso con dependencias satisfechas', async () => {
    const agent = createAgent({ env: {} });
    const plan = await agent.plan(task);
    const first = await agent.next(stateFrom(plan));
    expect(first.kind).toBe('call');
    if (first.kind !== 'call') return;
    expect(first.call.planStepId).toBe('s1');
    expect(first.call.taskId).toBe('task-1');
    expect(MEDIATED_TOOL_NAMES).toContain(first.call.tool);

    const second = await agent.next(stateFrom(plan, ['s1']));
    expect(second.kind).toBe('call');
    if (second.kind !== 'call') return;
    expect(second.call.planStepId).toBe('s2');
    expect(second.call.declaredIntent.length).toBeGreaterThan(0);
  });

  test('no emite pasos con dependencias incompletas y termina en done', async () => {
    const agent = createAgent({ env: {} });
    const plan = await agent.plan(task);
    const skipped = await agent.next(stateFrom(plan, ['s1', 's3']));
    expect(skipped.kind).toBe('call');
    if (skipped.kind !== 'call') return;
    expect(skipped.call.planStepId).toBe('s2');

    const all = plan.steps.map((step) => step.id);
    const done = await agent.next(stateFrom(plan, all));
    expect(done.kind).toBe('done');
    if (done.kind !== 'done') return;
    expect(done.summary).toContain('Plan agotado');
    expect(done.summary).toContain('no es un éxito comprobado');
    expect(done.verified).toBe(false);
  });

  test('revalida cada paso antes de emitirlo (defensa en profundidad)', async () => {
    const agent = createAgent({ env: {} });
    const poisonedPlan: AgentPlan = {
      taskId: 'task-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      model: { provider: 'test', requestedModel: 'm', returnedModel: 'm', match: true },
      steps: [
        { id: 'x1', intent: 'escapar', tool: 'shell.exec', args: { command: 'rm -rf /' }, dependsOn: [] },
        { id: 'x2', intent: 'leer', tool: 'fs.read', args: { path: 'index.js' }, dependsOn: [] },
      ],
    };
    const action = await agent.next({
      taskId: 'task-1',
      plan: poisonedPlan,
      completedSteps: [],
      pendingApprovals: [],
      lastOutcome: null,
    });
    expect(action.kind).toBe('call');
    if (action.kind !== 'call') return;
    expect(action.call.planStepId).toBe('x2');
    expect(action.call.tool).toBe('fs.read');
    expect(agent.warnings().some((warning) => warning.code === 'plan_partial')).toBe(true);
  });

  test('permite continuar trabajo independiente con aprobaciones pendientes', async () => {
    const agent = createAgent({ env: {} });
    const plan = await agent.plan(task);
    const state: AgentRunState = {
      taskId: 'task-1',
      plan,
      completedSteps: ['s1'],
      pendingApprovals: ['apr-1'],
      lastOutcome: 'approval_required',
    };
    const action = await agent.next(state);
    expect(action.kind).toBe('call');
    if (action.kind !== 'call') return;
    expect(action.call.planStepId).toBe('s2');
  });
});

describe('explain: evidencia, no autorización', () => {
  test('la explicación offline describe la restricción y no concede nada', async () => {
    const agent = createAgent({ env: {} });
    const text = await agent.explain(incident());
    expect(text).toContain('policy_denied');
    expect(text.toLowerCase()).not.toContain('permiso concedido');
    expect(text).toContain('evidencia');
    // No existe ninguna API de autorización en el agente.
    expect('grantPermission' in agent).toBe(false);
    expect('approve' in agent).toBe(false);
  });

  test('la explicación del modelo se sanea y se acota', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(chatPayload(`Necesitaba la dependencia. clave=${API_KEY} ${'x'.repeat(5000)}`));
    const agent = createAgent({
      env: { VULTR_INFERENCE_MODEL: 'vultr/qwen3-32b', VULTR_INFERENCE_API_KEY: API_KEY },
      fetchImpl,
    });
    const text = await agent.explain(incident());
    expect(text).not.toContain(API_KEY);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(agent.invocations().some((record) => record.purpose === 'explain')).toBe(true);
  });

  test('la explicación determinista describe el incidente sin pedir permisos', () => {
    const text = deterministicExplanation(incident({ verdict: verdict({ criticalViolations: [] }) }));
    expect(text).toContain('pkg.install');
    expect(text).toContain('registry.npmjs.org');
    expect(text).toContain('no concede autorización');
  });
});

describe('contrato AgentPort', () => {
  test('RepairAgent cumple la interfaz y expone metadatos auditables', async () => {
    const agent = createAgent({ env: {} });
    expect(typeof agent.plan).toBe('function');
    expect(typeof agent.next).toBe('function');
    expect(typeof agent.explain).toBe('function');
    const plan = await agent.plan(task);
    expect(plan.taskId).toBe('task-1');
    expect(plan.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(plan.model.provider).toBe(OFFLINE_PROVIDER);
    expect(agent.describe().tools).toEqual(MEDIATED_TOOL_NAMES);
  });
});

describe('contrato único de ejecución (test.run / proc.exec)', () => {
  test('test.run acepta suite o script y honra cwd; sin ninguno se rechaza', () => {
    expect(validateAgentToolCall('test.run', { cwd: '.', suite: 'tests-public/test.mjs' }, REPO)).toBeNull();
    expect(validateAgentToolCall('test.run', { cwd: 'pkg', script: 'test' }, REPO)).toBeNull();
    expect(validateAgentToolCall('test.run', { cwd: '.' }, REPO)).toContain('falta uno');
    expect(validateAgentToolCall('test.run', { cwd: '.', suite: '../fuera.mjs' }, REPO)).toContain('ruta');
    expect(validateAgentToolCall('test.run', { cwd: '.', suite: 'suite.txt' }, REPO)).toContain('formato');
    expect(validateAgentToolCall('test.run', { cwd: '../..', script: 'test' }, REPO)).toContain('ruta');
  });

  test('proc.exec sólo admite argv cerrado: sin shell, sin flags, sin binario arbitrario', () => {
    expect(validateAgentToolCall('proc.exec', { argv: ['node', 'tests-public/test.mjs', '.'] }, REPO)).toBeNull();
    expect(validateAgentToolCall('proc.exec', { argv: ['bun', 'run.ts'] }, REPO)).toBeNull();
    expect(validateAgentToolCall('proc.exec', { argv: ['sh', '-c', 'rm -rf /'] }, REPO)).toContain('binario');
    expect(validateAgentToolCall('proc.exec', { argv: ['node', '-e', 'process.exit(0)'] }, REPO)).toContain('script');
    expect(validateAgentToolCall('proc.exec', { argv: ['node', 'x.mjs', '--require', 'evil'] }, REPO)).toContain('flag');
    expect(validateAgentToolCall('proc.exec', { argv: ['node', '/etc/passwd.mjs'] }, REPO)).toContain('script');
    expect(validateAgentToolCall('proc.exec', { argv: ['node', 'x.mjs', '../fuera'] }, REPO)).toContain('..');
    expect(validateAgentToolCall('proc.exec', { argv: 'node x.mjs' }, REPO)).toContain('argv');
  });

  test('los prompts no exigen escribir antes de inspeccionar ni prohíben releer', () => {
    expect(PLAN_SYSTEM_PROMPT).not.toContain('tests-public');
    expect(DECIDE_SYSTEM_PROMPT).not.toContain('tests-public');
    expect(DECIDE_SYSTEM_PROMPT).not.toContain('No repitas una lectura');
    expect(DECIDE_SYSTEM_PROMPT).not.toContain('LEER NO REPARA');
    expect(DECIDE_SYSTEM_PROMPT).toContain('releer');
  });
});

describe('historial: observación estructurada retrocompatible', () => {
  const result = {
    exitCode: 1,
    stdout: 'x'.repeat(HISTORY_LIMITS.stdoutChars + 25),
    stderr: 'fallo de la suite',
    timedOut: false,
    killedReason: null,
    durationMs: 12,
  };

  test('observationFromResult conserva stdout/stderr y marca el truncado', () => {
    const observation = observationFromResult(result);
    expect(observation.exitCode).toBe(1);
    expect(observation.timedOut).toBe(false);
    expect(observation.stderr).toBe('fallo de la suite');
    expect(observation.stdoutTruncated).toBe(true);
    expect(observation.stdoutOmittedChars).toBe(25);
    expect(observation.stdout.length).toBe(HISTORY_LIMITS.stdoutChars);
  });

  test('buildDecideHistoryItem mantiene detail y añade observation', () => {
    const item = buildDecideHistoryItem({
      tool: 'test.run',
      args: { cwd: '.', script: 'test' },
      outcome: 'failed',
      result,
    });
    expect(item.detail.length).toBeGreaterThan(0);
    expect(item.observation?.exitCode).toBe(1);
    expect(item.planStepId).toBeUndefined();
  });

  test('decide entrega al modelo el detalle largo y la observación estructurada', async () => {
    const calls: CapturedCall[] = [];
    let call = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      call += 1;
      return jsonResponse(
        chatPayload(call === 1 ? planJson(defaultRepairSteps()) : JSON.stringify({ done: true, summary: 'listo' })),
      );
    };
    const agent = createAgent({
      env: { VULTR_INFERENCE_MODEL: 'vultr/qwen3-32b', VULTR_INFERENCE_API_KEY: API_KEY },
      fetchImpl,
    });
    const plan = await agent.plan(task);
    const longDetail = 'D'.repeat(1_500);
    const history: DecideHistoryItem[] = [
      { tool: 'fs.read', args: { path: 'index.js' }, outcome: 'allowed', detail: longDetail, planStepId: 's1' },
      buildDecideHistoryItem({
        tool: 'test.run',
        args: { cwd: '.', script: 'test' },
        outcome: 'failed',
        result,
        planStepId: 's2',
      }),
    ];
    const action = await agent.decide({
      taskId: 'task-1',
      objective: task.objective,
      repoPath: REPO,
      plan,
      history,
      maxSteps: 5,
    });
    expect(action.kind).toBe('done');
    if (action.kind !== 'done') return;
    expect(action.verified).toBe(false);

    const body = JSON.parse(calls.at(-1)?.init.body ?? '{}') as { messages: Array<{ content: string }> };
    const user = JSON.parse(body.messages[1]?.content ?? '{}') as { history: Array<Record<string, unknown>> };
    // 1500 < 2000: el detalle largo ya NO se recorta a 400.
    expect(user.history[0]?.detail).toBe(longDetail);
    const observation = user.history[1]?.observation as Record<string, unknown>;
    expect(observation.exitCode).toBe(1);
    expect(observation.stdoutTruncated).toBe(true);
    expect(observation.stderr).toBe('fallo de la suite');
  });

  test('sentinel: el contenido leído por una herramienta llega al payload del siguiente modelo', async () => {
    const sentinel = 'SENTINEL_FILE_CONTENT_7f3a9c';
    const calls: CapturedCall[] = [];
    let call = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      call += 1;
      return jsonResponse(
        chatPayload(call === 1 ? planJson(defaultRepairSteps()) : JSON.stringify({ done: true, summary: 'listo' })),
      );
    };
    const agent = createAgent({
      env: { VULTR_INFERENCE_MODEL: 'vultr/qwen3-32b', VULTR_INFERENCE_API_KEY: API_KEY },
      fetchImpl,
    });
    const plan = await agent.plan(task);
    const history: DecideHistoryItem[] = [
      buildDecideHistoryItem({
        tool: 'fs.read',
        args: { path: 'src/index.js' },
        outcome: 'allowed',
        planStepId: 's1',
        result: {
          exitCode: 0,
          stdout: `contenido del fichero: ${sentinel}`,
          stderr: '',
          timedOut: false,
          killedReason: null,
          durationMs: 3,
        },
      }),
    ];
    await agent.decide({ taskId: 'task-1', objective: task.objective, repoPath: REPO, plan, history, maxSteps: 5 });

    const body = calls.at(-1)?.init.body ?? '';
    expect(body).toContain(sentinel);
    const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
    const user = JSON.parse(parsed.messages[1]?.content ?? '{}') as { history: Array<Record<string, unknown>> };
    const observation = user.history[0]?.observation as Record<string, unknown>;
    expect(observation.stdout).toContain(sentinel);
  });

  test('en live una decisión inválida es un error explícito, no un done', async () => {
    let call = 0;
    const fetchImpl: FetchLike = async () => {
      call += 1;
      return jsonResponse(chatPayload(call === 1 ? planJson(defaultRepairSteps()) : 'no es json'));
    };
    const agent = createAgent({
      env: { VULTR_INFERENCE_MODEL: 'vultr/qwen3-32b', VULTR_INFERENCE_API_KEY: API_KEY },
      fetchImpl,
    });
    const plan = await agent.plan(task);
    const error = await agent
      .decide({ taskId: 'task-1', objective: task.objective, repoPath: REPO, plan, history: [], maxSteps: 5 })
      .catch((reason) => reason);
    expect(error).toBeInstanceOf(AgentUnavailableError);
    expect((error as AgentUnavailableError).code).toBe('decision_unavailable');
    expect(agent.warnings().some((warning) => warning.code === 'fallback_refused')).toBe(true);
  });

  test('en live una herramienta fuera del catálogo no se convierte en done', async () => {
    let call = 0;
    const fetchImpl: FetchLike = async () => {
      call += 1;
      return jsonResponse(
        chatPayload(
          call === 1
            ? planJson(defaultRepairSteps())
            : JSON.stringify({ tool: 'shell', args: { command: 'id' } }),
        ),
      );
    };
    const agent = createAgent({
      env: { VULTR_INFERENCE_MODEL: 'vultr/qwen3-32b', VULTR_INFERENCE_API_KEY: API_KEY },
      fetchImpl,
    });
    const plan = await agent.plan(task);
    const error = await agent
      .decide({ taskId: 'task-1', objective: task.objective, repoPath: REPO, plan, history: [], maxSteps: 5 })
      .catch((reason) => reason);
    expect(error).toBeInstanceOf(AgentUnavailableError);
    expect(agent.warnings().some((warning) => warning.code === 'decide_rejected')).toBe(true);
  });
});
