/**
 * BOUNDARY / Lifeguard — contratos estables compartidos.
 *
 * Este archivo es la única fuente de verdad de tipos entre módulos.
 * No implementa ningún componente: solo tipos, puertos e invariantes puras
 * que todos los módulos deben respetar.
 *
 * Invariantes críticas (no negociables, por encima del score):
 *  1. Las prohibiciones críticas se evalúan ANTES del score y nunca pueden
 *     ser levantadas por una puntuación, una aprobación humana ni el Judge.
 *  2. El Judge no tiene autoridad, no concede permisos y no bloquea el flujo.
 *  3. Una recuperación sólo se aplica si el mecanismo Y su efecto están
 *     autorizados; no se permite eludir un efecto prohibido por otra vía.
 *  4. El sandbox falla cerrado si sus límites no están verificados.
 *  5. Una aprobación es humana, de un solo uso, con alcance y expiración.
 *
 * Convenciones:
 *  - Todos los timestamps son ISO-8601 UTC (`new Date().toISOString()`).
 *  - Todo lo que produce el agente es NO confiable: el efecto de una operación
 *    lo calcula el gateway (`OperationRequest.computedBy === 'gateway'`).
 *  - Ningún puerto acepta comandos arbitrarios del host: solo tool + args.
 */

export const CONTRACT_VERSION = '1.0.0';

/* -------------------------------------------------------------------------- */
/* 1. Primitivos                                                              */
/* -------------------------------------------------------------------------- */

export type TaskId = string;
export type IncidentId = string;
export type ApprovalId = string;
export type RecoveryId = string;
export type IsoTimestamp = string;

/** Identifica de forma estable una operación concreta (para aprobaciones). */
export type OperationFingerprint = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export type Environment = 'sandbox' | 'staging' | 'production';

/** Capacidades que un agente puede ejercer. La política concede subconjuntos. */
export type Capability =
  | 'fs.read'
  | 'fs.write'
  | 'proc.exec'
  | 'net.outbound'
  | 'pkg.install'
  | 'secrets.read'
  | 'data.delete'
  | 'deploy.staging'
  | 'deploy.production'
  | 'billing.write';

export const CAPABILITIES: readonly Capability[] = [
  'fs.read',
  'fs.write',
  'proc.exec',
  'net.outbound',
  'pkg.install',
  'secrets.read',
  'data.delete',
  'deploy.staging',
  'deploy.production',
  'billing.write',
];

/** Clase de efecto final. Se evalúa el efecto, no sólo el procedimiento. */
export type EffectKind =
  | 'read'
  | 'write'
  | 'execute'
  | 'network.egress'
  | 'package.install'
  | 'secret.access'
  | 'data.destroy'
  | 'deploy'
  | 'payment';

/**
 * Firma técnica del efecto de una operación.
 * La calcula el gateway a partir de tool + args; el agente nunca la declara.
 */
export interface EffectSignature {
  readonly kinds: readonly EffectKind[];
  /** Recursos concretos afectados (rutas normalizadas, hosts, tablas...). */
  readonly targets: readonly string[];
  readonly environment: Environment;
  readonly irreversible: boolean;
  readonly externalImpact: boolean;
}

/* -------------------------------------------------------------------------- */
/* 2. Llamada del agente y operación normalizada                              */
/* -------------------------------------------------------------------------- */

/** Lo que el agente puede pedir. Todo es no confiable y no incluye efecto. */
export interface AgentToolCall {
  readonly taskId: TaskId;
  readonly planStepId: string;
  readonly tool: string;
  readonly args: JsonObject;
  /** Explicación declarativa del agente. Es evidencia, no autorización. */
  readonly declaredIntent: string;
}

/** Operación ya normalizada por el gateway: capacidad y efecto calculados. */
export interface OperationRequest {
  readonly id: string;
  readonly taskId: TaskId;
  readonly planStepId: string;
  readonly tool: string;
  readonly args: JsonObject;
  readonly declaredIntent: string;
  readonly capability: Capability;
  readonly effect: EffectSignature;
  readonly fingerprint: OperationFingerprint;
  readonly requestedAt: IsoTimestamp;
  /** Literal: sólo el gateway puede construir una operación. */
  readonly computedBy: 'gateway';
}

/* -------------------------------------------------------------------------- */
/* 3. Reglas críticas y política determinista                                 */
/* -------------------------------------------------------------------------- */

/**
 * Prohibiciones absolutas. Se evalúan antes que cualquier score y no admiten
 * recuperación, aprobación ni diagnóstico favorable.
 */
export type CriticalRuleId =
  | 'sandbox.escape'
  | 'sandbox.host-mount'
  | 'secrets.unauthorized'
  | 'policy.self-modify'
  | 'judge.grant'
  | 'production.unapproved'
  | 'data.irreversible-delete'
  | 'network.unlisted-host'
  | 'proc.privileged'
  | 'policy.protected-path';

export interface CriticalRuleDefinition {
  readonly id: CriticalRuleId;
  readonly description: string;
  /** Una violación crítica nunca es recuperable. */
  readonly unrecoverable: true;
  /** Ninguna aprobación humana puede levantarla. */
  readonly approvable: false;
}

