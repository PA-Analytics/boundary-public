/**
 * Preflight — prevención selectiva y preparación autorizada.
 *
 * MVP local sin claves ni red: funciones puras y deterministas.
 * Solo prepara dependencias DECLARADAS en la tarea; nunca concede
 * permisos nuevos ni descarga nada. La integración remota (p. ej.
 * Vultr) se inyecta después por configuración, sin cambiar el contrato.
 */

export interface DeclaredDependency {
  /** Nombre del paquete, formato restringido (sin rutas ni URLs). */
  name: string;
  /** Versión exacta, p. ej. "1.2.3". */
  version: string;
  /** SHA-256 hex del payload canónico esperado en el almacén preaprobado. */
  sha256: string;
}

export interface PreflightInput {
  objective: string;
  successCriteria?: string[];
  estimatedActions?: number;
  estimatedDurationMinutes?: number;
  /** true si la tarea toca producción, secretos, red externa o datos reales. */
  sensitive?: boolean;
  declaredDependencies?: DeclaredDependency[];
  capabilities?: string[];
}

export interface ExecutionManifest {
  objective: string;
  successCriteria: string[];
  fullPreflight: boolean;
  declaredDependencies: DeclaredDependency[];
  /** Dependencias declaradas válidas, listas para materializar vía Lifeguard. */
  prepared: string[];
  /** Dependencias declaradas inválidas con su motivo. */
  rejected: Array<{ key: string; reason: string }>;
  approvalPoints: string[];
  capabilities: string[];
}

export const FULL_PREFLIGHT_ACTION_THRESHOLD = 10;
export const FULL_PREFLIGHT_DURATION_MINUTES_THRESHOLD = 10;

/** Nombres permitidos: minúsculas, dígitos, `.` `_` `-`; sin `/`, `\`, `..`, URLs. */
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function isSafeDeclaredName(name: string): boolean {
  return SAFE_NAME_RE.test(name);
}

export function isSafeDeclaredVersion(version: string): boolean {
  return SAFE_VERSION_RE.test(version) && !version.includes("..");
}

export function isValidDeclaredDependency(d: DeclaredDependency): boolean {
  return (
    isSafeDeclaredName(d.name) &&
    isSafeDeclaredVersion(d.version) &&
    SHA256_RE.test(d.sha256)
  );
}

/**
 * Preflight selectivo: completo solo para tareas largas, con muchos
 * pasos o sensibles. Determinista; el agente no puede autoeximirse:
 * la decisión depende de parámetros verificables, no de su opinión.
 */
export function shouldRunFullPreflight(input: PreflightInput): boolean {
  if (input.sensitive) return true;
  if ((input.estimatedActions ?? 0) > FULL_PREFLIGHT_ACTION_THRESHOLD) return true;
  if ((input.estimatedDurationMinutes ?? 0) > FULL_PREFLIGHT_DURATION_MINUTES_THRESHOLD)
    return true;
  return false;
}

export function approvalPointsFor(input: PreflightInput): string[] {
  const points: string[] = [];
  if (input.sensitive) points.push("sensitive-scope: explicit approval required");
  const deps = input.declaredDependencies ?? [];
  if (deps.length > 0)
    points.push(`declared-dependencies: materialize only from pre-approved store (${deps.length})`);
  return points;
}

function storeKey(d: Pick<DeclaredDependency, "name" | "version">): string {
  return `${d.name}@${d.version}`;
}

/**
 * Construye el manifiesto de ejecución. No realiza E/S ni red.
 * Las dependencias no declaradas o malformadas quedan en `rejected`
 * y nunca se preparan (evitan el bloqueo solo las declaradas válidas).
 */
export function buildManifest(input: PreflightInput): ExecutionManifest {
  const declared = input.declaredDependencies ?? [];
  const prepared: string[] = [];
  const rejected: Array<{ key: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const d of declared) {
    const key = storeKey(d);
    if (seen.has(key)) {
      rejected.push({ key, reason: "duplicate declaration" });
      continue;
    }
    seen.add(key);
    if (!isValidDeclaredDependency(d)) {
      rejected.push({ key, reason: "invalid name, version or sha256 format" });
      continue;
    }
    prepared.push(key);
  }
  return {
    objective: input.objective,
    successCriteria: input.successCriteria ?? [],
    fullPreflight: shouldRunFullPreflight(input),
    declaredDependencies: declared,
    prepared,
    rejected,
    approvalPoints: approvalPointsFor(input),
    capabilities: input.capabilities ?? [],
  };
}
