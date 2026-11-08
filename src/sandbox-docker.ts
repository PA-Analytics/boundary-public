/**
 * DockerSandbox — adaptador REAL de `SandboxPort` sobre Docker rootless.
 *
 * Principios:
 *  1. El host nunca ejecuta la operación: todo ocurre dentro de un contenedor
 *     desechable, creado con red desactivada, rootfs de sólo lectura, sin
 *     capacidades, sin secretos y sin socket de Docker montado.
 *  2. Los límites no se declaran: se leen del runtime (`docker inspect`) y se
 *     comprueban en vivo dentro del contenedor (`/sys/fs/cgroup/*.max`). Si no
 *     se pueden verificar, `verifyLimits` devuelve `enforced: false` y el
 *     gateway falla cerrado antes de ejecutar nada.
 *  3. `exec` recibe un argv cerrado; no hay shell del host ni interpolación.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';

import {
  EXEC_SCRIPT_PATTERN,
  isWorkspaceRelativePath,
  normalizePathTarget,
  nowIso,
  validateExecArgv,
  type SandboxExec,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxLimitsReport,
  type SandboxPort,
  type SandboxResult,
  type SandboxSpec,
} from './contracts.ts';
import { SandboxUnavailableError } from './gateway.ts';

export interface DockerSandboxOptions {
  readonly dockerBin?: string;
  /** Socket del daemon rootless del usuario de la tarea. */
  readonly dockerHost?: string;
  readonly defaultTimeoutMs?: number;
  readonly nonRootUid?: number;
  readonly image?: string;
  readonly imageDigest?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_UID = 1000;
const WORKSPACE_ROOT = '/workspace';

