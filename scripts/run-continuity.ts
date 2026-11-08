#!/usr/bin/env bun
/** Opt-in launch of the supervised product. No agent starts until an authorized HTTP request. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const envFile = process.env.BOUNDARY_ENV_FILE ?? resolve(root, '.secrets/boundary.env');
const allowed = new Set(['VULTR_INFERENCE_API_KEY', 'VULTR_INFERENCE_BASE_URL', 'VULTR_INFERENCE_MODEL', 'BOUNDARY_API_TOKEN']);
if (existsSync(envFile)) {
  for (const raw of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    const name = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (allowed.has(name) && !process.env[name]) process.env[name] = value;
  }
}
const model = 'deepseek-v4.1-flash-1017';
if (process.env.VULTR_INFERENCE_MODEL && process.env.VULTR_INFERENCE_MODEL !== model) throw new Error('This product demo requires the configured Vultr DeepSeek model');
process.env.VULTR_INFERENCE_MODEL = model;
process.env.VULTR_INFERENCE_BASE_URL ??= 'https://api.vultrinference.com/v1';
const endpoint = new URL(process.env.VULTR_INFERENCE_BASE_URL);
if (endpoint.origin !== 'https://api.vultrinference.com' || endpoint.pathname.replace(/\/$/, '') !== '/v1' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Only the exact Vultr inference endpoint is allowed');
process.env.BOUNDARY_SANDBOX_IMAGE ??= 'boundary/gauntlet:1';
process.env.BOUNDARY_SANDBOX_DIGEST ??= 'sha256:6799c86df9f83e2073cdd002d817138fce21c0a3e036b0a3c2edebc4bba6f311';
process.env.BOUNDARY_ENABLE_CONTINUITY = '1';
const keyPath = process.env.BOUNDARY_OPERATOR_KEY_FILE ?? resolve(root, '.empryo/tmp/final-sprint/operator.key');
let operatorKey = process.env.BOUNDARY_CONTINUITY_KEY;
if (!operatorKey) {
  operatorKey = randomBytes(32).toString('hex');
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, operatorKey, { mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM' || !keyPath.startsWith('/mnt/')) throw error;
    console.warn('Operator key is on a Windows-mounted filesystem; POSIX chmod is unavailable. Keep the host ACL private.');
  }
}
process.env.BOUNDARY_CONTINUITY_KEY = operatorKey;
process.env.BOUNDARY_API_TOKEN = operatorKey;
const { startServer } = await import('../src/server.ts');
const port = Number(process.env.PORT ?? '3190');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port');
const server = await startServer({ port, hostname: '127.0.0.1' });
console.log(`Lifeguard product: ${server.url}`);
console.log('No task started. POST /api/continuity/tasks requires the local operator key; no inference credentials reach the browser.');
console.log(`Operator key file: ${keyPath} (contents never printed)`);
async function startAuthorizedDemo(): Promise<void> {
  const response = await fetch(`${server.url}/api/continuity/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-continuity-key': operatorKey! },
    body: '{}',
  });
  const payload = await response.json() as { session?: { id: string }; error?: string };
  if (response.status !== 202 || !payload.session?.id) throw new Error(`Demo start refused: HTTP ${response.status}`);
  const viewUrl = `${server.url}/?session=${encodeURIComponent(payload.session.id)}`;
  const pointer = resolve(root, '.empryo/tmp/final-sprint/session.json');
  writeFileSync(pointer, JSON.stringify({ sessionId: payload.session.id, viewUrl, startedAt: new Date().toISOString() }) + '\n');
  console.log(`Live conversation: ${viewUrl}`);
}

if (process.argv.includes('--start-demo')) await startAuthorizedDemo();

