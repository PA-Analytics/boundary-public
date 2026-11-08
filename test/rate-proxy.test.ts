/**
 * Tests del proxy de ritmo. Cero red real: `fetchImpl` está mockeado y el
 * reloj se inyecta donde hace falta. No se usa Docker ni se instala nada.
 */
import { describe, expect, test } from 'bun:test';

import {
  ALLOWED_MODEL,
  DEFAULT_CONFIG,
  ProxyError,
  UPSTREAM_CHAT_URL,
  createCooldown,
  createRateProxy,
  createScheduler,
  createSlidingWindowLimiter,
  normalizeConfig,
  parseRetryAfter,
  redactSecrets,
} from '../scripts/sandbox/rate-proxy.mjs';

/* -------------------------------------------------------------------------- */
/* Utilidades                                                                 */
/* -------------------------------------------------------------------------- */

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function manualClock(start = 0) {
  let current = start;
  let nextId = 1;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  return {
    now: () => current,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: current + Math.max(0, ms), fn, id });
      return id;
    },
    clearTimer: (id: any) => {
      const index = timers.findIndex((t) => t.id === id);
      if (index !== -1) timers.splice(index, 1);
    },
    advance(ms: number) {
      const target = current + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        current = next.at;
        next.fn();
      }
      current = target;
    },
    get pending() {
      return timers.length;
    },
  };
}

async function startProxy(overrides: Record<string, any> = {}) {
  const { config: configOverrides, ...rest } = overrides;
  const proxy = createRateProxy({
    ...rest,
    config: { port: 0, rpm: 600, burst: 600, ...(configOverrides ?? {}) },
  });
  await proxy.listen();
  const address = proxy.server.address() as { port: number };
  return { proxy, base: `http://127.0.0.1:${address.port}` };
}

function post(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key', ...headers },
    body: JSON.stringify(body),
  });
}

const okResponse = (payload: unknown = { ok: true }) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });

/* -------------------------------------------------------------------------- */
/* Exclusividad                                                               */
/* -------------------------------------------------------------------------- */