export const CRITICAL_RULES: readonly CriticalRuleDefinition[] = [
  {
    id: 'sandbox.escape',
    description: 'Cualquier intento de salir del sandbox o alcanzar el host.',
    unrecoverable: true,
    approvable: false,
  },
  {
    id: 'sandbox.host-mount',
    description: 'Montar rutas del host dentro del sandbox.',
    unrecoverable: true,
    approvable: false,
  },
  {
    id: 'secrets.unauthorized',
    description: 'Leer o transmitir secretos fuera del alcance autorizado.',
    unrecoverable: true,
    approvable: false,
  },
  {
    id: 'policy.self-modify',
    description: 'Que el agente modifique su propia política o sus límites.',
    unrecoverable: true,
    approvable: false,
  },
  {
    id: 'judge.grant',
    description: 'Usar un diagnóstico del Judge como autorización.',
    unrecoverable: true,
    approvable: false,
  },
  {
    id: 'production.unapproved',
    description: 'Tocar producción sin aprobación humana específica y vigente.',
    unrecoverable: true,
    approvable: false,
  },
  {
    id: 'data.irreversible-delete',
    description: 'Borrado irreversible de datos reales.',
    unrecoverable: true,
    approvable: false,
  },
  {
    id: 'network.unlisted-host',
    description: 'Salida de red hacia un host fuera de la lista autorizada.',
    unrecoverable: true,
    approvable: false,
  },
  {
    id: 'proc.privileged',
    description: 'Ejecutar procesos privilegiados o escalar privilegios.',
    unrecoverable: true,
    approvable: false,
  },
  {
    id: 'policy.protected-path',
    description: 'Escribir, ejecutar o destruir sobre una ruta protegida del alcance de la tarea.',
    unrecoverable: true,
    approvable: false,
  },
];

export function isCriticalRule(id: string): id is CriticalRuleId {
  return CRITICAL_RULES.some((rule) => rule.id === id);
}

/** Alcance autorizado de una tarea. Lo emite el preflight / operador. */
export interface TaskScope {
  readonly taskId: TaskId;
  readonly allowedCapabilities: readonly Capability[];
  readonly protectedPaths: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly mayMutateProduction: boolean;
}

/* ------------------------------- Riesgo ----------------------------------- */

export type RiskBand = 'auto' | 'controlled' | 'approval';

export interface RiskFactor {
  readonly id: string;
  readonly weight: number;
  readonly note: string;
}

/** Score determinista 0..100. Nunca sustituye a las reglas críticas. */
export interface RiskAssessment {
  readonly score: number;
  readonly band: RiskBand;
  readonly factors: readonly RiskFactor[];
  readonly threshold: number;
  /** Los umbrales no están calibrados: nunca presentarlos como validados. */
  readonly provisional: true;
}

export const DEFAULT_APPROVAL_THRESHOLD = 65;
export const AUTO_MAX_SCORE = 34;
export const CONTROLLED_MAX_SCORE = 64;

export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 100;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function riskBand(score: number, threshold: number = DEFAULT_APPROVAL_THRESHOLD): RiskBand {
  const value = clampScore(score);
  if (value >= threshold) return 'approval';
  if (value > AUTO_MAX_SCORE) return 'controlled';
  return 'auto';
}

/* ------------------------------- Veredicto -------------------------------- */

export type PolicyDecision = 'allow' | 'deny' | 'require_approval';

export interface PolicyReason {
  readonly code: string;
  readonly detail: string;
}

export interface PolicyVerdict {
  /** Decisión tal como la calcula la política. */
  readonly decision: PolicyDecision;
  readonly criticalViolations: readonly CriticalRuleId[];
  readonly risk: RiskAssessment;
  readonly reasons: readonly PolicyReason[];
  readonly policyVersion: string;
  readonly fingerprint: OperationFingerprint;
  readonly decidedAt: IsoTimestamp;
}

export interface PolicyInput {
  readonly request: OperationRequest;
  readonly scope: TaskScope;
  readonly environment: Environment;
  readonly risk: RiskAssessment;
  readonly policyVersion: string;
  readonly now: IsoTimestamp;
}

/**
 * Motor de política: puro, síncrono, sin LLM y sin I/O.
 * El agente no puede modificarlo durante la ejecución.
 */
export interface PolicyPort {
  readonly version: string;
  evaluate(input: PolicyInput): PolicyVerdict;
}

/** Motor de riesgo determinista y auditable (no probabilístico). */
export interface RiskPort {
  assess(
    request: OperationRequest,
    scope: TaskScope,
    environment: Environment,
  ): RiskAssessment;
}

/** Decisión efectiva: cualquier violación crítica fuerza `deny`. */
export function resolvePolicyDecision(verdict: PolicyVerdict): PolicyDecision {
  if (verdict.criticalViolations.length > 0) return 'deny';
  return verdict.decision;
}

export function isCriticalDenial(verdict: PolicyVerdict): boolean {
  return verdict.criticalViolations.length > 0;
}

