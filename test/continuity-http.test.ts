import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { buildRouter, createServerState } from '../src/server.ts';

// HTTP authorization tests only: start is mocked; no model, Docker or live evidence.
const names = ['BOUNDARY_ENABLE_CONTINUITY', 'BOUNDARY_CONTINUITY_KEY', 'BOUNDARY_API_TOKEN'] as const;
const previous = new Map(names.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of names) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const operatorKey = 'unit-test-operator-key-not-live';
function setup() {
  delete process.env.BOUNDARY_API_TOKEN;
  delete process.env.BOUNDARY_CONTINUITY_KEY;
  delete process.env.BOUNDARY_ENABLE_CONTINUITY;
  const state = createServerState();
  const router = buildRouter(state);
  const start = spyOn(state.continuity, 'start').mockImplementation(() => { throw new Error('busy'); });
  const call = (path: string, options: RequestInit = {}) => router(new Request(`http://127.0.0.1${path}`, options), {});
  return { state, start, call };
}
function enable() {
  process.env.BOUNDARY_ENABLE_CONTINUITY = '1';
  process.env.BOUNDARY_CONTINUITY_KEY = operatorKey;
}
describe('continuity HTTP gate (offline)', () => {
  test('disabled by default; no live task is started', async () => {
    const { call, start } = setup();
    const status = await call('/api/continuity/status');
    expect((await status.json() as Record<string, unknown>).enabled).toBe(false);
    expect((await call('/api/continuity/tasks', { method: 'POST' })).status).toBe(503);
    expect(start).not.toHaveBeenCalled();
  });
  test('missing operator secret fails closed even when enabled', async () => {
    const { call, start } = setup();
    process.env.BOUNDARY_ENABLE_CONTINUITY = '1';
    expect((await call('/api/continuity/tasks', { method: 'POST' })).status).toBe(503);
    expect(start).not.toHaveBeenCalled();
  });
  test('wrong operator key cannot spend inference budget', async () => {
    const { call, start } = setup();
    enable();
    expect((await call('/api/continuity/tasks', { method: 'POST', headers: { 'x-continuity-key': 'wrong' } })).status).toBe(401);
    expect(start).not.toHaveBeenCalled();
  });
  test('a cross-origin write is rejected even with the operator key', async () => {
    const { call, start } = setup();
    enable();
    expect((await call('/api/continuity/tasks', { method: 'POST', headers: { 'x-continuity-key': operatorKey, origin: 'https://other.invalid' } })).status).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });
  test('client cannot inject a task, command or scope', async () => {
    const { call, start } = setup();
    enable();
    const response = await call('/api/continuity/tasks', { method: 'POST', headers: { 'x-continuity-key': operatorKey }, body: JSON.stringify({ command: 'bad', capabilities: ['secrets.read'] }) });
    expect(response.status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });
  test('authorized fixed-task requests reach the bounded service', async () => {
    const { call, start } = setup();
    enable();
    const response = await call('/api/continuity/tasks', { method: 'POST', headers: { 'x-continuity-key': operatorKey }, body: '{}' });
    expect(response.status).toBe(409);
    expect(start).toHaveBeenCalledTimes(1);
  });
  test('opaque unknown session ID is not invented or cross-routed', async () => {
    const { call } = setup();
    const response = await call('/api/continuity/tasks/missing_session');
    expect(response.status).toBe(404);
    expect((await response.json() as Record<string, unknown>).code).toBe('session_not_found');
  });
  test('no operator secret is returned to the browser', async () => {
    const { call } = setup();
    enable();
    const text = await (await call('/api/continuity/status')).text();
    expect(text).not.toContain(operatorKey);
    expect(JSON.parse(text).operatorKeyRequired).toBe(true);
  });
});
