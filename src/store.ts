/**
 * Almacenes en memoria del MVP local (sin red, sin persistencia, sin secretos).
 *
 * - `InMemoryAuditSink`: apéndice con cadena de hash (sha256) y secuencia
 *   monótona. La cadena permite detectar reordenación local; NO afirma
 *   integridad criptográfica frente a manipulación del servidor.
 * - `InMemoryApprovalStore`: implementa `ApprovalStorePort` con uso único,
 *   caducidad y rechazo de reglas críticas (nunca se conceden).
 */
import { createHash } from 'node:crypto';

import {
  isApprovalUsable,
  isExpired,
  nowIso,
  type ApprovalGrant,
  type ApprovalId,
  type ApprovalRequest,
  type ApprovalStorePort,
  type AuditEvent,
  type AuditSink,
  type IsoTimestamp,
  type JsonObject,
  type OperationFingerprint,
  type TaskId,
} from './contracts.ts';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class InMemoryAuditSink implements AuditSink {
  private events: AuditEvent[] = [];
  private seq = 0;

  async append(event: Omit<AuditEvent, 'seq' | 'prevHash' | 'hash'>): Promise<AuditEvent> {
    const prev = this.events.length > 0 ? this.events[this.events.length - 1]!.hash : null;
    const seq = this.seq++;
    const hash = sha256Hex(
      `${prev ?? 'genesis'}|${seq}|${event.taskId}|${event.at}|${event.kind}|${event.actor}|${event.summary}|${JSON.stringify(event.detail)}`,
    );
    const full: AuditEvent = { ...event, seq, prevHash: prev, hash };
    this.events.push(full);
    return full;
  }

  async list(taskId: TaskId): Promise<readonly AuditEvent[]> {
    return this.events.filter((event) => event.taskId === taskId);
  }

  async all(): Promise<readonly AuditEvent[]> {
    return [...this.events];
  }
}

export class ApprovalStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApprovalStoreError';
    this.code = code;
  }
}

interface StoredApproval {
  request: ApprovalRequest;
  grant: ApprovalGrant | null;
  denied: boolean;
  consumed: boolean;
}

export class InMemoryApprovalStore implements ApprovalStorePort {
  private readonly items = new Map<ApprovalId, StoredApproval>();

  async create(request: ApprovalRequest): Promise<ApprovalRequest> {
    const existing = this.items.get(request.id);
    if (existing) return existing.request;
    this.items.set(request.id, { request, grant: null, denied: false, consumed: false });
    return request;
  }

  async list(taskId: TaskId): Promise<readonly ApprovalRequest[]> {
    return [...this.items.values()]
      .filter((item) => item.request.taskId === taskId)
      .map((item) => item.request);
  }

  async grant(id: ApprovalId, grantedAt: IsoTimestamp, expiresAt: IsoTimestamp): Promise<ApprovalGrant> {
    const item = this.items.get(id);
    if (!item) throw new ApprovalStoreError('not_found', `aprobación no encontrada: ${id}`);
    if (item.request.criticalRules.length > 0) {
      throw new ApprovalStoreError(
        'critical_not_grantable',
        `la solicitud ${id} tiene reglas críticas y jamás puede concederse`,
      );
    }
    if (item.denied) throw new ApprovalStoreError('already_denied', `la solicitud ${id} ya fue denegada`);
    if (item.grant) throw new ApprovalStoreError('already_granted', `la solicitud ${id} ya fue concedida`);
    if (isExpired(expiresAt, grantedAt)) {
      throw new ApprovalStoreError('already_expired', `la solicitud ${id} ya está caducada`);
    }
    const grant: ApprovalGrant = {
      id,
      taskId: item.request.taskId,
      fingerprint: item.request.fingerprint,
      capability: item.request.capability,
      scope: {
        effectKinds: [...item.request.effect.kinds],
        targets: [...item.request.effect.targets],
      },
      status: 'granted',
      grantedBy: 'human',
      singleUse: true,
      grantedAt,
      expiresAt,
    };
    item.grant = grant;
    return grant;
  }

  async deny(id: ApprovalId): Promise<void> {
    const item = this.items.get(id);
    if (!item) throw new ApprovalStoreError('not_found', `aprobación no encontrada: ${id}`);
    if (item.grant) throw new ApprovalStoreError('already_granted', `la solicitud ${id} ya fue concedida`);
    item.denied = true;
  }

  async consume(
    id: ApprovalId,
    fingerprint: OperationFingerprint,
    at: IsoTimestamp,
  ): Promise<ApprovalGrant | null> {
    const item = this.items.get(id);
    if (!item || !item.grant || item.consumed || item.denied) return null;
    const usable = isApprovalUsable(
      item.grant,
      { taskId: item.request.taskId, fingerprint, capability: item.request.capability },
      at,
    );
    if (!usable) return null;
    item.consumed = true;
    item.grant = { ...item.grant, status: 'consumed' };
    return item.grant;
  }

  async find(id: ApprovalId): Promise<ApprovalGrant | null> {
    return this.items.get(id)?.grant ?? null;
  }

  /** Estado legible para la API (incluye solicitudes pendientes y decididas). */
  async describe(taskId: TaskId, now: IsoTimestamp): Promise<readonly JsonObject[]> {
    return [...this.items.values()]
      .filter((item) => item.request.taskId === taskId)
      .map((item) => {
        const status = item.consumed
          ? 'consumed'
          : item.grant
            ? 'granted'
            : item.denied
              ? 'denied'
              : isExpired(item.request.expiresAt, now)
                ? 'expired'
                : 'pending';
        return { ...item.request, status } as unknown as JsonObject;
      });
  }
}

export function approvalExpiryFrom(requestedAt: IsoTimestamp, ttlMs: number): IsoTimestamp {
  return new Date(Date.parse(requestedAt) + ttlMs).toISOString();
}

export { nowIso };
