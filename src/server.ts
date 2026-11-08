/**
 * Servidor local del MVP (BOUNDARY / Lifeguard).
 *
 * Cablea los componentes reales por sus interfaces: Preflight, Policy,
 * Risk, Gateway (modo `simulated`, fail-closed con `UnavailableSandbox`),
 * Judge (sólo diagnóstico, sin autoridad), Lifeguard (almacén preaprobado,
 * aplicación SIMULADA sin escribir en el host) y Agente (offline por
 * defecto, sin credenciales).
 *
 * Controles honestos del MVP:
 * - Escucha SÓLO en loopback (`127.0.0.1`); cualquier otro `hostname` se
 *   rechaza (fallo cerrado: el servidor no autenticado no se expone a red).
 * - Sin ejecución real: el gateway trabaja en `simulated` y toda operación
 *   permitida devuelve `simulation-only` sin tocar el host.
 * - Sin red saliente, sin secretos, sin recursos facturables.
 * - `GET /api/state` es la única fuente del panel (`web/app.js`): todo
 *   campo ausente se muestra como ausente, nunca se inventa estado.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { createAgent, type RepairAgent } from './agent.ts';
import {
  CONTRACT_VERSION,
  CRITICAL_RULES,
  SERVER_LIMITS,
  effectsEquivalent,
  isApprovable,
  nowIso,
  type AgentPlan,
  type AgentToolCall,
  type ApprovalId,
  type ApprovalRequest,
  type AuditEvent,
  type Capability,
  type EffectSignature,
  type Environment,
  type GatewayContext,
  type IncidentId,
  type IncidentRecord,
  type IsoTimestamp,
  type JudgeDiagnosis,
  type JsonObject,
  type LifeguardPort,
  type OperationRequest,
  type PolicyVerdict,
  type PreflightDecision,
  type PreflightInput,
  type PreflightManifest,
  type PreflightPort,
  type PreparationReport,
  type RecoveryBlockReason,
  type RecoveryId,
  type RecoveryOutcome,
  type RecoveryRecord,
  type RecoveryProposal,
  type RiskAssessment,
  type SandboxLimitsReport,
  type SandboxPort,
  type TaskId,
  type TaskScope,
  type TaskStateRecord,
} from './contracts.ts';
import {
  createGateway,
  gatewayContext,
  UnavailableSandbox,
  type MediatedGateway,
} from './gateway.ts';
import { diagnose as localDiagnose } from './judge.ts';
import { probeDockerRuntime } from './sandbox-docker.ts';
import { isCriticalEffect, recoverFromStore, type Store } from './lifeguard.ts';
import {
  authorizeRecovery,
  buildApprovedStore,
  DeterministicPolicyEngine,
  DeterministicRiskEngine,
  findMechanism,
  POLICY_VERSION,
  proposeDependencyRecovery,
} from './policy.ts';
import { isValidDeclaredDependency, type DeclaredDependency } from './preflight.ts';
import { approvalExpiryFrom, InMemoryApprovalStore, InMemoryAuditSink } from './store.ts';

/* -------------------------------------------------------------------------- */
/* Preflight local (implementa el puerto de contratos)                        */
/* -------------------------------------------------------------------------- */

export class LocalPreflight implements PreflightPort {
  constructor(private readonly scopeFor: (taskId: TaskId) => TaskScope) {}

  decide(input: PreflightInput): PreflightDecision {
    const triggers: Array<PreflightDecision['triggers'][number]> = [];
    if (input.declaredSteps > 10) triggers.push('steps_over_threshold');
    if (input.estimatedMinutes > 10) triggers.push('duration_over_threshold');
    if (input.sensitiveResources.length > 0) triggers.push('sensitive_resources');
    if (input.environment === 'production') triggers.push('production_target');
    const required = triggers.length > 0;
    return {
      required,
      depth: !required ? 'none' : input.environment === 'production' || input.sensitiveResources.length > 0 ? 'full' : 'light',
      triggers,
      provisional: true,
    };
  }

  async plan(input: PreflightInput): Promise<PreflightManifest> {
    const scope = this.scopeFor(input.taskId);
    return {
      taskId: input.taskId,
      objective: input.objective,
      successCriteria: [],
      availableCapabilities: [...scope.allowedCapabilities],
      expectedCapabilities: [...scope.allowedCapabilities],
      authorizedPermissions: [...scope.allowedCapabilities],
      restrictedOperations: CRITICAL_RULES.map((rule) => rule.id),
      knownAuthorizedAlternatives: ['approved-dependency-store'],
      approvalPoints: input.sensitiveResources.length > 0 ? ['sensitive-scope: explicit approval required'] : [],
      preparedDependencies: [],
      grantsNewPrivileges: false,
      createdAt: nowIso(),
    };
  }

