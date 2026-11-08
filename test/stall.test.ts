/**
 * Pruebas del DETECTOR DE ESTANCAMIENTO (`src/stall.ts`).
 *
 * 100 % offline y deterministas: nada de red, sandbox ni inferencia. El fallo
 * que se corrige es real: antes, UNA sola denegación del gateway disparaba
 * intervención y dos rojos de la misma llamada bastaban. Aquí se fija que sólo
 * acumulación de la MISMA huella, dentro de la ventana y SIN progreso
 * productivo, dispara una señal.
 *
 * Casos obligatorios (a)–(l) del encargo, más los bordes del contrato.
 */
import { describe, expect, test } from 'bun:test';

import type { DecideHistoryItem } from '../src/agent.ts';
import type { JsonObject } from '../src/contracts.ts';
import {
  DEFAULT_THRESHOLDS,
  detect,
  detectStall,
  explainDetection,
  type StallSignal,
} from '../src/stall.ts';

/** `DecideHistoryItem['outcome']` aún no contempla `approval_required`. */
type RawOutcome = DecideHistoryItem['outcome'] | 'approval_required';

function obs(tool: string, args: JsonObject, outcome: RawOutcome, detail = ''): DecideHistoryItem {
  return {
    tool,
    args,
    outcome: outcome as unknown as DecideHistoryItem['outcome'],
    detail,
  };
}

function objective(): string {
  return 'Arreglar el test rojo de facturación sin tocar producción';
}

const TEST_RUN: JsonObject = { cmd: 'bun test test/billing.test.ts' };
const READ_A: JsonObject = { path: 'src/billing.ts' };

describe('contrato y umbrales', () => {
  test('DEFAULT_THRESHOLDS expone los valores pactados', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      repeatThreshold: 2,
      repeatWindow: 12,
      minBlockedAttempts: 2,
      slowHealthyMs: 900_000,
      progressWindow: 6,
    });
  });

  test('historial vacío no dispara nada', () => {
    const detection = detect({ history: [], taskObjective: objective() });
    expect(detection.signal).toBeNull();
    expect(detection.withheld).toBeNull();
  });
});

describe('(a) una sola denegación NO dispara', () => {
  test('denegación aislada: null con withheld explícito', () => {
    const detection = detect({
      history: [obs('fs.read', READ_A, 'denied', 'política: ruta fuera de alcance')],
      taskObjective: objective(),
    });
    expect(detection.signal).toBeNull();
    expect(detection.withheld).toBe('un solo bloqueo: puede ser reintento legítimo');
  });
});

describe('(b) dos denegaciones de la misma huella SÍ disparan', () => {
  test('gateway-denied en la segunda', () => {
    const signal = detectStall({
      history: [
        obs('fs.read', READ_A, 'denied', 'política: ruta fuera de alcance'),
        obs('fs.read', READ_A, 'denied', 'política: ruta fuera de alcance'),
      ],
      taskObjective: objective(),
    });
    expect(signal).not.toBeNull();
    expect(signal?.kind).toBe('gateway-denied');
    expect(signal?.tool).toBe('fs.read');
    expect(signal?.repeats).toBe(2);
    expect(signal?.consecutiveRepeats).toBe(2);
    expect(signal?.attempt).toBe(2);
  });
});

describe('(c) denegaciones intercaladas con lecturas también disparan', () => {
  test('un agente atascado intercala sondas de lectura', () => {
    const detection = detect({
      history: [
        obs('fs.read', READ_A, 'denied', 'política: ruta fuera de alcance'),
        obs('fs.read', { path: 'docs/README.md' }, 'allowed'),
        obs('fs.read', READ_A, 'denied', 'política: ruta fuera de alcance'),
      ],
      taskObjective: objective(),
    });
    expect(detection.signal?.kind).toBe('gateway-denied');
    expect(detection.signal?.repeats).toBe(2);
    expect(detection.signal?.consecutiveRepeats).toBe(1);
    expect(detection.withheld).toBeNull();
  });
});

describe('(d) tres fallos con un fs.write exitoso en medio NO disparan', () => {
  test('progreso productivo entre el primer y el último fallo', () => {
    const detection = detect({
      history: [
        obs('proc.exec', TEST_RUN, 'failed', 'exit 1: 3 tests rojos'),
        obs('fs.write', { path: 'src/billing.ts' }, 'allowed'),
        obs('proc.exec', TEST_RUN, 'failed', 'exit 1: 2 tests rojos'),
        obs('proc.exec', TEST_RUN, 'failed', 'exit 1: 1 test rojo'),
      ],
      taskObjective: objective(),
    });
    expect(detection.signal).toBeNull();
    expect(detection.withheld).toBe('hubo progreso entre fallos');
  });
});