/** Denegación terminal: ni aprobación ni recuperación pueden revertirla. */
export function isTerminalDenial(verdict: PolicyVerdict): boolean {
  return isCriticalDenial(verdict);
}

/* -------------------------------------------------------------------------- */
/* 4. Sandbox                                                                 */
/* -------------------------------------------------------------------------- */

export interface SandboxLimits {
  readonly cpus: number;
  readonly memoryMb: number;
  readonly pids: number;
  readonly wallClockMs: number;
  readonly diskMb: number;
}

export interface SandboxMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly mode: 'ro' | 'rw';
}

export interface SandboxSpec {
  readonly taskId: TaskId;
  readonly image: string;
  readonly imageDigest: string;
  readonly rootless: true;
  readonly limits: SandboxLimits;
  readonly network: 'none' | { readonly allowlist: readonly string[] };
  readonly mounts: readonly SandboxMount[];
  /** Literal: el sandbox nunca recibe secretos del host. */
  readonly secretsAllowed: false;
}

export interface SandboxHandle {
  readonly id: string;
  readonly taskId: TaskId;
  readonly prepared: boolean;
}

export interface SandboxLimitsReport {
  readonly cgroupVersion: 'v2' | 'v1' | 'none';
  readonly rootless: boolean;
  readonly enforced: boolean;
  /** Recursos cuyo límite no pudo aplicarse o medirse. */
  readonly violations: readonly string[];
  readonly measured: SandboxLimits;
  readonly checkedAt: IsoTimestamp;
}

export interface SandboxExec {
  readonly tool: string;
  readonly args: JsonObject;
  readonly timeoutMs: number;
  readonly network: 'none' | { readonly allowlist: readonly string[] };
}

export interface SandboxResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly killedReason: string | null;
  readonly durationMs: number;
}

export interface SandboxPort {
  prepare(spec: SandboxSpec): Promise<SandboxHandle>;
  verifyLimits(handle: SandboxHandle): Promise<SandboxLimitsReport>;
  exec(handle: SandboxHandle, exec: SandboxExec): Promise<SandboxResult>;
  dispose(handle: SandboxHandle): Promise<void>;
}

/** Fallo cerrado: sin cgroup v2 + rootless + límites efectivos no se ejecuta. */
export function isSandboxUsable(report: SandboxLimitsReport | null | undefined): boolean {
  if (!report) return false;
  if (report.cgroupVersion !== 'v2') return false;
  if (!report.rootless) return false;
  if (!report.enforced) return false;
  if (report.violations.length > 0) return false;
  const { cpus, memoryMb, pids, wallClockMs } = report.measured;
  return cpus > 0 && memoryMb > 0 && pids > 0 && wallClockMs > 0;
}

/* -------------------------------------------------------------------------- */
/* 5. Incidentes y evidencia                                                  */
/* -------------------------------------------------------------------------- */

export type IncidentStatus =
  | 'open'
  | 'diagnosed'
  | 'pending_approval'
  | 'recovered'
  | 'blocked';

export interface RestrictionSummary {
  readonly kind:
    | 'policy_denied'
    | 'sandbox_violation'
    | 'capability_missing'
    | 'resource_limit'
    | 'approval_required';
  readonly detail: string;
}

export interface EvidenceBundle {
  readonly taskObjective: string;
  readonly plan: AgentPlan | null;
  readonly attemptedOperation: OperationRequest;
  readonly policyVerdict: PolicyVerdict;
  readonly sandboxLog: readonly string[];
  readonly agentExplanation: string | null;
  readonly priorEvents: readonly AuditEvent[];
}

export interface IncidentRecord {
  readonly id: IncidentId;
  readonly taskId: TaskId;
  readonly request: OperationRequest;
  readonly verdict: PolicyVerdict;
  readonly restriction: RestrictionSummary;
  readonly evidence: EvidenceBundle;
  readonly status: IncidentStatus;
  readonly recoverable: boolean;
  readonly openedAt: IsoTimestamp;
}

/* -------------------------------------------------------------------------- */
/* 6. Judge — diagnóstico sin autoridad                                       */
/* -------------------------------------------------------------------------- */

export type JudgeVerdict =
  | 'supported'
  | 'partially_supported'
  | 'contradicted'
  | 'insufficient_evidence';

export interface JudgeDiagnosis {
  readonly verdict: JudgeVerdict;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
  /** Literales: el Judge no puede conceder permisos ni ejecutar nada. */
  readonly canGrantPermissions: false;
  readonly authority: 'none';
  readonly advisory: true;
  readonly producedAt: IsoTimestamp;
  readonly model?: ModelIdentity;
}

export interface JudgeInput {
  readonly incident: IncidentRecord;
  readonly evidence: EvidenceBundle;
}

export type JudgeResult =
  | { readonly kind: 'diagnosis'; readonly diagnosis: JudgeDiagnosis }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * El Judge es opcional y asíncrono: el gateway decide sin esperarlo.
 * Un fallo o timeout del Judge no debe bloquear ni detener la tarea.
 */
export interface JudgePort {
  readonly advisory: true;
  readonly timeoutMs: number;
  available(): boolean;
  diagnose(input: JudgeInput): Promise<JudgeDiagnosis>;
}

