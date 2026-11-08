/**
 * Deterministic Policy Engine + Risk Engine + catálogo de recuperación.
 *
 * Invariantes (por encima de cualquier score, aprobación o diagnóstico):
 *  1. Las reglas críticas se evalúan SIEMPRE antes del score y fuerzan `deny`.
 *     Ninguna aprobación humana ni veredicto del Judge las levanta.
 *  2. El efecto lo calcula este módulo a partir de `tool + args`; el agente
 *     nunca declara capacidad ni efecto.
 *  3. El score (0..100) sólo decide entre automático / revisado / aprobación
 *     humana. Es provisional y no está calibrado.
 *  4. Una recuperación sólo se autoriza si el MECANISMO está en el catálogo y
 *     el EFECTO propuesto obtiene un veredicto fresco que no equivale al
 *     efecto prohibido.
 *
 * Sin red, sin E/S y sin claves: todo es puro y determinista.
 */

import { createHash } from 'node:crypto';

import {
  DEFAULT_APPROVAL_THRESHOLD,
  clampScore,
  effectsEquivalent,
  normalizePathTarget,
  normalizeTarget,
  resolvePolicyDecision,
  riskBand,
  type AgentToolCall,
  type ApprovalId,
  type ApprovedMechanism,
  type AuditEvent,
  type Capability,
  type CriticalRuleId,
  type EffectKind,
  type EffectSignature,
  type Environment,
  type IncidentRecord,
  type IsoTimestamp,
  type JsonObject,
  type JsonValue,
  type OperationFingerprint,
  type OperationRequest,
  type PolicyInput,
  type PolicyPort,
  type PolicyReason,
  type PolicyVerdict,
  type RecoveryBlockReason,
  type RecoveryProposal,
  type RiskAssessment,
  type RiskFactor,
  type RiskPort,
  type SandboxLimitsReport,
  type TaskScope,
} from './contracts.ts';
import { isSandboxUsable } from './contracts.ts';
import {
  canonicalPayload,
  sha256Hex,
  type ApprovedPackage,
  type Store,
} from './lifeguard.ts';

export const POLICY_VERSION = 'deterministic-policy-1.0.0';

/** Hosts que un `pkg.install` declara como destino de red (siempre el mismo). */
export const PACKAGE_REGISTRY_HOST = 'registry.npmjs.org';

/* -------------------------------------------------------------------------- */
/* 1. Canonicalización y huellas                                              */
/* -------------------------------------------------------------------------- */

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.keys(value as JsonObject)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as JsonObject)[key] as JsonValue)}`);
  return `{${entries.join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Huella estable de una operación concreta: base de las aprobaciones. */
export function operationFingerprint(tool: string, args: JsonObject, capability: Capability): OperationFingerprint {
  return sha256(`${POLICY_VERSION}|${tool}|${capability}|${canonicalJson(args)}`);
}

/* -------------------------------------------------------------------------- */
/* 2. Clasificación: tool + args -> capacidad + efecto                        */
/* -------------------------------------------------------------------------- */

const TOOL_CAPABILITY: Readonly<Record<string, Capability>> = {
  'fs.list': 'fs.read',
  'fs.read': 'fs.read',
  'fs.write': 'fs.write',
  'test.run': 'proc.exec',
  'proc.exec': 'proc.exec',
  'pkg.install': 'pkg.install',
  'deploy.request': 'deploy.production',
};

/** Herramientas fuera del catálogo que implican ejecución directa en el host. */
const HOST_TOOLS: readonly string[] = ['shell', 'bash', 'sh', 'exec', 'host.exec', 'proc.spawn', 'docker'];

/** Herramientas que pretenden modificar la propia política o aprobaciones. */
const SELF_MODIFY_TOOLS: readonly string[] = [
  'policy.write',
  'policy.update',
  'gateway.configure',
  'sandbox.configure',
  'approvals.grant',
];

/** Herramientas que pretenden usar al Judge como autoridad. */
const JUDGE_GRANT_TOOLS: readonly string[] = ['judge.authorize', 'judge.grant'];

const PRIVILEGED_TARGET_RE = /(^|[^a-z0-9])(sudo|su|root|chroot|nsenter|mount|systemctl)([^a-z0-9]|$)/;

export function isKnownTool(tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_CAPABILITY, tool);
}

export function capabilityForTool(tool: string): Capability | null {
  return TOOL_CAPABILITY[tool] ?? null;
}

function isPathLike(target: string): boolean {
  return /[/\\]/.test(target) || /^[A-Za-z]:/.test(target) || target === '..' || target.startsWith('..');
}

/**
 * Escape de ruta, conservador: absolutas, unidades de Windows y CUALQUIER `..`
 * (aunque resuelva dentro del workspace), porque un `..` puede atravesar un
 * symlink que la política pura no puede resolver. `./` y `//` se normalizan
 * antes de comparar, así que no sirven para evadir rutas protegidas.
 */
function isUnsafePath(target: string): boolean {
  const normalized = normalizePathTarget(target);
  if (normalized.startsWith('/')) return true;
  if (/^[A-Za-z]:/.test(normalized)) return true;
  if (normalized === '..' || normalized.startsWith('../')) return true;
  return target.split(/[/\\]/).some((segment) => segment === '..');
}

/**
 * ¿La ruta normalizada cae dentro de una ruta protegida? Comparación
 * case-SENSITIVE (Linux) sobre la forma normalizada: `./out/x`, `out//x` y
 * `out/./x` colapsan a `out/x` y sí coinciden. No se resuelven symlinks: el
 * sandbox (rootfs de sólo lectura, único montaje del workspace) es la barrera.
 */
function pathHitsProtected(target: string, guarded: string): boolean {
  const t = target.replace(/^\/+/, '');
  const g = guarded.replace(/^\/+/, '');
  if (g.length === 0) return false;
  return t === g || t.startsWith(`${g}/`);
}

function stringArgs(args: JsonObject): string[] {
  const out: string[] = [];
  for (const [, value] of Object.entries(args)) {
    if (typeof value === 'string') out.push(value);
    else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value));
  }
  return out;
}

