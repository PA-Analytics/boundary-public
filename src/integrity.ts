/**
 * Monitor de integridad de rutas protegidas. `proc.exec` sólo expone argv a la
 * política: un script propio puede escribir una ruta protegida sin que se vea.
 * El gateway toma una instantánea de `protectedPaths` antes de ejecutar y, si la
 * ejecución las cambió, las restaura y trata la llamada como violación crítica.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    out[rel] = st.isSymbolicLink() ? `symlink:${readlinkSync(p)}` : readFileSync(p).toString('base64');
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
  // Lo cambiado se borra sin seguir symlinks (rmSync no los sigue) y se recrea desde la instantánea, de fuera hacia dentro (force ignora lo que ya cayó con su padre).
  for (const rel of [...changed].sort((a, b) => a.length - b.length)) rmSync(join(root, rel), { recursive: true, force: true });
  for (const rel of [...changed].sort()) {
    const prev = before[rel] ?? null;
    if (prev === null) continue;
    const p = join(root, rel);
    if (prev === 'dir') mkdirSync(p, { recursive: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      if (prev.startsWith('symlink:')) symlinkSync(prev.slice('symlink:'.length), p);
      else writeFileSync(p, Buffer.from(prev, 'base64'));
    }
  }
  return [...changed].sort();
}