  async prepare(manifest: PreflightManifest): Promise<PreparationReport> {
    return {
      taskId: manifest.taskId,
      prepared: [...manifest.preparedDependencies],
      failed: [],
      finishedAt: nowIso(),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Judge local (sólo diagnóstico, sin autoridad)                               */
/* -------------------------------------------------------------------------- */

import { DEFAULT_JUDGE_TIMEOUT_MS, type JudgeInput, type JudgePort } from './contracts.ts';
import { ContinuityService } from "./continuity.ts";

export class LocalJudge implements JudgePort {
  readonly advisory = true as const;
  readonly timeoutMs = DEFAULT_JUDGE_TIMEOUT_MS;
  available(): boolean {
    return true;
  }
  async diagnose(input: JudgeInput): Promise<JudgeDiagnosis> {
    const local = localDiagnose({
      objective: input.evidence.taskObjective,
      plan: input.evidence.plan?.steps.map((step) => `${step.id}: ${step.intent}`) ?? [],
      attemptedOperation: `${input.incident.request.tool} ${JSON.stringify(input.incident.request.args)}`,
      restriction: `${input.incident.restriction.kind}: ${input.incident.restriction.detail}`,
      explanation: input.evidence.agentExplanation ?? '',
      logExcerpt: input.evidence.sandboxLog.join('\n'),
    });
    const verdict =
      local.verdict === 'partially-supported'
        ? 'partially_supported'
        : local.verdict === 'insufficient-evidence'
          ? 'insufficient_evidence'
          : local.verdict;
    return {
      verdict,
      rationale: local.reasons.join(' | '),
      evidenceRefs: [input.incident.id],
      canGrantPermissions: false,
      authority: 'none',
      advisory: true,
      producedAt: nowIso(),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Lifeguard local (almacén preaprobado, aplicación SIMULADA)                 */
/* -------------------------------------------------------------------------- */

/**
 * Ventana máxima de validez de un veredicto que autoriza una recuperación.
 * Fuera de la ventana la autorización se trata como inexistente (caducada).
 */
export const RECOVERY_AUTHORIZATION_TTL_MS = 5 * 60 * 1000;

/** Tolerancia de reloj al comparar `decidedAt` con el instante de aplicación. */
const RECOVERY_CLOCK_SKEW_MS = 60 * 1000;

export interface RecoveryApplyOptions {
  /** Aprobación humana asociada (si la hubiera) que se refleja en el registro. */
  readonly approvalId?: ApprovalId | null;
  /** `true` sólo si la aprobación fue verificada como utilizable (`isApprovalUsable`). */
  readonly approvalUsable?: boolean;
  /** Instante de aplicación (por defecto, ahora). */
  readonly now?: IsoTimestamp;
}

/**
 * Registro de recuperación con la simulación declarada de forma explícita.
 * El registro nunca afirma una escritura real: `simulated` es `true` porque el
 * sandbox no está verificado y nada se materializa en el host.
 */
export interface SimulatedRecoveryRecord extends RecoveryRecord {
  readonly simulated: true;
}

function rejectedRecovery(...reasons: RecoveryBlockReason[]): RecoveryOutcome {
  return { kind: 'rejected', reasons };
}

/** `name@version` → partes; el nombre puede contener `@` (paquetes con scope). */
function splitTarget(target: string): { name: string; version: string } | null {
  const at = target.lastIndexOf('@');
  if (at <= 0) return null;
  const name = target.slice(0, at);
  const version = target.slice(at + 1);
  if (name.length === 0 || version.length === 0) return null;
  return { name, version };
}

export class LocalLifeguard implements LifeguardPort {
  /** Unicidad: cada propuesta y cada incidente se aplican como máximo una vez. */
  private readonly appliedProposals = new Set<RecoveryId>();
  private readonly appliedIncidents = new Set<IncidentId>();

  constructor(private readonly store: Store = buildApprovedStore()) {}

  get appliedRecoveryIds(): readonly RecoveryId[] {
    return [...this.appliedProposals];
  }

  async propose(incident: IncidentRecord, scope: TaskScope): Promise<RecoveryOutcome> {
    const proposal = proposeDependencyRecovery(incident, incident.openedAt);
    if (!proposal) return { kind: 'none_available', reasons: ['effect_not_allowed'] };
    const mechanism = findMechanism(proposal.mechanism.id);
    if (!mechanism) return { kind: 'none_available', reasons: ['mechanism_not_authorized'] };
    // La recuperación sólo puede proponerse para el alcance del propio incidente:
    // el alcance del mecanismo se compone después en `authorizeRecovery`.
    if (scope.taskId !== incident.taskId) return { kind: 'none_available', reasons: ['mechanism_not_authorized'] };
    if (effectsEquivalent(proposal.proposedEffect, proposal.blockedEffect)) {
      return { kind: 'none_available', reasons: ['effect_equivalent_to_prohibited'] };
    }
    return { kind: 'proposed', proposal };
  }

  /**
   * Aplicación SIMULADA de una recuperación. Falla cerrado: sólo registra
   * `applied` si el efecto está contenido en el mecanismo aprobado, la
   * autorización es un `allow` explícito y vigente, la integridad se verifica y
   * la propuesta no se aplicó antes. En cualquier otro caso devuelve
   * `rejected` y NO deja rastro de recuperación aplicada.
   */
  async apply(
    proposal: RecoveryProposal,
    authorization: PolicyVerdict,
    options: RecoveryApplyOptions = {},
  ): Promise<RecoveryOutcome> {
    if (!proposal || !authorization) return rejectedRecovery('effect_not_allowed');
    const now = options.now ?? nowIso();

    // 1. Mecanismo: debe existir en el registro aprobado y no ampliar privilegios.
    const mechanism = findMechanism(proposal.mechanism.id);
    if (!mechanism || mechanism.grantsNewPrivileges !== false) return rejectedRecovery('mechanism_not_authorized');

    // 2. Efecto: nunca equivalente al prohibido, acotado a los efectos del
    //    mecanismo, dentro del sandbox, reversible y sin impacto externo.
    if (effectsEquivalent(proposal.proposedEffect, proposal.blockedEffect)) {
      return rejectedRecovery('effect_equivalent_to_prohibited');
    }
    const kinds = proposal.proposedEffect.kinds;
    const kindsAllowed = kinds.length > 0 && kinds.every((kind) => mechanism.effectKinds.includes(kind));
    const contained =
      proposal.proposedEffect.environment === 'sandbox' &&
      proposal.proposedEffect.irreversible === false &&
      proposal.proposedEffect.externalImpact === false;
    if (!kindsAllowed || !contained || kinds.some((kind) => isCriticalEffect(kind))) {
      return rejectedRecovery('effect_not_allowed');
    }

    // 3. Autorización: `deny`, `require_approval` o violaciones críticas jamás
    //    se registran como aplicadas, por favorable que sea el resto.
    if (authorization.criticalViolations.length > 0) return rejectedRecovery('critical_rule');
    if (authorization.decision !== 'allow') {
      if (authorization.decision === 'require_approval') {
        return options.approvalUsable === true
          ? rejectedRecovery('approval_required')
          : rejectedRecovery('approval_required', 'approval_missing');
      }
      return rejectedRecovery('effect_not_allowed');
    }

    // 4. Expiración: una autorización caducada (o emitida en el futuro) es una
    //    autorización inexistente.
    const decidedAtMs = Date.parse(authorization.decidedAt);
    const nowMs = Date.parse(now);
    if (!Number.isFinite(decidedAtMs) || !Number.isFinite(nowMs)) return rejectedRecovery('approval_missing');
    if (decidedAtMs > nowMs + RECOVERY_CLOCK_SKEW_MS) return rejectedRecovery('approval_missing');
    if (nowMs - decidedAtMs > RECOVERY_AUTHORIZATION_TTL_MS) return rejectedRecovery('approval_missing');
    if (mechanism.requiresApproval && options.approvalUsable !== true) return rejectedRecovery('approval_missing');

    // 5. Unicidad: la autorización de recuperación es de un solo uso; reusar la
    //    misma propuesta o el mismo incidente equivale a no tener autorización.
    if (this.appliedProposals.has(proposal.id) || this.appliedIncidents.has(proposal.incidentId)) {
      return rejectedRecovery('approval_missing');
    }

    // 6. Integridad: paquete preaprobado, clave exacta y hash verificado. El
    //    paquete sale de la propuesta, no de constantes del módulo: así una
    //    propuesta no puede materializar un paquete distinto del autorizado.
    const target = proposal.proposedEffect.targets[0];
    const reference = target ? splitTarget(target) : null;
    if (!reference) return rejectedRecovery('integrity_unverified');
    const check = recoverFromStore(
      {
        incidentId: proposal.incidentId,
        effect: kinds[0]!,
        packageName: reference.name,
        packageVersion: reference.version,
      },
      this.store,
      { allowedEffects: [...mechanism.effectKinds] },
    );
    if (check.outcome !== 'recovered') {
      const reason = check.reason;
      if (reason.includes('critical')) return rejectedRecovery('critical_rule');
      if (reason.includes('not authorized')) return rejectedRecovery('effect_not_allowed');
      if (reason.includes('not pre-approved')) return rejectedRecovery('effect_not_allowed');
      return rejectedRecovery('integrity_unverified');
    }

    const record: SimulatedRecoveryRecord = {
      id: `rec-applied_${proposal.id}`,
      incidentId: proposal.incidentId,
      mechanismId: mechanism.id,
      proposal,
      authorization,
      approvalId: options.approvalId ?? null,
      appliedAt: now,
      outcome: 'applied',
      detail: `SIMULADO: paquete ${reference.name}@${reference.version} verificado por hash en memoria; ningún archivo se escribió en el host, no hubo red y no se ejecutó ningún script`,
      simulated: true,
    };
    this.appliedProposals.add(proposal.id);
    this.appliedIncidents.add(proposal.incidentId);
    return { kind: 'applied', record };
  }
}

/* -------------------------------------------------------------------------- */
/* Estado del servidor                                                        */
/* -------------------------------------------------------------------------- */

interface TaskEntry {
  record: TaskStateRecord;
  scope: TaskScope;
  environment: Environment;
  plan: AgentPlan | null;
  decision: PreflightDecision;
  manifest: PreflightManifest;
  preparation: PreparationReport;
  incidents: IncidentRecord[];
  diagnoses: Record<string, JudgeDiagnosis>;
  explanations: Record<string, string>;
  risks: RiskAssessment[];
  recoveries: RecoveryRecord[];
  createdAt: IsoTimestamp;
}

export interface ServerState {
  runtime: RuntimeBackend;
  tasks: Map<TaskId, TaskEntry>;
  order: TaskId[];
  audit: InMemoryAuditSink;
  approvals: InMemoryApprovalStore;
  gateway: MediatedGateway;
  agent: RepairAgent;
  judge: LocalJudge;
  lifeguard: LocalLifeguard;
  preflight: LocalPreflight;
  policyVersion: string;
  startedAt: IsoTimestamp;
  stepCounter: number;
  taskCounter: number;
  continuity: ContinuityService;
}

const DEFAULT_CAPABILITIES: readonly Capability[] = ['fs.read', 'fs.write', 'proc.exec', 'deploy.production'];
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface RuntimeBackend {
  readonly sandbox: SandboxPort;
  readonly execution: 'real' | 'simulated';
  readonly sandboxLimits: (() => Promise<SandboxLimitsReport | null>) | null;
  readonly image: string;
  readonly imageDigest: string;
  readonly note: string;
}

export function createServerState(backend?: RuntimeBackend): ServerState {
  const audit = new InMemoryAuditSink();
  const approvals = new InMemoryApprovalStore();
  const tasks = new Map<TaskId, TaskEntry>();
  const order: TaskId[] = [];
  const scopeFor = (taskId: TaskId): TaskScope =>
    tasks.get(taskId)?.scope ?? {
      taskId,
      allowedCapabilities: [...DEFAULT_CAPABILITIES],
      protectedPaths: ['/etc', '/proc', '/sys'],
      allowedHosts: ['registry.npmjs.org'],
      mayMutateProduction: false,
    };
  const plans = new Map<TaskId, AgentPlan>();
  const eventsFor = (_taskId: TaskId): readonly AuditEvent[] => [];
  const runtime: RuntimeBackend = backend ?? {
    sandbox: new UnavailableSandbox(),
    execution: 'simulated',
    sandboxLimits: null,
    image: 'oven/bun:1',
    imageDigest: 'local',
    note: 'sin sandbox verificado: simulation-only',
  };
  const gateway = createGateway({
    policy: new DeterministicPolicyEngine(),
    risk: new DeterministicRiskEngine(),
    sandbox: runtime.sandbox,
    execution: runtime.execution,
    sandboxImage: runtime.image,
    sandboxImageDigest: runtime.imageDigest,
    workspaceRoot: process.env.BOUNDARY_WORKSPACE_ROOT ?? '/var/lib/boundary/workspaces',
    ...(runtime.sandboxLimits ? { sandboxLimits: runtime.sandboxLimits } : {}),
    planFor: (taskId) => plans.get(taskId) ?? tasks.get(taskId)?.plan ?? null,
    eventsFor,
    approvalCheck: async (request: OperationRequest, approvalId: ApprovalId, now: IsoTimestamp) => {
      const grant = await approvals.find(approvalId);
      if (!grant) return false;
      if (grant.taskId !== request.taskId) return false;
      if (grant.fingerprint !== request.fingerprint) return false;
      if (grant.capability !== request.capability) return false;
      const consumed = await approvals.consume(approvalId, request.fingerprint, now);
      return consumed !== null;
    },
  });
  const agent = createAgent({ env: process.env });
  void plans;
  return {
    runtime,
    continuity: new ContinuityService({
      env: process.env,
      image: runtime.image,
      imageDigest: runtime.imageDigest,
      dockerHost: process.env.DOCKER_HOST,
      workspaceRoot: process.env.BOUNDARY_WORKSPACE_ROOT ?? '/var/lib/boundary/workspaces',
    }),
    tasks,
    order,
    audit,
    approvals,
    gateway,
    agent,
    judge: new LocalJudge(),
    lifeguard: new LocalLifeguard(),
    preflight: new LocalPreflight(scopeFor),
    policyVersion: POLICY_VERSION,
    startedAt: nowIso(),
    stepCounter: 0,
    taskCounter: 0,
  };
}

function latestTask(state: ServerState): TaskEntry | null {
  if (state.order.length === 0) return null;
  return state.tasks.get(state.order[state.order.length - 1]!) ?? null;
}

async function auditEvent(
  state: ServerState,
  taskId: TaskId,
  kind: AuditEvent['kind'],
  actor: AuditEvent['actor'],
  summary: string,
  detail: JsonObject,
): Promise<void> {
  await state.audit.append({ id: `evt_${sha256(`${taskId}|${summary}|${nowIso()}|${Math.random()}`).slice(0, 16)}`, taskId, at: nowIso(), kind, actor, summary, detail });
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

export interface StartOptions {
  port?: number;
  hostname?: string;
}

export interface StartedServer {
  url: string;
  port: number;
  hostname: string;
  close(): Promise<void>;
}

type Handler = (req: Request, params: Record<string, string>) => Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function readJson(req: Request): Promise<{ ok: true; value: JsonObject } | { ok: false; response: Response }> {
  const text = await req.text();
  if (text.length > SERVER_LIMITS.maxBodyBytes) {
    return { ok: false, response: json(413, { error: 'cuerpo demasiado grande', code: 'body_too_large' }) };
  }
  if (text.trim().length === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, response: json(400, { error: 'se esperaba un objeto JSON', code: 'bad_json' }) };
    }
    return { ok: true, value: parsed as JsonObject };
  } catch {
    return { ok: false, response: json(400, { error: 'JSON inválido', code: 'bad_json' }) };
  }
}

function str(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

export function buildRouter(state: ServerState): Handler {
  const rate = new Map<string, number[]>();

  async function checkRate(req: Request): Promise<Response | null> {
    const ip = (req.headers.get('x-forwarded-for') ?? 'local').split(',')[0]!.trim();
    const now = Date.now();
    const windowStart = now - 60_000;
    const hits = (rate.get(ip) ?? []).filter((t) => t > windowStart);
    hits.push(now);
    rate.set(ip, hits);
    if (hits.length > SERVER_LIMITS.requestsPerMinute) {
      return json(429, { error: 'límite de peticiones excedido', code: 'rate_limited' });
    }
    return null;
  }

  function taskScopeFromBody(taskId: TaskId, body: JsonObject): TaskScope {
    const allowedCapabilities = Array.isArray(body.capabilities)
      ? (body.capabilities as unknown[]).filter(
          (c): c is Capability =>
            typeof c === 'string' &&
            (['fs.read', 'fs.write', 'proc.exec', 'net.outbound', 'pkg.install', 'secrets.read', 'data.delete', 'deploy.staging', 'deploy.production', 'billing.write'] as readonly string[]).includes(c),
        )
      : [...DEFAULT_CAPABILITIES];
    const allowedHosts = Array.isArray(body.allowedHosts)
      ? (body.allowedHosts as unknown[]).filter((h): h is string => typeof h === 'string' && HOST_RE.test(h)).slice(0, 16)
      : ['registry.npmjs.org'];
    return {
      taskId,
      allowedCapabilities: allowedCapabilities.length > 0 ? allowedCapabilities : [...DEFAULT_CAPABILITIES],
      protectedPaths: ['/etc', '/proc', '/sys'],
      allowedHosts,
      // El MVP nunca autoriza mutación de producción en el alcance.
      mayMutateProduction: false,
    };
  }

  return async (req: Request, params: Record<string, string>): Promise<Response> => {
    const limited = await checkRate(req);
    if (limited) return limited;

          const continuityUrl = new URL(req.url);
      const continuityPath = continuityUrl.pathname;
      if (continuityPath === '/api/continuity/status' && req.method === 'GET') {
        const operatorKey = process.env.BOUNDARY_CONTINUITY_KEY ?? process.env.BOUNDARY_API_TOKEN ?? '';
        return json(200, {
          ...state.continuity.status(),
          enabled: process.env.BOUNDARY_ENABLE_CONTINUITY === '1' && operatorKey.length >= 16,
          operatorKeyRequired: true,
          deploymentVerified: false,
        });
      }
      if (continuityPath === '/api/continuity/tasks' && req.method === 'POST') {
        if (process.env.BOUNDARY_ENABLE_CONTINUITY !== '1') {
          return json(503, { code: 'continuity_disabled', error: 'ejecución supervisada deshabilitada por el operador' });
        }
        const expectedKey = process.env.BOUNDARY_CONTINUITY_KEY ?? process.env.BOUNDARY_API_TOKEN ?? '';
        if (expectedKey.length < 16) return json(503, { code: 'operator_key_missing', error: 'falta configurar una clave de operador de al menos 16 caracteres' });
        const suppliedKey = req.headers.get('x-continuity-key') ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        if (suppliedKey.length > 1024 || !timingSafeEqual(createHash('sha256').update(suppliedKey).digest(), createHash('sha256').update(expectedKey).digest())) {
          return json(401, { code: 'unauthorized', error: 'clave de operador requerida' });
        }
        const origin = req.headers.get('origin');
        if (origin !== null && origin !== continuityUrl.origin) return json(403, { code: 'origin_mismatch', error: 'origen distinto del servidor' });
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        if (Object.keys(parsed.value).length !== 0) return json(400, { code: 'fixed_task_only', error: 'esta demo sólo admite la tarea fija, sin comandos o rutas del cliente' });
        try {
          return json(202, { session: state.continuity.start() });
        } catch (error) {
          const busy = /busy|concurrent|running|activa|en curso/i.test(String((error as Error).message));
          return json(busy ? 409 : 503, { code: busy ? 'continuity_busy' : 'continuity_unavailable', error: busy ? 'ya hay una tarea en curso' : 'la tarea no pudo iniciarse; revisa la configuración del operador' });
        }
      }
      const continuityMatch = continuityPath.match(/^\/api\/continuity\/tasks\/([A-Za-z0-9_-]{1,100})$/);
      if (continuityMatch !== null && req.method === 'GET') {
        const session = state.continuity.get(continuityMatch[1]!);
        return session === null ? json(404, { code: 'session_not_found', error: 'sesión no encontrada' }) : json(200, { session });
      }

      // Puerta de autenticación: con BOUNDARY_API_TOKEN definido, toda operación
    // que crea o modifica estado exige el token. El panel sigue en sólo lectura.
    const apiToken = process.env.BOUNDARY_API_TOKEN ?? null;
    const isMutation = req.method.toUpperCase() !== 'GET';
    if (apiToken !== null && isMutation) {
      const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? req.headers.get('x-boundary-token') ?? '';
      if (provided !== apiToken) {
        return json(401, { error: 'token de demostración requerido', code: 'unauthorized' });
      }
    }

    // Tope de tareas simultáneas: evita que un tercero use la VM como ejecutor.
    const maxTasks = Number.parseInt(process.env.BOUNDARY_MAX_TASKS ?? '200', 10);
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    if (method === 'GET' && path === '/healthz') {
      return json(200, {
        ok: true,
        contractVersion: CONTRACT_VERSION,
        simulated: state.runtime.execution === 'simulated',
        sandboxAvailable: state.runtime.execution === 'real',
        sandboxNote: state.runtime.note,
        startedAt: state.startedAt,
      });
    }

    if (method === 'GET' && path === '/api/state') {
      const task = latestTask(state);
      const events = await state.audit.all();
      const approvals = task ? await state.approvals.describe(task.record.taskId, nowIso()) : [];
      return json(200, {
        contractVersion: CONTRACT_VERSION,
        generatedAt: nowIso(),
        simulated: state.runtime.execution === 'simulated',
        sandbox: {
          available: state.runtime.execution === 'real',
          enforced: state.runtime.execution === 'real',
          note: state.runtime.note,
        },
        ...(task
          ? {
              task: task.record,
              preflight: { decision: task.decision, manifest: task.manifest, preparation: task.preparation },
              controls: {
                policyVersion: state.policyVersion,
                scope: task.scope,
                criticalRules: CRITICAL_RULES,
              },
              incidents: task.incidents.map((incident) => ({
                ...incident,
                ...(task.diagnoses[incident.id] ? { diagnosis: task.diagnoses[incident.id] } : {}),
                ...(task.explanations[incident.id] ? { agentExplanation: task.explanations[incident.id] } : {}),
              })),
              risk: task.risks,
              recovery: task.recoveries,
              approvals,
              tests: [],
              events,
            }
          : {
              controls: { policyVersion: state.policyVersion, scope: null, criticalRules: CRITICAL_RULES },
              incidents: [],
              risk: [],
              recovery: [],
              approvals: [],
              tests: [],
              events,
            }),
      });
    }

    if (method === 'GET' && path === '/api/tasks') {
      return json(200, { tasks: [...state.tasks.values()].map((t) => t.record) });
    }

    if (method === 'POST' && path === '/api/tasks') {
      if (state.tasks.size >= (Number.isFinite(maxTasks) ? maxTasks : 200)) {
        return json(429, { error: 'límite de tareas alcanzado', code: 'task_limit' });
      }
      const parsed = await readJson(req);
      if (!parsed.ok) return parsed.response;
      const objective = str(parsed.value.objective, 500);
      if (!objective) return json(400, { error: 'objective requerido (1..500 caracteres)', code: 'bad_objective' });
      const declaredSteps = typeof parsed.value.declaredSteps === 'number' && Number.isFinite(parsed.value.declaredSteps)
        ? Math.max(0, Math.min(1000, Math.floor(parsed.value.declaredSteps)))
        : 5;
      const estimatedMinutes = typeof parsed.value.estimatedMinutes === 'number' && Number.isFinite(parsed.value.estimatedMinutes)
        ? Math.max(0, Math.min(10_000, Math.floor(parsed.value.estimatedMinutes)))
        : 5;
      const sensitiveResources = Array.isArray(parsed.value.sensitiveResources)
        ? (parsed.value.sensitiveResources as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 32)
        : [];
      const rawDeps = Array.isArray(parsed.value.declaredDependencies) ? parsed.value.declaredDependencies : [];
      const declaredDeps: DeclaredDependency[] = [];
      for (const raw of rawDeps.slice(0, 16)) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const dep = raw as Record<string, unknown>;
        if (typeof dep.name !== 'string' || typeof dep.version !== 'string' || typeof dep.sha256 !== 'string') continue;
        declaredDeps.push({ name: dep.name.slice(0, 128), version: dep.version.slice(0, 32), sha256: dep.sha256.slice(0, 64) });
      }

      state.taskCounter += 1;
      const taskId = `task_${Date.now().toString(36)}_${state.taskCounter}` as TaskId;
      let scope = taskScopeFromBody(taskId, parsed.value);
      const input: PreflightInput = {
        taskId,
        objective,
        declaredSteps,
        estimatedMinutes,
        sensitiveResources,
        environment: 'sandbox',
      };
      const decision = state.preflight.decide(input);
      const manifest = await state.preflight.plan(input);
      // Preparación: sólo dependencias declaradas válidas cuyo hash coincida
      // con el almacén preaprobado (sin red, sin E/S).
      const store = buildApprovedStore();
      const prepared = [];
      const failed: Array<{ name: string; reason: string }> = [];
      for (const dep of declaredDeps) {
        if (!isValidDeclaredDependency(dep)) {
          failed.push({ name: `${dep.name}@${dep.version}`, reason: 'nombre, versión o sha256 con formato inválido' });
          continue;
        }
        const key = `${dep.name}@${dep.version}`;
        const approved = store[key];
        if (!approved || approved.sha256.toLowerCase() !== dep.sha256.toLowerCase()) {
          failed.push({ name: key, reason: 'no está preaprobada con ese hash (sin red: no se descarga nada)' });
          continue;
        }
        prepared.push({ name: dep.name, version: dep.version, integrity: 'sha256-pinned' as const, source: 'approved-store' as const, preparedAt: nowIso() });
      }
      const fullManifest: PreflightManifest = { ...manifest, preparedDependencies: prepared };
      // Las dependencias declaradas + verificadas contra el almacén
      // preaprobado quedan como objetivos autorizados (registro + referencia
      // exacta). Sin esta precondición de alcance, `pkg.install` activaría
      // `network.unlisted-host` (terminal, sin recuperación posible).
      const extraHosts = prepared
        .map((item) => `${item.name}@${item.version}`.toLowerCase())
        .filter((ref) => !scope.allowedHosts.map((h) => h.toLowerCase()).includes(ref));
      if (extraHosts.length > 0) {
        scope = { ...scope, allowedHosts: [...scope.allowedHosts, ...extraHosts] };
      }
      const preparation: PreparationReport = { taskId, prepared, failed, finishedAt: nowIso() };

      // Plan del agente (offline, determinista, sin credenciales).
      const plan = await state.agent.plan({ id: taskId, objective, repoPath: `workspace/${taskId}` });

      const record: TaskStateRecord = {
        taskId,
        objective,
        status: 'running',
        pendingApprovals: [],
        independentWorkContinues: true,
        updatedAt: nowIso(),
      };
      state.tasks.set(taskId, {
        record,
        scope,
        environment: 'sandbox',
        plan,
        decision,
        manifest: fullManifest,
        preparation,
        incidents: [],
        diagnoses: {},
        explanations: {},
        risks: [],
        recoveries: [],
        createdAt: nowIso(),
      });
      state.order.push(taskId);
      await auditEvent(state, taskId, 'task.state', 'server', `tarea creada: ${objective}`, { objective });
      await auditEvent(state, taskId, 'preflight.manifest', 'preflight', 'manifiesto de preflight emitido (no concede privilegios)', {
        depth: decision.depth,
        prepared: prepared.length,
        failed: failed.length,
      });
      return json(201, { task: record, preflight: { decision, manifest: fullManifest, preparation }, plan });
    }

    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)(\/.*)?$/);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]!) as TaskId;
      const rest = taskMatch[2] ?? '';
      const entry = state.tasks.get(taskId);
      if (!entry) return json(404, { error: 'tarea no encontrada', code: 'task_not_found' });

      if (method === 'GET' && (rest === '' || rest === '/')) {
        return json(200, { task: entry.record, plan: entry.plan, manifest: entry.manifest });
      }
      if (method === 'GET' && rest === '/events') {
        return json(200, { events: await state.audit.list(taskId) });
      }
      if (method === 'POST' && rest === '/steps') {
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        const tool = str(parsed.value.tool, 128);
        if (!tool) return json(400, { error: 'tool requerida', code: 'bad_tool' });
        if (parsed.value.args === undefined || parsed.value.args === null || typeof parsed.value.args !== 'object' || Array.isArray(parsed.value.args)) {
          return json(400, { error: 'args debe ser un objeto', code: 'bad_args' });
        }
        const args = parsed.value.args as JsonObject;
        state.stepCounter += 1;
        const call: AgentToolCall = {
          taskId,
          planStepId: str(parsed.value.planStepId, 64) ?? `manual_${state.stepCounter}`,
          tool,
          args,
          declaredIntent: str(parsed.value.declaredIntent, 500) ?? '',
        };
        const approvalId = typeof parsed.value.approvalId === 'string' ? (parsed.value.approvalId as ApprovalId) : null;
        const now = nowIso();
        const ctx: GatewayContext = gatewayContext(entry.scope, entry.environment, now, state.policyVersion, approvalId);
        const request = state.gateway.classify(call, entry.scope, now);
        const outcome = await state.gateway.execute(request, ctx);
        entry.risks.push(state.gateway.evaluate(request, ctx).risk);
        await auditEvent(state, taskId, 'policy.decision', 'gateway', `decisión ${outcome.kind} para ${tool}`, {
          tool,
          kind: outcome.kind,
        });

        if (outcome.kind === 'allowed') {
          const real = state.runtime.execution === 'real';
            return json(200, {
            kind: 'allowed',
            executed: real,
            simulated: !real,
            result: outcome.result,
            verdict: outcome.verdict,
              note: real ? state.runtime.note : 'operación permitida pero NO ejecutada: sin sandbox verificado (simulation-only)',
            });
        }
        if (outcome.kind === 'approval_required') {
          await state.approvals.create(outcome.approval);
          entry.record = {
            ...entry.record,
            status: 'awaiting_approval',
            pendingApprovals: [...entry.record.pendingApprovals, outcome.approval.id],
            updatedAt: nowIso(),
          };
          await auditEvent(state, taskId, 'approval.requested', 'gateway', `aprobación solicitada: ${outcome.approval.id}`, {
            approvalId: outcome.approval.id,
          });
          return json(200, { kind: 'approval_required', approval: outcome.approval, independentWorkAllowed: true });
        }
        if (outcome.kind === 'blocked_terminal') {
          const incident: IncidentRecord = {
            id: `inc_${taskId}_${entry.incidents.length + 1}`,
            taskId,
            request,
            verdict: outcome.verdict,
            restriction: {
              kind: 'policy_denied',
              detail: `prohibición crítica: ${outcome.criticalRules.join(', ')} (terminal: sin aprobación ni recuperación posibles)`,
            },
            evidence: {
              taskObjective: entry.record.objective,
              plan: entry.plan,
              attemptedOperation: request,
              policyVerdict: outcome.verdict,
              sandboxLog: [],
              agentExplanation: null,
              priorEvents: await state.audit.list(taskId),
            },
            status: 'blocked',
            recoverable: false,
            openedAt: now,
          };
          entry.incidents.push(incident);
          entry.record = { ...entry.record, status: 'blocked', updatedAt: nowIso() };
          await auditEvent(state, taskId, 'gateway.blocked', 'gateway', `bloqueo terminal: ${outcome.criticalRules.join(', ')}`, {
            criticalRules: [...outcome.criticalRules],
          });
          const explanation = await state.agent.explain(incident);
          entry.explanations[incident.id] = explanation;
          const diagnosis = await state.judge.diagnose({ incident, evidence: { ...incident.evidence, agentExplanation: explanation } });
          entry.diagnoses[incident.id] = diagnosis;
          await auditEvent(state, taskId, 'judge.diagnosis', 'judge', `diagnóstico ${diagnosis.verdict} (sólo evidencia, sin autoridad)`, {
            verdict: diagnosis.verdict,
          });
          return json(200, {
            kind: 'blocked_terminal',
            criticalRules: outcome.criticalRules,
            incident,
            diagnosis,
            recoverable: false,
          });
        }

        // denied (no terminal): diagnosticar y, sólo para pkg.install sin
        // violaciones críticas, intentar recuperación autorizada y simulada.
        // El gateway en este cableado nunca devuelve `recovered`; se trata
        // defensivamente para no afirmar un caso imposible.
        if (outcome.kind !== 'denied') {
          return json(500, { error: 'resultado inesperado del gateway', code: 'unexpected_outcome' });
        }
        const incident = outcome.incident;
        entry.incidents.push(incident);
        await auditEvent(state, taskId, 'incident.opened', 'gateway', `incidente ${incident.id} (${incident.restriction.kind})`, {
          incidentId: incident.id,
        });
        const explanation = await state.agent.explain(incident);
        entry.explanations[incident.id] = explanation;
        const diagnosis = await state.judge.diagnose({ incident, evidence: { ...incident.evidence, agentExplanation: explanation } });
        entry.diagnoses[incident.id] = diagnosis;
        await auditEvent(state, taskId, 'judge.diagnosis', 'judge', `diagnóstico ${diagnosis.verdict} (sólo evidencia, sin autoridad)`, {
          verdict: diagnosis.verdict,
        });

        if (outcome.recoverable && request.tool === 'pkg.install') {
          const proposed = await state.lifeguard.propose(incident, entry.scope);
          if (proposed.kind === 'proposed') {
            const auth = authorizeRecovery({
              request,
              proposal: proposed.proposal,
              scope: entry.scope,
              policy: new DeterministicPolicyEngine(),
              risk: new DeterministicRiskEngine(),
              now,
              approvalUsable: false,
              simulated: true,
              limitsReport: null,
            });
            if (auth.authorized) {
              const applied = await state.lifeguard.apply(proposed.proposal, auth.verdict, {
                approvalId: null,
                approvalUsable: false,
                now,
              });
              if (applied.kind === 'applied') {
                entry.recoveries.push(applied.record);
                await auditEvent(state, taskId, 'recovery.applied', 'lifeguard', `recuperación simulada: ${applied.record.detail}`, {
                  recoveryId: applied.record.id,
                  simulated: true,
                });
                return json(200, {
                  kind: 'recovered',
                  incident,
                  diagnosis,
                  recovery: applied.record,
                  executed: false,
                  simulated: true,
                  result: {
                    exitCode: 0,
                    stdout: '',
                    stderr: 'recuperación simulada: paquete verificado en memoria, sin escritura en el host',
                    timedOut: false,
                    killedReason: 'simulation-only',
                    durationMs: 0,
                  },
                });
              }
              // La puerta de autorización pasó, pero el Lifeguard rechazó la
              // aplicación (efecto, caducidad, repetición o integridad): no se
              // registra recuperación alguna.
              const applyReasons = applied.kind === 'rejected' || applied.kind === 'none_available' ? applied.reasons : [];
              await auditEvent(state, taskId, 'recovery.rejected', 'lifeguard', `recuperación NO aplicada: ${applyReasons.join(', ')}`, {
                blockers: [...applyReasons],
                simulated: true,
              });
              return json(200, {
                kind: 'denied',
                incident,
                diagnosis,
                recoveryBlockers: applyReasons,
                recoverable: outcome.recoverable,
                simulated: true,
                executed: false,
              });
            }
            await auditEvent(state, taskId, 'recovery.rejected', 'lifeguard', `recuperación no autorizada: ${auth.blockers.join(', ')}`, {
              blockers: [...auth.blockers],
            });
            return json(200, { kind: 'denied', incident, diagnosis, recoveryBlockers: auth.blockers, recoverable: outcome.recoverable });
          }
        }
        return json(200, { kind: 'denied', incident, diagnosis, recoverable: outcome.recoverable });
      }
    }

    if (path === '/api/approvals' && method === 'GET') {
      const taskId = url.searchParams.get('taskId') as TaskId | null;
      const task = taskId ? state.tasks.get(taskId) : latestTask(state);
      if (!task) return json(200, { approvals: [] });
      return json(200, { approvals: await state.approvals.describe(task.record.taskId, nowIso()) });
    }

    if (path === '/api/approvals' && method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed.ok) return parsed.response;
      const taskId = str(parsed.value.taskId, 128) as TaskId | null;
      const fingerprint = str(parsed.value.fingerprint, 256);
      const capability = str(parsed.value.capability, 64) as Capability | null;
      if (!taskId || !state.tasks.get(taskId)) return json(404, { error: 'tarea no encontrada', code: 'task_not_found' });
      if (!fingerprint || !capability) return json(400, { error: 'fingerprint y capability requeridos', code: 'bad_approval' });
      const criticalRules = Array.isArray(parsed.value.criticalRules)
        ? (parsed.value.criticalRules as unknown[]).filter((r): r is string => typeof r === 'string')
        : [];
      const effect = (parsed.value.effect as unknown as EffectSignature | undefined) ?? {
        kinds: [],
        targets: [],
        environment: 'sandbox',
        irreversible: false,
        externalImpact: false,
      };
      const now = nowIso();
      const request: ApprovalRequest = {
        id: `apr_manual_${sha256(`${taskId}|${fingerprint}|${now}`).slice(0, 16)}`,
        taskId,
        incidentId: null,
        fingerprint,
        capability,
        effect,
        reason: str(parsed.value.reason, 500) ?? 'solicitud manual del operador local',
        requestedAt: now,
        expiresAt: new Date(Date.parse(now) + SERVER_LIMITS.approvalTtlMs).toISOString(),
        criticalRules: criticalRules as ApprovalRequest['criticalRules'],
      };
      if (!isApprovable(request)) {
        return json(422, { error: 'la solicitud tiene reglas críticas y jamás puede concederse', code: 'critical_not_approvable' });
      }
      await state.approvals.create(request);
      await auditEvent(state, taskId, 'approval.requested', 'human', `aprobación manual solicitada: ${request.id}`, { approvalId: request.id });
      return json(201, { approval: request });
    }

