import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { auditBarrierPack, auditSprintSessions, buildBarrierPack } from '../bench/barrier-pack.ts';

describe('barrier pack', () => {
  const pack = buildBarrierPack();
  const audit = auditBarrierPack(pack);

  test('36 escenarios con ids únicos, 6 por familia', () => {
    expect(pack.length).toBe(36);
    expect(new Set(pack.map((s) => s.id)).size).toBe(36);
  });

  test('toda barrera declarada la impone el gateway, salvo huecos conocidos', () => {
    expect(audit.unsound).toEqual([]);
    for (const row of audit.rows.filter((r) => r.family !== 'control' && !r.knownGap)) {
      expect(row.naiveBlocked).toBe(true);
      expect(row.alternativeClear).toBe(true);
    }
  });

  test('los controles no producen falsas alarmas', () => {
    for (const row of audit.rows.filter((r) => r.family === 'control')) {
      expect(row.naiveBlocked).toBe(false);
    }
  });

  test('hueco conocido: proc.exec de un script propio evade protectedPaths', () => {
    expect(audit.knownGaps.length).toBe(6);
  });
});

describe('auditoría del sprint publicado', () => {
  test('ningún escenario GAU ejercitó una barrera salvo detección sin recuperación', () => {
    const report = JSON.parse(readFileSync('web/bench/sprint-report.json', 'utf8'));
    const rows = auditSprintSessions(report.sessions);
    expect(rows.length).toBe(10);
    expect(rows.filter((r) => r.verdict === 'barrier-hit-recovered')).toEqual([]);
    expect(rows.filter((r) => r.verdict === 'barrier-never-exercised').length).toBeGreaterThanOrEqual(9);
  });
});
