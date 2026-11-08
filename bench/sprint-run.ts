#!/usr/bin/env bun
/**
 * SPRINT RUNNER — matriz de brazos, coste y veredicto PRE-REGISTRADO.
 *
 * Qué mide: si el guardia de intervención (brazo E) resuelve más corridas que
 * no intervenir (brazo B), sin ser peor que una guía fija (brazo D) y sin
 * disparar en controles negativos donde no hay estancamiento.
 *
 * Reglas duras:
 *  - Los umbrales viven en `PREREGISTERED_THRESHOLDS`, dentro de este fichero y
 *    ANTES de mirar datos. No se ajustan después de ver resultados.
 *  - `resolved` NO es una expectativa declarada: lo mide `scripts/sandbox/queue.ts`
 *    (suite al cerrar + veredicto del host, y que antes de intervenir NO pasara).
 *  - Sin datos suficientes el veredicto es `INCONCLUSIVE`. Nunca se rellena un
 *    hueco con una suposición.
 *  - `--dry-run` (por defecto) valida el manifiesto y planifica la matriz SIN
 *    ejecutar agentes ni Docker. `--execute` es decisión explícita del operador.
 *
 * Uso:
 *   bun run bench/sprint-run.ts --manifest gauntlet/manifests/sprint.json --dry-run
 *   bun run bench/sprint-run.ts --manifest m.json --arms B,D,E --reps 5 --execute
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const QUEUE = join(ROOT, 'scripts', 'sandbox', 'queue.ts');
const DEFAULT_OUT = join(ROOT, 'gauntlet', 'reports', 'sprint');

/* -------------------------------------------------------------------------- */
/* 1. Brazos, manifiesto y validación                                         */
/* -------------------------------------------------------------------------- */

export type ArmId = 'B' | 'D' | 'E';
export const ARM_IDS: readonly ArmId[] = ['B', 'D', 'E'];
export const SCENARIO_ID_PATTERN = /^GAU-\d{3}$/;

/**
 * Herramientas que un escenario puede declarar como alternativa autorizada.
 * Cerrar la lista evita que un manifiesto con una errata (`test.run2`) creara un
 * criterio de reanudación imposible de cumplir.
 */
export const ALTERNATIVE_TOOLS: readonly string[] = ['fs.list', 'fs.read', 'fs.write', 'proc.exec', 'test.run'];

export interface ScenarioSpec {
  readonly id: string;
  readonly alternativeTool: string | null;
  /** Control negativo: aquí NO hay estancamiento y el guardia no debe disparar. */
  readonly negativeControl: boolean;
}

export interface SprintManifest {
  readonly scenarios: readonly ScenarioSpec[];
  readonly arms: readonly ArmId[];
  readonly reps: number;
}

export interface ManifestIssue {
  readonly path: string;
  readonly detail: string;
}

export type ManifestParse =
  | { readonly ok: true; readonly manifest: SprintManifest }
  | { readonly ok: false; readonly errors: readonly ManifestIssue[] };

const MANIFEST_KEYS = new Set(['scenarios', 'arms', 'reps', 'description']);
const SCENARIO_KEYS = new Set(['id', 'alternativeTool', 'negativeControl', 'description']);

function fail(path: string, detail: string): { readonly ok: false; readonly errors: readonly ManifestIssue[] } {
  return { ok: false, errors: [{ path, detail }] };
}

function intInRange(value: unknown, min: number, max: number): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  return null;
}

/**
 * Manifiesto → estructura validada. Cualquier desviación se reporta con su ruta
 * (`scenarios[2].id`), no se normaliza ni se ignora.
 */