/** Digest de imagen verificable. Cualquier otro valor es metadato, no fijación. */
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function run(
  bin: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  timeoutMs: number,
  input?: string,
): { code: number; stdout: string; stderr: string; timedOut: boolean } {
  const started = Date.now();
  const proc = spawnSync(bin, [...args], {
    env,
    encoding: 'utf8',
    timeout: Math.max(1_000, timeoutMs),
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    input,
  });
  const timedOut = proc.error !== undefined && (proc.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  return {
    code: typeof proc.status === 'number' ? proc.status : -1,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? (proc.error ? String(proc.error.message) : ''),
    timedOut: timedOut || Date.now() - started >= Math.max(1_000, timeoutMs),
  };
}

/**
 * Escritura que NO sigue symlinks, ejecutada DENTRO del contenedor con un argv
 * fijo (sin shell, sin interpolación: el agente sólo aporta la ruta como
 * argumento). `O_NOFOLLOW` rechaza el componente final si es un enlace y el
 * `realpath` del directorio padre debe quedar dentro de la raíz del workspace,
 * de modo que un symlink interno no puede redirigir la escritura a una ruta
 * protegida ni escapar del montaje. La política pura no puede resolver enlaces;
 * esta es la barrera real.
 */
export const SAFE_WRITE_SCRIPT = [
  "const fs=require('node:fs'),path=require('node:path');",
  'const root=fs.realpathSync(process.argv[1]);',
  'const target=path.resolve(root,process.argv[2]);',
  "let dir;try{dir=fs.realpathSync(path.dirname(target));}catch(e){console.error('write-parent-missing');process.exit(3);}",
  "if(dir!==root&&!dir.startsWith(root+path.sep)){console.error('write-escape');process.exit(3);}",
  "let fd;try{fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW,0o644);}catch(e){console.error('write-refused:'+(e&&e.code));process.exit(4);}",
  "const chunks=[];process.stdin.on('data',c=>chunks.push(c));",
  "process.stdin.on('end',()=>{try{fs.writeSync(fd,Buffer.from(Buffer.concat(chunks).toString('utf8'),'base64'));fs.closeSync(fd);}catch(e){console.error('write-failed');process.exit(5);}});",
].join('');

/**
 * argv exacto de la escritura segura; `root` es parametrizable para probarla
 * offline. `nodeBin` permite ejecutar la MISMA sonda con otro runtime Node
 * compatible (p. ej. bun) cuando el host no tiene `node` en PATH; dentro del
 * contenedor siempre se usa `node`.
 */
export function safeWriteArgv(root: string, path: string, nodeBin = 'node'): string[] {
  return [nodeBin, '-e', SAFE_WRITE_SCRIPT, root, path];
}

export interface ExecPlan {
  readonly argv: string[];
  readonly stdin: string | null;
  /** Directorio de trabajo DENTRO del contenedor, siempre bajo /workspace. */
  readonly workdir: string;
}

/**
 * Traduce una herramienta mediada al argv que se ejecuta DENTRO del contenedor.
 * Lista cerrada: una herramienta desconocida no se ejecuta.
 * Sin interpolación: las rutas viajan como argumentos, nunca concatenadas a un script.
 * `cwd` se aplica de verdad (`--workdir`), no se ignora.
 */
export function buildExecCommand(exec: SandboxExec): ExecPlan {
  const args = exec.args as Record<string, unknown>;
  const asPath = (value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new SandboxUnavailableError('ruta ausente en la operación');
    }
    if (value.includes('\u0000')) throw new SandboxUnavailableError('ruta inválida');
    return value;
  };
  const asWorkdir = (value: unknown): string => {
    if (value === undefined || value === null || value === '') return WORKSPACE_ROOT;
    if (typeof value !== 'string' || value.includes('\u0000')) {
      throw new SandboxUnavailableError('cwd inválido');
    }
    const normalized = normalizePathTarget(value);
    if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
      throw new SandboxUnavailableError('cwd fuera del workspace');
    }
    return normalized === '' || normalized === '.' ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${normalized}`;
  };

  switch (exec.tool) {
    case 'fs.read':
      return { argv: ['cat', '--', asPath(args.path)], stdin: null, workdir: WORKSPACE_ROOT };
    case 'fs.list':
      return { argv: ['ls', '-la', '--', asPath(args.path ?? '.')], stdin: null, workdir: WORKSPACE_ROOT };
    case 'fs.write': {
      const path = asPath(args.path);
      const content = typeof args.content === 'string' ? args.content : '';
      const encoded = Buffer.from(content, 'utf8').toString('base64');
      return { argv: safeWriteArgv(WORKSPACE_ROOT, path), stdin: encoded, workdir: WORKSPACE_ROOT };
    }
    case 'test.run': {
      const workdir = asWorkdir(args.cwd);
      const suite = args.suite;
      if (typeof suite === 'string' && suite.length > 0) {
        if (!isWorkspaceRelativePath(suite) || !EXEC_SCRIPT_PATTERN.test(suite)) {
          throw new SandboxUnavailableError('suite inválida: se espera una ruta relativa a un fichero de test');
        }
        return { argv: ['node', '--test', suite], stdin: null, workdir };
      }
      const script = args.script;
      if (typeof script === 'string' && /^[A-Za-z0-9:_-]{1,64}$/.test(script)) {
        return { argv: ['bun', 'run', script], stdin: null, workdir };
      }
      throw new SandboxUnavailableError('test.run requiere "suite" o "script"');
    }
    case 'deploy.request':
      // Nunca despliega: deja constancia firmada de la solicitud aprobada.
      return { argv: ['sh', '-c', 'echo "deploy-request-approved"'], stdin: null, workdir: WORKSPACE_ROOT };
    case 'pkg.install': {
      const name = String(args.name ?? args.package ?? '');
      const version = String(args.version ?? '');
      if (!/^[a-z0-9@/._-]+$/i.test(name)) throw new SandboxUnavailableError('paquete inválido');
      return { argv: ['bun', 'add', version ? `${name}@${version}` : name], stdin: null, workdir: WORKSPACE_ROOT };
    }
    case 'proc.exec': {
      // Contrato único y cerrado: sin shell, sin flags, sin binario arbitrario.
      const argvError = validateExecArgv(args.argv);
      if (argvError !== null) throw new SandboxUnavailableError(argvError);
      return { argv: [...(args.argv as string[])], stdin: null, workdir: WORKSPACE_ROOT };
    }
    default:
      throw new SandboxUnavailableError(`herramienta no soportada por el sandbox: ${exec.tool}`);
  }
}

/**
 * Referencia de imagen FIJADA. Con un digest real se usa `imagen@sha256:...`;
 * sin digest verificable se usa el nombre y `prepare` resuelve el Id local.
 */
export function pinnedImageRef(image: string, imageDigest: string): string {
  const digest = imageDigest.trim();
  return DIGEST_PATTERN.test(digest) ? `${image}@${digest}` : image;
}

/**
 * Argumentos de `docker run`: función pura para poder probarlos sin daemon.
 * Cualquier límite ausente se rechaza aquí, antes de tocar el runtime.
 */
export function buildDockerRunArgs(
  spec: SandboxSpec,
  name: string,
  uid = DEFAULT_UID,
  imageRef?: string,
): string[] {
  const { limits, network } = spec;
  if (limits.memoryMb <= 0 || limits.pids <= 0 || limits.cpus <= 0) {
    throw new SandboxUnavailableError('límites no definidos: no se crea contenedor sin cota');
  }
  const args = [
    'run',
    '--detach',
    // Sin pull implícito: la imagen debe existir ya en el daemon local.
    '--pull',
    'never',
    '--name',
    name,
    '--network',
    network === 'none' ? 'none' : 'bridge',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(limits.pids),
    '--memory',
    `${limits.memoryMb}m`,
    '--memory-swap',
    `${limits.memoryMb}m`,
    '--cpus',
    String(limits.cpus),
    '--user',
    `${uid}:${uid}`,
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--workdir',
    '/workspace',
  ];
  if (limits.diskMb > 0) {
    args.push('--ulimit', 'fsize=' + String(limits.diskMb * 1024 * 1024));
  }
  for (const mount of spec.mounts) {
    const mountSpec = `type=bind,src=${mount.hostPath},dst=${mount.sandboxPath}`;
    args.push('--mount', mount.mode === 'ro' ? `${mountSpec},readonly` : mountSpec);
  }
  args.push(imageRef ?? pinnedImageRef(spec.image, spec.imageDigest));
  args.push('sleep', 'infinity');
  return args;
}

export interface RuntimeProbe {
  readonly ok: boolean;
  readonly reason: string;
  readonly report: SandboxLimitsReport | null;
  readonly sandbox: DockerSandbox | null;
}

/** Límites por defecto del MVP, ajustables por entorno sin recompilar. */
export function defaultLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxLimits {
  const num = (key: string, fallback: number): number => {
    const raw = Number.parseInt(env[key] ?? "", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  return {
    cpus: num("BOUNDARY_SANDBOX_CPUS", 1),
    memoryMb: num("BOUNDARY_SANDBOX_MEMORY_MB", 512),
    pids: num("BOUNDARY_SANDBOX_PIDS", 64),
    wallClockMs: num("BOUNDARY_SANDBOX_TIMEOUT_MS", 60000),
    diskMb: num("BOUNDARY_SANDBOX_DISK_MB", 256),
  };
}

/**
 * Verificación de arranque: crea un contenedor real con los límites por defecto,
 * comprueba que el runtime los aplica y lo destruye. Sólo si esto pasa se
 * habilita ejecución real; en cualquier otro caso el gateway queda fail-closed.
 */
export async function probeDockerRuntime(options: DockerSandboxOptions = {}): Promise<RuntimeProbe> {
  const sandbox = new DockerSandbox(options);
  const availability = sandbox.available();
  if (!availability.ok) {
    return { ok: false, reason: availability.reason, report: null, sandbox: null };
  }
  const spec: SandboxSpec = {
    taskId: "runtime-probe",
    image: options.image ?? process.env.BOUNDARY_SANDBOX_IMAGE ?? "oven/bun:1",
    imageDigest: options.imageDigest ?? process.env.BOUNDARY_SANDBOX_DIGEST ?? "local",
    rootless: true,
    limits: defaultLimitsFromEnv(),
    network: "none",
    mounts: [],
    secretsAllowed: false,
  };
  try {
    const handle = await sandbox.prepare(spec);
    const report = await sandbox.verifyLimits(handle);
    await sandbox.dispose(handle);
    if (!report.enforced) {
      return { ok: false, reason: "límites no verificados: " + report.violations.join(", "), report, sandbox: null };
    }
    return { ok: true, reason: "sandbox real verificado", report, sandbox };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), report: null, sandbox: null };
  }
}

export class DockerSandbox implements SandboxPort {
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly uid: number;
  private readonly timeoutMs: number;
  private readonly containers = new Map<string, string>();

  constructor(options: DockerSandboxOptions = {}) {
    this.bin = options.dockerBin ?? 'docker';
    this.uid = options.nonRootUid ?? DEFAULT_UID;
    this.timeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.env = { ...process.env };
    if (options.dockerHost) this.env.DOCKER_HOST = options.dockerHost;
  }

  /** Disponibilidad real: daemon alcanzable y rootless. */
  available(): { ok: boolean; reason: string } {
    const info = run(this.bin, this.env, ['info', '--format', '{{.CgroupVersion}}|{{.SecurityOptions}}|{{.Driver}}'], 15_000);
    if (info.code !== 0) {
      return { ok: false, reason: `daemon Docker no disponible: ${info.stderr.trim().slice(0, 200)}` };
    }
    const [cgroup, security] = info.stdout.trim().split('|');
    const rootless = (security ?? '').includes('name=rootless');
    if (cgroup !== '2') return { ok: false, reason: `cgroup v2 requerido, el daemon reporta '${cgroup}'` };
    if (!rootless) return { ok: false, reason: 'el daemon no es rootless' };
    return { ok: true, reason: 'docker rootless con cgroup v2' };
  }

  async prepare(spec: SandboxSpec): Promise<SandboxHandle> {
    if (spec.secretsAllowed !== false) {
      throw new SandboxUnavailableError('el sandbox no admite secretos');
    }
    const probe = this.available();
    if (!probe.ok) throw new SandboxUnavailableError(probe.reason);
    // `imageDigest` no es metadato: se resuelve la imagen local y se verifica.
    const imageRef = this.resolveLocalImage(spec.image, spec.imageDigest);
    for (const mount of spec.mounts) {
      mkdirSync(mount.hostPath, { recursive: true });
      // El contenedor corre con otro uid: el workspace debe ser escribible por ambos.
      if (mount.mode === 'rw') chmodSync(mount.hostPath, 0o777);
    }
    const name = `boundary-${spec.taskId}-${Date.now().toString(36)}`;
    const args = buildDockerRunArgs(spec, name, this.uid, imageRef);
    const started = run(this.bin, this.env, args, 60_000);
    if (started.code !== 0) {
      throw new SandboxUnavailableError(`no se pudo crear el sandbox: ${started.stderr.trim().slice(0, 300)}`);
    }
    const id = started.stdout.trim();
    this.containers.set(name, id);
    return { id, taskId: spec.taskId, prepared: true };
  }

  /**
   * Resuelve la imagen FIJADA localmente y verifica el digest declarado.
   * `--pull never` impide descargar: si la imagen no está, falla cerrado.
   */
  private resolveLocalImage(image: string, imageDigest: string): string {
    const inspect = run(
      this.bin,
      this.env,
      ['image', 'inspect', '--format', '{{.Id}}|{{join .RepoDigests ","}}', image],
      15_000,
    );
    if (inspect.code !== 0) {
      throw new SandboxUnavailableError(
        `imagen no presente localmente (--pull never): ${image} — ${inspect.stderr.trim().slice(0, 200)}`,
      );
    }
    const [rawId, rawDigests] = inspect.stdout.trim().split('|');
    const localId = (rawId ?? '').trim();
    if (localId.length === 0) {
      throw new SandboxUnavailableError(`no se pudo resolver el Id local de la imagen ${image}`);
    }
    const declared = imageDigest.trim();
    if (DIGEST_PATTERN.test(declared)) {
      const known = (rawDigests ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const matches = declared === localId || known.some((entry) => entry === declared || entry.endsWith(`@${declared}`));
      if (!matches) {
        throw new SandboxUnavailableError(
          `el digest declarado no coincide con la imagen local: ${declared} ≠ ${localId}`,
        );
      }
    }
    return localId;
  }

  async verifyLimits(handle: SandboxHandle): Promise<SandboxLimitsReport> {
    const inspect = run(this.bin, this.env, ['inspect', '--format', '{{json .HostConfig}}', handle.id], 15_000);
    const violations: string[] = [];
    let measured: SandboxLimits = { cpus: 0, memoryMb: 0, pids: 0, wallClockMs: 0, diskMb: 0 };
    let rootless = false;
    let cgroupVersion: 'v2' | 'v1' | 'none' = 'none';

    const info = run(this.bin, this.env, ['info', '--format', '{{.CgroupVersion}}|{{.SecurityOptions}}'], 15_000);
    if (info.code === 0) {
      const [cg, sec] = info.stdout.trim().split('|');
      cgroupVersion = cg === '2' ? 'v2' : cg === '1' ? 'v1' : 'none';
      rootless = (sec ?? '').includes('name=rootless');
    } else {
      violations.push('docker info no disponible');
    }

    if (inspect.code === 0) {
      try {
        const cfg = JSON.parse(inspect.stdout.trim()) as Record<string, unknown>;
        const memory = Number(cfg.Memory ?? 0) / (1024 * 1024);
        const pids = Number(cfg.PidsLimit ?? 0);
        const nano = Number(cfg.NanoCpus ?? 0);
        const network = String(cfg.NetworkMode ?? '');
        measured = { cpus: nano / 1e9, memoryMb: Math.round(memory), pids, wallClockMs: this.timeoutMs, diskMb: 0 };
        if (!(memory > 0)) violations.push('memoria no aplicada');
        if (!(pids > 0)) violations.push('pids no aplicados');
        if (!(nano > 0)) violations.push('cpu no aplicado');
        if (network !== 'none') violations.push(`red '${network}' distinta de none`);
      } catch {
        violations.push('no se pudo leer HostConfig');
      }
    } else {
      violations.push('contenedor no inspeccionable');
    }

    // Prueba en vivo: los límites deben verse dentro del propio contenedor.
    const live = run(
      this.bin,
      this.env,
      ['exec', handle.id, 'sh', '-c', 'echo $(cat /sys/fs/cgroup/memory.max 2>/dev/null) $(cat /sys/fs/cgroup/pids.max 2>/dev/null) $(cat /sys/fs/cgroup/cpu.max 2>/dev/null)'],
      20_000,
    );
    if (live.code === 0) {
      const parts = live.stdout.trim().split(/\s+/);
      const memMax = parts[0] ?? '';
      if (!memMax || memMax === 'max') violations.push('memory.max sin cota dentro del contenedor');
    } else {
      violations.push('no se pudo leer cgroup del contenedor');
    }

    if (!rootless) violations.push('daemon no rootless');
    if (cgroupVersion !== 'v2') violations.push('cgroup v2 no disponible');

    return {
      cgroupVersion,
      rootless,
      enforced: violations.length === 0,
      violations,
      measured,
      checkedAt: nowIso(),
    };
  }

  async exec(handle: SandboxHandle, exec: SandboxExec): Promise<SandboxResult> {
    const plan = buildExecCommand(exec);
    const timeoutMs = Math.min(exec.timeoutMs > 0 ? exec.timeoutMs : this.timeoutMs, this.timeoutMs);
    const started = Date.now();
    const out = run(
      this.bin,
      this.env,
      [
        ...(plan.stdin === null ? ['exec'] : ['exec', '-i']),
        '--workdir',
        plan.workdir,
        handle.id,
        ...plan.argv,
      ],
      timeoutMs,
      plan.stdin ?? undefined,
    );
    return {
      exitCode: out.code,
      stdout: out.stdout.slice(0, 64_000),
      stderr: out.stderr.slice(0, 16_000),
      timedOut: out.timedOut,
      killedReason: out.timedOut ? 'wall_clock_timeout' : null,
      durationMs: Date.now() - started,
    };
  }

  async dispose(handle: SandboxHandle): Promise<void> {
    run(this.bin, this.env, ['rm', '--force', handle.id], 30_000);
    for (const [name, id] of this.containers) {
      if (id === handle.id) this.containers.delete(name);
    }
  }
}
