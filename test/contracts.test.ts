/**
 * Verificación del módulo de contratos: invariantes deterministas que el resto
 * del sistema depende de cumplir. No prueba nube, contención ni benchmark.
 */
import { describe, expect, test } from 'bun:test';

import {
  API_ROUTES,
  CONTRACT_VERSION,
  CRITICAL_RULES,
  DEFAULT_APPROVAL_THRESHOLD,
  clampScore,
  canApplyRecovery,
  effectsEquivalent,
  isApprovalUsable,
  isApprovable,
  isBenchmarkEligible,
  isCriticalDenial,
  isCriticalRule,
  isSandboxUsable,
  isTerminalDenial,
  modelIdentityMatches,
  recoveryBlockers,
  resolvePolicyDecision,
  riskBand,
  type ApprovalGrant,
  type ApprovalRequest,
  type CriticalRuleId,
  type EffectSignature,
  type JudgeDiagnosis,
  type ModelInvocationRecord,
  type PolicyVerdict,
  type RecoveryProposal,
  type SandboxLimitsReport,
  type ApprovedMechanism,
} from '../src/contracts.ts';

const sandboxEffect: EffectSignature = {
  kinds: ['network.egress'],
  targets: ['registry.npmjs.org'],
  environment: 'sandbox',
  irreversible: false,
  externalImpact: true,
};

const localEffect: EffectSignature = {
  kinds: ['read', 'write'],
  targets: ['/work/repo/index.js'],
  environment: 'sandbox',
  irreversible: false,
  externalImpact: false,
};

