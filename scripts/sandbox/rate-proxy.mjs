#!/usr/bin/env node
/**
 * rate-proxy.mjs — proxy limitador exclusivo para Vultr Serverless Inference.
 *
 * Un único punto de salida para todos los workers del gauntlet. Garantías:
 *
 *  1. Exclusividad de modelo: sólo `deepseek-v4.1-flash-1017` (igualdad exacta,
 *     sin allowlist ampliable y sin comparaciones por substring).
 *  2. Exclusividad de upstream: sólo `https://api.vultrinference.com` y sólo la
 *     ruta `/v1/chat/completions`. Cualquier otra URL se rechaza al construir.
 *  3. Ritmo conservador configurable (90 rpm por defecto, reservando margen
 *     frente al límite medido de ~120 rpm) con ventana móvil + tope de ráfaga,
 *     de forma que ni la ventana ni la ráfaga puedan violar el límite.
 *  4. Máximo de peticiones upstream en vuelo (16 por defecto).
 *  5. Cola FIFO acotada con deadline propio de espera, separado del deadline de
 *     generación (lo que tarda el upstream en responder).
 *  6. `Retry-After` numérico o fecha HTTP, redondeado hacia arriba: nunca se
 *     espera menos de lo pedido por el servidor.
 *  7. Cooldown compartido entre todos los workers cuando el upstream da 429,
 *     más backoff exponencial acotado cuando no hay `Retry-After`.
 *  8. Desconexión del cliente cancela el trabajo en cola y aborta el upstream;
 *     no se siguen consumiendo peticiones huérfanas.
 *  9. Límite de tamaño de cuerpo y de respuesta.
 * 10. La cabecera `Authorization` nunca se registra ni se refleja en errores.
 * 11. Estadísticas de cola, intentos y uso real (tokens, caché, razonamiento)
 *     cuando la API los reporta.
 *
 * El módulo NO abre puertos al importarse: exporta factories y sólo arranca el
 * servidor cuando se ejecuta como programa principal.
 *
 * Uso:
 *   node scripts/sandbox/rate-proxy.mjs [--port 8787] [--rpm 90] [--burst 4]
 *   node scripts/sandbox/rate-proxy.mjs --print-config
 * Los workers apuntan VULTR_INFERENCE_BASE_URL a http://127.0.0.1:8787/v1
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const UPSTREAM_ORIGIN = 'https://api.vultrinference.com';
export const UPSTREAM_CHAT_PATH = '/v1/chat/completions';
export const UPSTREAM_CHAT_URL = `${UPSTREAM_ORIGIN}${UPSTREAM_CHAT_PATH}`;
export const ALLOWED_MODEL = 'deepseek-v4.1-flash-1017';
export const PROXY_VERSION = '2.0.0';

export const DEFAULT_CONFIG = Object.freeze({
  host: '127.0.0.1',
  port: 8787,
  rpm: 90,
  windowMs: 60_000,
  burst: 4,
  burstWindowMs: 1_000,
  maxInFlight: 16,
  maxQueue: 64,
  queueWaitMs: 120_000,
  generationMs: 180_000,
  bodyLimitBytes: 1_048_576,
  responseLimitBytes: 8_388_608,
  maxAttempts: 4,
  backoffBaseMs: 500,
  backoffMaxMs: 20_000,
  retryAfterMaxMs: 300_000,
});

export class ProxyError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
    Object.assign(this, extra);
  }
}

/* -------------------------------------------------------------------------- */
/* Configuración                                                              */
/* -------------------------------------------------------------------------- */

