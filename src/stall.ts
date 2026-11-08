/**
 * DETECCIÓN DE ESTANCAMIENTO («stall») — WORKER 01.
 *
 * Motivo real: hoy UNA sola denegación del gateway dispara intervención
 * (`src/intervention.ts:1007-1020`) y dos rojos de la misma llamada bastan.
 * El detector anterior no tenía señal de tiempo ni de progreso, así que
 * frenaba a agentes que estaban trabajando (léase: los controles negativos
 * GAU-002/016/019/023). Este módulo exige ACUMULACIÓN de la misma huella,
 * ventana de repeticiones, y evidencia de ausencia de progreso productivo.
 *
 * REGLAS DE DETECCIÓN (el orden es el de evaluación; documentado y probado):
 *
 * 1. `contractRejection` presente → `contract-rejected`. El contrato rechazó la
 *    llamada concreta; es determinista y no necesita acumulación.
 * 2. Última observación `allowed` o `recovered` → no hay atasco (`null`),
 *    salvo que exista `contractRejection` (regla 1 manda).
 * 3. `tool-failed` (`failed`) aislado → `null`: un rojo es iteración normal.
 * 4. `denied`/`blocked` → `gateway-denied`/`gateway-blocked` SOLO si la misma
 *    huella (tool + args canónicos) acumula ≥ `minBlockedAttempts`
 *    fallos/bloqueos dentro de `repeatWindow`, o si ya hubo un bloqueo previo
 *    de la misma huella. Un único bloqueo → `null` con
 *    `withheld:'un solo bloqueo: puede ser reintento legítimo'`.
 * 5. Observación `approval_required` → `approval-required` al primer intento:
 *    es una parada dura, no un reintento.
 * 6. `repeated-failure` → misma huella ≥ `repeatThreshold` fallos dentro de
 *    `repeatWindow` Y sin progreso productivo: ninguna observación `allowed`
 *    de `fs.write`, `test.run` o `proc.exec` entre el primer y el último fallo
 *    de esa huella. Si hubo progreso → `null` con
 *    `withheld:'hubo progreso entre fallos'`.
 * 7. Señal temporal: `elapsedMs = now - startedAt > slowHealthyMs` Y progreso
 *    productivo dentro de `progressWindow` → `null` con
 *    `withheld:'lento pero progresa'` (lento NO es atascado). No anula las
 *    paradas duras y deterministas de las reglas 1 y 5.
 * 8. `recentTools = history.slice(-6).map(i => i.tool)`, `taskObjective`
 *    recortado a 4000 caracteres, `reason` recortado a 600.
 * 9. Huella canónica: JSON con claves ordenadas de `{tool, args}`; el orden de
 *    inserción de las claves NO altera la huella.
 */

import type { DecideHistoryItem } from './agent.ts';

/* -------------------------------------------------------------------------- */
/* 1. Contrato público                                                        */
/* -------------------------------------------------------------------------- */

export type StallKind =
  | 'contract-rejected'
  | 'gateway-denied'
  | 'gateway-blocked'
  | 'approval-required'
  | 'repeated-failure';

export interface StallThresholds {
  readonly repeatThreshold: number;
  readonly repeatWindow: number;
  readonly minBlockedAttempts: number;
  readonly slowHealthyMs: number;
  readonly progressWindow: number;
}

export const DEFAULT_THRESHOLDS: StallThresholds = Object.freeze({
  repeatThreshold: 2,
  repeatWindow: 12,
  minBlockedAttempts: 2,
  slowHealthyMs: 900_000,
  progressWindow: 6,
});

export interface StallSignal {
  readonly kind: StallKind;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly attempt: number;
  readonly repeats: number;
  readonly consecutiveRepeats: number;
  readonly taskObjective: string;
  readonly recentTools: readonly string[];
  readonly elapsedMs: number;
  readonly lastProgressSeq: number;
  readonly stalledBecause: string;
}

export interface StallDetection {
  readonly signal: StallSignal | null;
  readonly withheld: string | null;
}

export interface StallContractRejection {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly reason: string;
}

export interface StallDetectInput {
  readonly history: readonly DecideHistoryItem[];
  readonly taskObjective: string;
  readonly contractRejection?: StallContractRejection;
  readonly now?: number;
  readonly startedAt?: number;
  readonly thresholds?: Partial<StallThresholds>;
}