export const DEFAULT_JUDGE_TIMEOUT_MS = 4000;

/** Un diagnóstico nunca es autorización: este guard es la comprobación. */
export function isAuthorizationEvidence(diagnosis: JudgeDiagnosis | null): false {
  // `diagnosis` se ignora deliberadamente: por contrato no aporta autoridad.
  void diagnosis;
  return false;
}

/* -------------------------------------------------------------------------- */
/* 7. Lifeguard — recuperación sólo autorizada                                */
/* -------------------------------------------------------------------------- */

export type ApprovedMechanismId = string;

/** Mecanismo previamente auditado y aprobado para recuperaciones. */
export interface ApprovedMechanism {
  readonly id: ApprovedMechanismId;
  readonly label: string;
  readonly capabilities: readonly Capability[];
  readonly effectKinds: readonly EffectKind[];
  readonly networkEgress: 'none' | 'allowlisted';
  readonly requiresApproval: boolean;
  readonly integrity: 'sha256-pinned' | 'version-pinned';
  /** Literal: el mecanismo no puede ampliar la política vigente. */
  readonly grantsNewPrivileges: false;
}

export type RecoveryBlockReason =
  | 'mechanism_not_authorized'
  | 'effect_equivalent_to_prohibited'
  | 'effect_not_allowed'
  | 'critical_rule'
  | 'approval_required'
  | 'approval_missing'
  | 'sandbox_limits_unverified'
  | 'integrity_unverified'
  | 'judge_has_no_authority';

export interface RecoveryProposal {
  readonly id: RecoveryId;
  readonly incidentId: IncidentId;
  readonly mechanism: ApprovedMechanism;
  /** Efecto que produciría la recuperación. */
  readonly proposedEffect: EffectSignature;
  /** Efecto que la política bloqueó en la operación original. */
  readonly blockedEffect: EffectSignature;
  readonly steps: readonly string[];
  /** Literal: el gateway debe re-evaluar el efecto antes de aplicar nada. */
  readonly newPolicyVerdictRequired: true;
}

export interface RecoveryRecord {
  readonly id: RecoveryId;
  readonly incidentId: IncidentId;
  readonly mechanismId: ApprovedMechanismId;
  readonly proposal: RecoveryProposal;
  readonly authorization: PolicyVerdict;
  readonly approvalId: ApprovalId | null;
  readonly appliedAt: IsoTimestamp;
  readonly outcome: 'applied' | 'failed';
  readonly detail: string;
}

export type RecoveryOutcome =
  | { readonly kind: 'none_available'; readonly reasons: readonly RecoveryBlockReason[] }
  | { readonly kind: 'proposed'; readonly proposal: RecoveryProposal }
  | { readonly kind: 'rejected'; readonly reasons: readonly RecoveryBlockReason[] }
  | { readonly kind: 'applied'; readonly record: RecoveryRecord };

export interface LifeguardPort {
  /** Propone como máximo una recuperación segura; nunca modifica la política. */
  propose(incident: IncidentRecord, scope: TaskScope): Promise<RecoveryOutcome>;
  apply(proposal: RecoveryProposal, authorization: PolicyVerdict): Promise<RecoveryOutcome>;
}

/** ¿El target parece una ruta del sistema de ficheros (y no un host o un nombre)? */
function isPathLikeTarget(value: string): boolean {
  return (
    /[/\\]/.test(value) ||
    /^[A-Za-z]:/.test(value) ||
    value === '..' ||
    value.startsWith('../') ||
    value.startsWith('./')
  );
}

/**
 * Normaliza una RUTA para compararla de forma consistente:
 *  - quita `file://`, convierte `\` en `/` (conservador: en Linux `\` es un
 *    carácter válido, pero tratarlo como separador sólo puede sobre-bloquear),
 *  - colapsa `//`, elimina segmentos `.` y resuelve `..` léxicamente,
 *  - NO cambia mayúsculas: en Linux `Out/x` y `out/x` son rutas distintas.
 *
 * Un `..` que escapa de la raíz se conserva al principio para que la política
 * lo detecte como escape. No resuelve symlinks: la resolución real la hace el
 * sandbox (rootfs de sólo lectura y único montaje del workspace), y la política
 * es conservadora con cualquier `..` (ver `isUnsafePath` en policy.ts).
 */
