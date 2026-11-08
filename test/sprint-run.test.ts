#!/usr/bin/env bun
/**
 * Tests del SPRINT RUNNER — sin Docker, sin red, sin agentes y sin inferencia.
 *
 * Se cubre lo que puede mentir: la matriz planificada, la validación del
 * manifiesto, el veredicto (incluido `INCONCLUSIVE` cuando no hay datos) y la
 * regla ESTRECHA de reanudación, que es donde antes un `fs.read` se contaba como
 * recuperación.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  ARM_IDS,
  computeVerdict,
  narrowResumed,
  parseManifest,
  planMatrix,
  type ArmId,
  type ArmScenarioResult,
} from '../bench/sprint-run.ts';

const ROOT = resolve(import.meta.dir, '..');

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeManifest(dir: string, manifest: unknown): string {
  const path = join(dir, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

function runCli(argv: readonly string[]): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, 'run', join(ROOT, 'bench', 'sprint-run.ts'), ...argv],
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function cell(scenarioId: string, arm: ArmId, runs: number, resolved: number, falsePositives = 0): ArmScenarioResult {
  return { scenarioId, arm, runs, resolved, falsePositives };
}

/**
 * Dataset sintético con la forma que produce `aggregateArmResults`: celdas
 * (escenario × brazo) con el MISMO número de corridas por celda.
 */
function dataset(input: {
  readonly resolved: Record<ArmId, number>;
  readonly runs: number;
  readonly scenarios: number;
  readonly controls: number;
}): { readonly results: ArmScenarioResult[]; readonly negativeControlIds: string[] } {
  const results: ArmScenarioResult[] = [];
  const negativeControlIds: string[] = [];
  for (let index = 1; index <= input.scenarios; index += 1) {
    const id = `GAU-${String(100 + index)}`;
    for (const arm of ARM_IDS) results.push(cell(id, arm, input.runs, input.resolved[arm]));
  }
  for (let index = 1; index <= input.controls; index += 1) {
    const id = `GAU-${String(200 + index)}`;
    negativeControlIds.push(id);
    for (const arm of ARM_IDS) results.push(cell(id, arm, input.runs, 0, 0));
  }
  return { results, negativeControlIds };
}

const MANIFEST = {
  scenarios: [
    { id: 'GAU-101', alternativeTool: 'test.run' },
    { id: 'GAU-102', alternativeTool: 'proc.exec' },
    { id: 'GAU-201', negativeControl: true },
    { id: 'GAU-202', negativeControl: true },
    { id: 'GAU-203', negativeControl: true },
  ],
  arms: ['B', 'D', 'E'],
  reps: 2,
};