export function normalizeConfig(partial = {}) {
  const merged = { ...DEFAULT_CONFIG, ...partial };
  const int = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };
  const config = {
    host: typeof merged.host === 'string' && merged.host.length > 0 ? merged.host : DEFAULT_CONFIG.host,
    port: int(merged.port, DEFAULT_CONFIG.port, 0, 65_535),
    rpm: int(merged.rpm, DEFAULT_CONFIG.rpm, 1, 600),
    windowMs: int(merged.windowMs, DEFAULT_CONFIG.windowMs, 1_000, 600_000),
    burst: int(merged.burst, DEFAULT_CONFIG.burst, 1, 600),
    burstWindowMs: int(merged.burstWindowMs, DEFAULT_CONFIG.burstWindowMs, 100, 60_000),
    maxInFlight: int(merged.maxInFlight, DEFAULT_CONFIG.maxInFlight, 1, 64),
    maxQueue: int(merged.maxQueue, DEFAULT_CONFIG.maxQueue, 0, 1_024),
    queueWaitMs: int(merged.queueWaitMs, DEFAULT_CONFIG.queueWaitMs, 0, 3_600_000),
    generationMs: int(merged.generationMs, DEFAULT_CONFIG.generationMs, 1_000, 3_600_000),
    bodyLimitBytes: int(merged.bodyLimitBytes, DEFAULT_CONFIG.bodyLimitBytes, 1_024, 67_108_864),
    responseLimitBytes: int(merged.responseLimitBytes, DEFAULT_CONFIG.responseLimitBytes, 1_024, 67_108_864),
    maxAttempts: int(merged.maxAttempts, DEFAULT_CONFIG.maxAttempts, 1, 10),
    backoffBaseMs: int(merged.backoffBaseMs, DEFAULT_CONFIG.backoffBaseMs, 0, 60_000),
    backoffMaxMs: int(merged.backoffMaxMs, DEFAULT_CONFIG.backoffMaxMs, 0, 300_000),
    retryAfterMaxMs: int(merged.retryAfterMaxMs, DEFAULT_CONFIG.retryAfterMaxMs, 0, 3_600_000),
  };
  if (config.burst > config.rpm) config.burst = config.rpm;
  if (config.backoffMaxMs < config.backoffBaseMs) config.backoffMaxMs = config.backoffBaseMs;
  return config;
}

/* -------------------------------------------------------------------------- */
/* Secretos                                                                   */
/* -------------------------------------------------------------------------- */

const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_VALUE_RE = /("?(?:api[_-]?key|authorization|token|secret)"?\s*[:=]\s*"?)[^"\s,}]+/gi;

export function redactSecrets(text) {
  return String(text ?? '')
    .replace(BEARER_RE, 'Bearer [redacted]')
    .replace(KEY_VALUE_RE, '$1[redacted]');
}

/* -------------------------------------------------------------------------- */
/* Retry-After                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Convierte `Retry-After` (segundos numéricos o fecha HTTP) a milisegundos.
 * Redondea hacia arriba para no esperar nunca menos de lo pedido.
 * Devuelve `null` si el valor no es interpretable.
 */
