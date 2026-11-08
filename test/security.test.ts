/**
 * Seguridad del gateway y del sandbox (MVP local, offline).
 *
 * Verifica lo que REALMENTE se puede comprobar en este entorno:
 *  - reglas críticas → bloqueo terminal, sin aprobación ni ejecución,
 *  - límites del sandbox → fallo cerrado (isSandboxUsable),
 *  - adapter fail-closed → nunca ejecuta tool/args en el host,
 *  - modo `real` → falla cerrado cuando Docker Linux no está disponible.
 *
 * No prueba contención de contenedores ni integración cloud: no están
 * verificadas en este MVP y no se afirman.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isSandboxUsable,
  type AgentToolCall,
  type CriticalRuleId,
  type Environment,
  type JsonObject,
  type SandboxLimitsReport,
  type TaskScope,
} from '../src/contracts.ts';
import {
  POLICY_VERSION,
  DeterministicPolicyEngine,
  classifyToolCall,
  criticalViolationsFor,
} from '../src/policy.ts';
import {
  SIMULATED_KILLED_REASON,
  SandboxUnavailableError,
  createGateway,
  gatewayContext,
  type GatewayOptions,
} from '../src/gateway.ts';
import { safeWriteArgv } from '../src/sandbox-docker.ts';
import {
  FailClosedSandbox,
  controlsFromSnapshot,
  createLocalSandbox,
  probeSandboxControls,
  readSandboxSnapshot,
  type SandboxSnapshot,
} from '../src/sandbox.ts';

const NOW = '2026-01-01T00:00:00.000Z';

const scope: TaskScope = {
  taskId: 'task-security',
  allowedCapabilities: ['fs.read', 'fs.write', 'proc.exec', 'pkg.install'],
  protectedPaths: [],
  allowedHosts: ['registry.npmjs.org'],
  mayMutateProduction: false,
};
const environment: Environment = 'sandbox';

function call(tool: string, args: JsonObject = {}): AgentToolCall {
  return { taskId: scope.taskId, planStepId: 'step-1', tool, args, declaredIntent: 'security test' };
}

function ctx(approvalId: string | null = null) {
  return gatewayContext(scope, environment, NOW, POLICY_VERSION, approvalId);
}

function makeGateway(overrides: Partial<GatewayOptions> = {}) {
  return createGateway({
    policy: new DeterministicPolicyEngine(),
    sandbox: new FailClosedSandbox(),
    execution: 'simulated',
    ...overrides,
  });
}

describe('reglas críticas (prioridad absoluta)', () => {
  test('la clasificación activa la regla crítica correcta', () => {
    const cases: Array<{
      tool: string;
      args: JsonObject;
      env?: Environment;
      taskScope?: TaskScope;
      rule: CriticalRuleId;
    }> = [
      { tool: 'shell', args: { cmd: 'id' }, rule: 'sandbox.escape' },
      { tool: 'bash', args: {}, rule: 'sandbox.escape' },
      { tool: 'mystery', args: { path: '/etc/shadow' }, rule: 'sandbox.escape' },
      { tool: 'mystery', args: { path: '/var/run/docker.sock' }, rule: 'sandbox.host-mount' },
      { tool: 'mystery', args: { cmd: 'sudo su' }, rule: 'proc.privileged' },
      { tool: 'policy.write', args: {}, rule: 'policy.self-modify' },
      { tool: 'judge.grant', args: {}, rule: 'judge.grant' },
      { tool: 'deploy.request', args: { target: 'prod' }, env: 'production', rule: 'production.unapproved' },
      {
        tool: 'pkg.install',
        args: { name: 'x', version: '1.0.0' },
        taskScope: { ...scope, allowedHosts: [] },
        rule: 'network.unlisted-host',
      },
    ];
    for (const c of cases) {
      const s = c.taskScope ?? scope;
      const request = classifyToolCall(call(c.tool, c.args), s, NOW);
      const violations = criticalViolationsFor(request, s, c.env ?? environment);
      expect(violations).toContain(c.rule);
    }
  });

  test('una regla crítica bloquea terminalmente y no ejecuta', async () => {
    const gw = makeGateway();
    const request = gw.classify(call('shell', { cmd: 'rm -rf /' }), scope, NOW);
    const outcome = await gw.execute(request, ctx());
    expect(outcome.kind).toBe('blocked_terminal');
    if (outcome.kind === 'blocked_terminal') {
      expect(outcome.criticalRules).toContain('sandbox.escape');
    }
  });

  test('ni una aprobación vigente levanta una regla crítica', async () => {
    const gw = makeGateway({ approvalCheck: async () => true });
    const request = gw.classify(call('policy.write', {}), scope, NOW);
    const outcome = await gw.execute(request, ctx('apr-valid'));
    expect(outcome.kind).toBe('blocked_terminal');
  });

  test('en modo simulado una operación permitida no ejecuta nada real', async () => {
    const gw = makeGateway();
    const request = gw.classify(call('fs.read', { path: 'README.md' }), scope, NOW);
    const outcome = await gw.execute(request, ctx());
    expect(outcome.kind).toBe('allowed');
    if (outcome.kind === 'allowed') {
      expect(outcome.result.killedReason).toBe(SIMULATED_KILLED_REASON);
      expect(outcome.result.stdout).toBe('');
      expect(outcome.result.exitCode).toBe(0);
    }
  });
});

describe('límites del sandbox (fallo cerrado)', () => {
  const goodLimits: SandboxLimitsReport = {
    cgroupVersion: 'v2',
    rootless: true,
    enforced: true,
    violations: [],
    measured: { cpus: 1, memoryMb: 512, pids: 64, wallClockMs: 30_000, diskMb: 256 },
    checkedAt: NOW,
  };

  test('isSandboxUsable exige cgroup v2, rootless, enforced y límites positivos', () => {
    expect(isSandboxUsable(goodLimits)).toBe(true);
    expect(isSandboxUsable(null)).toBe(false);
    expect(isSandboxUsable({ ...goodLimits, cgroupVersion: 'v1' })).toBe(false);
    expect(isSandboxUsable({ ...goodLimits, rootless: false })).toBe(false);
    expect(isSandboxUsable({ ...goodLimits, enforced: false })).toBe(false);
    expect(isSandboxUsable({ ...goodLimits, violations: ['pids'] })).toBe(false);
    expect(isSandboxUsable({ ...goodLimits, measured: { ...goodLimits.measured, cpus: 0 } })).toBe(false);
  });
});

describe('controles disponibles realmente', () => {
  test('el snapshot local es de sólo lectura y reporta la plataforma real', () => {
    const snap = readSandboxSnapshot();
    expect(typeof snap.platform).toBe('string');
    expect(typeof snap.cgroupV2).toBe('boolean');
    expect(typeof snap.dockerSocket).toBe('boolean');
    expect(typeof snap.nonRoot).toBe('boolean');
  });

  test('cuando Docker Linux no existe se informa "no disponible" y no se afirma ejecución', () => {
    const win: SandboxSnapshot = { platform: 'win32', cgroupV2: false, dockerSocket: false, nonRoot: false };
    const c = controlsFromSnapshot(win);
    expect(c.linux).toBe(false);
    expect(c.available).toBe(false);
    expect(c.reason).toMatch(/Docker Linux no disponible/i);
    expect(isSandboxUsable(c.limitsReport)).toBe(false);
    expect(c.limitsReport.enforced).toBe(false);
    expect(c.limitsReport.rootless).toBe(false);
  });

  test('incluso con Linux+cgroup v2+Docker, sin runtime verificado no se afirma disponibilidad', () => {
    const full: SandboxSnapshot = { platform: 'linux', cgroupV2: true, dockerSocket: true, nonRoot: true };
    const c = controlsFromSnapshot(full);
    expect(c.cgroupVersion).toBe('v2');
    expect(c.available).toBe(false); // enforced=false: no afirmamos contención
    expect(c.reason).toMatch(/no disponible/i);
    expect(isSandboxUsable(c.limitsReport)).toBe(false);
  });

  test('el probe real no afirma un sandbox utilizable en este entorno', () => {
    const c = probeSandboxControls();
    expect(c.available).toBe(false);
    expect(c.reason).toMatch(/no disponible/i);
    expect(isSandboxUsable(c.limitsReport)).toBe(false);
  });
});

describe('fail-closed: sin ejecución arbitraria en el host', () => {
  test('prepare/exec del adapter fallan cerrado y nunca ejecutan tool/args', async () => {
    const sandbox = new FailClosedSandbox();
    const handle = { id: 'h', taskId: 't', prepared: false };
    await expect(
      sandbox.prepare({
        taskId: 't',
        image: 'x',
        imageDigest: 'sha256:unverified',
        rootless: true,
        limits: { cpus: 1, memoryMb: 512, pids: 64, wallClockMs: 1000, diskMb: 256 },
        network: 'none',
        mounts: [],
        secretsAllowed: false,
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(
      sandbox.exec(handle, { tool: 'shell', args: { cmd: 'echo pwned' }, timeoutMs: 1000, network: 'none' }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    const report = await sandbox.verifyLimits(handle);
    expect(isSandboxUsable(report)).toBe(false);
  });

  test('el gateway en modo real falla cerrado y no ejecuta en el host', async () => {
    const local = createLocalSandbox();
    expect(local.available).toBe(false);
    const gw = makeGateway({
      execution: 'real',
      sandbox: local.sandbox,
      sandboxLimits: local.sandboxLimits,
    });
    const request = gw.classify(call('fs.read', { path: 'README.md' }), scope, NOW);
    await expect(gw.execute(request, ctx())).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  test('en modo real una regla crítica se bloquea antes de intentar ejecutar', async () => {
    const local = createLocalSandbox();
    const gw = makeGateway({
      execution: 'real',
      sandbox: local.sandbox,
      sandboxLimits: local.sandboxLimits,
    });
    const request = gw.classify(call('shell', { cmd: 'id' }), scope, NOW);
    const outcome = await gw.execute(request, ctx());
    expect(outcome.kind).toBe('blocked_terminal');
  });
});

describe('rutas protegidas: normalización consistente y sin evasión', () => {
  const guarded: TaskScope = { ...scope, protectedPaths: ['out/published.json', 'secrets/'] };

  function violationsFor(tool: string, args: JsonObject): readonly CriticalRuleId[] {
    const request = classifyToolCall(call(tool, args), guarded, NOW);
    return criticalViolationsFor(request, guarded, environment);
  }

  test('las variantes con ./ y // no evaden la ruta protegida', () => {
    const variants = [
      'out/published.json',
      './out/published.json',
      'out//published.json',
      'out/./published.json',
      'out/../out/published.json',
    ];
    for (const path of variants) {
      expect(violationsFor('fs.write', { path, content: 'x' })).toContain('policy.protected-path');
    }
  });

  test('un fichero distinto en el mismo directorio no se bloquea', () => {
    expect(violationsFor('fs.write', { path: 'out/published.json.bak', content: 'x' })).not.toContain(
      'policy.protected-path',
    );
    expect(violationsFor('fs.write', { path: 'out/other.json', content: 'x' })).not.toContain(
      'policy.protected-path',
    );
  });

  test('las mayúsculas NO se colapsan en Linux', () => {
    expect(violationsFor('fs.write', { path: 'Out/published.json', content: 'x' })).not.toContain(
      'policy.protected-path',
    );
  });

  test('test.run y proc.exec no sirven para ejecutar sobre rutas protegidas', () => {
    expect(violationsFor('test.run', { cwd: 'out', suite: 'out/published.json' })).toContain(
      'policy.protected-path',
    );
    expect(violationsFor('proc.exec', { argv: ['node', 'out/published.json'] })).toContain(
      'policy.protected-path',
    );
  });

  test('un fichero protegido de primer nivel (sin barra) NO se omite', () => {
    const topLevel: TaskScope = { ...scope, protectedPaths: ['report.json', 'package-lock.json'] };
    const violations = (tool: string, args: JsonObject): readonly CriticalRuleId[] =>
      criticalViolationsFor(classifyToolCall(call(tool, args), topLevel, NOW), topLevel, environment);
    expect(violations('fs.write', { path: 'report.json', content: 'x' })).toContain('policy.protected-path');
    expect(violations('fs.write', { path: './report.json', content: 'x' })).toContain('policy.protected-path');
    expect(violations('fs.write', { path: 'report.json.bak', content: 'x' })).not.toContain('policy.protected-path');
    expect(violations('proc.exec', { argv: ['node', 'report.json'] })).toContain('policy.protected-path');
    expect(violations('test.run', { cwd: '.', suite: 'report.json' })).toContain('policy.protected-path');
  });

  test('cualquier .. se trata como escape conservador', () => {
    expect(violationsFor('fs.read', { path: 'a/../out/published.json' })).toContain('sandbox.escape');
  });
});

describe('fs.write: argv real del sandbox no sigue symlinks ni escapa', () => {
  /**
   * Runtime que ejecuta la sonda en el HOST. Dentro del contenedor siempre es
   * `node` (verificado en la imagen); en el host puede no haber `node` en PATH,
   * así que se usa NODE_BIN o el runtime actual (bun implementa el mismo fs).
   * El test NO se salta: se ejecuta de verdad en Linux.
   */
  const NODE_BIN = (() => {
    const explicit = (process.env.NODE_BIN ?? '').trim();
    if (explicit !== '') return explicit;
    const probe = spawnSync('node', ['--version'], { encoding: 'utf8' });
    return probe.status === 0 ? 'node' : process.execPath;
  })();

  function runWrite(root: string, rel: string, content: string) {
    const argv = safeWriteArgv(root, rel, NODE_BIN);
    return spawnSync(argv[0]!, argv.slice(1), {
      input: Buffer.from(content, 'utf8').toString('base64'),
      encoding: 'utf8',
    });
  }

  test('escribe dentro de la raíz y rechaza el escape con ..', () => {
    const root = mkdtempSync(join(tmpdir(), 'write-guard-'));
    mkdirSync(join(root, 'out'), { recursive: true });
    const ok = runWrite(root, 'out/new.json', 'contenido');
    expect(ok.status).toBe(0);
    expect(readFileSync(join(root, 'out', 'new.json'), 'utf8')).toBe('contenido');
    const escape = runWrite(root, '../outside.json', 'pwned');
    expect(escape.status).not.toBe(0);
  });

  test('un enlace de directorio no permite escribir fuera de la raíz', () => {
    const root = mkdtempSync(join(tmpdir(), 'write-dirlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'write-outside-'));
    symlinkSync(outside, join(root, 'linkdir'), 'junction');
    const viaDir = runWrite(root, 'linkdir/x.json', 'pwned');
    expect(viaDir.status).not.toBe(0);
    expect(existsSync(join(outside, 'x.json'))).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('un symlink interno no redirige la escritura', () => {
    const root = mkdtempSync(join(tmpdir(), 'write-link-'));
    mkdirSync(join(root, 'out'), { recursive: true });
    writeFileSync(join(root, 'out', 'published.json'), 'original');
    symlinkSync(join(root, 'out', 'published.json'), join(root, 'link.json'));
    const viaLink = runWrite(root, 'link.json', 'pwned');
    expect(viaLink.status).not.toBe(0);
    expect(readFileSync(join(root, 'out', 'published.json'), 'utf8')).toBe('original');
  });
});
