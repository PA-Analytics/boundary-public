#!/usr/bin/env bun
/**
 * SPRINT AGGREGATE — informe del sprint a partir de una corrida REAL de la cola.
 *
 * QUÉ HACE: lee el `latest.json` que escribe `scripts/sandbox/queue.ts` con
 * `--execute` y el manifiesto del sprint, y produce el informe del sprint. La
 * agregación, los umbrales pre-registrados y el veredicto NO se reimplementan
 * aquí: se delegan en `bench/sprint-run.ts` (`buildReport`, `aggregateArmResults`,
 * `planMatrix`, `PREREGISTERED_THRESHOLDS`).
 *
 * REGLAS DURAS:
 *  - Sin filas `runs` no hay sprint: se sale con código 1 y un mensaje claro.
 *    Nunca se escribe un informe vacío como si hubiera datos.
 *  - Un campo ausente en el informe de cola se escribe `null` en `sessions`:
 *    no se rellena con una suposición.
 *  - `sessions` es la vista por corrida que consume el panel (intervenciones y
 *    observaciones incluidas). No altera el veredicto: sólo lo acompaña.
 *
 * Uso:
 *   bun run bench/sprint-aggregate.ts \
 *     --queue gauntlet/reports/queue/latest.json \
 *     --manifest gauntlet/manifests/sprint.json \
 *     --out gauntlet/reports/sprint/sprint-report.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  ARM_IDS,
  PREREGISTERED_THRESHOLDS,
  aggregateArmResults,
  buildReport,
  loadManifest,
  planMatrix,
  type ArmId,
  type PlannedRun,
  type RunOutcome,
  type SprintManifest,
  type SprintReport,
} from './sprint-run.ts';

/* -------------------------------------------------------------------------- */
/* 1. Vista por corrida para el panel (`sessions`)                            */
/* -------------------------------------------------------------------------- */

/** Intervención del guardia tal como la escribió la cola; `null` = campo ausente. */
export interface SessionIntervention {
  readonly stall: unknown;
  readonly kind: string | null;
  readonly text: string | null;
  readonly evidenceRefs: readonly string[] | null;
  readonly sent: boolean | null;
  readonly resumed: boolean | null;
  readonly resumedReason: string | null;
}

/** Observación reducida para el panel; `null` = campo ausente en la cola. */
export interface SessionObservation {
  readonly tool: string | null;
  readonly args: Record<string, unknown> | null;
  readonly outcome: string | null;
  readonly detail: string | null;
  readonly planStepId: string | null;
}

/** Una fila por corrida. `null` significa "la cola no lo escribió". */
export interface SessionRow {
  readonly key: string | null;
  readonly scenarioId: string;
  readonly arm: ArmId;
  readonly repetition: number;
  readonly state: string | null;
  readonly resolved: boolean | null;
  readonly detected: boolean | null;
  readonly received: boolean | null;
  readonly resumed: boolean;
  readonly withheld: string | null;
  readonly interventions: readonly SessionIntervention[] | null;
  readonly tally: Record<string, unknown> | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly guardTokens: number | null;
  readonly guardCalls: number | null;
  readonly latencyMs: number | null;
  readonly publicExit: number | null;
  readonly hiddenExit: number | null;
  readonly modelReturned: string | null;
  readonly observations: readonly SessionObservation[] | null;
}

/** Informe de sprint + vista por corrida. */
export interface AggregatedSprint extends SprintReport {
  readonly sessions: readonly SessionRow[];
}

/* -------------------------------------------------------------------------- */
/* 2. Lectura defensiva del JSON de la cola                                   */
/* -------------------------------------------------------------------------- */

const ARM_SET: ReadonlySet<string> = new Set<string>(ARM_IDS);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

function identityKey(scenarioId: string, arm: ArmId, repetition: number): string {
  return `${scenarioId}|${arm}|${repetition}`;
}

/**
 * Regla única de reanudación: la corrida se reanudó si ALGUNA intervención suya
 * lo dice. Una fila sin `interventions` no se reanudó (no se supone).
 */
