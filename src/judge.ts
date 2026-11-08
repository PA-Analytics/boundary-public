/**
 * Judge — diagnóstico opcional basado en evidencia, SIN autoridad.
 *
 * El Judge nunca autoriza, nunca desbloquea y nunca forma parte del
 * flujo obligatorio: si falla o no está configurado, el sistema sigue
 * aplicando la política determinista. La integración con un modelo
 * remoto (p. ej. Vultr Serverless Inference) es configurable después
 * vía `JudgeModelProvider`; el MVP local usa solo heurística
 * determinista y auditable.
 */

export type JudgeVerdict =
  | "supported"
  | "partially-supported"
  | "contradicted"
  | "insufficient-evidence";

export interface JudgeEvidence {
  /** Tarea original del usuario. */
  objective: string;
  /** Plan del agente antes del incidente. */
  plan: string[];
  /** Operación que intentó ejecutar. */
  attemptedOperation: string;
  /** Restricción que se activó. */
  restriction: string;
  /** Explicación del agente. */
  explanation: string;
  /** Extracto de logs / evidencias técnicas disponibles. */
  logExcerpt?: string;
}

export interface JudgeDiagnosis {
  verdict: JudgeVerdict;
  reasons: string[];
  /** Siempre false: el Judge no concede permisos. */
  authorizes: false;
}

/** Proveedor de modelo configurable a posteriori (Vultr u otro). */
export type JudgeModelProvider = (evidence: JudgeEvidence) => Promise<string>;

function tokens(s: string): Set<string> {
  const words = s
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü\s._-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  return new Set(words);
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / Math.min(a.size, b.size);
}

/**
 * Diagnóstico determinista: contrasta la explicación con la tarea,
 * el plan y la evidencia registrada. No llama a ningún modelo.
 */
export function diagnose(evidence: JudgeEvidence): JudgeDiagnosis {
  const reasons: string[] = [];
  const objective = tokens(evidence.objective);
  const plan = tokens(evidence.plan.join("\n"));
  const attempted = tokens(evidence.attemptedOperation);
  const explanation = tokens(evidence.explanation);
  const logs = tokens(
    `${evidence.restriction}\n${evidence.logExcerpt ?? ""}`,
  );

  if (evidence.explanation.trim().length < 20) {
    return {
      verdict: "insufficient-evidence",
      reasons: ["explanation too short to evaluate"],
      authorizes: false,
    };
  }

  const explainsTask = overlapRatio(explanation, objective);
  const matchesPlan = overlapRatio(explanation, new Set([...plan, ...attempted]));
  const backedByLogs = overlapRatio(explanation, logs);

  reasons.push(`explanation/objective overlap=${explainsTask.toFixed(2)}`);
  reasons.push(`explanation/plan+operation overlap=${matchesPlan.toFixed(2)}`);
  reasons.push(`explanation/evidence overlap=${backedByLogs.toFixed(2)}`);

  // Señal de contradicción: la explicación ignora la restricción registrada.
  if (backedByLogs === 0) {
    reasons.push("explanation ignores the recorded restriction/evidence");
    return { verdict: "contradicted", reasons, authorizes: false };
  }
  const strong = explainsTask >= 0.3 && matchesPlan >= 0.3 && backedByLogs > 0;
  if (strong) return { verdict: "supported", reasons, authorizes: false };
  const partial =
    explainsTask >= 0.15 || matchesPlan >= 0.15 || backedByLogs >= 0.15;
  if (partial) return { verdict: "partially-supported", reasons, authorizes: false };
  return { verdict: "insufficient-evidence", reasons, authorizes: false };
}

/**
 * Vía configurable con modelo remoto. El texto del modelo solo se usa
 * como contexto informativo; el veredicto lo sigue calculando
 * `diagnose()` y el resultado jamás autoriza nada.
 */
export async function diagnoseWithModel(
  evidence: JudgeEvidence,
  provider?: JudgeModelProvider,
): Promise<JudgeDiagnosis> {
  if (!provider) return diagnose(evidence);
  const extra = await provider(evidence);
  const enriched: JudgeEvidence = {
    ...evidence,
    logExcerpt: `${evidence.logExcerpt ?? ""}\n[model-note] ${extra}`.trim(),
  };
  return diagnose(enriched);
}

/** El Judge no autoriza: siempre false, por tipo y por valor. */
export function canAuthorize(_diagnosis: JudgeDiagnosis): false {
  return false;
}