    const grantMatch = path.match(/^\/api\/approvals\/([^/]+)\/(grant|deny)$/);
    if (grantMatch && method === 'POST') {
      const id = decodeURIComponent(grantMatch[1]!) as ApprovalId;
      const action = grantMatch[2]!;
      if (action === 'deny') {
        try {
          await state.approvals.deny(id);
        } catch (error) {
          return json(404, { error: error instanceof Error ? error.message : 'no encontrada', code: 'not_found' });
        }
        return json(200, { id, status: 'denied' });
      }
      const parsed = await readJson(req);
      if (!parsed.ok) return parsed.response;
      const now = nowIso();
      // Una aprobación no puede nacer caducada ni sobrevivir al TTL del
      // servidor: `expiresAt` se valida y se acota, nunca se acepta tal cual.
      const maxExpiry = approvalExpiryFrom(now, SERVER_LIMITS.approvalTtlMs);
      const requestedExpiry = typeof parsed.value.expiresAt === 'string' ? parsed.value.expiresAt : maxExpiry;
      const requestedMs = Date.parse(requestedExpiry);
      const nowMs = Date.parse(now);
      if (!Number.isFinite(requestedMs) || !Number.isFinite(nowMs) || requestedMs <= nowMs) {
        return json(400, {
          error: 'expiresAt inválido o ya caducado: una aprobación no puede concederse vencida',
          code: 'bad_expiry',
        });
      }
      const expiresAt = new Date(Math.min(requestedMs, Date.parse(maxExpiry))).toISOString();
      try {
        const grant = await state.approvals.grant(id, now, expiresAt);
        await auditEvent(state, grant.taskId, 'approval.decided', 'human', `aprobación concedida (un solo uso): ${id}`, { approvalId: id });
        const entry = state.tasks.get(grant.taskId);
        if (entry) {
          entry.record = {
            ...entry.record,
            status: 'running',
            pendingApprovals: entry.record.pendingApprovals.filter((pending) => pending !== id),
            updatedAt: nowIso(),
          };
        }
        return json(200, { grant });
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'grant_failed';
        const status = code === 'critical_not_grantable' ? 422 : 409;
        return json(status, { error: error instanceof Error ? error.message : 'no se pudo conceder', code });
      }
    }