/* -------------------------------------------------------------------------- */
/* 2. Constantes y utilidades deterministas                                   */
/* -------------------------------------------------------------------------- */

const MAX_OBJECTIVE_CHARS = 4_000;
const MAX_REASON_CHARS = 600;
const RECENT_TOOLS_WINDOW = 6;
const TRUNCATION_MARKER = '…[truncado]';

/** Forward-compat: `DecideHistoryItem['outcome']` aún no incluye este valor. */
const APPROVAL_OUTCOME = 'approval_required';
const FAILURE_OUTCOMES: ReadonlySet<string> = new Set(['failed', 'denied', 'blocked']);
const GATEWAY_OUTCOMES: ReadonlySet<string> = new Set(['denied', 'blocked']);
/** Sólo estas observaciones `allowed` cuentan como progreso PRODUCTIVO. */
const PRODUCTIVE_TOOLS: ReadonlySet<string> = new Set(['fs.write', 'test.run', 'proc.exec']);

/** Recorta SIN superar `max`: la marca de truncado va dentro del límite. */
function clampText(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  const keep = Math.max(0, max - TRUNCATION_MARKER.length);
  return `${text.slice(0, keep)}${TRUNCATION_MARKER}`;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function resolveThresholds(partial: Partial<StallThresholds> | undefined): StallThresholds {
  return {
    repeatThreshold: clampInt(partial?.repeatThreshold ?? DEFAULT_THRESHOLDS.repeatThreshold, 1, 100, DEFAULT_THRESHOLDS.repeatThreshold),
    repeatWindow: clampInt(partial?.repeatWindow ?? DEFAULT_THRESHOLDS.repeatWindow, 1, 1_000, DEFAULT_THRESHOLDS.repeatWindow),
    minBlockedAttempts: clampInt(partial?.minBlockedAttempts ?? DEFAULT_THRESHOLDS.minBlockedAttempts, 1, 100, DEFAULT_THRESHOLDS.minBlockedAttempts),
    slowHealthyMs: clampInt(partial?.slowHealthyMs ?? DEFAULT_THRESHOLDS.slowHealthyMs, 0, 86_400_000, DEFAULT_THRESHOLDS.slowHealthyMs),
    progressWindow: clampInt(partial?.progressWindow ?? DEFAULT_THRESHOLDS.progressWindow, 1, 1_000, DEFAULT_THRESHOLDS.progressWindow),
  };
}

/** Serialización CANÓNICA de JSON: claves ordenadas, sin depender del orden. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  const parts = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${parts.join(',')}}`;
}

/** Huella estable de un intento: herramienta + args canónicos. */
function fingerprintOf(tool: string, args: Readonly<Record<string, unknown>> | undefined): string {
  return `${tool}::${canonicalJson(args ?? {})}`;
}

/** Copia profunda e inmutable (el detector nunca comparte referencias). */
function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => cloneJson(item))) as unknown as T;
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(source)) copy[key] = cloneJson(source[key]);
  return Object.freeze(copy) as unknown as T;
}

function cloneArgs(value: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> {
  const copy = cloneJson<unknown>(value ?? {});
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) return Object.freeze({});
  return copy as Readonly<Record<string, unknown>>;
}

function outcomeOf(item: DecideHistoryItem): string {
  const outcome: string = item.outcome;
  return outcome;
}

function isFailure(item: DecideHistoryItem): boolean {
  return FAILURE_OUTCOMES.has(outcomeOf(item));
}

function isProductiveAllowed(item: DecideHistoryItem): boolean {
  return outcomeOf(item) === 'allowed' && PRODUCTIVE_TOOLS.has(item.tool);
}

/** 1-based: nº de la última observación productiva, 0 si no hubo ninguna. */
function lastProductiveIndex(history: readonly DecideHistoryItem[]): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item !== undefined && isProductiveAllowed(item)) return index;
  }
  return -1;
}

interface RepeatCounts {
  readonly repeats: number;
  readonly consecutiveRepeats: number;
}

function countRepeats(
  history: readonly DecideHistoryItem[],
  fingerprint: string,
  windowSize: number,
): RepeatCounts {
  const window = history.slice(-windowSize);
  let repeats = 0;
  for (const item of window) {
    if (isFailure(item) && fingerprintOf(item.tool, item.args) === fingerprint) repeats += 1;
  }
  let consecutiveRepeats = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item === undefined) break;
    if (!isFailure(item)) break;
    if (fingerprintOf(item.tool, item.args) !== fingerprint) break;
    consecutiveRepeats += 1;
  }
  return { repeats, consecutiveRepeats };
}

