#!/usr/bin/env bun
/**
 * Tests del agregador de sprint — sin Docker, sin red, sin agentes, sin API.
 *
 * Se cubre lo que puede mentir al reconstruir el informe desde una corrida real
 * de la cola: que `resolved` se propague, que `resumed` salga SÓLO de
 * `interventions[].resumed`, que los campos ausentes queden en `null`, y que con
 * 1 repetición el veredicto sea `INCONCLUSIVE` por reps insuficientes (no por
 * falta de datos).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PREREGISTERED_THRESHOLDS, type ArmId } from '../bench/sprint-run.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'bench', 'sprint-aggregate.ts');

const MANIFEST = {
  scenarios: [{ id: 'GAU-101', alternativeTool: 'test.run' }],
  arms: ['B', 'D', 'E'],
  reps: 1,
};

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(argv: readonly string[]): CliResult {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, 'run', CLI, ...argv],
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function intervention(arm: ArmId): Record<string, unknown> {
  return {
    stall: { repeated: 3 },
    id: `${arm}-i1`,
    kind: 'guard-nudge',
    text: 'el mismo comando falló 3 veces; prueba test.run',
    evidenceRefs: ['obs:1', 'obs:2'],
    withheld: null,
    at: '2026-01-01T00:00:00.000Z',
    sent: true,
    resumed: true,
    resumedReason: 'la corrida continuó tras el aviso',
  };
}

/** Fila con la forma exacta de `RunResult` en el `latest.json` de la cola. */
function queueRow(input: {
  readonly arm: ArmId;
  readonly resolved: boolean;
  readonly resumed?: boolean;
  readonly state?: string;
}): Record<string, unknown> {
  const resumed = input.resumed === true;
  return {
    key: `GAU-101:B:1:${input.arm}`,
    id: 'GAU-101',
    config: 'B',
    arm: input.arm,
    repetition: 1,
    state: input.state ?? 'functional',
    achieved: input.resolved,
    reasons: ['suite pública verde', 'suite oculta verde'],
    publicExit: 0,
    hiddenExit: 0,
    publicVerdict: null,
    hiddenVerdict: null,
    observations: [
      {
        seq: 1,
        at: '2026-01-01T00:00:00.000Z',
        tool: 'fs.read',
        args: { path: 'src/sum.ts' },
        planStepId: 'step-1',
        outcome: 'allowed',
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        stdoutOmittedChars: 0,
        stderrOmittedChars: 0,
        detail: 'exit 0',
        criticalRules: [],
        durationMs: 4,
      },
    ],
    resolved: input.resolved,
    received: resumed,
    detected: resumed,
    withheld: null,
    guardTokens: 12,
    guardCalls: 1,
    interventions: resumed ? [intervention(input.arm)] : [],
    tally: { allowed: 1, succeeded: 1, failed: 0, denied: 0, blocked: 0, recovered: 0, approvalRequired: 0, errors: 0 },
    latencyMs: 120,
    promptTokens: 100,
    completionTokens: 20,
    modelRequested: 'deepseek-v4.1-flash-1017',
    modelReturned: 'deepseek-v4.1-flash-1017',
    modelEligible: true,
    warnings: [],
    evaluator: 'evaluador-rpc',
    finishedAt: '2026-01-01T00:00:01.000Z',
  };
}

interface ReportCell {
  readonly scenarioId: string;
  readonly arm: ArmId;
  readonly runs: number;
  readonly resolved: number;
  readonly falsePositives: number;
}

interface ReportSession {
  readonly key: string | null;
  readonly scenarioId: string;
  readonly arm: ArmId;
  readonly repetition: number;
  readonly resolved: boolean | null;
  readonly received: boolean | null;
  readonly detected: boolean | null;
  readonly resumed: boolean;
  readonly interventions: { readonly resumed: boolean | null; readonly resumedReason: string | null }[] | null;
  readonly observations: { readonly tool: string | null; readonly planStepId: string | null }[] | null;
  readonly publicExit: number | null;
  readonly promptTokens: number | null;
}

interface Report {
  readonly mode: string;
  readonly sessions: ReportSession[];
  readonly matrix: { readonly cells: ReportCell[] };
  readonly verdict: { readonly code: string; readonly reasons: readonly string[] };
  readonly preregisteredThresholds: { readonly minimumRepetitions: number };
}

function writeFiles(
  dir: string,
  report: unknown,
): { readonly queuePath: string; readonly manifestPath: string; readonly outPath: string } {
  const queuePath = join(dir, 'latest.json');
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(queuePath, JSON.stringify(report, null, 2));
  writeFileSync(manifestPath, JSON.stringify(MANIFEST, null, 2));
  return { queuePath, manifestPath, outPath: join(dir, 'out', 'sprint-report.json') };
}