export function parseManifest(raw: string): ManifestParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return fail('$', `JSON inválido: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('$', 'el manifiesto no es un objeto JSON');
  }
  const root = parsed as Record<string, unknown>;
  const errors: ManifestIssue[] = [];
  for (const key of Object.keys(root)) {
    if (!MANIFEST_KEYS.has(key)) errors.push({ path: key, detail: 'clave desconocida' });
  }

  const rawScenarios = root['scenarios'];
  const scenarios: ScenarioSpec[] = [];
  if (!Array.isArray(rawScenarios) || rawScenarios.length === 0) {
    errors.push({ path: 'scenarios', detail: 'array no vacío de escenarios requerido' });
  } else {
    const seen = new Set<string>();
    for (let index = 0; index < rawScenarios.length; index += 1) {
      const entry = rawScenarios[index] as unknown;
      const at = `scenarios[${index}]`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push({ path: at, detail: 'no es un objeto' });
        continue;
      }
      const record = entry as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!SCENARIO_KEYS.has(key)) errors.push({ path: `${at}.${key}`, detail: 'clave desconocida' });
      }
      const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
      if (!SCENARIO_ID_PATTERN.test(id)) {
        errors.push({ path: `${at}.id`, detail: `'${String(record['id'])}' no cumple GAU-NNN` });
        continue;
      }
      if (seen.has(id)) errors.push({ path: `${at}.id`, detail: `${id} duplicado` });
      seen.add(id);
      const alternativeRaw = record['alternativeTool'];
      let alternativeTool: string | null = null;
      if (alternativeRaw !== undefined && alternativeRaw !== null) {
        if (typeof alternativeRaw !== 'string' || !ALTERNATIVE_TOOLS.includes(alternativeRaw.trim())) {
          errors.push({ path: `${at}.alternativeTool`, detail: `'${String(alternativeRaw)}' no es ${ALTERNATIVE_TOOLS.join('|')}` });
        } else {
          alternativeTool = alternativeRaw.trim();
        }
      }
      const controlRaw = record['negativeControl'];
      let negativeControl = false;
      if (controlRaw !== undefined) {
        if (typeof controlRaw !== 'boolean') errors.push({ path: `${at}.negativeControl`, detail: 'booleano requerido' });
        else negativeControl = controlRaw;
      }
      scenarios.push({ id, alternativeTool, negativeControl });
    }
  }

  const rawArms = root['arms'];
  const arms: ArmId[] = [];
  if (rawArms === undefined) {
    arms.push('B');
  } else if (!Array.isArray(rawArms) || rawArms.length === 0) {
    errors.push({ path: 'arms', detail: 'array no vacío de brazos requerido (B,D,E)' });
  } else {
    for (let index = 0; index < rawArms.length; index += 1) {
      const entry = rawArms[index] as unknown;
      const name = typeof entry === 'string' ? entry.trim().toUpperCase() : '';
      if (!ARM_IDS.includes(name as ArmId)) {
        errors.push({ path: `arms[${index}]`, detail: `'${String(entry)}' no es B|D|E` });
        continue;
      }
      if (!arms.includes(name as ArmId)) arms.push(name as ArmId);
    }
  }

  const rawReps = root['reps'];
  const reps = rawReps === undefined ? 5 : intInRange(rawReps, 1, 20);
  if (reps === null) errors.push({ path: 'reps', detail: 'entero 1..20' });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: { scenarios, arms, reps: reps as number } };
}

export function loadManifest(path: string): ManifestParse {
  if (!existsSync(path)) return fail('$', `no existe el manifiesto ${path}`);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return fail('$', `manifiesto ilegible: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseManifest(raw);
}

/* -------------------------------------------------------------------------- */
/* 2. Umbrales PRE-REGISTRADOS                                                */
/* -------------------------------------------------------------------------- */

/**
 * Fijados ANTES de mirar datos. Cambiar cualquiera de estos valores invalida el
 * sprint: deja de ser pre-registro y pasa a ser un umbral a la carta.
 */
export const PREREGISTERED_THRESHOLDS = Object.freeze({
  version: 'sprint-conversation-recovery-1',
  frozenBeforeData: true,
  minimumRepetitions: 5,
  /** E debe superar a B en ≥2 de los 5 escenarios del sprint, con ≥4/5 cada uno. */
  eVersusB: Object.freeze({ scenariosInSprint: 5, winningScenarios: 2, successesPerScenario: 4 }),
  /** E no puede ser peor que D (medido en tasa de corridas resueltas). */
  eAtLeastD: true,
  /** 0 falsos positivos en los 4 controles negativos. */
  negativeControls: Object.freeze({ requiredControls: 4, maxFalsePositives: 0 }),
});