/** Primer y último fallo de una huella en todo el historial. */
function failureSpan(
  history: readonly DecideHistoryItem[],
  fingerprint: string,
): { readonly first: number; readonly last: number } | null {
  let first = -1;
  let last = -1;
  for (let index = 0; index < history.length; index += 1) {
    const item = history[index];
    if (item === undefined || !isFailure(item)) continue;
    if (fingerprintOf(item.tool, item.args) !== fingerprint) continue;
    if (first === -1) first = index;
    last = index;
  }
  if (first === -1 || last === -1 || first === last) return null;
  return { first, last };
}

/** ¿Hubo progreso productivo ENTRE el primer y el último fallo de la huella? */
function hasProgressBetween(
  history: readonly DecideHistoryItem[],
  span: { readonly first: number; readonly last: number },
): boolean {
  for (let index = span.first + 1; index < span.last; index += 1) {
    const item = history[index];
    if (item !== undefined && isProductiveAllowed(item)) return true;
  }
  return false;
}

/** ¿Ya hubo un bloqueo del gateway de la misma huella antes del último intento? */
function hasPriorGatewayBlock(history: readonly DecideHistoryItem[], fingerprint: string): boolean {
  for (let index = 0; index < history.length - 1; index += 1) {
    const item = history[index];
    if (item === undefined) continue;
    if (!GATEWAY_OUTCOMES.has(outcomeOf(item))) continue;
    if (fingerprintOf(item.tool, item.args) === fingerprint) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* 3. Detección                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Evalúa el historial y devuelve la señal de estancamiento (o `null`) junto
 * con `withheld`: el motivo explícito por el que NO se intervino. `withheld`
 * es la prueba auditable de que el agente estaba trabajando.
 */
export function detect(input: StallDetectInput): StallDetection {
  const history: readonly DecideHistoryItem[] = Array.isArray(input.history) ? input.history : [];
  const thresholds = resolveThresholds(input.thresholds);
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
  const elapsedMs =
    typeof input.startedAt === 'number' && Number.isFinite(input.startedAt)
      ? Math.max(0, now - input.startedAt)
      : 0;
  const taskObjective = clampText(String(input.taskObjective ?? ''), MAX_OBJECTIVE_CHARS);
  const recentTools: readonly string[] = Object.freeze(
    history.slice(-RECENT_TOOLS_WINDOW).map((item) => item.tool),
  );
  const lastProgressSeq = lastProductiveIndex(history) + 1;
  const progressInWindow = history.slice(-thresholds.progressWindow).some(isProductiveAllowed);
  const slowButProgressing = elapsedMs > thresholds.slowHealthyMs && progressInWindow;

  const build = (
    kind: StallKind,
    tool: string,
    args: Readonly<Record<string, unknown>> | undefined,
    reason: string,
    repeats: number,
    consecutiveRepeats: number,
    stalledBecause: string,
  ): StallSignal =>
    Object.freeze({
      kind,
      tool,
      args: cloneArgs(args),
      reason: clampText(String(reason ?? ''), MAX_REASON_CHARS),
      attempt: history.length,
      repeats,
      consecutiveRepeats,
      taskObjective,
      recentTools,
      elapsedMs,
      lastProgressSeq,
      stalledBecause,
    });

  // Regla 1: rechazo de contrato. Determinista, manda sobre todo lo demás.
  if (input.contractRejection !== undefined) {
    const { tool, args, reason } = input.contractRejection;
    const fingerprint = fingerprintOf(tool, args);
    const counts = countRepeats(history, fingerprint, thresholds.repeatWindow);
    return {
      signal: build(
        'contract-rejected',
        tool,
        args,
        reason,
        Math.max(1, counts.repeats),
        Math.max(1, counts.consecutiveRepeats),
        'regla 1: el contrato rechazó la llamada concreta; es determinista, no una racha',
      ),
      withheld: null,
    };
  }

  const last = history.at(-1);
  if (last === undefined) return { signal: null, withheld: null };
  const lastOutcome = outcomeOf(last);

  // Regla 2: la última observación fue permitida o se recuperó → no hay atasco.
  if (lastOutcome === 'allowed' || lastOutcome === 'recovered') {
    return { signal: null, withheld: null };
  }

  const lastFingerprint = fingerprintOf(last.tool, last.args);
  const counts = countRepeats(history, lastFingerprint, thresholds.repeatWindow);

  // Regla 5: aprobación pendiente = parada dura, dispara al primer intento.
  if (lastOutcome === APPROVAL_OUTCOME) {
    return {
      signal: build(
        'approval-required',
        last.tool,
        last.args,
        last.detail,
        Math.max(1, counts.repeats),
        Math.max(1, counts.consecutiveRepeats),
        'regla 5: el gateway pidió aprobación humana; es una parada dura al primer intento',
      ),
      withheld: null,
    };
  }

  if (!FAILURE_OUTCOMES.has(lastOutcome)) return { signal: null, withheld: null };

  let signal: StallSignal | null = null;
  let withheld: string | null = null;

  if (GATEWAY_OUTCOMES.has(lastOutcome)) {
    // Regla 4: un solo bloqueo NO es atasco.
    const kind: StallKind = lastOutcome === 'denied' ? 'gateway-denied' : 'gateway-blocked';
    const priorBlock = hasPriorGatewayBlock(history, lastFingerprint);
    if (counts.repeats >= thresholds.minBlockedAttempts || priorBlock) {
      const previous = priorBlock ? ' y ya había un bloqueo previo de la misma huella' : '';
      signal = build(
        kind,
        last.tool,
        last.args,
        last.detail,
        Math.max(1, counts.repeats),
        counts.consecutiveRepeats,
        `regla 4: ${Math.max(1, counts.repeats)} ${lastOutcome} de la misma huella en ${thresholds.repeatWindow} intentos (umbral ${thresholds.minBlockedAttempts})${previous}`,
      );
    } else {
      withheld = 'un solo bloqueo: puede ser reintento legítimo';
    }
  } else if (counts.repeats >= thresholds.repeatThreshold) {
    // Regla 6: repetición de la misma huella SIN progreso productivo.
    const span = failureSpan(history, lastFingerprint);
    if (span !== null && hasProgressBetween(history, span)) {
      withheld = 'hubo progreso entre fallos';
    } else {
      signal = build(
        'repeated-failure',
        last.tool,
        last.args,
        last.detail,
        Math.max(1, counts.repeats),
        counts.consecutiveRepeats,
        `regla 6: ${Math.max(1, counts.repeats)} fallos de la misma huella en ${thresholds.repeatWindow} intentos sin ninguna escritura/test/comando exitoso intermedio (umbral ${thresholds.repeatThreshold})`,
      );
    }
  }
  // Regla 3 implícita: un único `failed` no produce señal ni `withheld`.

  // Regla 7: lento pero progresa no es un atasco.
  if (signal !== null && slowButProgressing) {
    return { signal: null, withheld: 'lento pero progresa' };
  }

  return { signal, withheld };
}

/** Atajo booleano: la señal de estancamiento, si la hay. */
export const detectStall = (input: Parameters<typeof detect>[0]): StallSignal | null => detect(input).signal;

/* -------------------------------------------------------------------------- */
/* 4. Explicación legible                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Explica la señal en texto no vacío, incluyendo la regla que la disparó.
 * Es lo que se muestra al operador y lo que se adjunta al parte de incidencia.
 */
export function explainDetection(signal: StallSignal): string {
  const lines: string[] = [
    `Estancamiento detectado: ${signal.kind} en el intento ${signal.attempt}.`,
    `Regla aplicada — ${signal.stalledBecause}.`,
    `Herramienta: ${signal.tool}.`,
    `Repeticiones de la huella: ${signal.repeats} (consecutivas: ${signal.consecutiveRepeats}).`,
  ];
  lines.push(`Motivo: ${signal.reason.length > 0 ? signal.reason : '(sin detalle)'}.`);
  lines.push(`Objetivo: ${signal.taskObjective.length > 0 ? signal.taskObjective : '(no declarado)'}.`);
  if (signal.recentTools.length > 0) {
    lines.push(`Herramientas recientes: ${signal.recentTools.join(' → ')}.`);
  }
  if (signal.elapsedMs > 0) {
    lines.push(`Tiempo transcurrido: ${Math.round(signal.elapsedMs / 1000)}s.`);
  }
  lines.push(
    signal.lastProgressSeq > 0
      ? `Último progreso productivo en la observación nº ${signal.lastProgressSeq}.`
      : 'Sin progreso productivo registrado.',
  );
  return lines.join('\n');
}