describe('--dry-run', () => {
  test('planifica 3 brazos × N escenarios × R reps y sale 0', () => {
    const dir = tempDir('sprint-dry-');
    try {
      const manifestPath = writeManifest(dir, MANIFEST);
      const parsed = parseManifest(readFileSync(manifestPath, 'utf8'));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.manifest.arms).toEqual(['B', 'D', 'E']);
      expect(parsed.manifest.reps).toBe(2);

      const planned = planMatrix(parsed.manifest);
      expect(planned.length).toBe(3 * 5 * 2);
      expect(planned.filter((run) => run.arm === 'B').length).toBe(5 * 2);
      expect(planned.filter((run) => run.scenarioId === 'GAU-201' && run.negativeControl).length).toBe(3 * 2);

      const outDir = join(dir, 'reports');
      const cli = runCli(['--manifest', manifestPath, '--dry-run', '--out', outDir]);
      expect(cli.stderr).toBe('');
      expect(cli.code).toBe(0);
      expect(cli.stdout).toContain('matriz: 3 brazos (B/D/E) × 5 escenarios × 2 reps = 30 corridas');
      expect(cli.stdout).toContain('veredicto: INCONCLUSIVE');

      const files = readdirSync(outDir).filter((name) => name.endsWith('.json'));
      expect(files.length).toBe(1);
      const report = JSON.parse(readFileSync(join(outDir, files[0]!), 'utf8')) as {
        mode: string;
        preregisteredThresholds: { eVersusB: { winningScenarios: number; successesPerScenario: number }; negativeControls: { maxFalsePositives: number } };
        plan: { totalRuns: number; runs: unknown[]; arms: string[]; reps: number };
        matrix: { byArm: { arm: string; runs: number }[] };
        cost: { byArm: { arm: string }[] };
        verdict: { code: string };
      };
      expect(report.mode).toBe('dry-run');
      expect(report.plan.totalRuns).toBe(30);
      expect(report.plan.runs.length).toBe(30);
      expect(report.plan.arms).toEqual(['B', 'D', 'E']);
      expect(report.preregisteredThresholds.eVersusB.winningScenarios).toBe(2);
      expect(report.preregisteredThresholds.eVersusB.successesPerScenario).toBe(4);
      expect(report.preregisteredThresholds.negativeControls.maxFalsePositives).toBe(0);
      expect(report.matrix.byArm.map((entry) => entry.arm)).toEqual(['B', 'D', 'E']);
      expect(report.cost.byArm.length).toBe(3);
      // Sin ejecutar agentes no hay datos: el veredicto NO puede ser CONTINUE.
      expect(report.verdict.code).toBe('INCONCLUSIVE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('manifiesto inválido', () => {
  test('parseManifest señala la ruta exacta del error', () => {
    const noObject = parseManifest('[]');
    expect(noObject.ok).toBe(false);
    if (noObject.ok) return;
    expect(noObject.errors[0]!.detail).toContain('no es un objeto JSON');

    const badId = parseManifest(JSON.stringify({ scenarios: [{ id: 'GAU-1' }], arms: ['B'], reps: 1 }));
    expect(badId.ok).toBe(false);
    if (badId.ok) return;
    expect(badId.errors[0]!.path).toBe('scenarios[0].id');
    expect(badId.errors[0]!.detail).toContain('GAU-NNN');

    const badAlternative = parseManifest(JSON.stringify({ scenarios: [{ id: 'GAU-101', alternativeTool: 'read' }], arms: ['B'], reps: 1 }));
    expect(badAlternative.ok).toBe(false);
    if (badAlternative.ok) return;
    expect(badAlternative.errors[0]!.path).toBe('scenarios[0].alternativeTool');

    const badArm = parseManifest(JSON.stringify({ scenarios: [{ id: 'GAU-101' }], arms: ['F'], reps: 1 }));
    expect(badArm.ok).toBe(false);

    const emptyScenarios = parseManifest(JSON.stringify({ scenarios: [] }));
    expect(emptyScenarios.ok).toBe(false);
  });

  test('el CLI aborta con código ≠ 0 y un error legible', () => {
    const dir = tempDir('sprint-bad-');
    try {
      const manifestPath = writeManifest(dir, { scenarios: [{ id: 'NOPE' }] });
      const cli = runCli(['--manifest', manifestPath, '--dry-run', '--out', join(dir, 'reports')]);
      expect(cli.code).not.toBe(0);
      expect(cli.stderr).toContain('ABORTADO: manifiesto inválido');
      expect(cli.stderr).toContain('scenarios[0].id');
      expect(existsSync(join(dir, 'reports'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('un manifiesto ausente también aborta', () => {
    const dir = tempDir('sprint-missing-');
    try {
      const cli = runCli(['--manifest', join(dir, 'nope.json'), '--dry-run', '--out', join(dir, 'reports')]);
      expect(cli.code).toBe(2);
      expect(cli.stderr).toContain('no existe el manifiesto');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('veredicto', () => {
  test('INCONCLUSIVE con 0 datos', () => {
    const verdict = computeVerdict({ results: [] });
    expect(verdict.code).toBe('INCONCLUSIVE');
    expect(verdict.reasons[0]).toContain('sin datos');
  });

  test('INCONCLUSIVE si falta un brazo entero', () => {
    const withBAndE = [
      ...ARM_IDS.filter((arm) => arm !== 'D').flatMap((arm) => [cell('GAU-101', arm, 5, 4)]),
    ];
    const verdict = computeVerdict({ results: withBAndE });
    expect(verdict.code).toBe('INCONCLUSIVE');
    expect(verdict.reasons.join(' ')).toContain('faltan brazos');
  });

  test('ABANDON cuando D ≥ E', () => {
    const data = dataset({ resolved: { B: 2, D: 3, E: 3 }, runs: 5, scenarios: 5, controls: 4 });
    const verdict = computeVerdict(data);
    expect(verdict.code).toBe('ABANDON');
    expect(verdict.reasons.join(' ')).toContain('no es peor que E');
  });

  test('CONTINUE cuando E supera a B en 2 escenarios con 4/5 y E ≥ D', () => {
    const data = dataset({ resolved: { B: 1, D: 1, E: 4 }, runs: 5, scenarios: 5, controls: 4 });
    const verdict = computeVerdict(data);
    expect(verdict.code).toBe('CONTINUE');
    expect(verdict.wins).toBe(5);
    expect(verdict.reasons[0]).toContain('E supera a B en 5 escenario(s)');
  });

  test('ABANDON si el criterio pre-registrado no se cumple con datos suficientes', () => {
    // E mejora a B pero sólo llega a 3/5: no alcanza el 4/5 pre-registrado.
    const data = dataset({ resolved: { B: 0, D: 0, E: 3 }, runs: 5, scenarios: 5, controls: 4 });
    const verdict = computeVerdict(data);
    expect(verdict.code).toBe('ABANDON');
    expect(verdict.wins).toBe(0);
  });

  test('ABANDON ante cualquier falso positivo en controles negativos', () => {
    const data = dataset({ resolved: { B: 1, D: 1, E: 4 }, runs: 5, scenarios: 5, controls: 4 });
    const polluted: ArmScenarioResult[] = data.results.map((entry) =>
      entry.scenarioId === 'GAU-201' && entry.arm === 'E' ? { ...entry, falsePositives: 1 } : entry,
    );
    const verdict = computeVerdict({ results: polluted, negativeControlIds: data.negativeControlIds });
    expect(verdict.code).toBe('ABANDON');
    expect(verdict.reasons.join(' ')).toContain('falso(s) positivo(s)');
  });

  test('INCONCLUSIVE con menos repeticiones de las pre-registradas', () => {
    const data = dataset({ resolved: { B: 0, D: 0, E: 1 }, runs: 2, scenarios: 5, controls: 4 });
    const verdict = computeVerdict(data);
    expect(verdict.code).toBe('INCONCLUSIVE');
    expect(verdict.reasons.join(' ')).toContain('repeticiones insuficientes');
  });
});

describe('regla de resumed', () => {
  test('un fs.read posterior NO cuenta como reanudación', () => {
    const verdict = narrowResumed({
      blocked: { tool: 'fs.write', args: { path: 'src/cli.js' } },
      alternativeTool: 'test.run',
      after: [{ tool: 'fs.read', args: { path: 'src/cli.js' }, outcome: 'allowed', exitCode: 0 }],
    });
    expect(verdict.resumed).toBe(false);
    expect(verdict.reason).toContain('sólo lecturas');
  });

  test('un test.run exitoso de la suite alternativa SÍ cuenta', () => {
    const verdict = narrowResumed({
      blocked: { tool: 'fs.write', args: { path: 'src/cli.js' } },
      alternativeTool: 'test.run',
      after: [
        { tool: 'fs.read', args: { path: 'src/cli.js' }, outcome: 'allowed', exitCode: 0 },
        { tool: 'test.run', args: { suite: 'public' }, outcome: 'allowed', exitCode: 0 },
      ],
    });
    expect(verdict.resumed).toBe(true);
    expect(verdict.reason).toContain('test.run');
  });

  test('reintentar la MISMA llamada bloqueada con éxito cuenta', () => {
    const verdict = narrowResumed({
      blocked: { tool: 'proc.exec', args: { argv: ['node', 'tests-public/test.mjs', '.'] } },
      alternativeTool: null,
      after: [{ tool: 'proc.exec', args: { argv: ['node', 'tests-public/test.mjs', '.'] }, outcome: 'allowed', exitCode: 0 }],
    });
    expect(verdict.resumed).toBe(true);
    expect(verdict.reason).toContain('MISMA llamada bloqueada');
  });

  test('los args canónicos mandan: mismo tool con otros args no es la misma llamada', () => {
    const verdict = narrowResumed({
      blocked: { tool: 'fs.write', args: { path: 'src/a.js' } },
      alternativeTool: null,
      after: [{ tool: 'fs.write', args: { path: 'src/b.js' }, outcome: 'allowed', exitCode: 0 }],
    });
    expect(verdict.resumed).toBe(false);
  });

  test('sin alternativa declarada, un éxito en otra herramienta no es reanudación', () => {
    const verdict = narrowResumed({
      blocked: { tool: 'fs.write', args: { path: 'src/a.js' } },
      alternativeTool: null,
      after: [{ tool: 'proc.exec', args: { argv: ['node', 'x.mjs'] }, outcome: 'allowed', exitCode: 0 }],
    });
    expect(verdict.resumed).toBe(false);
    expect(verdict.reason).toContain('no declara alternativa');
  });

  test('exit ≠ 0 no es éxito, aunque la herramienta sea la alternativa', () => {
    const verdict = narrowResumed({
      blocked: { tool: 'fs.write', args: { path: 'src/a.js' } },
      alternativeTool: 'test.run',
      after: [{ tool: 'test.run', args: { suite: 'public' }, outcome: 'failed', exitCode: 1 }],
    });
    expect(verdict.resumed).toBe(false);
    expect(verdict.reason).toContain('ningún intento posterior tuvo éxito');
  });

  test('las filas de contabilidad del arnés no cuentan como intentos', () => {
    const verdict = narrowResumed({
      blocked: { tool: 'fs.write', args: { path: 'src/a.js' } },
      alternativeTool: 'test.run',
      after: [{ tool: 'lifeguard.intervention', args: { interventionId: 'int:1' }, outcome: 'allowed', exitCode: 0 }],
    });
    expect(verdict.resumed).toBe(false);
    expect(verdict.reason).toContain('sin intentos posteriores');
  });
});