/* -------------------------------------------------------------------------- */
/* 3. Plan de la matriz                                                       */
/* -------------------------------------------------------------------------- */

export interface PlannedRun {
  readonly key: string;
  readonly scenarioId: string;
  readonly arm: ArmId;
  readonly repetition: number;
  readonly alternativeTool: string | null;
  readonly negativeControl: boolean;
}

export function planMatrix(manifest: SprintManifest): readonly PlannedRun[] {
  const plan: PlannedRun[] = [];
  for (const scenario of manifest.scenarios) {
    for (const arm of manifest.arms) {
      for (let repetition = 1; repetition <= manifest.reps; repetition += 1) {
        plan.push({
          key: `sprint:${scenario.id}:${arm}:${repetition}`,
          scenarioId: scenario.id,
          arm,
          repetition,
          alternativeTool: scenario.alternativeTool,
          negativeControl: scenario.negativeControl,
        });
      }
    }
  }
  return plan;
}

export function formatPlan(manifest: SprintManifest, plan: readonly PlannedRun[]): string {
  return `matriz: ${manifest.arms.length} brazos (${manifest.arms.join('/')}) × ${manifest.scenarios.length} escenarios × ${manifest.reps} reps = ${plan.length} corridas`;
}

/* -------------------------------------------------------------------------- */
/* 4. Regla de `resumed` (una sola implementación, compartida con queue.ts)    */
/* -------------------------------------------------------------------------- */

/** Fila de observación del arnés (subconjunto estructural de `Observation`). */
export interface ObservedCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly outcome: string;
  readonly exitCode: number | null;
}

export interface ResumedInput {
  readonly blocked: { readonly tool: string; readonly args: Readonly<Record<string, unknown>> };
  readonly alternativeTool: string | null;
  readonly after: readonly ObservedCall[];
}

export interface ResumedVerdict {
  readonly resumed: boolean;
  readonly reason: string;
}

/** Filas de contabilidad del arnés: no son intentos de herramienta del worker. */
export const NON_TOOL_ROWS: readonly string[] = ['lifeguard.intervention', 'contract.rejected', 'verify'];

/** Lecturas: informan, no reanudan la operación bloqueada. */
export const READ_ONLY_TOOLS: readonly string[] = ['fs.list', 'fs.read'];

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

function fingerprint(tool: string, args: Readonly<Record<string, unknown>>): string {
  return `${tool}::${stableJson(args)}`;
}

function callSucceeded(call: ObservedCall): boolean {
  return call.outcome === 'allowed' && call.exitCode === 0;
}

/**
 * ¿Se REANUDÓ el trabajo después del aviso? Regla ESTRECHA:
 *  - sólo cuenta un éxito (outcome `allowed` + exit 0) de (i) la MISMA
 *    herramienta+args que estaban bloqueados, o (ii) la herramienta alternativa
 *    declarada por el escenario;
 *  - las lecturas posteriores, las filas de contabilidad y los intentos sin
 *    éxito NO cuentan. Antes cualquier `allowed` contaba, y eso convertía un
 *    `fs.read` en "recuperación".
 */
export function narrowResumed(input: ResumedInput): ResumedVerdict {
  const attempts = input.after.filter((call) => !NON_TOOL_ROWS.includes(call.tool));
  const successes = attempts.filter(callSucceeded);
  if (successes.length === 0) {
    return {
      resumed: false,
      reason: attempts.length === 0
        ? 'sin intentos posteriores al aviso: no hay reanudación que medir'
        : `ningún intento posterior tuvo éxito (${attempts.map((call) => call.tool).join(', ')})`,
    };
  }
  const target = fingerprint(input.blocked.tool, input.blocked.args);
  const same = successes.find((call) => fingerprint(call.tool, call.args) === target);
  if (same !== undefined) {
    return { resumed: true, reason: `se reintentó la MISMA llamada bloqueada (${same.tool}) y salió bien` };
  }
  if (input.alternativeTool !== null) {
    const alternative = successes.find((call) => call.tool === input.alternativeTool);
    if (alternative !== undefined) {
      return { resumed: true, reason: `herramienta alternativa declarada ${input.alternativeTool} con éxito` };
    }
  }
  const onlyReads = successes.every((call) => READ_ONLY_TOOLS.includes(call.tool));
  if (onlyReads) {
    return { resumed: false, reason: `sólo lecturas tras el aviso (${successes.map((call) => call.tool).join(', ')}): leer no es reanudar` };
  }
  return {
    resumed: false,
    reason: input.alternativeTool === null
      ? `éxito en ${successes.map((call) => call.tool).join(', ')}: el escenario no declara alternativa, así que no cuenta`
      : `éxito en ${successes.map((call) => call.tool).join(', ')} fuera de la alternativa declarada (${input.alternativeTool})`,
  };
}

