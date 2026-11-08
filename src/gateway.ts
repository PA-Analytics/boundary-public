/**
 * Gateway — punto único de mediación entre el agente y el sandbox.
 *
 * Flujo obligatorio de cada llamada:
 *   1. `classify` (entrada no confiable → operación normalizada, capacidad y efecto).
 *   2. Reglas críticas y política determinista (`evaluate`, en `src/policy.ts`).
 *   3. Sólo si la decisión es `allow` (o hay aprobación humana vigente) se
 *      intenta ejecutar, y sólo dentro de un sandbox con límites verificados.
 *
 * Modos de ejecución:
 *   - `simulated` (por defecto en local): no hay sandbox disponible, así que NO
 *     se ejecuta nada. Se devuelve un resultado marcado `simulation-only` y el
 *     servidor lo audita como `executed:false`. No se afirma contención.
 *   - `real`: exige un `SandboxPort` con límites verificados (cgroup v2,
 *     rootless, `enforced`). Si no los hay, lanza `SandboxUnavailableError`:
 *     fallo cerrado, nunca ejecución parcial sin barreras.
 */

import {
  SERVER_LIMITS,
  isSandboxUsable,
  isTerminalDenial,
  nowIso,
  resolvePolicyDecision,
  type AgentPlan,
  type AgentToolCall,
  type ApprovalId,
  type ApprovalRequest,
  type AuditEvent,
  type Capability,
  type CriticalRuleId,
  type Environment,
  type GatewayContext,
  type GatewayOutcome,
  type GatewayPort,
  type IncidentRecord,
  type IsoTimestamp,
  type JsonObject,
  type OperationRequest,
  type PolicyPort,
  type PolicyVerdict,
  type RiskPort,
  type SandboxExec,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxLimitsReport,
  type SandboxPort,
  type SandboxResult,
  type SandboxSpec,
  type TaskScope,
} from './contracts.ts';
import {
  POLICY_VERSION,
  DeterministicRiskEngine,
  approvalRequestId,
  classifyToolCall,
  criticalViolationsFor,
} from './policy.ts';

export const SIMULATED_KILLED_REASON = 'simulation-only';

export class SandboxUnavailableError extends Error {
  readonly code = 'sandbox_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

const DEFAULT_LIMITS: SandboxLimits = {
  cpus: 1,
  memoryMb: 512,
  pids: 64,
  wallClockMs: 30_000,
  diskMb: 256,
};

/** Comprueba (y normalmente consume) una aprobación humana de un solo uso. */
export type ApprovalCheck = (
  request: OperationRequest,
  approvalId: ApprovalId,
  now: IsoTimestamp,
) => Promise<boolean>;

/**
 * Sandbox no disponible: todo falla cerrado. Existe para que el MVP local
 * nunca simule un aislamiento que no ha verificado.
 */
export class UnavailableSandbox implements SandboxPort {
  async prepare(_spec: SandboxSpec): Promise<SandboxHandle> {
    throw new SandboxUnavailableError('sandbox real no configurado en este entorno');
  }
  async verifyLimits(handle: SandboxHandle): Promise<SandboxLimitsReport> {
    return {
      cgroupVersion: 'none',
      rootless: false,
      enforced: false,
      violations: ['no cgroup v2 rootless verificado', `handle ${handle.id} no preparado`],
      measured: DEFAULT_LIMITS,
      checkedAt: nowIso(),
    };
  }
  async exec(_handle: SandboxHandle, _exec: SandboxExec): Promise<SandboxResult> {
    throw new SandboxUnavailableError('ejecución denegada: sandbox real no disponible');
  }
  async dispose(_handle: SandboxHandle): Promise<void> {
    /* nada que liberar */
  }
}

export interface GatewayOptions {
  readonly policy: PolicyPort;
  readonly risk?: RiskPort;
  readonly sandbox: SandboxPort;
  /** `simulated` no ejecuta nada; `real` exige límites verificados. */
  readonly execution?: 'simulated' | 'real';
  readonly now?: () => IsoTimestamp;
  readonly approvalTtlMs?: number;
  readonly sandboxImage?: string;
  /** Raíz en el host donde vive el workspace escribible de cada tarea. */
  readonly workspaceRoot?: string;
  readonly sandboxImageDigest?: string;
  readonly objectiveFor?: (taskId: string) => string;
  readonly planFor?: (taskId: string) => AgentPlan | null;
  readonly eventsFor?: (taskId: string) => readonly AuditEvent[];
  readonly approvalCheck?: ApprovalCheck;
  readonly sandboxLimits?: () => Promise<SandboxLimitsReport | null>;
  readonly newIncidentId?: () => string;
}

function simulatedResult(): SandboxResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: 'simulado: sin ejecución real (sandbox no disponible en este entorno)',
    timedOut: false,
    killedReason: SIMULATED_KILLED_REASON,
    durationMs: 0,
  };
}