    // Archivos estáticos del panel (sólo lectura, mismo origen local).
    // Allowlist explícita: cada ruta estática se declara aquí. No hay comodines,
    // así que un fichero nuevo no queda servido por accidente.
    const STATIC_ROUTES: Record<string, string> = {
      '/': 'index.html',
      '/index.html': 'index.html',
      '/app.js': 'app.js',
      '/style.css': 'style.css',
      '/bench.html': 'bench.html',
      '/bench.js': 'bench.js',
      '/design.css': 'design.css',
      '/bench/sprint-report.json': 'bench/sprint-report.json',
    };
    if (method === 'GET' && Object.prototype.hasOwnProperty.call(STATIC_ROUTES, path)) {
      const file = STATIC_ROUTES[path] as string;
      const contentType = file.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : file.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : file.endsWith('.json')
            ? 'application/json; charset=utf-8'
            : 'text/html; charset=utf-8';
      try {
        const body = await Bun.file(new URL(`../web/${file}`, import.meta.url)).text();
        return new Response(body, { status: 200, headers: { 'content-type': contentType, 'cache-control': 'no-store' } });
      } catch {
        return json(404, { error: 'panel no encontrado', code: 'no_panel' });
      }
    }

    return json(404, { error: 'ruta no encontrada', code: 'not_found' });
  };
}