function verdict(overrides: Partial<PolicyVerdict> = {}): PolicyVerdict {
  return {
    decision: 'allow',
    criticalViolations: [],
    risk: {
      score: 10,
      band: 'auto',
      factors: [],
      threshold: DEFAULT_APPROVAL_THRESHOLD,
      provisional: true,
    },
    reasons: [],
    policyVersion: 'test-1',
    fingerprint: 'fp-1',
    decidedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const goodLimits: SandboxLimitsReport = {
  cgroupVersion: 'v2',
  rootless: true,
  enforced: true,
  violations: [],
  measured: { cpus: 1, memoryMb: 512, pids: 64, wallClockMs: 60000, diskMb: 1024 },
  checkedAt: '2026-01-01T00:00:00.000Z',
};

const mechanism: ApprovedMechanism = {
  id: 'dep-store',
  label: 'Almacén aprobado de dependencias',
  capabilities: ['pkg.install'],
  effectKinds: ['package.install'],
  networkEgress: 'none',
  requiresApproval: false,
  integrity: 'sha256-pinned',
  grantsNewPrivileges: false,
};

const proposal: RecoveryProposal = {
  id: 'rec-1',
  incidentId: 'inc-1',
  mechanism,
  proposedEffect: {
    kinds: ['package.install'],
    targets: ['lodash@4.17.21'],
    environment: 'sandbox',
    irreversible: false,
    externalImpact: false,
  },
  blockedEffect: sandboxEffect,
  steps: ['fetch from store', 'verify hash', 'install offline'],
  newPolicyVerdictRequired: true,
};

describe('contracts', () => {
  test('version and critical rules are stable', () => {
    expect(CONTRACT_VERSION).toBe('1.0.0');
    expect(CRITICAL_RULES.length).toBeGreaterThan(0);
    expect(CRITICAL_RULES.every((rule) => rule.unrecoverable && rule.approvable === false)).toBe(true);
    expect(isCriticalRule('sandbox.escape')).toBe(true);
    expect(isCriticalRule('not-a-rule')).toBe(false);
  });

  test('critical violations force deny regardless of score', () => {
    const low = verdict({
      decision: 'allow',
      criticalViolations: ['sandbox.escape'],
      risk: { ...verdict().risk, score: 0, band: 'auto' },
    });
    expect(resolvePolicyDecision(low)).toBe('deny');
    expect(isCriticalDenial(low)).toBe(true);
    expect(isTerminalDenial(low)).toBe(true);

    const highButClean = verdict({ decision: 'require_approval' });
    expect(isTerminalDenial(highButClean)).toBe(false);
    expect(resolvePolicyDecision(highButClean)).toBe('require_approval');
  });

  test('risk bands respect provisional thresholds', () => {
    expect(riskBand(0)).toBe('auto');
    expect(riskBand(34)).toBe('auto');
    expect(riskBand(35)).toBe('controlled');
    expect(riskBand(64)).toBe('controlled');
    expect(riskBand(DEFAULT_APPROVAL_THRESHOLD)).toBe('approval');
    expect(riskBand(100)).toBe('approval');
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(500)).toBe(100);
    expect(clampScore(Number.NaN)).toBe(100);
  });

  test('sandbox fails closed without verified limits', () => {
    expect(isSandboxUsable(goodLimits)).toBe(true);
    expect(isSandboxUsable(null)).toBe(false);
    expect(isSandboxUsable({ ...goodLimits, cgroupVersion: 'v1' })).toBe(false);
    expect(isSandboxUsable({ ...goodLimits, rootless: false })).toBe(false);
    expect(isSandboxUsable({ ...goodLimits, enforced: false })).toBe(false);
    expect(isSandboxUsable({ ...goodLimits, violations: ['pids'] })).toBe(false);
    expect(isSandboxUsable({ ...goodLimits, measured: { ...goodLimits.measured, cpus: 0 } })).toBe(false);
  });

  test('effect equivalence blocks the same effect through another path', () => {
    expect(
      effectsEquivalent(sandboxEffect, {
        ...sandboxEffect,
        targets: ['HTTPS://Registry.NPMJS.org/'],
      }),
    ).toBe(true);
    // Mismo efecto, distinto mecanismo: sigue siendo el mismo efecto prohibido.
    expect(effectsEquivalent(sandboxEffect, { ...sandboxEffect, targets: ['registry.npmjs.org'] })).toBe(true);
    // Efecto global (sin targets) es equivalente a cualquier target del mismo tipo.
    expect(effectsEquivalent({ ...sandboxEffect, targets: [] }, { ...sandboxEffect, targets: ['other.example'] })).toBe(
      true,
    );
    expect(effectsEquivalent(sandboxEffect, localEffect)).toBe(false);
    expect(effectsEquivalent(sandboxEffect, { ...sandboxEffect, environment: 'production' })).toBe(false);
    expect(effectsEquivalent(sandboxEffect, { ...sandboxEffect, irreversible: true })).toBe(false);
  });

  test('recovery is allowed only when mechanism and effect are authorized', () => {
    expect(
      recoveryBlockers({
        proposal,
        mechanismAuthorized: true,
        integrityVerified: true,
        effectVerdict: verdict({ fingerprint: 'fp-rec' }),
        approvalUsable: false,
        limitsReport: goodLimits,
      }),
    ).toEqual([]);
    expect(canApplyRecovery({
      proposal,
      mechanismAuthorized: true,
      integrityVerified: true,
      effectVerdict: verdict({ fingerprint: 'fp-rec' }),
      approvalUsable: false,
      limitsReport: goodLimits,
    })).toBe(true);

    const blocked = recoveryBlockers({
      proposal: { ...proposal, proposedEffect: sandboxEffect },
      mechanismAuthorized: false,
      integrityVerified: false,
      effectVerdict: verdict({ criticalViolations: ['network.unlisted-host'] as readonly CriticalRuleId[] }),
      approvalUsable: false,
      limitsReport: null,
    });
    expect(blocked).toContain('mechanism_not_authorized');
    expect(blocked).toContain('integrity_unverified');
    expect(blocked).toContain('sandbox_limits_unverified');
    expect(blocked).toContain('effect_equivalent_to_prohibited');
    expect(blocked).toContain('critical_rule');
    expect(canApplyRecovery({
      proposal: { ...proposal, proposedEffect: sandboxEffect },
      mechanismAuthorized: false,
      integrityVerified: false,
      effectVerdict: verdict({ criticalViolations: ['network.unlisted-host'] }),
      approvalUsable: false,
      limitsReport: null,
    })).toBe(false);
  });

  test('approval requiring recovery stays blocked without usable approval', () => {
    const requireApproval = verdict({ decision: 'require_approval' });
    const without = recoveryBlockers({
      proposal,
      mechanismAuthorized: true,
      integrityVerified: true,
      effectVerdict: requireApproval,
      approvalUsable: false,
      limitsReport: goodLimits,
    });
    expect(without).toContain('approval_required');
    expect(without).toContain('approval_missing');

    const withApproval = recoveryBlockers({
      proposal,
      mechanismAuthorized: true,
      integrityVerified: true,
      effectVerdict: requireApproval,
      approvalUsable: true,
      limitsReport: goodLimits,
    });
    expect(withApproval).toEqual(['approval_required']);
  });

  test('approvals are human, single use, scoped and expiring', () => {
    const request: ApprovalRequest = {
      id: 'apr-1',
      taskId: 'task-1',
      incidentId: null,
      fingerprint: 'fp-1',
      capability: 'deploy.production',
      effect: { ...localEffect, environment: 'production' },
      reason: 'deploy',
      requestedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:30:00.000Z',
      criticalRules: [],
    };
    expect(isApprovable(request)).toBe(true);
    expect(isApprovable({ ...request, criticalRules: ['production.unapproved'] })).toBe(false);

    const grant: ApprovalGrant = {
      id: 'apr-1',
      taskId: 'task-1',
      fingerprint: 'fp-1',
      capability: 'deploy.production',
      scope: { effectKinds: ['deploy'], targets: ['app.example'] },
      status: 'granted',
      grantedBy: 'human',
      singleUse: true,
      grantedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:30:00.000Z',
    };
    const expected = { taskId: 'task-1', fingerprint: 'fp-1', capability: 'deploy.production' as const };

    expect(isApprovalUsable(grant, expected, '2026-01-01T00:10:00.000Z')).toBe(true);
    expect(isApprovalUsable(grant, expected, '2026-01-01T00:30:00.000Z')).toBe(false);
    expect(isApprovalUsable({ ...grant, status: 'consumed' }, expected, '2026-01-01T00:10:00.000Z')).toBe(false);
    expect(isApprovalUsable(grant, { ...expected, fingerprint: 'other' }, '2026-01-01T00:10:00.000Z')).toBe(false);
    expect(isApprovalUsable(null, expected, '2026-01-01T00:10:00.000Z')).toBe(false);
  });

  test('judge diagnosis cannot carry authority (compile-time enforced)', () => {
    const diagnosis: JudgeDiagnosis = {
      verdict: 'supported',
      rationale: 'evidencia consistente',
      evidenceRefs: ['evt-1'],
      canGrantPermissions: false,
      authority: 'none',
      advisory: true,
      producedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(diagnosis.canGrantPermissions).toBe(false);
    expect(diagnosis.authority).toBe('none');

    // @ts-expect-error el Judge no puede declararse con autoridad
    const illegal: JudgeDiagnosis = { ...diagnosis, authority: 'grant' };
    void illegal;
  });

  test('model identity is verified for benchmark eligibility', () => {
    expect(modelIdentityMatches('Vultr/Qwen3-32B', 'vultr/qwen3-32b')).toBe(true);
    expect(modelIdentityMatches('vultr/a', 'vultr/b')).toBe(false);

    const record: ModelInvocationRecord = {
      provider: 'vultr-serverless-inference',
      requestedModel: 'vultr/a',
      returnedModel: 'vultr/a',
      match: true,
      taskId: 'task-1',
      purpose: 'plan',
      at: '2026-01-01T00:00:00.000Z',
      promptTokens: 10,
      completionTokens: 20,
    };
    expect(isBenchmarkEligible([record])).toBe(true);
    expect(isBenchmarkEligible([])).toBe(false);
    expect(isBenchmarkEligible([{ ...record, returnedModel: 'vultr/b', match: false }])).toBe(false);
  });

  test('api routes are stable', () => {
    expect(API_ROUTES.health).toBe('/healthz');
    expect(API_ROUTES.task('a b')).toBe('/api/tasks/a%20b');
    expect(API_ROUTES.approvalGrant('x')).toBe('/api/approvals/x/grant');
  });
});