export class MediatedGateway implements GatewayPort {
  private readonly policy: PolicyPort;
  private readonly risk: RiskPort;
  private readonly sandbox: SandboxPort;
  private readonly execution: 'simulated' | 'real';
  private readonly clock: () => IsoTimestamp;
  private readonly approvalTtlMs: number;
  private readonly sandboxImage: string;
  private readonly sandboxImageDigest: string;
  private readonly objectiveFor: (taskId: string) => string;
  private readonly planFor: (taskId: string) => AgentPlan | null;
  private readonly eventsFor: (taskId: string) => readonly AuditEvent[];
  private readonly approvalCheck: ApprovalCheck | null;
  private readonly sandboxLimits: (() => Promise<SandboxLimitsReport | null>) | null;
  private readonly workspaceRoot: string | null;
  private readonly newIncidentId: () => string;
  private incidentCounter = 0;

  constructor(options: GatewayOptions) {
    this.policy = options.policy;
    this.risk = options.risk ?? new DeterministicRiskEngine();
    this.sandbox = options.sandbox;
    this.execution = options.execution ?? 'simulated';
    this.clock = options.now ?? nowIso;
    this.approvalTtlMs = options.approvalTtlMs ?? SERVER_LIMITS.approvalTtlMs;
    this.sandboxImage = options.sandboxImage ?? 'boundary/fixture-sandbox';
    this.sandboxImageDigest = options.sandboxImageDigest ?? 'sha256:unverified';
    this.objectiveFor = options.objectiveFor ?? (() => 'objetivo no registrado');
    this.planFor = options.planFor ?? (() => null);
    this.eventsFor = options.eventsFor ?? (() => []);
    this.approvalCheck = options.approvalCheck ?? null;
    this.sandboxLimits = options.sandboxLimits ?? null;
    this.workspaceRoot = options.workspaceRoot ?? null;
    this.newIncidentId = options.newIncidentId ?? (() => `inc_${++this.incidentCounter}`);
  }

  get mode(): 'simulated' | 'real' {
    return this.execution;
  }

  classify(call: AgentToolCall, scope: TaskScope, now: IsoTimestamp): OperationRequest {
    return classifyToolCall(call, scope, now);
  }

  evaluate(request: OperationRequest, ctx: GatewayContext): PolicyVerdict {
    const risk = this.risk.assess(request, ctx.scope, ctx.environment);
    return this.policy.evaluate({
      request,
      scope: ctx.scope,
      environment: ctx.environment,
      risk,
      policyVersion: ctx.policyVersion || this.policy.version || POLICY_VERSION,
      now: ctx.now,
    });
  }

  async execute(request: OperationRequest, ctx: GatewayContext): Promise<GatewayOutcome> {
    const verdict = this.evaluate(request, ctx);

    const critical: readonly CriticalRuleId[] = verdict.criticalViolations;
    if (critical.length > 0) {
      return { kind: 'blocked_terminal', request, verdict, criticalRules: critical };
    }

    const decision = resolvePolicyDecision(verdict);

    if (decision === 'deny') {
      const incident = this.buildIncident(request, verdict, ctx, {
        kind: 'policy_denied',
        detail: verdict.reasons.map((reason) => `${reason.code}: ${reason.detail}`).join(' | '),
      });
      return { kind: 'denied', request, verdict, incident, recoverable: !isTerminalDenial(verdict) };
    }

    if (decision === 'require_approval') {
      const approvalId = ctx.approvalId ?? null;
      if (approvalId !== null && this.approvalCheck) {
        const usable = await this.approvalCheck(request, approvalId, ctx.now);
        if (usable) {
          return { kind: 'allowed', request, verdict, result: await this.run(request) };
        }
      }
      return {
        kind: 'approval_required',
        request,
        verdict,
        approval: this.buildApprovalRequest(request, verdict),
        independentWorkAllowed: true,
      };
    }

    return { kind: 'allowed', request, verdict, result: await this.run(request) };
  }