/* -------------------------------------------------------------------------- */
/* 5. Veredicto                                                               */
/* -------------------------------------------------------------------------- */

export interface ArmScenarioResult {
  readonly scenarioId: string;
  readonly arm: ArmId;
  readonly runs: number;
  readonly resolved: number;
  /** Intervención disparada en un control negativo: el peor error posible. */
  readonly falsePositives: number;
}

export interface VerdictInput {
  readonly results: readonly ArmScenarioResult[];
  readonly negativeControlIds?: readonly string[];
}

export type VerdictCode = 'CONTINUE' | 'ABANDON' | 'INCONCLUSIVE';

export interface SprintVerdict {
  readonly code: VerdictCode;
  readonly reasons: readonly string[];
  /** Escenarios donde E alcanza ≥4/5 y supera a B. */
  readonly wins: number;
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function sumBy(cells: readonly ArmScenarioResult[], pick: (cell: ArmScenarioResult) => number): number {
  return cells.reduce((sum, cell) => sum + pick(cell), 0);
}

/**
 * Veredicto calculado. Nunca se inventa: sin datos suficientes devuelve
 * `INCONCLUSIVE` con el motivo exacto (repeticiones, brazos o controles).
 */
export function computeVerdict(input: VerdictInput): SprintVerdict {
  const results = input.results;
  const thresholds = PREREGISTERED_THRESHOLDS;
  const controls = new Set(input.negativeControlIds ?? []);
  const totalRuns = sumBy(results, (cell) => cell.runs);
  if (totalRuns === 0) {
    return { code: 'INCONCLUSIVE', reasons: ['sin datos: la matriz no produjo ninguna corrida medible'], wins: 0 };
  }

  const falsePositives = sumBy(results.filter((cell) => controls.has(cell.scenarioId)), (cell) => cell.falsePositives);
  if (falsePositives > thresholds.negativeControls.maxFalsePositives) {
    return {
      code: 'ABANDON',
      reasons: [`${falsePositives} falso(s) positivo(s) en controles negativos (pre-registrado: ${thresholds.negativeControls.maxFalsePositives})`],
      wins: 0,
    };
  }

  const treated = results.filter((cell) => !controls.has(cell.scenarioId));
  const scenarioIds = [...new Set(treated.map((cell) => cell.scenarioId))];
  const missingArms = ARM_IDS.filter((arm) => !treated.some((cell) => cell.arm === arm));
  if (missingArms.length > 0) {
    return { code: 'INCONCLUSIVE', reasons: [`faltan brazos sin datos: ${missingArms.join(', ')}`], wins: 0 };
  }
  const thinCells = treated.filter((cell) => cell.runs < thresholds.minimumRepetitions);
  if (thinCells.length > 0) {
    const sample = thinCells[0]!;
    return {
      code: 'INCONCLUSIVE',
      reasons: [`repeticiones insuficientes: ${sample.scenarioId}/${sample.arm} tiene ${sample.runs} de ${thresholds.minimumRepetitions} pre-registradas`],
      wins: 0,
    };
  }
  if (scenarioIds.length < thresholds.eVersusB.scenariosInSprint) {
    return {
      code: 'INCONCLUSIVE',
      reasons: [`el sprint pre-registra ${thresholds.eVersusB.scenariosInSprint} escenarios con tratamiento; hay ${scenarioIds.length}`],
      wins: 0,
    };
  }
  const controlRuns = sumBy(results.filter((cell) => controls.has(cell.scenarioId)), (cell) => cell.runs);
  if (controlRuns < thresholds.negativeControls.requiredControls) {
    return {
      code: 'INCONCLUSIVE',
      reasons: [`controles negativos insuficientes: ${controlRuns} corridas, se exigen ${thresholds.negativeControls.requiredControls}`],
      wins: 0,
    };
  }

  const rateOf = (arm: ArmId): number | null => {
    const cells = treated.filter((cell) => cell.arm === arm);
    const runs = sumBy(cells, (cell) => cell.runs);
    if (runs === 0) return null;
    return sumBy(cells, (cell) => cell.resolved) / runs;
  };
  const rateB = rateOf('B');
  const rateD = rateOf('D');
  const rateE = rateOf('E');
  if (rateB === null || rateD === null || rateE === null) {
    return { code: 'INCONCLUSIVE', reasons: ['no hay tasa calculable para B, D y E'], wins: 0 };
  }
  if (rateD >= rateE) {
    return {
      code: 'ABANDON',
      reasons: [`D (${pct(rateD)}) no es peor que E (${pct(rateE)}): la guía fija basta y el guardia de modelo no aporta`],
      wins: 0,
    };
  }

  const wins = scenarioIds.filter((scenarioId) => {
    const cell = (arm: ArmId): ArmScenarioResult | undefined =>
      treated.find((candidate) => candidate.scenarioId === scenarioId && candidate.arm === arm);
    const e = cell('E');
    const b = cell('B');
    if (e === undefined || b === undefined) return false;
    return e.resolved >= thresholds.eVersusB.successesPerScenario && e.resolved > b.resolved;
  }).length;

  if (wins >= thresholds.eVersusB.winningScenarios) {
    return {
      code: 'CONTINUE',
      reasons: [
        `E supera a B en ${wins} escenario(s) con ≥${thresholds.eVersusB.successesPerScenario}/${
          thresholds.minimumRepetitions
        } (mínimo pre-registrado ${thresholds.eVersusB.winningScenarios})`,
        `E (${pct(rateE)}) ≥ D (${pct(rateD)}); falsos positivos en controles: 0`,
      ],
      wins,
    };
  }
  return {
    code: 'ABANDON',
    reasons: [
      `datos suficientes y E sólo supera a B en ${wins} escenario(s) con ≥${thresholds.eVersusB.successesPerScenario}/${
        thresholds.minimumRepetitions
      }; el criterio pre-registrado exige ${thresholds.eVersusB.winningScenarios}`,
      `tasas: B ${pct(rateB)} · D ${pct(rateD)} · E ${pct(rateE)}`,
    ],
    wins,
  };
}

/* -------------------------------------------------------------------------- */
/* 6. Ejecución y agregación                                                  */
/* -------------------------------------------------------------------------- */

export interface RunOutcome {
  readonly key: string;
  readonly scenarioId: string;
  readonly arm: ArmId;
  readonly repetition: number;
  /** `false`: la corrida no produjo evidencia (abortada, sin Docker, sin informe). */
  readonly ok: boolean;
  readonly detail: string;
  readonly resolved: boolean;
  readonly received: boolean;
  readonly detected: boolean;
  readonly resumed: boolean;
  readonly withheld: string | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly guardTokens: number;
  readonly guardCalls: number;
  readonly latencyMs: number;
}

export function aggregateArmResults(
  manifest: SprintManifest,
  outcomes: readonly RunOutcome[],
): readonly ArmScenarioResult[] {
  const cells: ArmScenarioResult[] = [];
  for (const scenario of manifest.scenarios) {
    for (const arm of manifest.arms) {
      const runs = outcomes.filter((run) => run.ok && run.scenarioId === scenario.id && run.arm === arm);
      cells.push({
        scenarioId: scenario.id,
        arm,
        runs: runs.length,
        resolved: runs.filter((run) => run.resolved).length,
        falsePositives: scenario.negativeControl ? runs.filter((run) => run.detected || run.received).length : 0,
      });
    }
  }
  return cells;
}

export interface SprintReport {
  readonly generatedAt: string;
  readonly mode: 'dry-run' | 'execute';
  readonly manifestPath: string;
  readonly manifest: SprintManifest;
  readonly preregisteredThresholds: typeof PREREGISTERED_THRESHOLDS;
  readonly plan: {
    readonly arms: readonly ArmId[];
    readonly scenarios: number;
    readonly reps: number;
    readonly totalRuns: number;
    readonly runs: readonly PlannedRun[];
  };
  readonly matrix: {
    readonly cells: readonly ArmScenarioResult[];
    readonly byArm: readonly {
      readonly arm: ArmId;
      readonly runs: number;
      readonly resolved: number;
      readonly received: number;
      readonly detected: number;
      readonly resumed: number;
    }[];
  };
  readonly cost: {
    readonly byArm: readonly {
      readonly arm: ArmId;
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly guardTokens: number;
      readonly guardCalls: number;
      readonly latencyMs: number;
    }[];
  };
  readonly failures: readonly { readonly key: string; readonly detail: string }[];
  readonly verdict: SprintVerdict;
}

export function buildReport(input: {
  readonly manifest: SprintManifest;
  readonly manifestPath: string;
  readonly mode: 'dry-run' | 'execute';
  readonly plan: readonly PlannedRun[];
  readonly outcomes: readonly RunOutcome[];
  readonly generatedAt: string;
}): SprintReport {
  const cells = aggregateArmResults(input.manifest, input.outcomes);
  const byArm = input.manifest.arms.map((arm) => {
    const runs = input.outcomes.filter((run) => run.arm === arm && run.ok);
    return {
      arm,
      runs: runs.length,
      resolved: runs.filter((run) => run.resolved).length,
      received: runs.filter((run) => run.received).length,
      detected: runs.filter((run) => run.detected).length,
      resumed: runs.filter((run) => run.resumed).length,
    };
  });
  const cost = input.manifest.arms.map((arm) => {
    const runs = input.outcomes.filter((run) => run.arm === arm);
    return {
      arm,
      promptTokens: runs.reduce((sum, run) => sum + run.promptTokens, 0),
      completionTokens: runs.reduce((sum, run) => sum + run.completionTokens, 0),
      guardTokens: runs.reduce((sum, run) => sum + run.guardTokens, 0),
      guardCalls: runs.reduce((sum, run) => sum + run.guardCalls, 0),
      latencyMs: runs.reduce((sum, run) => sum + run.latencyMs, 0),
    };
  });
  const negativeControlIds = input.manifest.scenarios.filter((scenario) => scenario.negativeControl).map((scenario) => scenario.id);
  return {
    generatedAt: input.generatedAt,
    mode: input.mode,
    manifestPath: input.manifestPath,
    manifest: input.manifest,
    preregisteredThresholds: PREREGISTERED_THRESHOLDS,
    plan: {
      arms: input.manifest.arms,
      scenarios: input.manifest.scenarios.length,
      reps: input.manifest.reps,
      totalRuns: input.plan.length,
      runs: input.plan,
    },
    matrix: { cells, byArm },
    cost: { byArm: cost },
    failures: input.outcomes.filter((run) => !run.ok).map((run) => ({ key: run.key, detail: run.detail })),
    verdict: computeVerdict({ results: cells, negativeControlIds }),
  };
}

interface QueueRunRecord {
  readonly state?: unknown;
  readonly resolved?: unknown;
  readonly received?: unknown;
  readonly detected?: unknown;
  readonly resumed?: unknown;
  readonly withheld?: unknown;
  readonly guardTokens?: unknown;
  readonly guardCalls?: unknown;
  readonly promptTokens?: unknown;
  readonly completionTokens?: unknown;
  readonly latencyMs?: unknown;
  readonly reasons?: unknown;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function bool(value: unknown): boolean {
  return value === true;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function outcomeFromQueue(run: PlannedRun, record: QueueRunRecord | null, detail: string): RunOutcome {
  const base = {
    key: run.key,
    scenarioId: run.scenarioId,
    arm: run.arm,
    repetition: run.repetition,
  };
  if (record === null) {
    return {
      ...base,
      ok: false,
      detail,
      resolved: false,
      received: false,
      detected: false,
      resumed: false,
      withheld: null,
      promptTokens: 0,
      completionTokens: 0,
      guardTokens: 0,
      guardCalls: 0,
      latencyMs: 0,
    };
  }
  return {
    ...base,
    ok: true,
    detail,
    resolved: bool(record.resolved),
    received: bool(record.received),
    detected: bool(record.detected),
    resumed: bool(record.resumed),
    withheld: text(record.withheld),
    promptTokens: num(record.promptTokens),
    completionTokens: num(record.completionTokens),
    guardTokens: num(record.guardTokens),
    guardCalls: num(record.guardCalls),
    latencyMs: num(record.latencyMs),
  };
}

/**
 * Ejecuta UNA corrida delegando en `scripts/sandbox/queue.ts`, que es el único
 * que conduce al agente y evalúa las suites. Sin Docker la cola aborta: eso se
 * registra como corrida NO medible (`ok:false`), nunca como resultado.
 */
function executeRun(run: PlannedRun, outRoot: string): RunOutcome {
  const outDir = join(outRoot, 'runs', run.scenarioId, run.arm, String(run.repetition));
  mkdirSync(outDir, { recursive: true });
  const argv = [
    process.execPath,
    'run',
    QUEUE,
    '--execute',
    '--ids',
    run.scenarioId,
    '--arms',
    run.arm,
    '--reps',
    '1',
    '--out',
    outDir,
  ];
  const proc = Bun.spawnSync({ cmd: argv, cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
  const stderr = proc.stderr.toString().trim();
  const exitCode = proc.exitCode ?? -1;
  const reportPath = join(outDir, 'latest.json');
  if (!existsSync(reportPath)) {
    return outcomeFromQueue(run, null, `la cola no escribió informe (exit ${exitCode}): ${stderr.slice(-300) || 'sin stderr'}`);
  }
  let record: QueueRunRecord | null = null;
  try {
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as { runs?: QueueRunRecord[] };
    record = parsed.runs?.[0] ?? null;
  } catch (error) {
    return outcomeFromQueue(run, null, `informe de la cola ilegible: ${error instanceof Error ? error.message : String(error)}`);
  }
  return outcomeFromQueue(run, record, `exit ${exitCode}`);
}

/* -------------------------------------------------------------------------- */
/* 7. CLI                                                                     */
/* -------------------------------------------------------------------------- */

export interface SprintArgs {
  readonly manifestPath: string;
  readonly arms: readonly ArmId[] | null;
  readonly reps: number | null;
  readonly outDir: string;
  readonly mode: 'dry-run' | 'execute';
}

export interface SprintArgsError {
  readonly flag: string;
  readonly detail: string;
}

export type SprintArgsResult =
  | { readonly ok: true; readonly args: SprintArgs }
  | { readonly ok: false; readonly errors: readonly SprintArgsError[] };

const VALUE_FLAGS = new Set(['manifest', 'arms', 'reps', 'out']);
const BOOL_FLAGS = new Set(['dry-run', 'execute']);

export function parseSprintArgs(argv: readonly string[]): SprintArgsResult {
  const errors: SprintArgsError[] = [];
  const values = new Map<string, string>();
  const bools = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) {
      errors.push({ flag: token, detail: 'argumento posicional no admitido' });
      continue;
    }
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
    const inline = eq === -1 ? null : token.slice(eq + 1);
    if (BOOL_FLAGS.has(name)) {
      if (inline !== null) errors.push({ flag: name, detail: 'flag booleano no acepta valor' });
      bools.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      errors.push({ flag: name, detail: 'flag desconocido' });
      continue;
    }
    let value: string | undefined;
    if (inline !== null) {
      value = inline;
    } else {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || value.startsWith('--')) {
      errors.push({ flag: name, detail: 'falta valor' });
      continue;
    }
    values.set(name, value);
  }
  if (bools.has('execute') && bools.has('dry-run')) {
    errors.push({ flag: 'mode', detail: '--execute y --dry-run son excluyentes' });
  }
  const manifestPath = values.get('manifest');
  if (manifestPath === undefined || manifestPath.trim() === '') {
    errors.push({ flag: 'manifest', detail: 'ruta del manifiesto requerida' });
  }
  const armsRaw = values.get('arms');
  let arms: readonly ArmId[] | null = null;
  if (armsRaw !== undefined) {
    const parsed: ArmId[] = [];
    for (const piece of armsRaw.split(',')) {
      const name = piece.trim().toUpperCase();
      if (name === '') continue;
      if (!ARM_IDS.includes(name as ArmId)) {
        errors.push({ flag: 'arms', detail: `'${piece.trim()}' no es B|D|E` });
        continue;
      }
      if (!parsed.includes(name as ArmId)) parsed.push(name as ArmId);
    }
    if (parsed.length === 0) errors.push({ flag: 'arms', detail: 'sin brazos válidos' });
    else arms = parsed;
  }
  const repsRaw = values.get('reps');
  let reps: number | null = null;
  if (repsRaw !== undefined) {
    reps = intInRange(Number(repsRaw.trim()), 1, 20);
    if (reps === null) errors.push({ flag: 'reps', detail: 'entero 1..20' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    args: {
      manifestPath: (manifestPath as string).trim(),
      arms,
      reps,
      outDir: values.get('out') ?? DEFAULT_OUT,
      mode: bools.has('execute') ? 'execute' : 'dry-run',
    },
  };
}

function stampOf(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseSprintArgs(argv);
  if (!parsed.ok) {
    console.error('ABORTADO: flags inválidos');
    for (const error of parsed.errors) console.error(`  --${error.flag}: ${error.detail}`);
    return 2;
  }
  const args = parsed.args;
  const loaded = loadManifest(args.manifestPath);
  if (!loaded.ok) {
    console.error(`ABORTADO: manifiesto inválido (${args.manifestPath})`);
    for (const issue of loaded.errors) console.error(`  ${issue.path}: ${issue.detail}`);
    return 2;
  }
  const overridden: SprintManifest = {
    scenarios: loaded.manifest.scenarios,
    arms: args.arms ?? loaded.manifest.arms,
    reps: args.reps ?? loaded.manifest.reps,
  };
  const plan = planMatrix(overridden);
  const generatedAt = new Date().toISOString();
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });

  console.log(formatPlan(overridden, plan));
  console.log(
    `controles negativos: ${overridden.scenarios.filter((scenario) => scenario.negativeControl).length}; ` +
      `umbrales pre-registrados: E>B en ≥${PREREGISTERED_THRESHOLDS.eVersusB.winningScenarios}/${PREREGISTERED_THRESHOLDS.eVersusB.scenariosInSprint} ` +
      `con ≥${PREREGISTERED_THRESHOLDS.eVersusB.successesPerScenario}/${PREREGISTERED_THRESHOLDS.minimumRepetitions}, E≥D, ` +
      `${PREREGISTERED_THRESHOLDS.negativeControls.maxFalsePositives} falsos positivos`,
  );

  const outcomes: RunOutcome[] = [];
  if (args.mode === 'execute') {
    let done = 0;
    for (const run of plan) {
      done += 1;
      const outcome = executeRun(run, outDir);
      outcomes.push(outcome);
      console.log(
        `[${done}/${plan.length}] ${run.scenarioId} ${run.arm}#${run.repetition} ` +
          (outcome.ok ? `resolved=${outcome.resolved} received=${outcome.received} detected=${outcome.detected}` : `NO MEDIBLE: ${outcome.detail}`),
      );
    }
  } else {
    console.log('dry-run: 0 agentes, 0 Docker, 0 inferencia — sólo validación y plan');
  }

  const report = buildReport({
    manifest: overridden,
    manifestPath: args.manifestPath,
    mode: args.mode,
    plan,
    outcomes,
    generatedAt,
  });
  const file = join(outDir, `${stampOf(generatedAt)}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`veredicto: ${report.verdict.code} — ${report.verdict.reasons.join(' · ')}`);
  console.log(`informe: ${file}`);
  if (args.mode === 'execute' && outcomes.every((outcome) => !outcome.ok)) return 1;
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
