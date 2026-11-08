#!/usr/bin/env bun
/**
 * Runner del benchmark LIVE: ejecuta bench/live.ts contra inferencia real y Docker.
 * Escribe resultados en bench/results/live-<ts>.json y un resumen en Markdown.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runLiveBenchmark, type LiveReport, type RunRecord } from "./live.ts";

const repetitions = Number.parseInt(process.env.BOUNDARY_LIVE_REPS ?? "5", 10);
const outDir = resolve(import.meta.dir, "results");
mkdirSync(outDir, { recursive: true });

console.log(`BOUNDARY live benchmark — modelo ${process.env.VULTR_INFERENCE_MODEL ?? "(sin modelo)"}, ${repetitions} repeticiones por configuracion`);
const report = await runLiveBenchmark(repetitions);

if (!report.probe.ok) {
  console.log(`BLOQUEADO: ${report.probe.reason}`);
  process.exit(2);
}

function key(run: RunRecord): string {
  return `${run.config}/${run.scenario}`;
}

interface Aggregate {
  config: string;
  scenario: string;
  runs: number;
  achieved: number;
  recovered: number;
  denied: number;
  blocked: number;
  interventions: number;
  latencyAvg: number;
  tokens: number;
  modelMatch: number;
}

const groups = new Map<string, RunRecord[]>();
for (const run of report.runs) {
  const k = key(run);
  const list = groups.get(k) ?? [];
  list.push(run);
  groups.set(k, list);
}

const aggregate: Aggregate[] = [...groups.entries()].map(([k, runs]) => ({
  config: runs[0]!.config,
  scenario: runs[0]!.scenario,
  runs: runs.length,
  achieved: runs.filter((r) => r.objectiveAchieved).length,
  recovered: runs.reduce((sum, r) => sum + r.recovered, 0),
  denied: runs.reduce((sum, r) => sum + r.denied, 0),
  blocked: runs.reduce((sum, r) => sum + r.blocked, 0),
  interventions: runs.reduce((sum, r) => sum + r.interventions, 0),
  latencyAvg: Math.round(runs.reduce((sum, r) => sum + r.latencyMs, 0) / runs.length),
  tokens: runs.reduce((sum, r) => sum + r.promptTokens + r.completionTokens, 0),
  modelMatch: runs.filter((r) => r.modelMatch).length,
  }));

aggregate.sort((a, b) => (a.scenario === b.scenario ? a.config.localeCompare(b.config) : a.scenario.localeCompare(b.scenario)));

const lines: string[] = [];
lines.push("# BOUNDARY — benchmark con LLM real", "");
lines.push(`Generado: ${report.generatedAt}`);
lines.push(`Modelo: ${report.model ?? "(ninguno)"} · repeticiones: ${report.repetitions} · modelo usado en el ciclo: ${report.liveModelUsed ? "SI" : "NO"}`);
lines.push(`Sandbox: ${report.probe.reason}`, "");
lines.push("| Escenario | Config | Runs | Objetivo | Recup. | Deneg. | Bloqueos | Interv. | Latencia media | Tokens | Modelo coincide |");
lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
for (const row of aggregate) {
  lines.push(`| ${row.scenario} | ${row.config} | ${row.runs} | ${row.achieved}/${row.runs} | ${row.recovered} | ${row.denied} | ${row.blocked} | ${row.interventions} | ${row.latencyAvg} ms | ${row.tokens} | ${row.modelMatch}/${row.runs} |`);
}
lines.push("");
lines.push("Configuraciones: A = agente base sin capa, B = politica determinista, C = politica + Judge + Lifeguard.");
lines.push("Todas comparten modelo, catalogo de herramientas, limites de sandbox (mem 512MB, pids 64, red none) y presupuesto de pasos.");

const stamp = report.generatedAt.replace(/[:.]/g, "-");
writeFileSync(resolve(outDir, `live-${stamp}.json`), JSON.stringify(report, null, 2));
writeFileSync(resolve(outDir, `live-${stamp}.md`), lines.join("\n"));
writeFileSync(resolve(outDir, "latest.json"), JSON.stringify(report, null, 2));
writeFileSync(resolve(outDir, "latest.md"), lines.join("\n"));

console.log("");
console.log(lines.join("\n"));
console.log("");
console.log(`benchmarkEligible: ${report.liveModelUsed ? "true (modelo real en el ciclo)" : "false (sin modelo real)"}`);