const HTTP_DATE_RE =
  /^(?:[A-Za-z]{3},\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT|[A-Za-z]{6,9},\s*\d{1,2}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+GMT|[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/;

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.ceil(seconds * 1_000);
  }
  // Sólo se acepta una fecha HTTP real: `Date.parse` es demasiado laxo y
  // interpretaría cosas como '-3' como una fecha válida.
  if (!HTTP_DATE_RE.test(raw)) return null;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/* -------------------------------------------------------------------------- */
/* Limitador de ventana móvil                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Ventana móvil estricta: como mucho `limit` concesiones en cualquier intervalo
 * de `windowMs`, y como mucho `burst` en cualquier intervalo de `burstWindowMs`.
 * Al no usar cubo de fichas, una ráfaga no puede adelantar cupo futuro.
 */
export function createSlidingWindowLimiter(options = {}) {
  const {
    limit,
    windowMs = 60_000,
    burst = limit,
    burstWindowMs = 1_000,
    now = Date.now,
  } = options;
  if (!Number.isFinite(limit) || limit < 1) throw new RangeError('limit debe ser >= 1');
  const log = [];

  const prune = (t) => {
    while (log.length > 0 && t - log[0] >= windowMs) log.shift();
  };

  function peek(t = now()) {
    prune(t);
    if (log.length >= limit) return Math.max(1, log[0] + windowMs - t);
    if (burst < limit) {
      let recent = 0;
      for (let i = log.length - 1; i >= 0; i -= 1) {
        if (t - log[i] < burstWindowMs) recent += 1;
        else break;
      }
      if (recent >= burst) {
        const oldest = log[log.length - burst];
        return Math.max(1, oldest + burstWindowMs - t);
      }
    }
    return 0;
  }

  function record(t = now()) {
    log.push(t);
    prune(t);
  }

  function tryAcquire(t = now()) {
    const wait = peek(t);
    if (wait === 0) record(t);
    return wait;
  }

  return {
    peek,
    record,
    tryAcquire,
    get size() {
      return log.length;
    },
    limit,
    windowMs,
    burst,
    burstWindowMs,
  };
}

/* -------------------------------------------------------------------------- */
/* Cooldown compartido                                                        */
/* -------------------------------------------------------------------------- */

export function createCooldown(options = {}) {
  const { now = Date.now } = options;
  let until = 0;
  return {
    set(ms) {
      const delay = Math.max(0, Number(ms) || 0);
      until = Math.max(until, now() + delay);
      return until;
    },
    remaining(t = now()) {
      return Math.max(0, until - t);
    },
    clear() {
      until = 0;
    },
    get until() {
      return until;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Planificador: cola FIFO acotada + concurrencia + ritmo                     */
/* -------------------------------------------------------------------------- */

export function createScheduler(options) {
  const {
    limiter,
    cooldown = null,
    maxInFlight = 16,
    maxQueue = 64,
    queueWaitMs = 120_000,
    now = Date.now,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
  } = options;

  const queue = [];
  let inFlight = 0;
  let timer = null;
  const stats = {
    enqueued: 0,
    dispatched: 0,
    expired: 0,
    cancelled: 0,
    rejectedFull: 0,
    depth: 0,
    maxDepth: 0,
  };

  function armTimer(delayMs) {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    timer = setTimer(() => {
      timer = null;
      pump();
    }, Math.max(1, delayMs));
  }

  function pump() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    while (queue.length > 0) {
      const head = queue[0];
      if (head.state !== 'queued') {
        queue.shift();
        continue;
      }
      const t = now();
      if (t >= head.deadlineAt) {
        queue.shift();
        head.state = 'expired';
        stats.expired += 1;
        head.reject(new ProxyError(504, 'rate-proxy: deadline de espera en cola agotado'));
        continue;
      }
      if (inFlight >= maxInFlight) break;
      const wait = Math.max(limiter.peek(t), cooldown ? cooldown.remaining(t) : 0);
      if (wait > 0) {
        armTimer(Math.min(wait, head.deadlineAt - t));
        stats.depth = queue.length;
        return;
      }
      limiter.record(t);
      queue.shift();
      head.state = 'running';
      inFlight += 1;
      stats.dispatched += 1;
      Promise.resolve()
        .then(() => head.run(head))
        .then(
          (value) => head.resolve(value),
          (error) => head.reject(error),
        )
        .finally(() => {
          inFlight -= 1;
          pump();
        });
    }
    stats.depth = queue.length;
    if (queue.length > 0) {
      const head = queue[0];
      armTimer(Math.max(1, head.deadlineAt - now()));
    }
  }

  function enqueue(run) {
    const job = { run, state: 'queued', deadlineAt: now() + queueWaitMs, resolve: null, reject: null };
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    queue.push(job);
    stats.enqueued += 1;
    stats.depth = queue.length;
    stats.maxDepth = Math.max(stats.maxDepth, queue.length);
    pump();

    // Si tras el despacho inmediato el job sigue esperando y la cola excede el
    // tope, se rechaza: la cola es acotada, no crece sin límite.
    if (job.state === 'queued' && queue.length > maxQueue) {
      const index = queue.indexOf(job);
      if (index !== -1) queue.splice(index, 1);
      job.state = 'rejected';
      stats.enqueued -= 1;
      stats.rejectedFull += 1;
      stats.depth = queue.length;
      job.reject(new ProxyError(503, 'rate-proxy: cola llena'));
      return { promise, cancel() {}, state: 'rejected' };
    }

    return {
      promise,
      cancel(reason = 'cancelado') {
        if (job.state !== 'queued') return;
        const index = queue.indexOf(job);
        if (index !== -1) queue.splice(index, 1);
        job.state = 'cancelled';
        stats.cancelled += 1;
        stats.depth = queue.length;
        job.reject(new ProxyError(499, `rate-proxy: ${reason}`));
        pump();
      },
      get state() {
        return job.state;
      },
    };
  }

  function shutdown(reason = 'proxy cerrado') {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    while (queue.length > 0) {
      const job = queue.shift();
      if (job.state === 'queued') {
        job.state = 'cancelled';
        job.reject(new ProxyError(503, `rate-proxy: ${reason}`));
      }
    }
    stats.depth = 0;
  }

  return {
    enqueue,
    pump,
    shutdown,
    stats,
    get inFlight() {
      return inFlight;
    },
    get depth() {
      return queue.length;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Utilidades HTTP                                                            */
/* -------------------------------------------------------------------------- */

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      if (!overflow) chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (overflow) reject(new ProxyError(413, `rate-proxy: cuerpo mayor a ${limit} bytes`));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.on('aborted', () => {
      if (settled) return;
      settled = true;
      reject(new ProxyError(499, 'rate-proxy: cliente desconectado'));
    });
  });
}

function createLogger(sink = console) {
  return {
    info: (message) => sink.log(message),
    warn: (message) => sink.warn(message),
    error: (message) => sink.error(message),
  };
}

/* -------------------------------------------------------------------------- */
/* Proxy                                                                      */
/* -------------------------------------------------------------------------- */

export function createRateProxy(options = {}) {
  const config = normalizeConfig(options.config ?? {});
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger ?? createLogger();
  const upstreamUrl = options.upstreamUrl ?? UPSTREAM_CHAT_URL;

  // Exclusividad de upstream: igualdad exacta, nunca substring ni prefijo.
  if (upstreamUrl !== UPSTREAM_CHAT_URL) {
    throw new RangeError(`rate-proxy: upstream no permitido '${upstreamUrl}' (sólo ${UPSTREAM_CHAT_URL})`);
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('rate-proxy: fetchImpl debe ser una función');

  const limiter = createSlidingWindowLimiter({
    limit: config.rpm,
    windowMs: config.windowMs,
    burst: config.burst,
    burstWindowMs: config.burstWindowMs,
    now,
  });
  const cooldown = createCooldown({ now });
  const scheduler = createScheduler({
    limiter,
    cooldown,
    maxInFlight: config.maxInFlight,
    maxQueue: config.maxQueue,
    queueWaitMs: config.queueWaitMs,
    now,
    setTimer,
    clearTimer,
  });

  const stats = {
    requests: 0,
    rejected: { model: 0, body: 0, auth: 0, route: 0, json: 0, queueFull: 0 },
    upstream: { attempts: 0, ok: 0, rateLimited: 0, errors: 0, retries: 0, timeouts: 0 },
    client: { completed: 0, aborted: 0 },
    usage: {
      responses: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
    },
  };

  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

  function recordUsage(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const usage = parsed && typeof parsed === 'object' ? parsed.usage : null;
    if (!usage || typeof usage !== 'object') return;
    const prompt = num(usage.prompt_tokens);
    const completion = num(usage.completion_tokens);
    const total = num(usage.total_tokens) ?? (prompt ?? 0) + (completion ?? 0);
    const cached =
      num(usage.prompt_tokens_details?.cached_tokens) ??
      num(usage.cache_read_input_tokens) ??
      num(usage.cached_tokens);
    const reasoning =
      num(usage.completion_tokens_details?.reasoning_tokens) ??
      num(usage.reasoning_tokens) ??
      num(usage.thinking_tokens);
    stats.usage.responses += 1;
    stats.usage.promptTokens += prompt ?? 0;
    stats.usage.completionTokens += completion ?? 0;
    stats.usage.totalTokens += total ?? 0;
    stats.usage.cachedTokens += cached ?? 0;
    stats.usage.reasoningTokens += reasoning ?? 0;
  }

  function boundedBackoff(attempt) {
    const raw = config.backoffBaseMs * 2 ** Math.max(0, attempt - 1);
    return Math.min(config.backoffMaxMs, Math.max(config.backoffBaseMs, raw));
  }

  function createJob({ body, authorization, res }) {
    const controllers = new Set();
    const readers = new Set();
    const sleepers = new Set();
    let cancelled = false;

    return {
      body,
      authorization,
      res,
      get cancelled() {
        return cancelled;
      },
      attach(controller) {
        controllers.add(controller);
        return () => controllers.delete(controller);
      },
      attachReader(reader) {
        readers.add(reader);
        return () => readers.delete(reader);
      },
      cancel(reason = 'cliente desconectado') {
        if (cancelled) return;
        cancelled = true;
        for (const controller of controllers) {
          try {
            controller.abort(new ProxyError(499, reason));
          } catch {
            /* noop */
          }
        }
        controllers.clear();
        for (const reader of readers) {
          try {
            Promise.resolve(reader.cancel()).catch(() => {});
          } catch {
            /* noop */
          }
        }
        readers.clear();
        for (const sleeper of [...sleepers]) sleeper.reject(new ProxyError(499, reason));
        sleepers.clear();
      },
      sleep(ms) {
        if (cancelled) return Promise.reject(new ProxyError(499, 'cliente desconectado'));
        return new Promise((resolve, reject) => {
          const sleeper = { reject: null };
          const handle = setTimer(() => {
            sleepers.delete(sleeper);
            resolve();
          }, ms);
          sleeper.reject = (error) => {
            clearTimer(handle);
            sleepers.delete(sleeper);
            reject(error);
          };
          sleepers.add(sleeper);
        });
      },
    };
  }

  async function forward(job) {
    const deadline = now() + config.generationMs;
    let attempt = 0;
    let lastError = null;

    while (attempt < config.maxAttempts) {
      attempt += 1;
      if (job.cancelled) throw new ProxyError(499, 'cliente desconectado');
      const remaining = deadline - now();
      if (remaining <= 0) {
        stats.upstream.timeouts += 1;
        throw new ProxyError(504, 'rate-proxy: deadline de generación agotado');
      }

      const controller = new AbortController();
      const detach = job.attach(controller);
      const timer = setTimer(() => {
        try {
          controller.abort(new ProxyError(504, 'rate-proxy: deadline de generación agotado'));
        } catch {
          /* noop */
        }
      }, remaining);

      let response;
      try {
        response = await fetchImpl(upstreamUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: job.authorization },
          body: job.body,
          signal: controller.signal,
        });
      } catch (error) {
        lastError = error;
        if (job.cancelled) throw new ProxyError(499, 'cliente desconectado');
        if (attempt >= config.maxAttempts) {
          stats.upstream.errors += 1;
          throw new ProxyError(502, 'rate-proxy: upstream inalcanzable');
        }
        stats.upstream.retries += 1;
        await job.sleep(boundedBackoff(attempt));
        continue;
      } finally {
        clearTimer(timer);
        detach();
      }

      stats.upstream.attempts += 1;

      if (response.status !== 429) {
        stats.upstream.ok += 1;
        return response;
      }

      stats.upstream.rateLimited += 1;
      const rawRetryAfter = response.headers.get('retry-after');
      const parsed = parseRetryAfter(rawRetryAfter, now());
      const retryAfterMs = parsed === null ? null : Math.min(parsed, config.retryAfterMaxMs);
      try {
        await response.text();
      } catch {
        /* noop */
      }
      if (retryAfterMs !== null) cooldown.set(retryAfterMs);

      if (attempt >= config.maxAttempts) {
        throw new ProxyError(429, 'rate-proxy: 429 persistente del upstream', {
          retryAfterMs: retryAfterMs ?? boundedBackoff(attempt),
        });
      }

      // Nunca se recorta por debajo de lo pedido: si hay Retry-After se espera
      // exactamente eso; el backoff acotado sólo aplica cuando no lo hay.
      const waitMs = retryAfterMs !== null ? retryAfterMs : boundedBackoff(attempt);
      if (now() + waitMs >= deadline) {
        stats.upstream.timeouts += 1;
        throw new ProxyError(429, 'rate-proxy: 429 con espera mayor al deadline de generación', {
          retryAfterMs: waitMs,
        });
      }
      stats.upstream.retries += 1;
      await job.sleep(waitMs);
    }

    stats.upstream.errors += 1;
    throw new ProxyError(502, 'rate-proxy: upstream inalcanzable', {
      cause: lastError instanceof Error ? lastError.message : undefined,
    });
  }

  async function execute(job, res) {
    const response = await forward(job);
    const contentType = response.headers.get('content-type') ?? 'application/json';

    if (contentType.includes('text/event-stream') && response.body) {
      if (res.destroyed) {
        try {
          await response.body.cancel();
        } catch {
          /* noop */
        }
        return;
      }
      res.writeHead(response.status, {
        'content-type': contentType,
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const reader = response.body.getReader();
      const detach = job.attachReader(reader);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (job.cancelled || res.destroyed) {
            try {
              await reader.cancel();
            } catch {
              /* noop */
            }
            break;
          }
          res.write(Buffer.from(value));
        }
      } finally {
        detach();
      }
      if (!res.writableEnded && !res.destroyed) res.end();
      stats.client.completed += 1;
      return;
    }

    const text = await response.text();
    if (text.length > config.responseLimitBytes) {
      throw new ProxyError(502, 'rate-proxy: respuesta del upstream demasiado grande');
    }
    recordUsage(text);
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(response.status, { 'content-type': contentType });
    res.end(text);
    stats.client.completed += 1;
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${config.host}:${config.port}`);

    if (req.method === 'GET' && url.pathname === '/__health') {
      sendJson(res, 200, {
        ok: true,
        version: PROXY_VERSION,
        model: ALLOWED_MODEL,
        upstream: UPSTREAM_CHAT_URL,
        inFlight: scheduler.inFlight,
        depth: scheduler.depth,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/__stats') {
      sendJson(res, 200, snapshot());
      return;
    }

    if (url.pathname !== UPSTREAM_CHAT_PATH) {
      stats.rejected.route += 1;
      sendJson(res, 404, { error: { message: `rate-proxy: sólo POST ${UPSTREAM_CHAT_PATH}`, type: 'route_not_allowed' } });
      return;
    }

    if (req.method !== 'POST') {
      stats.rejected.route += 1;
      sendJson(res, 405, { error: { message: 'rate-proxy: método no permitido', type: 'method_not_allowed' } });
      return;
    }

    stats.requests += 1;

    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || authorization.trim() === '') {
      stats.rejected.auth += 1;
      sendJson(res, 401, { error: { message: 'rate-proxy: falta Authorization', type: 'missing_auth' } });
      return;
    }

    let body;
    try {
      body = await readBody(req, config.bodyLimitBytes);
    } catch (error) {
      if (error instanceof ProxyError && error.status === 413) {
        stats.rejected.body += 1;
        sendJson(res, 413, { error: { message: error.message, type: 'body_too_large' } });
        return;
      }
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      stats.rejected.json += 1;
      sendJson(res, 400, { error: { message: 'rate-proxy: JSON inválido', type: 'invalid_json' } });
      return;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      stats.rejected.json += 1;
      sendJson(res, 400, { error: { message: 'rate-proxy: el cuerpo debe ser un objeto JSON', type: 'invalid_json' } });
      return;
    }

    // Exclusividad de modelo: igualdad exacta, sin allowlist ampliable.
    if (parsed.model !== ALLOWED_MODEL) {
      stats.rejected.model += 1;
      sendJson(res, 400, {
        error: {
          message: `rate-proxy: modelo no permitido; sólo '${ALLOWED_MODEL}'`,
          type: 'model_not_allowed',
        },
      });
      return;
    }

    const job = createJob({ body, authorization, res });
    const queued = scheduler.enqueue(() => execute(job, res));
    if (queued.state === 'rejected') stats.rejected.queueFull += 1;

    const onClose = () => {
      if (res.writableEnded) return;
      stats.client.aborted += 1;
      job.cancel('cliente desconectado');
      queued.cancel('cliente desconectado');
    };
    res.on('close', onClose);

    try {
      await queued.promise;
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      const status = error instanceof ProxyError ? error.status : 502;
      const headers = {};
      if (error && typeof error.retryAfterMs === 'number') {
        headers['retry-after'] = String(Math.ceil(error.retryAfterMs / 1_000));
      }
      sendJson(
        res,
        status,
        {
          error: {
            message: redactSecrets(error instanceof Error ? error.message : 'rate-proxy: error'),
            type: error instanceof ProxyError ? 'proxy_error' : 'upstream_error',
          },
        },
        headers,
      );
    } finally {
      res.off('close', onClose);
    }
  }

  function snapshot() {
    return {
      version: PROXY_VERSION,
      model: ALLOWED_MODEL,
      upstreamUrl: UPSTREAM_CHAT_URL,
      config: { ...config },
      requests: stats.requests,
      rejected: { ...stats.rejected },
      queue: { ...scheduler.stats, depth: scheduler.depth },
      upstream: { ...stats.upstream },
      client: { ...stats.client },
      usage: { ...stats.usage },
      rate: {
        rpm: config.rpm,
        burst: config.burst,
        windowMs: config.windowMs,
        windowUsed: limiter.size,
        inFlight: scheduler.inFlight,
        maxInFlight: config.maxInFlight,
        cooldownMs: Math.round(cooldown.remaining()),
      },
    };
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.error(`rate-proxy: ${redactSecrets(error instanceof Error ? error.message : error)}`);
      if (!res.writableEnded && !res.destroyed) {
        sendJson(res, 500, { error: { message: 'rate-proxy: error interno', type: 'internal_error' } });
      }
    });
  });

  let closed = false;

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address());
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.port, config.host);
    });
  }

  async function close() {
    if (closed) return;
    closed = true;
    scheduler.shutdown('proxy cerrado');
    await new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
  }

  return { config, server, stats, snapshot, listen, close, handle, scheduler, limiter, cooldown, logger };
}

export async function startProxy(options = {}) {
  const proxy = createRateProxy(options);
  await proxy.listen();
  return proxy;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const ARG_MAP = {
  port: 'port',
  host: 'host',
  rpm: 'rpm',
  burst: 'burst',
  'max-in-flight': 'maxInFlight',
  'max-queue': 'maxQueue',
  'queue-wait-ms': 'queueWaitMs',
  'generation-ms': 'generationMs',
  'body-limit': 'bodyLimitBytes',
  'max-attempts': 'maxAttempts',
  'backoff-base-ms': 'backoffBaseMs',
  'backoff-max-ms': 'backoffMaxMs',
};

function parseArgs(argv) {
  const config = {};
  const flags = { help: false, printConfig: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--print-config') {
      flags.printConfig = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`argumento no reconocido: ${arg}`);
    const [rawName, inline] = arg.slice(2).split('=');
    const key = ARG_MAP[rawName];
    if (!key) throw new Error(`opción desconocida: --${rawName}`);
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`falta valor para --${rawName}`);
    config[key] = Number(value);
  }
  return { config, ...flags };
}

function usage() {
  return [
    'rate-proxy — proxy limitador exclusivo para Vultr Serverless Inference',
    '',
    `  modelo permitido : ${ALLOWED_MODEL}`,
    `  upstream         : ${UPSTREAM_CHAT_URL}`,
    '',
    'Opciones:',
    '  --host <ip>              (por defecto 127.0.0.1)',
    '  --port <n>               (por defecto 8787)',
    '  --rpm <n>                peticiones por minuto (por defecto 90)',
    '  --burst <n>              máximo por ventana de ráfaga (por defecto 4)',
    '  --max-in-flight <n>      peticiones upstream simultáneas (por defecto 16)',
    '  --max-queue <n>          cola FIFO máxima (por defecto 64)',
    '  --queue-wait-ms <n>      deadline de espera en cola (por defecto 120000)',
    '  --generation-ms <n>      deadline de generación (por defecto 180000)',
    '  --body-limit <bytes>     tamaño máximo de cuerpo (por defecto 1048576)',
    '  --max-attempts <n>       intentos por petición (por defecto 4)',
    '  --print-config           imprime la configuración normalizada y sale',
    '  --help                   esta ayuda',
  ].join('\n');
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return null;
  }
  const proxy = createRateProxy({ config: args.config });
  if (args.printConfig) {
    console.log(JSON.stringify(proxy.config, null, 2));
    return null;
  }
  await proxy.listen();
  const { host, port, rpm, burst, maxInFlight, maxQueue } = proxy.config;
  console.log(
    `rate-proxy ${PROXY_VERSION} en http://${host}:${port}/v1 — ${rpm} rpm, burst ${burst}, ` +
      `in-flight ${maxInFlight}, cola ${maxQueue}, modelo ${ALLOWED_MODEL}`,
  );
  const stop = () => {
    proxy.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return proxy;
}

const isMain = (() => {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`rate-proxy: ${redactSecrets(error instanceof Error ? error.message : error)}`);
    process.exitCode = 1;
  });
}