function packageRef(args: JsonObject): string {
  const name = typeof args.name === 'string' ? args.name : 'unknown';
  const version = typeof args.version === 'string' ? args.version : '0.0.0';
  return `${name}@${version}`;
}

/**
 * Calcula el efecto técnico de la operación. `tool` desconocida produce un
 * efecto de ejecución que la política denegará: nunca se asume inofensiva.
 */
export function effectForCall(tool: string, args: JsonObject): EffectSignature {
  switch (tool) {
    case 'fs.list':
    case 'fs.read':
      return {
        kinds: ['read'],
        targets: [typeof args.path === 'string' ? args.path : '.'],
        environment: 'sandbox',
        irreversible: false,
        externalImpact: false,
      };
    case 'fs.write':
      return {
        kinds: ['write'],
        targets: [typeof args.path === 'string' ? args.path : 'unknown'],
        environment: 'sandbox',
        irreversible: false,
        externalImpact: false,
      };
    case 'test.run': {
      const targets: string[] = [];
        if (typeof args.cwd === 'string') targets.push(args.cwd);
        if (typeof args.suite === 'string') targets.push(args.suite);
        if (typeof args.script === 'string') targets.push(args.script);
        return {
        kinds: ['execute'],
          targets: targets.length > 0 ? targets : ['unknown'],
        environment: 'sandbox',
        irreversible: false,
        externalImpact: false,
      };
      }
      case 'proc.exec': {
      const argv = Array.isArray(args.argv) ? (args.argv as unknown[]) : [];
      const targets = argv.filter((item): item is string => typeof item === 'string');
      return {
        kinds: ['execute'],
        targets: targets.length > 0 ? targets : ['unknown'],
        environment: 'sandbox',
        irreversible: false,
        externalImpact: false,
      };
      }
    case 'pkg.install':
      return {
        kinds: ['package.install', 'network.egress'],
        targets: [PACKAGE_REGISTRY_HOST, packageRef(args)],
        environment: 'sandbox',
        irreversible: false,
        externalImpact: true,
      };
    case 'deploy.request':
      return {
        kinds: ['deploy'],
        targets: [typeof args.target === 'string' ? args.target : 'unknown'],
        environment: 'production',
        irreversible: false,
        externalImpact: true,
      };
    default:
      return {
        kinds: ['execute'],
        targets: [tool, ...stringArgs(args).slice(0, 3)],
        environment: 'sandbox',
        irreversible: true,
        externalImpact: true,
      };
  }
}

