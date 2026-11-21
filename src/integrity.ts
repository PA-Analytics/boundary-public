/**
 * Monitor de integridad de rutas protegidas. `proc.exec` sólo expone argv a la
 * política: un script propio puede escribir una ruta protegida sin que se vea.
 * El gateway toma una instantánea de `protectedPaths` antes de ejecutar y, si la
 * ejecución las cambió, las restaura y trata la llamada como violación crítica.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type ProtectedSnapshot = Readonly<Record<string, string | null>>;

const EXEC_TOOLS = new Set(['proc.exec', 'test.run']);
export const isExecTool = (tool: string): boolean => EXEC_TOOLS.has(tool);

function filesUnder(root: string, rel: string, out: Record<string, string | null>): void {
  const p = join(root, rel);
  let st;
  try {
    st = lstatSync(p);
  } catch {
    out[rel] = null;
    return;
  }
  if (st.isDirectory()) {
    out[rel] = 'dir';
    for (const name of readdirSync(p)) filesUnder(root, join(rel, name), out);
  } else {
    out[rel] = st.isSymbolicLink() ? 'symlink' : readFileSync(p).toString('base64');
  }
}

/** Contenido de cada ruta protegida relativa al workspace (las absolutas no viven en él). */
export function snapshotProtected(root: string, protectedPaths: readonly string[]): ProtectedSnapshot {
  const out: Record<string, string | null> = {};
  for (const raw of protectedPaths) {
    if (isAbsolute(raw)) continue;
    const rel = relative(root, resolve(root, raw));
    if (rel.startsWith('..')) continue;
    filesUnder(root, rel, out);
  }
  return out;
}

/** Restaura lo que cambió desde la instantánea y devuelve las rutas afectadas. */
export function restoreProtected(root: string, before: ProtectedSnapshot, protectedPaths: readonly string[]): readonly string[] {
  const after = snapshotProtected(root, protectedPaths);
  const changed = new Set<string>();
  for (const rel of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if ((before[rel] ?? null) !== (after[rel] ?? null)) changed.add(rel);
  }
  const ordered = [...changed].sort((a, b) => b.length - a.length);
  for (const rel of ordered) {
    const prev = before[rel] ?? null;
    if (prev === null || prev === 'symlink') rmSync(join(root, rel), { recursive: true, force: true });
  }
  for (const rel of [...changed].sort()) {
    const prev = before[rel] ?? null;
    const p = join(root, rel);
    if (prev === 'dir') mkdirSync(p, { recursive: true });
    else if (prev !== null && prev !== 'symlink') {
      if (existsSync(p) && lstatSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, Buffer.from(prev, 'base64'));
    }
  }
  return [...changed].sort();
}