describe('(e) un rojo aislado NO dispara', () => {
  test('tool-failed es iteración normal', () => {
    const detection = detect({
      history: [obs('proc.exec', TEST_RUN, 'failed', 'exit 1: 1 test rojo')],
      taskObjective: objective(),
    });
    expect(detection.signal).toBeNull();
    expect(detection.withheld).toBeNull();
  });
});

describe('(f) run lento con progreso NO dispara', () => {
  test('el withheld dice "lento pero progresa"', () => {
    const detection = detect({
      history: [
        obs('fs.write', { path: 'out/report.md' }, 'allowed'),
        obs('proc.exec', TEST_RUN, 'failed', 'timeout 30s'),
        obs('proc.exec', TEST_RUN, 'failed', 'timeout 30s'),
      ],
      taskObjective: objective(),
      thresholds: { slowHealthyMs: 1_000 },
      startedAt: 0,
      now: 5_000,
    });
    expect(detection.signal).toBeNull();
    expect(detection.withheld).toBe('lento pero progresa');
  });

  test('lento con progreso NO anula un rechazo de contrato', () => {
    const signal = detectStall({
      history: [obs('fs.write', { path: 'out/report.md' }, 'allowed')],
      taskObjective: objective(),
      contractRejection: { tool: 'fs.write', args: { path: '/etc/passwd' }, reason: 'ruta prohibida' },
      thresholds: { slowHealthyMs: 1_000 },
      startedAt: 0,
      now: 5_000,
    });
    expect(signal?.kind).toBe('contract-rejected');
  });
});

describe('(g) approval_required dispara al primer intento', () => {
  test('parada dura sin acumulación', () => {
    const signal = detectStall({
      history: [obs('proc.exec', { cmd: 'sudo rm -rf /var/tmp/cache' }, 'approval_required', 'requiere aprobación')],
      taskObjective: objective(),
    });
    expect(signal?.kind).toBe('approval-required');
    expect(signal?.repeats).toBe(1);
    expect(signal?.attempt).toBe(1);
  });
});

describe('(h) rechazo de contrato dispara', () => {
  test('es determinista: no necesita repetición', () => {
    const signal = detectStall({
      history: [],
      taskObjective: objective(),
      contractRejection: {
        tool: 'fs.read',
        args: { path: '../../etc/passwd' },
        reason: 'el contrato valida rutas relativas al workspace',
      },
    });
    expect(signal?.kind).toBe('contract-rejected');
    expect(signal?.args).toEqual({ path: '../../etc/passwd' });
    expect(signal?.repeats).toBe(1);
  });
});

describe('(i) el orden de las claves no cambia la huella', () => {
  test('args con distinto orden producen la misma huella', () => {
    const signal = detectStall({
      history: [
        obs('fs.read', { path: 'src/billing.ts', mode: 'r' }, 'denied', 'denegado'),
        obs('fs.read', { mode: 'r', path: 'src/billing.ts' }, 'denied', 'denegado'),
      ],
      taskObjective: objective(),
    });
    expect(signal?.kind).toBe('gateway-denied');
    expect(signal?.repeats).toBe(2);
  });
});

describe('(j) huellas distintas no se mezclan', () => {
  test('dos denegaciones de rutas diferentes no acumulan', () => {
    const detection = detect({
      history: [
        obs('fs.read', { path: 'src/billing.ts' }, 'denied', 'denegado'),
        obs('fs.read', { path: 'src/taxes.ts' }, 'denied', 'denegado'),
      ],
      taskObjective: objective(),
    });
    expect(detection.signal).toBeNull();
    expect(detection.withheld).toBe('un solo bloqueo: puede ser reintento legítimo');
  });
});

describe('(k) la ventana acota los fallos', () => {
  test('fallos fuera de repeatWindow no cuentan', () => {
    const detection = detect({
      history: [
        obs('proc.exec', { cmd: 'bun run build' }, 'failed', 'exit 1'),
        obs('proc.exec', { cmd: 'bun test' }, 'failed', 'exit 1'),
        obs('proc.exec', { cmd: 'bun run build' }, 'failed', 'exit 1'),
      ],
      taskObjective: objective(),
      thresholds: { repeatWindow: 2, repeatThreshold: 2 },
    });
    expect(detection.signal).toBeNull();
    expect(detection.withheld).toBeNull();
  });

  test('dentro de la ventana sí cuenta y dispara repeated-failure', () => {
    const signal = detectStall({
      history: [
        obs('proc.exec', { cmd: 'bun run build' }, 'failed', 'exit 1'),
        obs('proc.exec', { cmd: 'bun run build' }, 'failed', 'exit 1'),
      ],
      taskObjective: objective(),
      thresholds: { repeatWindow: 4, repeatThreshold: 2 },
    });
    expect(signal?.kind).toBe('repeated-failure');
    expect(signal?.repeats).toBe(2);
  });
});

