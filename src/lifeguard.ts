/**
 * Lifeguard — recuperación segura desde almacén preaprobado.
 *
 * Reglas deterministas (por encima de cualquier score u opinión):
 *  1. Efectos críticos → siempre `rejected`, sin ruta de recuperación.
 *  2. Solo se recupera lo declarado + preaprobado + hash verificado.
 *  3. Sin scripts, sin symlinks, sin rutas absolutas ni traversal,
 *     con límite de tamaño. Sin red ni E/S: el llamante aporta el store.
 *  4. Mecanismo Y efecto deben estar autorizados (no eludir por otra ruta).
 */

import { createHash } from "node:crypto";

/** Efectos prohibidos: fuera del mecanismo de puntuación. */
export const CRITICAL_EFFECTS = [
  "sandbox-escape",
  "production-write",
  "secret-access",
  "unrestricted-network",
  "data-destruction",
] as const;

export type CriticalEffect = (typeof CRITICAL_EFFECTS)[number];

export function isCriticalEffect(effect: string): boolean {
  return (CRITICAL_EFFECTS as readonly string[]).includes(effect);
}

export interface StoreFile {
  /** Ruta relativa dentro del destino, p. ej. "lib/util.js". */
  path: string;
  content: string;
  /** Los symlinks están prohibidos; este flag solo existe para rechazarlos. */
  symlink?: boolean;
}

export interface ApprovedPackage {
  name: string;
  version: string;
  /** SHA-256 hex del payload canónico (ver `canonicalPayload`). */
  sha256: string;
  files: StoreFile[];
  /** Cualquier script de instalación invalida el paquete. */
  scripts?: Record<string, string>;
}

export type Store = Record<string, ApprovedPackage>;

export interface RecoveryRequest {
  incidentId: string;
  /** Efecto final que el agente quería conseguir (no solo el procedimiento). */
  effect: string;
  packageName: string;
  packageVersion: string;
}

export type RecoveryOutcome = "recovered" | "rejected" | "needs-approval";

export interface RecoveryResult {
  outcome: RecoveryOutcome;
  reason: string;
  files?: StoreFile[];
}

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_FILES = 50;

export function storeKey(name: string, version: string): string {
  return `${name}@${version}`;
}

/** Payload canónico para el hash: JSON determinista ordenado por path. */
export function canonicalPayload(pkg: Pick<ApprovedPackage, "name" | "version" | "files">): string {
  const sorted = [...pkg.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    files: sorted.map((f) => ({ path: f.path, content: f.content })),
  });
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Rechaza absolutas, `..`, backslashes, drive letters, vacías y `.` solo. */
export function isSafeEntryPath(p: string): boolean {
  if (!p || p === "." || p.length > 256) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  if (p.includes("\\")) return false;
  if (p.includes("\0")) return false;
  const segs = p.split("/");
  for (const s of segs) {
    if (!s || s === "." || s === "..") return false;
  }
  return true;
}

export function validateStoreEntry(pkg: ApprovedPackage): { ok: boolean; reason?: string } {
  if (pkg.scripts && Object.keys(pkg.scripts).length > 0)
    return { ok: false, reason: "install scripts are forbidden" };
  if (pkg.files.length === 0) return { ok: false, reason: "empty package" };
  if (pkg.files.length > MAX_FILES) return { ok: false, reason: "too many files" };
  const seen = new Set<string>();
  for (const f of pkg.files) {
    if (f.symlink) return { ok: false, reason: `symlink forbidden: ${f.path}` };
    if (!isSafeEntryPath(f.path)) return { ok: false, reason: `unsafe path: ${f.path}` };
    if (seen.has(f.path)) return { ok: false, reason: `duplicate path: ${f.path}` };
    seen.add(f.path);
    if (Buffer.byteLength(f.content, "utf8") > MAX_FILE_BYTES)
      return { ok: false, reason: `file too large: ${f.path}` };
  }
  return { ok: true };
}

/**
 * Intenta recuperar desde el almacén preaprobado.
 * `allowedEffects`: efectos autorizados para esta tarea; si se aporta y
 * el efecto no está incluido → `rejected` (el mecanismo no basta, el
 * efecto también debe estar permitido). `undefined` = sin allowlist
 * adicional, pero los efectos críticos siguen bloqueados siempre.
 */
export function recoverFromStore(
  request: RecoveryRequest,
  store: Store,
  opts?: { allowedEffects?: string[] },
): RecoveryResult {
  // 1. Prohibición crítica: prioridad absoluta, sin recuperación posible.
  if (isCriticalEffect(request.effect)) {
    return {
      outcome: "rejected",
      reason: `critical effect '${request.effect}' is never recoverable`,
    };
  }
  // 2. El efecto debe estar autorizado (anti-elusión por ruta alternativa).
  if (opts?.allowedEffects !== undefined && !opts.allowedEffects.includes(request.effect)) {
    return { outcome: "rejected", reason: `effect '${request.effect}' is not authorized` };
  }
  // 3. Solo paquetes preaprobados con clave exacta nombre@versión.
  const key = storeKey(request.packageName, request.packageVersion);
  const pkg = store[key];
  if (!pkg) {
    return { outcome: "needs-approval", reason: `package '${key}' is not pre-approved` };
  }
  if (pkg.name !== request.packageName || pkg.version !== request.packageVersion) {
    return { outcome: "rejected", reason: "store key mismatch" };
  }
  // 4. Sin scripts ni extracción peligrosa.
  const valid = validateStoreEntry(pkg);
  if (!valid.ok) return { outcome: "rejected", reason: valid.reason ?? "invalid package" };
  // 5. Integridad: hash del payload canónico.
  const actual = sha256Hex(canonicalPayload(pkg));
  if (actual !== pkg.sha256.toLowerCase()) {
    return { outcome: "rejected", reason: "hash mismatch: package altered" };
  }
  return { outcome: "recovered", reason: `materialized '${key}' from pre-approved store`, files: pkg.files };
}