  /** Ejecuta (o declara simulado) sólo tras una decisión favorable. */
  private async run(request: OperationRequest): Promise<SandboxResult> {
    if (this.execution === 'simulated') return simulatedResult();

    const limits = this.sandboxLimits ? await this.sandboxLimits() : null;
    // `isSandboxUsable` devuelve boolean (no es un type guard): estrechamos el
    // `null` explícitamente para poder leer `limits.measured` sin afirmar tipos.
    if (limits === null || !isSandboxUsable(limits)) {
      throw new SandboxUnavailableError(
        'ejecución real denegada: límites del sandbox no verificados (cgroup v2, rootless, enforced)',
      );
    }

    const spec: SandboxSpec = {
      taskId: request.taskId,
      image: this.sandboxImage,
      imageDigest: this.sandboxImageDigest,
      rootless: true,
      limits: limits.measured,
      network: 'none',
      mounts: this.workspaceRoot
        ? [{ hostPath: `${this.workspaceRoot}/${request.taskId}`, sandboxPath: '/workspace', mode: 'rw' as const }]
        : [],
      secretsAllowed: false,
    };
    const handle = await this.sandbox.prepare(spec);
    try {
      return await this.sandbox.exec(handle, {
        tool: request.tool,
        args: request.args,
        timeoutMs: spec.limits.wallClockMs,
        network: 'none',
      });
    } finally {
      await this.sandbox.dispose(handle);
    }
  }

  private buildIncident(
    request: OperationRequest,
    verdict: PolicyVerdict,
    ctx: GatewayContext,
    restriction: IncidentRecord['restriction'],
  ): IncidentRecord {
    return {
      id: this.newIncidentId(),
      taskId: request.taskId,
      request,
      verdict,
      restriction,
      evidence: {
        taskObjective: this.objectiveFor(request.taskId),
        plan: this.planFor(request.taskId),
        attemptedOperation: request,
        policyVerdict: verdict,
        sandboxLog: [],
        agentExplanation: null,
        priorEvents: this.eventsFor(request.taskId),
      },
      status: verdict.criticalViolations.length > 0 ? 'blocked' : 'open',
      recoverable: verdict.criticalViolations.length === 0,
      openedAt: ctx.now,
    };
  }

  private buildApprovalRequest(request: OperationRequest, verdict: PolicyVerdict): ApprovalRequest {
    const now = this.clock();
    return {
      id: approvalRequestId('apr', request.fingerprint),
      taskId: request.taskId,
      incidentId: null,
      fingerprint: request.fingerprint,
      capability: request.capability as Capability,
      effect: request.effect,
      reason: verdict.reasons.map((reason) => `${reason.code}: ${reason.detail}`).join(' | '),
      requestedAt: now,
      expiresAt: new Date(Date.parse(now) + this.approvalTtlMs).toISOString(),
      criticalRules: verdict.criticalViolations,
    };
  }
}

export function createGateway(options: GatewayOptions): MediatedGateway {
  return new MediatedGateway(options);
}

/** Construye un contexto de gateway para una tarea concreta. */
export function gatewayContext(
  scope: TaskScope,
  environment: Environment,
  now: IsoTimestamp,
  policyVersion: string = POLICY_VERSION,
  approvalId: ApprovalId | null = null,
): GatewayContext {
  return { scope, environment, now, policyVersion, approvalId };
}

export function describeRequest(request: OperationRequest): JsonObject {
  return {
    tool: request.tool,
    capability: request.capability,
    effect: {
      kinds: [...request.effect.kinds],
      targets: [...request.effect.targets],
      environment: request.effect.environment,
      irreversible: request.effect.irreversible,
      externalImpact: request.effect.externalImpact,
    },
    fingerprint: request.fingerprint,
    planStepId: request.planStepId,
  };
}

export { criticalViolationsFor };
