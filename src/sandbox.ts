/**
 * Sandbox adapter — MVP local, offline, fail-closed.
 *
 * NO afirma contención de contenedores ni integración cloud: sólo observa, de
 * forma local y de sólo lectura, qué controles existen realmente (plataforma,
 * cgroup v2, socket de Docker, uid no-root). Como en este MVP no hay un runtime
 * rootless con límites verificados, `enforced` es siempre `false` y el adapter
 * se NIEGA a ejecutar: `prepare`/`exec` lanzan `SandboxUnavailableError` y
 * NUNCA invocan `tool`/`args` del agente en el host (sin spawn, sin eval, sin
 * red, sin lectura de secretos, sin recursos facturables).
 *
 * Cuando Docker Linux no existe, `reason` lo informa como "no disponible".
 * `isSandboxUsable(limitsReport)` es siempre `false`, de modo que el gateway
 * en modo `real` falla cerrado ANTES de tocar el sandbox.
 */

import { existsSync } from 'node:fs';

import {
  isSandboxUsable,
  nowIso,
  type IsoTimestamp,
  type SandboxExec,
  type SandboxHandle,
  type SandboxLimitsReport,
  type SandboxPort,
  type SandboxResult,
  type SandboxSpec,
} from './contracts.ts';
import { SandboxUnavailableError } from './gateway.ts';

/** Controles locales realmente observables (sin consultar al daemon ni a la red). */
export interface SandboxSnapshot {
  readonly platform: string;
  readonly cgroupV2: boolean;
  readonly dockerSocket: boolean;
  /** Observable (uid != 0); NO prueba que Docker sea rootless. */
  readonly nonRoot: boolean;
}

export interface SandboxControls extends SandboxSnapshot {
  readonly linux: boolean;
  readonly cgroupVersion: 'v2' | 'v1' | 'none';
  /** Siempre false en el MVP: ningún runtime verificado aplica los límites. */
  readonly enforced: boolean;
  /** `isSandboxUsable(limitsReport)`: siempre false en el MVP. */
  readonly available: boolean;
  readonly reason: string;
  readonly limitsReport: SandboxLimitsReport;
  readonly checkedAt: IsoTimestamp;
}

const CGROUP_V2_CONTROLLERS = '/sys/fs/cgroup/cgroup.controllers';
const DOCKER_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock'] as const;

/** Lectura local de sólo lectura. Nunca conecta, nunca crea nada, nunca sale a red. */
export function readSandboxSnapshot(): SandboxSnapshot {
  const maybeGetuid = (process as unknown as { getuid?: () => number }).getuid;
  return {
    platform: process.platform,
    cgroupV2: existsSync(CGROUP_V2_CONTROLLERS),
    dockerSocket: DOCKER_SOCKETS.some((p) => existsSync(p)),
    nonRoot: typeof maybeGetuid === 'function' && maybeGetuid() !== 0,
  };
}

/** Puro y determinista: permite verificar el reporte sin depender del host. */
export function controlsFromSnapshot(snapshot: SandboxSnapshot): SandboxControls {
  const checkedAt = nowIso();
  const linux = snapshot.platform === 'linux';
  const cgroupVersion: 'v2' | 'v1' | 'none' = snapshot.cgroupV2 ? 'v2' : 'none';

  const violations: string[] = [];
  if (!linux) violations.push('plataforma no Linux');
  if (!snapshot.cgroupV2) violations.push('cgroup v2 no verificado');
  if (!snapshot.dockerSocket) violations.push('socket de Docker no detectado');
  if (!snapshot.nonRoot) violations.push('rootless no verificado (uid)');
  // Nunca afirmamos límites aplicados: no hay runtime verificado en este MVP.
  violations.push('runtime rootless con límites aplicados no integrado (enforced=false)');

  const limitsReport: SandboxLimitsReport = {
    cgroupVersion,
    rootless: false, // no verificamos Docker rootless
    enforced: false, // ningún límite aplicado por un runtime verificado
    violations,
    measured: { cpus: 0, memoryMb: 0, pids: 0, wallClockMs: 0, diskMb: 0 },
    checkedAt,
  };

  let reason: string;
  if (!linux) {
    reason = `Docker Linux no disponible: plataforma '${snapshot.platform}' (se requiere Linux con cgroup v2 rootless)`;
  } else if (!snapshot.cgroupV2) {
    reason = 'Docker Linux no disponible: cgroup v2 no detectado (/sys/fs/cgroup/cgroup.controllers ausente)';
  } else if (!snapshot.dockerSocket) {
    reason = 'Docker Linux no disponible: socket de Docker no detectado';
  } else {
    reason =
      'Docker detectado, pero este MVP no integra un runtime rootless con límites verificados: ejecución no disponible (fail-closed)';
  }

  return {
    ...snapshot,
    linux,
    cgroupVersion,
    enforced: false,
    available: isSandboxUsable(limitsReport),
    reason,
    limitsReport,
    checkedAt,
  };
}

export function probeSandboxControls(): SandboxControls {
  return controlsFromSnapshot(readSandboxSnapshot());
}

/**
 * `SandboxPort` fail-closed. No ejecuta comandos arbitrarios en el host:
 * `prepare` y `exec` siempre fallan cerrado; `verifyLimits` devuelve el
 * reporte honesto de los controles realmente disponibles.
 */
export class FailClosedSandbox implements SandboxPort {
  async prepare(_spec: SandboxSpec): Promise<SandboxHandle> {
    throw new SandboxUnavailableError(probeSandboxControls().reason);
  }

  async verifyLimits(_handle: SandboxHandle): Promise<SandboxLimitsReport> {
    return probeSandboxControls().limitsReport;
  }

  async exec(_handle: SandboxHandle, _exec: SandboxExec): Promise<SandboxResult> {
    // Sin backend verificado: jamás se invoca tool/args en el host.
    throw new SandboxUnavailableError(
      'ejecución denegada: sandbox real no disponible (fail-closed, sin ejecución en el host)',
    );
  }

  async dispose(_handle: SandboxHandle): Promise<void> {
    /* nunca se preparó un contenedor: nada que liberar */
  }
}

export interface LocalSandbox {
  readonly sandbox: SandboxPort;
  readonly controls: SandboxControls;
  /** Listo para inyectar en `GatewayOptions.sandboxLimits`. */
  readonly sandboxLimits: () => Promise<SandboxLimitsReport | null>;
  readonly available: boolean;
  readonly reason: string;
}

/** Fábrica mínima para cablear el gateway local en modo `real` (fail-closed). */
export function createLocalSandbox(): LocalSandbox {
  const controls = probeSandboxControls();
  return {
    sandbox: new FailClosedSandbox(),
    controls,
    sandboxLimits: () => Promise.resolve(controls.limitsReport),
    available: controls.available,
    reason: controls.reason,
  };
}
