import { describe, expect, test } from 'bun:test';
import { interventionReachedRequest } from '../src/continuity.ts';

// El cuerpo HTTP real transporta el prompt como cadena JSON dentro de otro JSON.
function envelope(text: string, interventionId: string): string {
  const content = JSON.stringify({
    objective: 'reparar slugify',
    history: [
      { tool: 'fs.read', args: { path: 'src/slug.js' }, outcome: 'allowed', detail: 'lee el fichero' },
      { tool: 'lifeguard.intervention', args: { interventionId, kind: 'guidance' }, outcome: 'allowed', detail: text },
    ],
  });
  return JSON.stringify({ model: 'deepseek-v4.1-flash-1017', messages: [{ role: 'user', content }] });
}

describe('recepción real de la intervención', () => {
  test('un mensaje con comillas llega entero aunque el cuerpo lo escape dos veces', () => {
    const id = 'int:cs_demo:ml1:1';
    const text = 'No insistas con "tools/audit-check.mjs": es ruta protegida. Ejecuta el script "check" de package.json.';
    const body = envelope(text, id);
    expect(body.includes(JSON.stringify(text).slice(1, -1))).toBe(false);
    const seen = interventionReachedRequest([body], id, text);
    expect(seen.idSeen).toBe(true);
    expect(seen.textSeen).toBe(true);
    expect(seen.requests).toBe(1);
  });

  test('un mensaje con barras y saltos de línea también se reconoce', () => {
    const id = 'int:cs_demo:ml1:2';
    const text = 'Ruta C:\\repo\\src\\slug.js\nUsa node --test tests/slug.test.mjs';
    const seen = interventionReachedRequest([envelope(text, id)], id, text);
    expect(seen.idSeen).toBe(true);
    expect(seen.textSeen).toBe(true);
  });

  test('sin mensaje en la petición no se declara recepción', () => {
    const body = envelope('otra cosa', 'int:cs_demo:ml1:3');
    const seen = interventionReachedRequest([body], 'int:cs_demo:ml1:3', 'texto que nunca se envió');
    expect(seen.idSeen).toBe(true);
    expect(seen.textSeen).toBe(false);
  });

  test('sin peticiones no hay recepción', () => {
    const seen = interventionReachedRequest([], 'int:cs_demo:ml1:4', 'cualquier texto');
    expect(seen.idSeen).toBe(false);
    expect(seen.textSeen).toBe(false);
    expect(seen.requests).toBe(0);
  });
});