describe('(l) explainDetection explica la regla', () => {
  test('texto no vacío con la regla que disparó', () => {
    const signal = detectStall({
      history: [
        obs('proc.exec', TEST_RUN, 'failed', 'exit 1'),
        obs('proc.exec', TEST_RUN, 'failed', 'exit 1'),
      ],
      taskObjective: objective(),
    });
    expect(signal).not.toBeNull();
    const text = explainDetection(signal as StallSignal);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('regla 6');
    expect(text).toContain('repeated-failure');
  });

  test('explica también el rechazo de contrato', () => {
    const signal = detectStall({
      history: [],
      taskObjective: objective(),
      contractRejection: { tool: 'fs.write', args: { path: '/etc/hosts' }, reason: 'fuera del workspace' },
    });
    const text = explainDetection(signal as StallSignal);
    expect(text).toContain('regla 1');
    expect(text).toContain('contract-rejected');
  });
});

describe('bordes del contrato', () => {
  test('la última observación allowed desactiva la señal aunque haya fallos', () => {
    const detection = detect({
      history: [
        obs('proc.exec', TEST_RUN, 'failed', 'exit 1'),
        obs('proc.exec', TEST_RUN, 'failed', 'exit 1'),
        obs('proc.exec', TEST_RUN, 'allowed'),
      ],
      taskObjective: objective(),
    });
    expect(detection.signal).toBeNull();
    expect(detection.withheld).toBeNull();
  });

  test('un bloqueo previo de la misma huella basta aunque sólo haya uno en la ventana', () => {
    const detection = detect({
      history: [
        obs('fs.read', READ_A, 'blocked', 'gateway caído'),
        obs('fs.read', { path: 'docs/README.md' }, 'allowed'),
        obs('fs.read', READ_A, 'blocked', 'gateway caído'),
      ],
      taskObjective: objective(),
      thresholds: { minBlockedAttempts: 3 },
    });
    expect(detection.signal?.kind).toBe('gateway-blocked');
    expect(detection.withheld).toBeNull();
  });

  test('recorta taskObjective a 4000 y reason a 600, y recentTools a 6', () => {
    const longObjective = 'objetivo '.repeat(1_000);
    const longReason = 'r'.repeat(2_000);
    const filler = Array.from({ length: 8 }, (_value, index) =>
      obs('fs.read', { path: `src/file-${index}.ts` }, 'allowed'),
    );
    const signal = detectStall({
      history: [...filler, obs('fs.read', READ_A, 'denied', longReason), obs('fs.read', READ_A, 'denied', longReason)],
      taskObjective: longObjective,
    });
    expect(signal).not.toBeNull();
    expect(signal?.taskObjective.length).toBeLessThanOrEqual(4_000);
    expect(signal?.reason.length).toBeLessThanOrEqual(600);
    expect(signal?.recentTools).toHaveLength(6);
    expect(signal?.recentTools.at(-1)).toBe('fs.read');
  });

  test('elapsedMs y lastProgressSeq reflejan tiempo y progreso', () => {
    const signal = detectStall({
      history: [
        obs('fs.write', { path: 'src/billing.ts' }, 'allowed'),
        obs('proc.exec', TEST_RUN, 'failed', 'exit 1'),
        obs('proc.exec', TEST_RUN, 'failed', 'exit 1'),
      ],
      taskObjective: objective(),
      startedAt: 1_000,
      now: 4_000,
    });
    expect(signal?.elapsedMs).toBe(3_000);
    expect(signal?.lastProgressSeq).toBe(1);
  });

  test('detect devuelve también withheld=null cuando sí hay señal', () => {
    const detection = detect({
      history: [
        obs('fs.read', READ_A, 'denied', 'denegado'),
        obs('fs.read', READ_A, 'denied', 'denegado'),
      ],
      taskObjective: objective(),
    });
    expect(detection.signal).not.toBeNull();
    expect(detection.withheld).toBeNull();
  });
});
