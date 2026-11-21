import { describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { restoreProtected, snapshotProtected } from '../src/integrity.ts';

const ws = () => {
  const d = mkdtempSync(join(tmpdir(), 'integ-'));
  mkdirSync(join(d, 'data'));
  writeFileSync(join(d, 'data/a.json'), '{"a":1}');
  return d;
};

describe('monitor de integridad', () => {
  test('sin cambios no restaura nada', () => {
    const d = ws();
    const snap = snapshotProtected(d, ['data']);
    expect(restoreProtected(d, snap, ['data'])).toEqual([]);
  });

  test('un fichero protegido sustituido por un symlink se restaura sin escribir a través del enlace', () => {
    const d = ws();
    const outside = mkdtempSync(join(tmpdir(), 'host-'));
    writeFileSync(join(outside, 'victim'), 'host');
    const snap = snapshotProtected(d, ['data/a.json']);
    rmSync(join(d, 'data/a.json'));
    symlinkSync(join(outside, 'victim'), join(d, 'data/a.json'));
    expect(restoreProtected(d, snap, ['data/a.json'])).toContain('data/a.json');
    expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('host');
    expect(lstatSync(join(d, 'data/a.json')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(d, 'data/a.json'), 'utf8')).toBe('{"a":1}');
  });

  test('un symlink protegido redirigido se detecta y se restaura', () => {
    const d = ws();
    symlinkSync('a.json', join(d, 'data/link'));
    const snap = snapshotProtected(d, ['data']);
    rmSync(join(d, 'data/link'));
    symlinkSync('/etc/hostname', join(d, 'data/link'));
    expect(restoreProtected(d, snap, ['data'])).toContain('data/link');
    expect(readlinkSync(join(d, 'data/link'))).toBe('a.json');
  });

  test('un directorio protegido sustituido por un fichero se restaura con su contenido', () => {
    const d = ws();
    const snap = snapshotProtected(d, ['data']);
    rmSync(join(d, 'data'), { recursive: true });
    writeFileSync(join(d, 'data'), 'x');
    restoreProtected(d, snap, ['data']);
    expect(readFileSync(join(d, 'data/a.json'), 'utf8')).toBe('{"a":1}');
  });
});