export function resumedFromInterventions(value: unknown): boolean {
  const list = asArray(value);
  if (list === null) return false;
  return list.some((entry) => asRecord(entry)?.resumed === true);
}

function mapInterventions(value: unknown): readonly SessionIntervention[] | null {
  const list = asArray(value);
  if (list === null) return null;
  return list.map((entry) => {
    const item = asRecord(entry) ?? {};
    const refs = asArray(item.evidenceRefs);
    return {
      stall: item.stall ?? null,
      kind: asString(item.kind),
      text: asString(item.text),
      evidenceRefs: refs === null ? null : refs.filter((ref): ref is string => typeof ref === 'string'),
      sent: asBoolean(item.sent),
      resumed: asBoolean(item.resumed),
      resumedReason: asString(item.resumedReason),
    };
  });
}

function mapObservations(value: unknown): readonly SessionObservation[] | null {
  const list = asArray(value);
  if (list === null) return null;
  return list.map((entry) => {
    const item = asRecord(entry) ?? {};
    return {
      tool: asString(item.tool),
      args: asRecord(item.args),
      outcome: asString(item.outcome),
      detail: asString(item.detail),
      planStepId: asString(item.planStepId),
    };
  });
}

function detailOf(row: Record<string, unknown>, state: string | null): string {
  const reasons = asArray(row.reasons);
  if (reasons !== null) {
    const joined = reasons.filter((reason): reason is string => typeof reason === 'string').join(' | ');
    if (joined.trim() !== '') return joined;
  }
  return state ?? '';
}

/* -------------------------------------------------------------------------- */
/* 3. Fila de la cola → `RunOutcome` + `SessionRow`                           */
/* -------------------------------------------------------------------------- */

export interface QueueMapping {
  readonly outcomes: readonly RunOutcome[];
  readonly sessions: readonly SessionRow[];
  /** Filas descartadas o anomalías de identidad: se avisan, no se silencian. */
  readonly warnings: readonly string[];
}

/**
 * Mapea `runs` de la cola a las dos vistas con la MISMA lectura de cada fila:
 * `RunOutcome` (lo que agrega el veredicto) y `SessionRow` (lo que pinta el
 * panel). Una fila sin `id` de escenario o con un brazo distinto de B|D|E no se
 * puede medir y se omite con aviso.
 */
export function mapQueueRows(rows: readonly unknown[], plan: readonly PlannedRun[]): QueueMapping {
  const planned = new Set(plan.map((run) => identityKey(run.scenarioId, run.arm, run.repetition)));
  const outcomes: RunOutcome[] = [];
  const sessions: SessionRow[] = [];
  const warnings: string[] = [];

  rows.forEach((raw, index) => {
    const row = asRecord(raw);
    if (row === null) {
      warnings.push(`fila ${index}: no es un objeto JSON, se omite`);
      return;
    }
    const scenarioId = (asString(row.id) ?? '').trim();
    if (scenarioId === '') {
      warnings.push(`fila ${index}: sin 'id' de escenario, se omite`);
      return;
    }
    const armText = (asString(row.arm) ?? '').trim().toUpperCase();
    if (!ARM_SET.has(armText)) {
      warnings.push(`fila ${index} (${scenarioId}): brazo '${String(row.arm)}' no es B|D|E, se omite`);
      return;
    }
    const arm = armText as ArmId;
    let repetition = asPositiveInt(row.repetition);
    if (repetition === null) {
      repetition = 1;
      warnings.push(`fila ${index} (${scenarioId}/${arm}): 'repetition' ilegible (${String(row.repetition)}), se asume 1`);
    }
    if (!planned.has(identityKey(scenarioId, arm, repetition))) {
      warnings.push(`fila ${index}: ${scenarioId}/${arm}#${repetition} no está en la matriz del manifiesto`);
    }

    const state = asString(row.state);
    const resolved = asBoolean(row.resolved) === true;
    const received = asBoolean(row.received) === true;
    const detected = asBoolean(row.detected) === true;
    const resumed = resumedFromInterventions(row.interventions);

    outcomes.push({
      key: asString(row.key) ?? `sprint:${scenarioId}:${arm}:${repetition}`,
      scenarioId,
      arm,
      repetition,
      ok: state !== 'unsupported' && state !== 'infrastructure',
      detail: detailOf(row, state),
      resolved,
      received,
      detected,
      resumed,
      withheld: asString(row.withheld),
      promptTokens: asNumber(row.promptTokens) ?? 0,
      completionTokens: asNumber(row.completionTokens) ?? 0,
      guardTokens: asNumber(row.guardTokens) ?? 0,
      guardCalls: asNumber(row.guardCalls) ?? 0,
      latencyMs: asNumber(row.latencyMs) ?? 0,
    });

    sessions.push({
      key: asString(row.key),
      scenarioId,
      arm,
      repetition,
      state,
      resolved: asBoolean(row.resolved),
      detected: asBoolean(row.detected),
      received: asBoolean(row.received),
      resumed,
      withheld: asString(row.withheld),
      interventions: mapInterventions(row.interventions),
      tally: asRecord(row.tally),
      promptTokens: asNumber(row.promptTokens),
      completionTokens: asNumber(row.completionTokens),
      guardTokens: asNumber(row.guardTokens),
      guardCalls: asNumber(row.guardCalls),
      latencyMs: asNumber(row.latencyMs),
      publicExit: asNumber(row.publicExit),
      hiddenExit: asNumber(row.hiddenExit),
      modelReturned: asString(row.modelReturned),
      observations: mapObservations(row.observations),
    });
  });

  return { outcomes, sessions, warnings };
}