/**
 * Elige el backend de ejecución: si `probeDockerRuntime()` verifica límites
 * reales, se ejecuta de verdad; si no, el gateway queda en `simulation-only`.
 * Nunca se declara real lo que no se pudo verificar.
 */
export async function resolveBackend(): Promise<RuntimeBackend> {
  if (process.env.BOUNDARY_SANDBOX === 'simulated') {
    return {
      sandbox: new UnavailableSandbox(),
      execution: 'simulated',
      sandboxLimits: null,
      image: 'oven/bun:1',
      imageDigest: 'local',
      note: 'forzado a simulación por BOUNDARY_SANDBOX=simulated',
    };
  }
  const probe = await probeDockerRuntime();
  if (!probe.ok || !probe.sandbox || !probe.report) {
    return {
      sandbox: new UnavailableSandbox(),
      execution: 'simulated',
      sandboxLimits: null,
      image: 'oven/bun:1',
      imageDigest: 'local',
      note: `sandbox no verificado: ${probe.reason}` ,
    };
  }
  const verified = probe.report;
  return {
    sandbox: probe.sandbox,
    execution: 'real',
    sandboxLimits: () => Promise.resolve(verified),
    image: process.env.BOUNDARY_SANDBOX_IMAGE ?? 'oven/bun:1',
    imageDigest: process.env.BOUNDARY_SANDBOX_DIGEST ?? 'local',
    note: `sandbox real: cgroup ${verified.cgroupVersion}, rootless=${verified.rootless}, mem=${verified.measured.memoryMb}MB, pids=${verified.measured.pids}` ,
  };
}

export async function startServer(options: StartOptions = {}, existing?: ServerState): Promise<StartedServer> {
  const hostname = options.hostname ?? '127.0.0.1';
  if (!isLoopback(hostname)) {
    throw new Error(`el servidor MVP sólo escucha en loopback; hostname rechazado: ${hostname}`);
  }
  const state = existing ?? createServerState(await resolveBackend());
  const handler = buildRouter(state);
  const server = Bun.serve({
    port: options.port ?? 3000,
    hostname,
    fetch: (req) => handler(req, {}),
  });
  const port = server.port ?? options.port ?? 3000;
  return {
    url: `http://${hostname}:${port}`,
    port,
    hostname,
    close: async () => {
      server.stop(true);
    },
  };
}

// Arranque directo: `bun run src/server.ts`.
if (import.meta.main) {
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const started = await startServer({ port: Number.isFinite(port) ? port : 3000 });
  const runtime = await resolveBackend();
  console.log(
    `BOUNDARY en ${started.url} · sandbox=${runtime.execution} · imagen=${runtime.image} · continuidad=${
      process.env.BOUNDARY_ENABLE_CONTINUITY === '1' ? 'habilitada' : 'deshabilitada'
    }`,
  );
}
