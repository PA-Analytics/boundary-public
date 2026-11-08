/**
 * Adaptador Docker: funciones puras, sin daemon y sin red.
 *
 * Verifica lo que se puede comprobar sin Docker:
 *  - `docker run` emite `--pull never` y fija la imagen por digest/Id local,
 *  - `imageDigest` no es metadato: un digest verificable se usa como referencia,
 *  - `test.run` honra `cwd`/`suite`/`script` (antes se ignoraban),
 *  - `proc.exec` es un argv cerrado: sin shell, sin flags, sin binario arbitrario.
 *
 * NO prueba contención real ni ejecución de contenedores.
 */
import { describe, expect, test } from 'bun:test';

import type { SandboxSpec } from '../src/contracts.ts';
import { SandboxUnavailableError } from '../src/gateway.ts';
import { buildDockerRunArgs, buildExecCommand, pinnedImageRef } from '../src/sandbox-docker.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const LOCAL_ID = `sha256:${'b'.repeat(64)}`;

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    taskId: 't',
    image: 'boundary/gauntlet:1',
    imageDigest: DIGEST,
    rootless: true,
    limits: { cpus: 1, memoryMb: 512, pids: 64, wallClockMs: 30_000, diskMb: 256 },
    network: 'none',
    mounts: [],
    secretsAllowed: false,
    ...overrides,
  };
}

describe('docker run: sin pull implícito e imagen fijada', () => {
  test('emite --pull never', () => {
    const args = buildDockerRunArgs(spec(), 'n', 1000);
    const index = args.indexOf('--pull');
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe('never');
  });

  test('fija la imagen por digest cuando el digest es verificable', () => {
    const args = buildDockerRunArgs(spec(), 'n', 1000);
    expect(args).toContain(`boundary/gauntlet:1@${DIGEST}`);
    expect(pinnedImageRef('img', DIGEST)).toBe(`img@${DIGEST}`);
  });

  test('un digest no verificable no se finge como fijación', () => {
    expect(pinnedImageRef('img', 'local')).toBe('img');
    expect(pinnedImageRef('img', 'sha256:unverified')).toBe('img');
  });

  test('usa la referencia local resuelta cuando se pasa imageRef', () => {
    const args = buildDockerRunArgs(spec(), 'n', 1000, LOCAL_ID);
    expect(args).toContain(LOCAL_ID);
    expect(args).not.toContain(`boundary/gauntlet:1@${DIGEST}`);
  });
});

describe('exec: contrato cerrado y cwd real', () => {
  test('test.run honra cwd y suite', () => {
    const plan = buildExecCommand({
      tool: 'test.run',
      args: { cwd: 'pkg', suite: 'tests-public/test.mjs' },
      timeoutMs: 1000,
      network: 'none',
    });
    expect(plan.argv).toEqual(['node', '--test', 'tests-public/test.mjs']);
    expect(plan.workdir).toBe('/workspace/pkg');
  });

  test('test.run honra script', () => {
    const plan = buildExecCommand({
      tool: 'test.run',
      args: { cwd: '.', script: 'test' },
      timeoutMs: 1000,
      network: 'none',
    });
    expect(plan.argv).toEqual(['bun', 'run', 'test']);
    expect(plan.workdir).toBe('/workspace');
  });

  test('test.run sin suite ni script falla cerrado', () => {
    expect(() =>
      buildExecCommand({ tool: 'test.run', args: { cwd: '.' }, timeoutMs: 1000, network: 'none' }),
    ).toThrow(SandboxUnavailableError);
  });

  test('cwd fuera del workspace falla cerrado', () => {
    expect(() =>
      buildExecCommand({ tool: 'test.run', args: { cwd: '../..', script: 'test' }, timeoutMs: 1000, network: 'none' }),
    ).toThrow(SandboxUnavailableError);
  });

  test('proc.exec no abre shell ni acepta flags', () => {
    const plan = buildExecCommand({
      tool: 'proc.exec',
      args: { argv: ['node', 'tests-public/test.mjs', '.'] },
      timeoutMs: 1000,
      network: 'none',
    });
    expect(plan.argv).toEqual(['node', 'tests-public/test.mjs', '.']);
    expect(() =>
      buildExecCommand({ tool: 'proc.exec', args: { argv: ['sh', '-c', 'id'] }, timeoutMs: 1000, network: 'none' }),
    ).toThrow(SandboxUnavailableError);
    expect(() =>
      buildExecCommand({
        tool: 'proc.exec',
        args: { argv: ['node', 'x.mjs', '--require', 'evil'] },
        timeoutMs: 1000,
        network: 'none',
      }),
    ).toThrow(SandboxUnavailableError);
  });
});