/* -------------------------------------------------------------------------- */
/* 4. Informe: `buildReport` existente + `sessions`                           */
/* -------------------------------------------------------------------------- */

export function buildAggregatedReport(input: {
  readonly manifest: SprintManifest;
  readonly manifestPath: string;
  readonly outcomes: readonly RunOutcome[];
  readonly sessions: readonly SessionRow[];
  readonly generatedAt: string;
}): AggregatedSprint {
  const plan = planMatrix(input.manifest);
  const report = buildReport({
    manifest: input.manifest,
    manifestPath: input.manifestPath,
    mode: 'execute',
    plan,
    outcomes: input.outcomes,
    generatedAt: input.generatedAt,
  });
  // La matriz escrita debe ser EXACTAMENTE la de `aggregateArmResults`: se
  // contrasta y, si `buildReport` dejara de coincidir, manda la función exportada.
  const cells = aggregateArmResults(input.manifest, input.outcomes);
  const matrix = JSON.stringify(report.matrix.cells) === JSON.stringify(cells) ? report.matrix : { ...report.matrix, cells };
  return { ...report, matrix, sessions: input.sessions };
}

/* -------------------------------------------------------------------------- */
/* 5. CLI                                                                     */
/* -------------------------------------------------------------------------- */

const VALUE_FLAGS = new Set(['queue', 'manifest', 'out']);

export interface AggregateArgs {
  readonly queuePath: string;
  readonly manifestPath: string;
  readonly outPath: string;
}

export interface AggregateArgsError {
  readonly flag: string;
  readonly detail: string;
}

export type AggregateArgsResult =
  | { readonly ok: true; readonly args: AggregateArgs }
  | { readonly ok: false; readonly errors: readonly AggregateArgsError[] };