describe('exclusividad', () => {
  test('sólo acepta el upstream exacto, sin substring ni prefijo', () => {
    expect(() =>
      createRateProxy({ upstreamUrl: 'https://api.vultrinference.com.evil.test/v1/chat/completions' }),
    ).toThrow(RangeError);
    expect(() => createRateProxy({ upstreamUrl: 'https://api.vultrinference.com/v1/chat/completions?x=1' })).toThrow(
      RangeError,
    );
    expect(() => createRateProxy({ upstreamUrl: 'http://api.vultrinference.com/v1/chat/completions' })).toThrow(
      RangeError,
    );
    expect(() => createRateProxy({ upstreamUrl: 'https://api.vultrinference.com/v1/chat/completions/' })).toThrow(
      RangeError,
    );
    expect(() => createRateProxy({ upstreamUrl: UPSTREAM_CHAT_URL })).not.toThrow();
  });

  test('el modelo permitido es único y exacto', () => {
    expect(ALLOWED_MODEL).toBe('deepseek-v4.1-flash-1017');
  });

  test('rechaza cualquier otro modelo sin llamar al upstream', async () => {
    const calls: string[] = [];
    const { proxy, base } = await startProxy({
      fetchImpl: async (url: string) => {
        calls.push(url);
        return okResponse();
      },
    });
    try {
      for (const model of ['glm-5.3', 'qwen3.8-27b', 'deepseek-v4.1-flash-1017 ', 'DEEPSEEK-V4.1-FLASH-1017', '']) {
        const res = await post(base, { model });
        expect(res.status).toBe(400);
        const payload = (await res.json()) as any;
        expect(payload.error.type).toBe('model_not_allowed');
      }
      expect(calls).toHaveLength(0);
      expect(proxy.snapshot().rejected.model).toBe(5);
    } finally {
      await proxy.close();
    }
  });

  test('reenvía al upstream exacto con el modelo permitido', async () => {
    const calls: { url: string; init: any }[] = [];
    const { proxy, base } = await startProxy({
      fetchImpl: async (url: string, init: any) => {
        calls.push({ url, init });
        return okResponse();
      },
    });
    try {
      const res = await post(base, { model: ALLOWED_MODEL, messages: [] });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(UPSTREAM_CHAT_URL);
      expect(calls[0]!.init.method).toBe('POST');
      expect(calls[0]!.init.headers.authorization).toBe('Bearer test-key');
    } finally {
      await proxy.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Retry-After                                                                */
/* -------------------------------------------------------------------------- */

describe('parseRetryAfter', () => {
  test('segundos numéricos', () => {
    expect(parseRetryAfter('9')).toBe(9_000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter(' 12 ')).toBe(12_000);
  });

  test('fracciones se redondean hacia arriba, nunca hacia abajo', () => {
    expect(parseRetryAfter('0.5')).toBe(500);
    expect(parseRetryAfter('1.234')).toBe(1_234);
    expect(parseRetryAfter('0.0001')).toBe(1);
  });

  test('fecha HTTP', () => {
    const now = Date.parse('Wed, 21 Oct 2015 07:27:55 GMT');
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', now)).toBe(5_000);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:27:00 GMT', now)).toBe(0);
  });

  test('valores no interpretables', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('basura')).toBeNull();
    expect(parseRetryAfter('-3')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Limitador                                                                  */
/* -------------------------------------------------------------------------- */

describe('createSlidingWindowLimiter', () => {
  test('la ventana móvil no deja pasar más de `limit`', () => {
    const clock = manualClock(0);
    const limiter = createSlidingWindowLimiter({
      limit: 3,
      windowMs: 1_000,
      burst: 3,
      burstWindowMs: 1_000,
      now: clock.now,
    });
    expect(limiter.tryAcquire()).toBe(0);
    expect(limiter.tryAcquire()).toBe(0);
    expect(limiter.tryAcquire()).toBe(0);
    expect(limiter.tryAcquire()).toBeGreaterThan(0);
    clock.advance(1_000);
    expect(limiter.tryAcquire()).toBe(0);
  });

  test('la ráfaga no adelanta cupo futuro', () => {
    const clock = manualClock(0);
    const limiter = createSlidingWindowLimiter({
      limit: 10,
      windowMs: 60_000,
      burst: 2,
      burstWindowMs: 1_000,
      now: clock.now,
    });
    expect(limiter.tryAcquire()).toBe(0);
    expect(limiter.tryAcquire()).toBe(0);
    const wait = limiter.tryAcquire();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(1_000);
    clock.advance(1_000);
    expect(limiter.tryAcquire()).toBe(0);
  });

  test('peek no consume cupo', () => {
    const clock = manualClock(0);
    const limiter = createSlidingWindowLimiter({
      limit: 1,
      windowMs: 1_000,
      burst: 1,
      burstWindowMs: 1_000,
      now: clock.now,
    });
    expect(limiter.peek()).toBe(0);
    expect(limiter.peek()).toBe(0);
    expect(limiter.size).toBe(0);
    expect(limiter.tryAcquire()).toBe(0);
    expect(limiter.peek()).toBeGreaterThan(0);
  });
});

describe('createCooldown', () => {
  test('comparte la espera y no la acorta', () => {
    const clock = manualClock(0);
    const cooldown = createCooldown({ now: clock.now });
    expect(cooldown.remaining()).toBe(0);
    cooldown.set(5_000);
    expect(cooldown.remaining()).toBe(5_000);
    clock.advance(2_000);
    expect(cooldown.remaining()).toBe(3_000);
    cooldown.set(1_000);
    expect(cooldown.remaining()).toBe(3_000);
    clock.advance(3_000);
    expect(cooldown.remaining()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Planificador                                                               */
/* -------------------------------------------------------------------------- */

function makeScheduler(overrides: Record<string, any> = {}) {
  const clock = manualClock(0);
  const limiter = createSlidingWindowLimiter({
    limit: 100,
    windowMs: 60_000,
    burst: 100,
    burstWindowMs: 1_000,
    now: clock.now,
  });
  const scheduler = createScheduler({
    limiter,
    maxInFlight: 1,
    maxQueue: 8,
    queueWaitMs: 10_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  });
  return { clock, limiter, scheduler };
}

describe('createScheduler', () => {
  test('FIFO y respeto de maxInFlight', async () => {
    const { scheduler } = makeScheduler();
    const order: number[] = [];
    const resolvers: Array<() => void> = [];
    const makeJob = (n: number) => () =>
      new Promise<void>((resolve) => {
        order.push(n);
        resolvers.push(resolve);
      });

    const a = scheduler.enqueue(makeJob(1));
    const b = scheduler.enqueue(makeJob(2));
    const c = scheduler.enqueue(makeJob(3));
    await flush();
    expect(order).toEqual([1]);
    expect(scheduler.inFlight).toBe(1);
    expect(scheduler.depth).toBe(2);

    resolvers[0]!();
    await flush();
    expect(order).toEqual([1, 2]);

    resolvers[1]!();
    await flush();
    expect(order).toEqual([1, 2, 3]);

    resolvers[2]!();
    await flush();
    expect(scheduler.inFlight).toBe(0);
    await Promise.all([a.promise, b.promise, c.promise]);
  });

  test('cola acotada: rechaza cuando está llena', async () => {
    const { scheduler } = makeScheduler({ maxQueue: 0 });
    const hold = scheduler.enqueue(() => new Promise<void>(() => {}));
    await flush();
    const rejected = scheduler.enqueue(() => undefined);
    await expect(rejected.promise).rejects.toThrow(/cola llena/);
    expect(scheduler.stats.rejectedFull).toBe(1);
    void hold;
  });

  test('deadline de espera separado del de generación', async () => {
    const { clock, scheduler } = makeScheduler({ queueWaitMs: 100 });
    const hold = scheduler.enqueue(() => new Promise<void>(() => {}));
    await flush();
    const waiting = scheduler.enqueue(() => undefined);
    const settled = waiting.promise.catch((error) => error);
    await flush();
    expect(scheduler.depth).toBe(1);
    clock.advance(150);
    await flush();
    const error = await settled;
    expect(error).toBeInstanceOf(ProxyError);
    expect(error.status).toBe(504);
    expect(scheduler.stats.expired).toBe(1);
    void hold;
  });

  test('cancelar un job en cola lo saca sin consumir ritmo', async () => {
    const { scheduler, limiter } = makeScheduler();
    const hold = scheduler.enqueue(() => new Promise<void>(() => {}));
    await flush();
    const usedBefore = limiter.size;
    const waiting = scheduler.enqueue(() => undefined);
    await flush();
    waiting.cancel('cliente desconectado');
    await expect(waiting.promise).rejects.toThrow(/cliente desconectado/);
    expect(scheduler.stats.cancelled).toBe(1);
    expect(scheduler.depth).toBe(0);
    expect(limiter.size).toBe(usedBefore);
    void hold;
  });

  test('shutdown rechaza lo que queda en cola', async () => {
    const { scheduler } = makeScheduler();
    const hold = scheduler.enqueue(() => new Promise<void>(() => {}));
    await flush();
    const waiting = scheduler.enqueue(() => undefined);
    await flush();
    scheduler.shutdown('proxy cerrado');
    await expect(waiting.promise).rejects.toThrow(/proxy cerrado/);
    expect(scheduler.depth).toBe(0);
    void hold;
  });
});

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

describe('proxy HTTP', () => {
  test('importar no abre puerto', () => {
    const proxy = createRateProxy({ config: { port: 0 } });
    expect(proxy.server.listening).toBe(false);
    void proxy.close();
  });

  test('health y stats', async () => {
    const { proxy, base } = await startProxy({ fetchImpl: async () => okResponse() });
    try {
      const health = await fetch(`${base}/__health`);
      expect(health.status).toBe(200);
      const healthBody = (await health.json()) as any;
      expect(healthBody.ok).toBe(true);
      expect(healthBody.model).toBe(ALLOWED_MODEL);
      expect(healthBody.upstream).toBe(UPSTREAM_CHAT_URL);

      const stats = await fetch(`${base}/__stats`);
      const statsBody = (await stats.json()) as any;
      expect(statsBody.rate.rpm).toBe(600);
      expect(statsBody.queue.depth).toBe(0);
    } finally {
      await proxy.close();
    }
  });

  test('rutas y métodos no permitidos', async () => {
    const { proxy, base } = await startProxy({ fetchImpl: async () => okResponse() });
    try {
      expect((await fetch(`${base}/v1/models`)).status).toBe(404);
      expect((await fetch(`${base}/v1/chat/completions`)).status).toBe(405);
      expect((await fetch(`${base}/v1/chat/completions/extra`, { method: 'POST' })).status).toBe(404);
    } finally {
      await proxy.close();
    }
  });

  test('exige Authorization y no la filtra', async () => {
    const { proxy, base } = await startProxy({ fetchImpl: async () => okResponse() });
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: ALLOWED_MODEL }),
      });
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).not.toContain('Bearer');
    } finally {
      await proxy.close();
    }
  });

  test('límite de cuerpo', async () => {
    const { proxy, base } = await startProxy({
      config: { bodyLimitBytes: 1_024 },
      fetchImpl: async () => okResponse(),
    });
    try {
      const res = await post(base, { model: ALLOWED_MODEL, padding: 'x'.repeat(4_000) });
      expect(res.status).toBe(413);
      expect(proxy.snapshot().rejected.body).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  test('JSON inválido', async () => {
    const { proxy, base } = await startProxy({ fetchImpl: async () => okResponse() });
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
        body: '{no-json',
      });
      expect(res.status).toBe(400);
    } finally {
      await proxy.close();
    }
  });

  test('429 respeta Retry-After sin recortar la espera', async () => {
    let attempt = 0;
    const { proxy, base } = await startProxy({
      config: { maxAttempts: 3 },
      fetchImpl: async () => {
        attempt += 1;
        if (attempt === 1) {
          return new Response('{}', { status: 429, headers: { 'retry-after': '0.25' } });
        }
        return okResponse({ ok: true });
      },
    });
    try {
      const started = Date.now();
      const res = await post(base, { model: ALLOWED_MODEL });
      const elapsed = Date.now() - started;
      expect(res.status).toBe(200);
      expect(attempt).toBe(2);
      expect(elapsed).toBeGreaterThanOrEqual(240);
      const snapshot = proxy.snapshot();
      expect(snapshot.upstream.rateLimited).toBe(1);
      expect(snapshot.upstream.retries).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  test('429 persistente devuelve 429 con Retry-After', async () => {
    const { proxy, base } = await startProxy({
      config: { maxAttempts: 2 },
      fetchImpl: async () => new Response('{}', { status: 429, headers: { 'retry-after': '0.05' } }),
    });
    try {
      const res = await post(base, { model: ALLOWED_MODEL });
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(proxy.snapshot().upstream.rateLimited).toBe(2);
    } finally {
      await proxy.close();
    }
  });

  test('cola llena devuelve 503', async () => {
    const { proxy, base } = await startProxy({
      config: { maxInFlight: 1, maxQueue: 0 },
      fetchImpl: () => new Promise<Response>(() => {}),
    });
    try {
      const first = post(base, { model: ALLOWED_MODEL }).catch(() => null);
      await flush();
      const second = await post(base, { model: ALLOWED_MODEL });
      expect(second.status).toBe(503);
      expect(proxy.snapshot().rejected.queueFull).toBe(1);
      void first;
    } finally {
      await proxy.close();
    }
  });

  test('deadline de espera en cola devuelve 504', async () => {
    const { proxy, base } = await startProxy({
      config: { maxInFlight: 1, maxQueue: 4, queueWaitMs: 60 },
      fetchImpl: () => new Promise<Response>(() => {}),
    });
    try {
      const first = post(base, { model: ALLOWED_MODEL }).catch(() => null);
      await flush();
      const second = await post(base, { model: ALLOWED_MODEL });
      expect(second.status).toBe(504);
      void first;
    } finally {
      await proxy.close();
    }
  });

  test('la desconexión del cliente aborta el upstream', async () => {
    let aborted = false;
    const { proxy, base } = await startProxy({
      fetchImpl: (_url: string, init: any) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    try {
      const controller = new AbortController();
      const pending = fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
        body: JSON.stringify({ model: ALLOWED_MODEL }),
        signal: controller.signal,
      }).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 60));
      controller.abort();
      await pending;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(aborted).toBe(true);
      expect(proxy.snapshot().client.aborted).toBeGreaterThanOrEqual(1);
    } finally {
      await proxy.close();
    }
  });

  test('acumula uso real, caché y razonamiento', async () => {
    const { proxy, base } = await startProxy({
      fetchImpl: async () =>
        okResponse({
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 40,
            total_tokens: 140,
            prompt_tokens_details: { cached_tokens: 30 },
            completion_tokens_details: { reasoning_tokens: 12 },
          },
        }),
    });
    try {
      await post(base, { model: ALLOWED_MODEL });
      await post(base, { model: ALLOWED_MODEL });
      const usage = proxy.snapshot().usage;
      expect(usage.responses).toBe(2);
      expect(usage.promptTokens).toBe(200);
      expect(usage.completionTokens).toBe(80);
      expect(usage.totalTokens).toBe(280);
      expect(usage.cachedTokens).toBe(60);
      expect(usage.reasoningTokens).toBe(24);
    } finally {
      await proxy.close();
    }
  });

  test('sin usage en la respuesta no inventa cifras', async () => {
    const { proxy, base } = await startProxy({ fetchImpl: async () => okResponse({ choices: [] }) });
    try {
      await post(base, { model: ALLOWED_MODEL });
      const usage = proxy.snapshot().usage;
      expect(usage.responses).toBe(0);
      expect(usage.totalTokens).toBe(0);
    } finally {
      await proxy.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Configuración y secretos                                                   */
/* -------------------------------------------------------------------------- */

describe('configuración', () => {
  test('defaults conservadores', () => {
    expect(DEFAULT_CONFIG.rpm).toBe(90);
    expect(DEFAULT_CONFIG.maxInFlight).toBe(16);
    expect(DEFAULT_CONFIG.burst).toBeLessThanOrEqual(DEFAULT_CONFIG.rpm);
  });

  test('normaliza y acota', () => {
    const config = normalizeConfig({ rpm: 10_000, burst: 10_000, maxInFlight: 0, maxQueue: -5, port: 0 });
    expect(config.rpm).toBe(600);
    expect(config.burst).toBe(600);
    expect(config.maxInFlight).toBe(1);
    expect(config.maxQueue).toBe(0);
    expect(config.port).toBe(0);
  });
});

describe('redactSecrets', () => {
  test('oculta bearer y claves', () => {
    expect(redactSecrets('Authorization: Bearer sk-abc123')).not.toContain('sk-abc123');
    expect(redactSecrets('{"api_key":"sk-abc123"}')).not.toContain('sk-abc123');
    expect(redactSecrets('token=sk-abc123')).not.toContain('sk-abc123');
  });
});

describe('ProxyError', () => {
  test('lleva status y retryAfterMs', () => {
    const error = new ProxyError(429, 'x', { retryAfterMs: 1_500 });
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(1_500);
    expect(error).toBeInstanceOf(Error);
  });
});