/**
 * Normaliza una llamada del agente. La operación resultante lleva
 * `computedBy: 'gateway'`: el agente no aporta capacidad ni efecto.
 */
export function classifyToolCall(
  call: AgentToolCall,
  _scope: TaskScope,
  now: IsoTimestamp,
): OperationRequest {
  const capability = capabilityForTool(call.tool) ?? 'proc.exec';
  const effect = effectForCall(call.tool, call.args);
  const fingerprint = operationFingerprint(call.tool, call.args, capability);
  return {
    id: `op_${fingerprint.slice(0, 16)}`,
    taskId: call.taskId,
    planStepId: call.planStepId,
    tool: call.tool,
    args: call.args,
    declaredIntent: call.declaredIntent,
    capability,
    effect,
    fingerprint,
    requestedAt: now,
    computedBy: 'gateway',
  };
}

/* -------------------------------------------------------------------------- */
/* 3. Reglas críticas (prioridad absoluta)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Devuelve las prohibiciones críticas activadas por la operación.
 * Se evalúa ANTES del score, de las aprobaciones y del diagnóstico del Judge.
 */
export function criticalViolationsFor(
  request: OperationRequest,
  scope: TaskScope,
  environment: Environment,
): readonly CriticalRuleId[] {
  const violations = new Set<CriticalRuleId>();
  const kinds = new Set<EffectKind>(request.effect.kinds);
  const targets = request.effect.targets;
  const strings = stringArgs(request.args);

  if (!isKnownTool(request.tool) && HOST_TOOLS.includes(request.tool)) violations.add('sandbox.escape');
  if (!isKnownTool(request.tool)) {
    for (const value of strings) {
      if (isPathLike(value) && isUnsafePath(value)) violations.add('sandbox.escape');
      if (/docker\.sock|^\/proc|^\/sys|^\/host|\/host\//.test(value)) violations.add('sandbox.host-mount');
      if (PRIVILEGED_TARGET_RE.test(value)) violations.add('proc.privileged');
    }
  }
  // Rutas protegidas y de escape, también para herramientas conocidas.
  for (const target of targets) {
    if (isPathLike(target) && isUnsafePath(target)) violations.add('sandbox.escape');
    if (/docker\.sock|^\/proc|^\/sys|^\/host|\/host\//.test(target)) violations.add('sandbox.host-mount');
    if (PRIVILEGED_TARGET_RE.test(target)) violations.add('proc.privileged');
  }

  if (SELF_MODIFY_TOOLS.includes(request.tool)) violations.add('policy.self-modify');
  if (JUDGE_GRANT_TOOLS.includes(request.tool)) violations.add('judge.grant');

  if (kinds.has('secret.access') && !scope.allowedCapabilities.includes('secrets.read')) {
    violations.add('secrets.unauthorized');
  }

  const mutating: readonly EffectKind[] = ['deploy', 'write', 'data.destroy', 'payment'];
  if (
    environment === 'production' &&
    !scope.mayMutateProduction &&
    request.effect.kinds.some((kind) => mutating.includes(kind))
  ) {
    violations.add('production.unapproved');
  }

  if (kinds.has('data.destroy') && request.effect.irreversible) violations.add('data.irreversible-delete');

  if (kinds.has('network.egress')) {
    const allowed = scope.allowedHosts.map((host) => host.toLowerCase());
    for (const target of targets) {
      if (target === PACKAGE_REGISTRY_HOST || !isPathLike(target)) {
        if (!allowed.includes(target.toLowerCase())) violations.add('network.unlisted-host');
      }
    }
  }

  // Rutas protegidas del alcance: escribir, ejecutar o destruir sobre ellas es violación crítica.
  // Un nombre simple (`report.json`) TAMBIÉN es una ruta: no se filtra por "parece ruta",
  // porque ese filtro dejaba pasar exactamente los ficheros protegidos de primer nivel.
  const guardedPaths = scope.protectedPaths
    .map((p) => normalizePathTarget(p))
    .filter((p) => p.length > 0);
  if (guardedPaths.length > 0 && (kinds.has('write') || kinds.has('execute') || kinds.has('data.destroy'))) {
    for (const target of targets) {
      const normalized = normalizePathTarget(target);
      if (normalized.length === 0) continue;
      for (const guarded of guardedPaths) {
        if (pathHitsProtected(normalized, guarded)) violations.add('policy.protected-path');
      }
    }
  }

  return [...violations].sort();
}

/* -------------------------------------------------------------------------- */
/* 4. Risk Engine determinista                                                */
/* -------------------------------------------------------------------------- */

const EFFECT_WEIGHTS: Readonly<Record<EffectKind, number>> = {
  read: 5,
  write: 20,
  execute: 25,
  'network.egress': 15,
  'package.install': 20,
  'secret.access': 80,
  'data.destroy': 90,
  deploy: 55,
  payment: 85,
};

const ENVIRONMENT_WEIGHTS: Readonly<Record<Environment, number>> = {
  sandbox: 0,
  staging: 12,
  production: 30,
};

/**
 * Score 0..100 por suma de pesos auditables. No es una probabilidad y sus
 * umbrales no están calibrados: el campo `provisional` lo declara.
 */
export class DeterministicRiskEngine implements RiskPort {
  assess(request: OperationRequest, scope: TaskScope, environment: Environment): RiskAssessment {
    const factors: RiskFactor[] = [];
    let score = 0;

    for (const kind of new Set(request.effect.kinds)) {
      const weight = EFFECT_WEIGHTS[kind];
      score += weight;
      factors.push({ id: `effect.${kind}`, weight, note: `efecto ${kind}` });
    }

    const envWeight = ENVIRONMENT_WEIGHTS[environment];
    if (envWeight > 0) {
      score += envWeight;
      factors.push({ id: `environment.${environment}`, weight: envWeight, note: `entorno ${environment}` });
    }

    if (request.effect.irreversible) {
      score += 20;
      factors.push({ id: 'effect.irreversible', weight: 20, note: 'efecto irreversible' });
    }
    if (request.effect.externalImpact) {
      score += 10;
      factors.push({ id: 'effect.external', weight: 10, note: 'impacto sobre sistemas externos' });
    }
    if (!scope.allowedCapabilities.includes(request.capability)) {
      score += 10;
      factors.push({
        id: 'capability.not-in-scope',
        weight: 10,
        note: `capacidad ${request.capability} fuera del alcance autorizado`,
      });
    }

    const clamped = clampScore(score);
    return {
      score: clamped,
      band: riskBand(clamped, DEFAULT_APPROVAL_THRESHOLD),
      factors,
      threshold: DEFAULT_APPROVAL_THRESHOLD,
      provisional: true,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* 5. Policy Engine determinista                                              */
/* -------------------------------------------------------------------------- */

/**
 * - Cualquier regla crítica → `deny` (terminal, sin recuperación ni aprobación).
 * - Capacidad fuera del alcance → `deny` (recuperable sólo por un mecanismo
 *   preaprobado cuyo efecto pase una evaluación fresca).
 * - Herramienta no mediada → `deny`.
 * - Banda `approval` → `require_approval`; `auto`/`controlled` → `allow`.
 */
export class DeterministicPolicyEngine implements PolicyPort {
  readonly version = POLICY_VERSION;

  evaluate(input: PolicyInput): PolicyVerdict {
    const reasons: PolicyReason[] = [];
    const critical = criticalViolationsFor(input.request, input.scope, input.environment);

    if (critical.length > 0) {
      reasons.push({
        code: 'critical_rule',
        detail: `prohibición crítica: ${critical.join(', ')}`,
      });
    } else if (!isKnownTool(input.request.tool)) {
      reasons.push({
        code: 'tool_not_mediated',
        detail: `herramienta fuera del catálogo mediado: ${input.request.tool}`,
      });
    } else if (!input.scope.allowedCapabilities.includes(input.request.capability)) {
      reasons.push({
        code: 'capability_not_in_scope',
        detail: `la tarea no autoriza ${input.request.capability}`,
      });
    } else if (input.risk.band === 'approval') {
      reasons.push({
        code: 'risk_requires_approval',
        detail: `score ${input.risk.score} ≥ ${input.risk.threshold} (umbral provisional)`,
      });
    } else {
      reasons.push({
        code: input.risk.band === 'controlled' ? 'controlled_review_recommended' : 'auto_allowed',
        detail:
          input.risk.band === 'controlled'
            ? `score ${input.risk.score} en banda controlada: se permite y se audita`
            : `score ${input.risk.score} en banda automática`,
      });
    }

    let decision: PolicyVerdict['decision'];
    if (critical.length > 0 || !isKnownTool(input.request.tool)) decision = 'deny';
    else if (!input.scope.allowedCapabilities.includes(input.request.capability)) decision = 'deny';
    else if (input.risk.band === 'approval') decision = 'require_approval';
    else decision = 'allow';

    return {
      decision,
      criticalViolations: critical,
      risk: input.risk,
      reasons,
      policyVersion: this.version,
      fingerprint: input.request.fingerprint,
      decidedAt: input.now,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* 6. Catálogo de recuperación y almacén aprobado                             */
/* -------------------------------------------------------------------------- */

export const APPROVED_MECHANISMS: readonly ApprovedMechanism[] = [
  {
    id: 'approved-dependency-store',
    label: 'Almacén de dependencias preaprobadas (sin salida de red)',
    capabilities: ['pkg.install'],
    effectKinds: ['package.install'],
    networkEgress: 'none',
    requiresApproval: false,
    integrity: 'sha256-pinned',
    grantsNewPrivileges: false,
  },
];

export function findMechanism(id: string): ApprovedMechanism | null {
  return APPROVED_MECHANISMS.find((mechanism) => mechanism.id === id) ?? null;
}

export const RECOVERY_MECHANISM_ID = 'approved-dependency-store';

/** Dependencia del fixture `broken-repo` que el escenario necesita. */
export const APPROVED_PACKAGE_NAME = 'boundary-cost-tools';
export const APPROVED_PACKAGE_VERSION = '1.4.2';

function approvedPackage(): ApprovedPackage {
  const pkg: ApprovedPackage = {
    name: APPROVED_PACKAGE_NAME,
    version: APPROVED_PACKAGE_VERSION,
    sha256: '',
    files: [
      {
        path: 'package.json',
        content: `${JSON.stringify(
          {
            name: APPROVED_PACKAGE_NAME,
            version: APPROVED_PACKAGE_VERSION,
            type: 'commonjs',
            main: 'index.js',
            scripts: {},
          },
          null,
          2,
        )}\n`,
      },
      {
        path: 'index.js',
        content:
          '// materializado desde el almacén preaprobado (sin scripts, hash verificado)\n' +
          'exports.cost = (units) => Math.round(units * 1.25);\n',
      },
    ],
  };
  pkg.sha256 = sha256Hex(canonicalPayload(pkg));
  return pkg;
}

/** Almacén en memoria: el MVP no descarga nada ni sale a la red. */
export function buildApprovedStore(): Store {
  const pkg = approvedPackage();
  return { [`${pkg.name}@${pkg.version}`]: pkg };
}

/** SHA-256 fijado del paquete aprobado (para que el preflight lo declare). */
export function approvedPackageSha256(): string {
  return approvedPackage().sha256;
}

/* -------------------------------------------------------------------------- */
/* 7. Autorización de recuperaciones                                          */
/* -------------------------------------------------------------------------- */

export interface RecoveryAuthorizationInput {
  readonly request: OperationRequest;
  readonly proposal: RecoveryProposal;
  readonly scope: TaskScope;
  readonly policy: PolicyPort;
  readonly risk: RiskPort;
  readonly now: IsoTimestamp;
  readonly approvalUsable: boolean;
  /** true → la aplicación será simulada; los límites del sandbox no se exigen. */
  readonly simulated: boolean;
  readonly limitsReport: SandboxLimitsReport | null;
}

export interface RecoveryAuthorization {
  readonly authorized: boolean;
  readonly verdict: PolicyVerdict;
  readonly blockers: readonly RecoveryBlockReason[];
  readonly notes: readonly string[];
}

/**
 * Alcance de la recuperación: añade únicamente las capacidades del mecanismo
 * aprobado. Nunca amplía hosts, producción ni reglas críticas.
 */
export function recoveryScope(scope: TaskScope, mechanism: ApprovedMechanism): TaskScope {
  const capabilities = new Set<Capability>([...scope.allowedCapabilities, ...mechanism.capabilities]);
  return { ...scope, allowedCapabilities: [...capabilities] };
}

/**
 * Puerta única de autorización de recuperaciones. No consulta al Judge: un
 * diagnóstico favorable no cambia nada aquí.
 */
export function authorizeRecovery(input: RecoveryAuthorizationInput): RecoveryAuthorization {
  const mechanism = findMechanism(input.proposal.mechanism.id);
  const blockers = new Set<RecoveryBlockReason>();
  const notes: string[] = [];

  const mechanismAuthorized = mechanism !== null && !mechanism.grantsNewPrivileges;
  if (!mechanismAuthorized) blockers.add('mechanism_not_authorized');
  else if (mechanism.requiresApproval && !input.approvalUsable) blockers.add('approval_missing');

  const proposedRequest: OperationRequest = {
    ...input.request,
    id: `rec_${input.proposal.id}`,
    capability: input.proposal.mechanism.capabilities[0] ?? input.request.capability,
    effect: input.proposal.proposedEffect,
    args: { name: APPROVED_PACKAGE_NAME, version: APPROVED_PACKAGE_VERSION },
    declaredIntent: `recuperación vía ${input.proposal.mechanism.id}`,
  };
  const scope = mechanism ? recoveryScope(input.scope, mechanism) : input.scope;
  const risk = input.risk.assess(proposedRequest, scope, input.proposal.proposedEffect.environment);
  const verdict = input.policy.evaluate({
    request: proposedRequest,
    scope,
    environment: input.proposal.proposedEffect.environment,
    risk,
    policyVersion: input.policy.version,
    now: input.now,
  });

  if (verdict.criticalViolations.length > 0) blockers.add('critical_rule');
  if (effectsEquivalent(input.proposal.proposedEffect, input.proposal.blockedEffect)) {
    blockers.add('effect_equivalent_to_prohibited');
  }
  const decision = resolvePolicyDecision(verdict);
  if (decision === 'deny' && verdict.criticalViolations.length === 0) blockers.add('effect_not_allowed');
  if (decision === 'require_approval') {
    blockers.add('approval_required');
    if (!input.approvalUsable) blockers.add('approval_missing');
  }

  if (input.simulated) {
    notes.push('aplicación simulada: los límites del sandbox no se verificaron ni se afirman');
  } else if (!isSandboxUsable(input.limitsReport)) {
    blockers.add('sandbox_limits_unverified');
  }

  return { authorized: blockers.size === 0, verdict, blockers: [...blockers].sort(), notes };
}

/** Propuesta determinista desde el incidente hacia el almacén aprobado. */
export function proposeDependencyRecovery(
  incident: IncidentRecord,
  now: IsoTimestamp,
): RecoveryProposal | null {
  const mechanism = findMechanism(RECOVERY_MECHANISM_ID);
  if (!mechanism) return null;
  if (incident.request.tool !== 'pkg.install') return null;
  if (incident.verdict.criticalViolations.length > 0) return null;

  return {
    id: `rec_${incident.id}`,
    incidentId: incident.id,
    mechanism,
    proposedEffect: {
      kinds: mechanism.effectKinds,
      targets: [`${APPROVED_PACKAGE_NAME}@${APPROVED_PACKAGE_VERSION}`],
      environment: 'sandbox',
      irreversible: false,
      externalImpact: false,
    },
    blockedEffect: incident.request.effect,
    steps: [
      'verificar el paquete contra el SHA-256 fijado del almacén preaprobado',
      'rechazar scripts de instalación, symlinks y rutas no relativas',
      'materializar el paquete sin salida de red',
      're-evaluar el efecto con la política antes de aplicar nada',
    ],
    newPolicyVerdictRequired: true,
  };
}

/* -------------------------------------------------------------------------- */
/* 8. Utilidades de estado                                                    */
/* -------------------------------------------------------------------------- */

export function approvalRequestId(prefix: string, fingerprint: OperationFingerprint): ApprovalId {
  return `${prefix}_${fingerprint.slice(0, 16)}`;
}

export function summarizeVerdict(verdict: PolicyVerdict): JsonObject {
  return {
    decision: verdict.decision,
    criticalViolations: [...verdict.criticalViolations],
    score: verdict.risk.score,
    band: verdict.risk.band,
    policyVersion: verdict.policyVersion,
    reasons: verdict.reasons.map((reason) => `${reason.code}: ${reason.detail}`),
  };
}

export function recentEventSummary(events: readonly AuditEvent[]): readonly string[] {
  return events.slice(-5).map((event) => `${event.kind}: ${event.summary}`);
}