export function parseAggregateArgs(argv: readonly string[]): AggregateArgsResult {
  const errors: AggregateArgsError[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) {
      errors.push({ flag: token, detail: 'argumento posicional no admitido' });
      continue;
    }
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
    const inline = eq === -1 ? null : token.slice(eq + 1);
    if (!VALUE_FLAGS.has(name)) {
      errors.push({ flag: name, detail: 'flag desconocido (--queue, --manifest, --out)' });
      continue;
    }
    let value: string | undefined;
    if (inline !== null) {
      value = inline;
    } else {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || value.startsWith('--') || value.trim() === '') {
      errors.push({ flag: name, detail: 'falta valor' });
      continue;
    }
    values.set(name, value.trim());
  }
  for (const required of ['queue', 'manifest', 'out'] as const) {
    if (!values.has(required)) errors.push({ flag: required, detail: 'ruta requerida' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    args: {
      queuePath: values.get('queue') as string,
      manifestPath: values.get('manifest') as string,
      outPath: values.get('out') as string,
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function main(argv: readonly string[]): number {
  const parsed = parseAggregateArgs(argv);
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
  const manifest = loaded.manifest;

  const queuePath = resolve(args.queuePath);
  if (!existsSync(queuePath)) {
    console.error(`ABORTADO: no existe el informe de la cola ${queuePath}`);
    console.error('  lo escribe `bun run scripts/sandbox/queue.ts --execute ...` como latest.json');
    return 1;
  }
  let parsedQueue: unknown;
  try {
    parsedQueue = JSON.parse(readFileSync(queuePath, 'utf8')) as unknown;
  } catch (error) {
    console.error(`ABORTADO: informe de cola ilegible (${queuePath}): ${errorText(error)}`);
    return 1;
  }
  const queue = asRecord(parsedQueue);
  const rows = queue === null ? null : asArray(queue.runs);
  if (rows === null || rows.length === 0) {
    console.error(`ABORTADO: el informe de cola no tiene filas 'runs' (${queuePath})`);
    console.error('  sin corridas no hay informe de sprint: no se escribe un informe vacío');
    return 1;
  }

  const plan = planMatrix(manifest);
  const mapping = mapQueueRows(rows, plan);
  for (const warning of mapping.warnings) console.error(`aviso: ${warning}`);
  if (mapping.outcomes.length === 0) {
    console.error(`ABORTADO: ninguna de las ${rows.length} fila(s) de la cola se pudo mapear a una corrida medible`);
    return 1;
  }

  const generatedAt = new Date().toISOString();
  const report = buildAggregatedReport({
    manifest,
    manifestPath: args.manifestPath,
    outcomes: mapping.outcomes,
    sessions: mapping.sessions,
    generatedAt,
  });

  const outPath = resolve(args.outPath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  const measurable = mapping.outcomes.filter((outcome) => outcome.ok).length;
  const cellsText = report.matrix.cells
    .map((cell) => `${cell.scenarioId}/${cell.arm} ${cell.resolved}/${cell.runs}`)
    .join(' · ');
  console.log(
    `cola: ${rows.length} fila(s) leídas → ${mapping.outcomes.length} corrida(s) mapeada(s), ` +
      `${measurable} medible(s), ${mapping.outcomes.length - measurable} no medible(s); ${report.sessions.length} sesión(es)`,
  );
  console.log(`matriz: ${cellsText}`);
  console.log(
    `umbrales pre-registrados: E>B en ≥${PREREGISTERED_THRESHOLDS.eVersusB.winningScenarios}/${PREREGISTERED_THRESHOLDS.eVersusB.scenariosInSprint} ` +
      `con ≥${PREREGISTERED_THRESHOLDS.eVersusB.successesPerScenario}/${PREREGISTERED_THRESHOLDS.minimumRepetitions}, E≥D, ` +
      `${PREREGISTERED_THRESHOLDS.negativeControls.maxFalsePositives} falso(s) positivo(s)`,
  );
  if (manifest.reps < PREREGISTERED_THRESHOLDS.minimumRepetitions) {
    console.log(
      `aviso: el manifiesto planifica ${manifest.reps} rep(s) y el pre-registro exige ${PREREGISTERED_THRESHOLDS.minimumRepetitions}: ` +
        'el veredicto no podrá pasar de INCONCLUSIVE por repeticiones insuficientes',
    );
  }
  console.log(`veredicto: ${report.verdict.code} — ${report.verdict.reasons.join(' · ')}`);
  console.log(`informe: ${outPath}`);

  if (measurable === 0) {
    console.error('ABORTADO: ninguna corrida de la cola fue medible (todas unsupported/infrastructure); el informe NO es evidencia');
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