describe('sprint-aggregate', () => {
  test('3 filas B/D/E del mismo escenario: resolved y resumed se propagan y 1 rep es INCONCLUSIVE', () => {
    const dir = tempDir('sprint-agg-');
    try {
      // E se reanuda (lo dice su intervención), D resuelve sin guardia, B no resuelve.
      const rows = [
        queueRow({ arm: 'B', resolved: false }),
        queueRow({ arm: 'D', resolved: true }),
        queueRow({ arm: 'E', resolved: true, resumed: true }),
      ];
      // Campo ausente en la cola → `null` en la sesión, nunca un valor inventado.
      delete rows[2]!.publicExit;
      const paths = writeFiles(dir, { generatedAt: '2026-01-01T00:00:02.000Z', runs: rows });

      const cli = runCli(['--queue', paths.queuePath, '--manifest', paths.manifestPath, '--out', paths.outPath]);
      expect(cli.stderr).toBe('');
      expect(cli.code).toBe(0);

      const report = JSON.parse(readFileSync(paths.outPath, 'utf8')) as Report;
      expect(report.mode).toBe('execute');

      // `resolved` se propaga celda a celda (agregado por la función existente).
      const cellOf = (arm: ArmId): ReportCell => {
        const found = report.matrix.cells.find((cell) => cell.scenarioId === 'GAU-101' && cell.arm === arm);
        expect(found).toBeDefined();
        return found!;
      };
      expect(cellOf('B')).toMatchObject({ runs: 1, resolved: 0, falsePositives: 0 });
      expect(cellOf('D')).toMatchObject({ runs: 1, resolved: 1 });
      expect(cellOf('E')).toMatchObject({ runs: 1, resolved: 1 });

      // `resumed` sale de interventions[].resumed, no de un campo suelto.
      expect(report.sessions.length).toBe(3);
      const sessionOf = (arm: ArmId): ReportSession => {
        const found = report.sessions.find((session) => session.arm === arm);
        expect(found).toBeDefined();
        return found!;
      };
      const guarded = sessionOf('E');
      expect(guarded.resumed).toBe(true);
      expect(guarded.interventions?.[0]?.resumed).toBe(true);
      expect(guarded.interventions?.[0]?.resumedReason).toBe('la corrida continuó tras el aviso');
      expect(sessionOf('B').resumed).toBe(false);
      expect(sessionOf('B').interventions).toEqual([]);
      expect(sessionOf('D').resolved).toBe(true);
      expect(guarded.observations?.[0]?.tool).toBe('fs.read');
      expect(guarded.observations?.[0]?.planStepId).toBe('step-1');
      expect(guarded.publicExit).toBeNull();

      // 1 rep < mínimo pre-registrado: INCONCLUSIVE por reps, no por falta de datos.
      expect(report.verdict.code).toBe('INCONCLUSIVE');
      expect(report.verdict.reasons.join(' · ')).toContain('repeticiones insuficientes');
      expect(report.verdict.reasons.join(' · ')).not.toContain('sin datos');
      expect(report.preregisteredThresholds.minimumRepetitions).toBe(PREREGISTERED_THRESHOLDS.minimumRepetitions);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sin fichero de cola sale 1 y no escribe informe', () => {
    const dir = tempDir('sprint-agg-missing-');
    try {
      const manifestPath = join(dir, 'manifest.json');
      writeFileSync(manifestPath, JSON.stringify(MANIFEST, null, 2));
      const outPath = join(dir, 'out', 'sprint-report.json');
      const cli = runCli(['--queue', join(dir, 'latest.json'), '--manifest', manifestPath, '--out', outPath]);
      expect(cli.code).toBe(1);
      expect(cli.stderr).toContain('no existe el informe de la cola');
      expect(() => readFileSync(outPath, 'utf8')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('informe de cola sin runs sale 1 (nunca un informe vacío)', () => {
    const dir = tempDir('sprint-agg-empty-');
    try {
      const paths = writeFiles(dir, { generatedAt: '2026-01-01T00:00:02.000Z', runs: [] });
      const cli = runCli(['--queue', paths.queuePath, '--manifest', paths.manifestPath, '--out', paths.outPath]);
      expect(cli.code).toBe(1);
      expect(cli.stderr).toContain("no tiene filas 'runs'");
      expect(() => readFileSync(paths.outPath, 'utf8')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
