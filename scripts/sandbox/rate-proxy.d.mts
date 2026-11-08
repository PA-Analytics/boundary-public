/**
 * Tipos públicos de `scripts/sandbox/rate-proxy.mjs`.
 *
 * El módulo es JS puro (se ejecuta con `node`/`bun` sin build). Esta declaración
 * es la interfaz que consumen los tests y el integrador.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export const UPSTREAM_ORIGIN: 'https://api.vultrinference.com';
export const UPSTREAM_CHAT_PATH: '/v1/chat/completions';
export const UPSTREAM_CHAT_URL: string;
export const ALLOWED_MODEL: 'deepseek-v4.1-flash-1017';
export const PROXY_VERSION: string;

export interface ProxyConfig {
  host: string;
  port: number;
  rpm: number;
  windowMs: number;
  burst: number;
  burstWindowMs: number;
  maxInFlight: number;
  maxQueue: number;
  queueWaitMs: number;
  generationMs: number;
  bodyLimitBytes: number;
  responseLimitBytes: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  retryAfterMaxMs: number;
}

export const DEFAULT_CONFIG: Readonly<ProxyConfig>;
export function normalizeConfig(partial?: Partial<ProxyConfig>): ProxyConfig;

export class ProxyError extends Error {
  constructor(status: number, message: string, extra?: Record<string, unknown>);
  status: number;
  retryAfterMs?: number;
}

export function redactSecrets(text: unknown): string;
export function parseRetryAfter(value: string | null | undefined, nowMs?: number): number | null;

export interface Limiter {
  peek(t?: number): number;
  record(t?: number): void;
  tryAcquire(t?: number): number;
  readonly size: number;
  readonly limit: number;
  readonly windowMs: number;
  readonly burst: number;
  readonly burstWindowMs: number;
}

export function createSlidingWindowLimiter(options: {
  limit: number;
  windowMs?: number;
  burst?: number;
  burstWindowMs?: number;
  now?: () => number;
}): Limiter;

export interface Cooldown {
  set(ms: number): number;
  remaining(t?: number): number;
  clear(): void;
  readonly until: number;
}

export function createCooldown(options?: { now?: () => number }): Cooldown;

export interface SchedulerStats {
  enqueued: number;
  dispatched: number;
  expired: number;
  cancelled: number;
  rejectedFull: number;
  depth: number;
  maxDepth: number;
}

export interface QueuedJob<T> {
  promise: Promise<T>;
  cancel(reason?: string): void;
  readonly state: string;
}

export interface Scheduler {
  enqueue<T>(run: (job: unknown) => Promise<T> | T): QueuedJob<T>;
  pump(): void;
  shutdown(reason?: string): void;
  readonly stats: SchedulerStats;
  readonly inFlight: number;
  readonly depth: number;
}

export function createScheduler(options: {
  limiter: Limiter;
  cooldown?: Cooldown | null;
  maxInFlight?: number;
  maxQueue?: number;
  queueWaitMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => any;
  clearTimer?: (handle: any) => void;
}): Scheduler;

export interface ProxyStats {
  requests: number;
  rejected: { model: number; body: number; auth: number; route: number; json: number; queueFull: number };
  upstream: { attempts: number; ok: number; rateLimited: number; errors: number; retries: number; timeouts: number };
  client: { completed: number; aborted: number };
  usage: {
    responses: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
  };
}

export interface ProxySnapshot extends ProxyStats {
  version: string;
  model: string;
  upstreamUrl: string;
  config: ProxyConfig;
  queue: SchedulerStats;
  rate: {
    rpm: number;
    burst: number;
    windowMs: number;
    windowUsed: number;
    inFlight: number;
    maxInFlight: number;
    cooldownMs: number;
  };
}

export interface ProxyLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RateProxyOptions {
  config?: Partial<ProxyConfig>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => any;
  clearTimer?: (handle: any) => void;
  logger?: ProxyLogger;
  upstreamUrl?: string;
}

export interface RateProxy {
  readonly config: ProxyConfig;
  readonly server: Server;
  readonly stats: ProxyStats;
  readonly scheduler: Scheduler;
  readonly limiter: Limiter;
  readonly cooldown: Cooldown;
  readonly logger: ProxyLogger;
  snapshot(): ProxySnapshot;
  listen(): Promise<{ port: number } | string | null>;
  close(): Promise<void>;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createRateProxy(options?: RateProxyOptions): RateProxy;
export function startProxy(options?: RateProxyOptions): Promise<RateProxy>;