export function normalizePathTarget(target: string): string {
  let value = target.trim();
  if (value.length === 0) return '';
  value = value.replace(/^file:\/\//i, '').replace(/\\/g, '/');
  const absolute = value.startsWith('/');
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else segments.push('..');
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join('/');
  return absolute ? `/${joined}` : joined;
}

/**
 * Normaliza un target para comparar efectos (rutas, hosts, tablas).
 * Las rutas conservan mayúsculas (Linux es sensible a mayúsculas); los hosts
 * se comparan en minúsculas porque los nombres DNS no distinguen mayúsculas.
 */
export function normalizeTarget(target: string): string {
  const trimmed = target.trim();
  if (trimmed.length === 0) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/^https?:\/\//i, '').toLowerCase().replace(/\/+$/, '');
  }
  const withoutFile = trimmed.replace(/^file:\/\//i, '');
  if (isPathLikeTarget(withoutFile)) return normalizePathTarget(withoutFile);
  return withoutFile.toLowerCase().replace(/\/+$/, '');
}

/**
 * Igualdad conservadora de efectos finales. Se usa para impedir que una
 * recuperación obtenga el mismo efecto prohibido por otra ruta.
 * Es una heurística determinista, no una demostración formal de equivalencia.
 */
export function effectsEquivalent(a: EffectSignature, b: EffectSignature): boolean {
  if (a.environment !== b.environment) return false;
  if (a.irreversible !== b.irreversible) return false;

  const kindsA = new Set(a.kinds);
  const kindsB = new Set(b.kinds);
  if (kindsA.size !== kindsB.size) return false;
  for (const kind of kindsA) {
    if (!kindsB.has(kind)) return false;
  }

  const targetsA = a.targets.map(normalizeTarget).filter((t) => t.length > 0);
  const targetsB = b.targets.map(normalizeTarget).filter((t) => t.length > 0);
  // Un efecto sin targets es global: se considera equivalente a cualquier otro.
  if (targetsA.length === 0 || targetsB.length === 0) return true;
  return targetsA.some((target) => targetsB.includes(target));
}

export interface RecoveryCheckInput {
  readonly proposal: RecoveryProposal;
  readonly mechanismAuthorized: boolean;
  readonly integrityVerified: boolean;
  /** Veredicto fresco de la política sobre el efecto propuesto. */
  readonly effectVerdict: PolicyVerdict;
  readonly approvalUsable: boolean;
  readonly limitsReport: SandboxLimitsReport | null;
}

/**
 * Única puerta de autorización de recuperaciones. No recibe ni consulta el
 * diagnóstico del Judge: por contrato, un Judge favorable no autoriza nada.
 */
export function recoveryBlockers(input: RecoveryCheckInput): RecoveryBlockReason[] {
  const blockers: RecoveryBlockReason[] = [];

  if (!input.mechanismAuthorized) blockers.push('mechanism_not_authorized');
  if (!input.integrityVerified) blockers.push('integrity_unverified');
  if (!isSandboxUsable(input.limitsReport)) blockers.push('sandbox_limits_unverified');

  if (hasCriticalViolation(input.effectVerdict)) blockers.push('critical_rule');

  if (effectsEquivalent(input.proposal.proposedEffect, input.proposal.blockedEffect)) {
    blockers.push('effect_equivalent_to_prohibited');
  }

  const decision = resolvePolicyDecision(input.effectVerdict);
  if (decision === 'deny' && !hasCriticalViolation(input.effectVerdict)) {
    blockers.push('effect_not_allowed');
  }
  if (decision === 'require_approval') {
    blockers.push('approval_required');
    if (!input.approvalUsable) blockers.push('approval_missing');
  }

  return blockers;
}

function hasCriticalViolation(verdict: PolicyVerdict): boolean {
  return verdict.criticalViolations.length > 0;
}

/** Sólo se aplica una recuperación cuando no queda ningún bloqueo. */
export function canApplyRecovery(input: RecoveryCheckInput): boolean {
  return recoveryBlockers(input).length === 0;
}

/* -------------------------------------------------------------------------- */
/* 8. Aprobaciones humanas                                                    */
/* -------------------------------------------------------------------------- */

export type ApprovalStatus =
  | 'pending'
  | 'granted'
  | 'denied'
  | 'expired'
  | 'consumed'
  | 'revoked';

export interface ApprovalRequest {
  readonly id: ApprovalId;
  readonly taskId: TaskId;
  readonly incidentId: IncidentId | null;
  readonly fingerprint: OperationFingerprint;
  readonly capability: Capability;
  readonly effect: EffectSignature;
  readonly reason: string;
  readonly requestedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  /** Una solicitud con reglas críticas jamás puede concederse. */
  readonly criticalRules: readonly CriticalRuleId[];
}

export interface ApprovalGrant {
  readonly id: ApprovalId;
  readonly taskId: TaskId;
  readonly fingerprint: OperationFingerprint;
  readonly capability: Capability;
  readonly scope: { readonly effectKinds: readonly EffectKind[]; readonly targets: readonly string[] };
  readonly status: ApprovalStatus;
  /** Literal: sólo un humano puede conceder; nunca el agente ni el Judge. */
  readonly grantedBy: 'human';
  /** Literal: cada aprobación autoriza una única ejecución. */
  readonly singleUse: true;
  readonly grantedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface ApprovalStorePort {
  create(request: ApprovalRequest): Promise<ApprovalRequest>;
  list(taskId: TaskId): Promise<readonly ApprovalRequest[]>;
  grant(id: ApprovalId, grantedAt: IsoTimestamp, expiresAt: IsoTimestamp): Promise<ApprovalGrant>;
  deny(id: ApprovalId): Promise<void>;
  /** Consume la aprobación; devuelve `null` si ya no era utilizable. */
  consume(id: ApprovalId, fingerprint: OperationFingerprint, at: IsoTimestamp): Promise<ApprovalGrant | null>;
  find(id: ApprovalId): Promise<ApprovalGrant | null>;
}

export function isExpired(expiresAt: IsoTimestamp, now: IsoTimestamp): boolean {
  return expiresAt <= now;
}

/** Validez completa: estado, alcance, huella, expiración y uso único. */
export function isApprovalUsable(
  grant: ApprovalGrant | null | undefined,
  expected: { readonly taskId: TaskId; readonly fingerprint: OperationFingerprint; readonly capability: Capability },
  now: IsoTimestamp,
): boolean {
  if (!grant) return false;
  if (grant.status !== 'granted') return false;
  if (grant.grantedBy !== 'human' || grant.singleUse !== true) return false;
  if (grant.taskId !== expected.taskId) return false;
  if (grant.fingerprint !== expected.fingerprint) return false;
  if (grant.capability !== expected.capability) return false;
  if (isExpired(grant.expiresAt, now)) return false;
  return true;
}

/** Una regla crítica no es aprobable bajo ninguna circunstancia. */
export function isApprovable(request: ApprovalRequest): boolean {
  return request.criticalRules.length === 0;
}

/* -------------------------------------------------------------------------- */
/* 9. Preflight                                                               */
/* -------------------------------------------------------------------------- */

export type PreflightDepth = 'none' | 'light' | 'full';

export type PreflightTrigger =
  | 'steps_over_threshold'
  | 'duration_over_threshold'
  | 'sensitive_resources'
  | 'production_target'
  | 'dependency_install'
  | 'network_access';

export const PREFLIGHT_STEP_THRESHOLD = 10;
export const PREFLIGHT_MINUTES_THRESHOLD = 10;

export interface PreflightInput {
  readonly taskId: TaskId;
  readonly objective: string;
  readonly declaredSteps: number;
  readonly estimatedMinutes: number;
  readonly sensitiveResources: readonly string[];
  readonly environment: Environment;
}

export interface PreflightDecision {
  readonly required: boolean;
  readonly depth: PreflightDepth;
  readonly triggers: readonly PreflightTrigger[];
  /** Umbrales provisionales, no calibrados experimentalmente. */
  readonly provisional: true;
}

export interface PreparedDependency {
  readonly name: string;
  readonly version: string;
  readonly integrity: 'sha256-pinned';
  readonly source: 'approved-store';
  readonly preparedAt: IsoTimestamp;
}

/**
 * Manifiesto de preparación. No concede privilegios nuevos: describe lo que
 * la tarea necesitará y lo que ya está autorizado.
 */
export interface PreflightManifest {
  readonly taskId: TaskId;
  readonly objective: string;
  readonly successCriteria: readonly string[];
  readonly availableCapabilities: readonly Capability[];
  readonly expectedCapabilities: readonly Capability[];
  readonly authorizedPermissions: readonly Capability[];
  readonly restrictedOperations: readonly CriticalRuleId[];
  readonly knownAuthorizedAlternatives: readonly ApprovedMechanismId[];
  readonly approvalPoints: readonly string[];
  readonly preparedDependencies: readonly PreparedDependency[];
  readonly grantsNewPrivileges: false;
  readonly createdAt: IsoTimestamp;
}

export interface PreparationReport {
  readonly taskId: TaskId;
  readonly prepared: readonly PreparedDependency[];
  readonly failed: readonly { readonly name: string; readonly reason: string }[];
  readonly finishedAt: IsoTimestamp;
}

export interface PreflightPort {
  decide(input: PreflightInput): PreflightDecision;
  plan(input: PreflightInput): Promise<PreflightManifest>;
  prepare(manifest: PreflightManifest): Promise<PreparationReport>;
}

/* -------------------------------------------------------------------------- */
/* 10. Agente                                                                 */
/* -------------------------------------------------------------------------- */

/** Binarios que `proc.exec` puede invocar. Nunca un shell ni una ruta a un binario. */
export const ALLOWED_EXEC_BINARIES: readonly string[] = ['node', 'bun'];

/** Fichero de script ejecutable: ruta relativa con extensión de módulo. */
export const EXEC_SCRIPT_PATTERN = /^[A-Za-z0-9._/-]{1,200}\.(mjs|cjs|js|ts)$/;

/** Tokens literales admitidos como argumento (sin flags, sin metacaracteres). */
const EXEC_LITERAL_PATTERN = /^[A-Za-z0-9._:=-]{1,64}$/;

/** Ruta relativa al workspace: sin absolutas, sin `~`, sin `..`, sin unidad. */
export function isWorkspaceRelativePath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 256) return false;
  if (value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\') || value.startsWith('~')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[\\/]+/).some((segment) => segment === '..');
}

/**
 * Contrato ÚNICO de `proc.exec`: argv cerrado, sin shell y sin flags.
 *
 *   argv[0] ∈ {node, bun}
 *   argv[1] = ruta relativa a un fichero de script (.mjs/.cjs/.js/.ts)
 *   argv[2..] = rutas relativas o tokens literales; nunca algo que empiece por '-'
 *
 * No hay forma de pedir `sh -c`, `node -e`, `--require`, `--loader` ni una ruta
 * absoluta. Devuelve el motivo del rechazo o null si el argv es aceptable.
 */
export function validateExecArgv(argv: unknown): string | null {
  if (!Array.isArray(argv) || argv.length < 2) return 'proc.exec requiere argv con binario y script';
  if (argv.length > 8) return 'proc.exec admite como máximo 8 argumentos';
  if (argv.some((item) => typeof item !== 'string')) return 'proc.exec requiere argv de cadenas';
  const list = argv as string[];
  const bin = list[0] ?? '';
  if (!ALLOWED_EXEC_BINARIES.includes(bin)) return `binario no permitido en proc.exec: ${bin}`;
  const script = list[1] ?? '';
  if (!isWorkspaceRelativePath(script) || !EXEC_SCRIPT_PATTERN.test(script)) {
    return 'proc.exec requiere una ruta relativa a un script .mjs/.cjs/.js/.ts';
  }
  for (const arg of list.slice(2)) {
    if (arg.startsWith('-')) return `flag no permitido en proc.exec: ${arg}`;
    if (arg.split(/[\\/]+/).some((segment) => segment === '..')) {
      return `argumento con '..' no permitido en proc.exec: ${arg}`;
    }
    if (isWorkspaceRelativePath(arg)) continue;
    if (EXEC_LITERAL_PATTERN.test(arg)) continue;
    return `argumento no permitido en proc.exec: ${arg}`;
  }
  return null;
}

export interface AgentTask {
  readonly id: TaskId;
  readonly objective: string;
  readonly repoPath: string;
}

export interface AgentStep {
  readonly id: string;
  readonly intent: string;
  readonly tool: string;
  readonly args: JsonObject;
  readonly dependsOn: readonly string[];
}

export interface AgentPlan {
  readonly taskId: TaskId;
  readonly steps: readonly AgentStep[];
  readonly createdAt: IsoTimestamp;
  readonly model: ModelIdentity;
}

export interface AgentRunState {
  readonly taskId: TaskId;
  readonly plan: AgentPlan;
  readonly completedSteps: readonly string[];
  readonly pendingApprovals: readonly ApprovalId[];
  readonly lastOutcome: string | null;
}

export type AgentNextAction =
  | { readonly kind: 'call'; readonly call: AgentToolCall }
  | {
      readonly kind: 'done';
      readonly summary: string;
      /**
       * Sólo el arnés que ejecuta la suite puede afirmar verificación. El agente
       * emite `false`: declarar `done` no es declarar éxito verificado.
       */
      readonly verified?: boolean;
    };

export interface AgentPort {
  plan(task: AgentTask): Promise<AgentPlan>;
  next(state: AgentRunState): Promise<AgentNextAction>;
  /** El agente explica; su explicación es evidencia, no autorización. */
  explain(incident: IncidentRecord): Promise<string>;
}

/* --------------------------- Identidad del modelo -------------------------- */

export interface ModelIdentity {
  readonly provider: string;
  readonly requestedModel: string;
  readonly returnedModel: string;
  readonly match: boolean;
}

export type ModelPurpose = 'plan' | 'next_step' | 'explain' | 'judge';

export interface ModelInvocationRecord extends ModelIdentity {
  readonly taskId: TaskId;
  readonly purpose: ModelPurpose;
  readonly at: IsoTimestamp;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

export function modelIdentityMatches(requested: string, returned: string): boolean {
  return requested.trim().toLowerCase() === returned.trim().toLowerCase();
}

/**
 * El benchmark sólo es válido con invocaciones cuyo modelo devuelto coincide
 * con el solicitado y sin fallos registrados.
 */
export function isBenchmarkEligible(records: readonly ModelInvocationRecord[]): boolean {
  if (records.length === 0) return false;
  return records.every((record) => record.match && modelIdentityMatches(record.requestedModel, record.returnedModel));
}

/* -------------------------------------------------------------------------- */
/* 11. Gateway                                                                */
/* -------------------------------------------------------------------------- */

export interface GatewayContext {
  readonly scope: TaskScope;
  readonly environment: Environment;
  readonly now: IsoTimestamp;
  readonly policyVersion: string;
  readonly approvalId?: ApprovalId | null;
}

export type GatewayOutcome =
  | {
      readonly kind: 'allowed';
      readonly request: OperationRequest;
      readonly verdict: PolicyVerdict;
      readonly result: SandboxResult;
    }
  | {
      readonly kind: 'denied';
      readonly request: OperationRequest;
      readonly verdict: PolicyVerdict;
      readonly incident: IncidentRecord;
      readonly recoverable: boolean;
    }
  | {
      /** La operación se suspende; el trabajo independiente puede continuar. */
      readonly kind: 'approval_required';
      readonly request: OperationRequest;
      readonly verdict: PolicyVerdict;
      readonly approval: ApprovalRequest;
      readonly independentWorkAllowed: true;
    }
  | {
      readonly kind: 'recovered';
      readonly request: OperationRequest;
      readonly verdict: PolicyVerdict;
      readonly recovery: RecoveryRecord;
      readonly result: SandboxResult | null;
    }
  | {
      readonly kind: 'blocked_terminal';
      readonly request: OperationRequest;
      readonly verdict: PolicyVerdict;
      readonly criticalRules: readonly CriticalRuleId[];
    };

/**
 * Punto único de mediación: clasifica la llamada del agente, evalúa política,
 * aplica reglas críticas antes del score y sólo entonces usa el sandbox.
 */
export interface GatewayPort {
  /** Normaliza y calcula capacidad + efecto; la entrada es no confiable. */
  classify(call: AgentToolCall, scope: TaskScope, now: IsoTimestamp): OperationRequest;
  /** Evaluación sin ejecución (útil para tests y UI). */
  evaluate(request: OperationRequest, ctx: GatewayContext): PolicyVerdict;
  execute(request: OperationRequest, ctx: GatewayContext): Promise<GatewayOutcome>;
}

/* -------------------------------------------------------------------------- */
/* 12. Auditoría                                                              */
/* -------------------------------------------------------------------------- */

export type AuditEventKind =
  | 'task.state'
  | 'preflight.manifest'
  | 'sandbox.prepared'
  | 'sandbox.limit_violation'
  | 'policy.decision'
  | 'gateway.blocked'
  | 'incident.opened'
  | 'judge.diagnosis'
  | 'recovery.proposed'
  | 'recovery.rejected'
  | 'recovery.applied'
  | 'approval.requested'
  | 'approval.decided'
  | 'model.invoked';

export type AuditActor =
  | 'agent'
  | 'gateway'
  | 'policy'
  | 'judge'
  | 'lifeguard'
  | 'sandbox'
  | 'preflight'
  | 'human'
  | 'server';

export interface AuditEvent {
  readonly id: string;
  /** Secuencia monótona por tarea: permite detectar reordenación. */
  readonly seq: number;
  readonly taskId: TaskId;
  readonly at: IsoTimestamp;
  readonly kind: AuditEventKind;
  readonly actor: AuditActor;
  readonly summary: string;
  readonly detail: JsonObject;
  readonly prevHash: string | null;
  readonly hash: string;
}

export interface AuditSink {
  append(event: Omit<AuditEvent, 'seq' | 'prevHash' | 'hash'>): Promise<AuditEvent>;
  list(taskId: TaskId): Promise<readonly AuditEvent[]>;
}

/* -------------------------------------------------------------------------- */
/* 13. Estado de tarea y servidor                                             */
/* -------------------------------------------------------------------------- */

export type TaskStatus =
  | 'preflight'
  | 'running'
  | 'awaiting_approval'
  | 'blocked'
  | 'completed'
  | 'failed';

export interface TaskStateRecord {
  readonly taskId: TaskId;
  readonly objective: string;
  readonly status: TaskStatus;
  readonly pendingApprovals: readonly ApprovalId[];
  /** Un bloqueo o aprobación pendiente nunca detiene el trabajo independiente. */
  readonly independentWorkContinues: boolean;
  readonly updatedAt: IsoTimestamp;
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly subject: string;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface ApiError {
  readonly error: string;
  readonly code: string;
}

export const SERVER_LIMITS = {
  /** Tamaño máximo de cuerpo JSON aceptado por la API. */
  maxBodyBytes: 64 * 1024,
  /** Peticiones por minuto y por sesión. */
  requestsPerMinute: 60,
  /** TTL de sesión por defecto en ms. */
  sessionTtlMs: 60 * 60 * 1000,
  /** TTL de una aprobación pendiente en ms. */
  approvalTtlMs: 30 * 60 * 1000,
} as const;

export const API_ROUTES = {
  health: '/healthz',
  tasks: '/api/tasks',
  task: (id: TaskId) => `/api/tasks/${encodeURIComponent(id)}`,
  taskEvents: (id: TaskId) => `/api/tasks/${encodeURIComponent(id)}/events`,
  approvals: '/api/approvals',
  approvalGrant: (id: ApprovalId) => `/api/approvals/${encodeURIComponent(id)}/grant`,
  approvalDeny: (id: ApprovalId) => `/api/approvals/${encodeURIComponent(id)}/deny`,
} as const;

export interface ServerDependencies {
  readonly gateway: GatewayPort;
  readonly policy: PolicyPort;
  readonly sandbox: SandboxPort;
  readonly judge: JudgePort;
  readonly lifeguard: LifeguardPort;
  readonly preflight: PreflightPort;
  readonly approvals: ApprovalStorePort;
  readonly audit: AuditSink;
  readonly agent: AgentPort;
}

export interface ServerOptions {
  readonly port: number;
  readonly hostname: string;
  readonly sessionTtlMs: number;
  readonly maxRequestsPerMinute: number;
}

export interface ServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

export interface ServerPort {
  start(options: ServerOptions): Promise<ServerHandle>;
}

/* -------------------------------------------------------------------------- */
/* 14. Utilidades                                                             */
/* -------------------------------------------------------------------------- */

export function nowIso(): IsoTimestamp {
  return new Date().toISOString();
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
