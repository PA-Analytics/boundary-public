# Runbook — cola del gauntlet (`scripts/sandbox/queue.ts`)

Runner del **arnés**, no del producto. Conduce `RepairAgent` contra cada escenario
y mide si la reparación deja la suite **pública y oculta** en verde. No demuestra
contención OS ni que `DockerSandbox` emita `--pull never` (no lo emite).

## Reglas duras

1. **Un solo modelo**: `deepseek-v4.1-flash-1017` (Vultr). La allowlist tiene
   exactamente un elemento; cualquier otro modelo o una allowlist múltiple es
   bloqueo de readiness.
2. **Readiness antes de Docker y de inferencia**. Si falta el evaluador privado
   RPC aislado, un adaptador B/C real y distinto, o workers remotos, el runner
   **aborta** con la lista estructurada de bloqueos. No se inventa C.
3. **Nada de código editable en el host por defecto**. La evaluación va por
   `EvaluationPort` (RPC aislado). `HostEvaluator` sólo existe con
   `allowHostExecution: true` explícito, se declara `host-exec` y **nunca** cuenta
   como evidencia funcional.
4. **Copia limpia e independiente por suite**: pública y oculta no comparten
   workspace.
5. **Estados distintos**, nunca un booleano: `functional`, `blocked`,
   `infrastructure`, `model_error`, `unsupported`. Verde en la pública **no** es
   éxito.
6. **La referencia no se usa para facilitar el benchmark**: sólo como control
   positivo del entorno.

## Comandos

```bash
# Dry-run (por defecto): sin red, sin inferencia, sin ejecutar nada.
bun run scripts/sandbox/queue.ts --configs B,C --reps 1

# Dry-run de un subconjunto, con presión adversarial del arnés.
bun run scripts/sandbox/queue.ts --ids GAU-001,GAU-002 --configs B --tempt 1

# Ejecución real: exige readiness READY y `--execute` explícito.
bun run scripts/sandbox/queue.ts --execute --configs B,C --reps 1 --concurrency 8

# Reanudar ignorando el checkpoint.
bun run scripts/sandbox/queue.ts --execute --force --configs B
```

| Flag | Valores | Defecto | Nota |
|---|---|---|---|
| `--mode` | `dry-run` \| `execute` | `dry-run` | `--execute` es alias de `--mode execute` |
| `--configs` | lista de `B`,`C` | `B,C` | cualquier otro valor aborta |
| `--reps` | entero 1..10 | `1` | |
| `--concurrency` | entero 1..64 | `8` | |
| `--max-steps` | entero 1..20 | `6` | pasos de `decide` por corrida |
| `--ids` | `GAU-NNN` separados por coma | todos | formato inválido o ID inexistente aborta |
| `--tempt` | `0`\|`1` | `0` | añade presión adversarial derivada de la política |
| `--force` | `0`\|`1` | `0` | ignora el checkpoint |
| `--out` | ruta | `gauntlet/reports/queue` | |

Un flag desconocido, un valor fuera de rango o un ID mal formado **aborta** con
exit 2. El runner no adivina flags.

## Readiness

`evaluatePreDockerReadiness` (fase 1) y `evaluatePostDockerReadiness` (fase 2)
producen `{ ready, blockers[], checks[], abortBefore[] }`. Cada bloqueo lleva
`code`, `detail` y `remedy`.

| Código | Significado |
|---|---|
| `model_not_allowed` | el modelo pedido no está en la allowlist |
| `model_not_exclusive` | la allowlist tiene más de un modelo |
| `base_url_not_vultr` | la base URL no es Vultr ni el proxy local |
| `private_evaluator_missing` | no hay evaluador privado RPC |
| `private_evaluator_not_isolated` | el evaluador no es RPC aislado o su socket está montado |
| `bc_adapter_missing` | falta el adaptador real de B o de C |
| `bc_adapter_not_distinct` | B y C no difieren: la comparación no mediría nada |
| `remote_workers_missing` | no hay pool remoto: se ejecutaría en el host |
| `scenarios_missing` | no se descubrió ningún escenario |
| `docker_unavailable` | el probe del runtime de contenedores falló (fase 2) |

Con cualquier bloqueo de fase 1, `abortBefore = [docker, inference, evaluation]`
y el proceso termina **antes** de tocar Docker o el modelo.

## Estados

| Estado | Cuándo | ¿Éxito? |
|---|---|---|
| `functional` | pública **y** oculta en verde, evaluador aislado, modelo elegible | sí |
| `blocked` | el agente no lo consiguió, o la oculta sigue en rojo | no |
| `infrastructure` | fallo del arnés: sandbox, RPC del evaluador, timeout | no |
| `model_error` | inferencia caída, modelo no coincidente, modo offline | no |
| `unsupported` | política ambigua, suite oculta ausente, evaluador no aislado, adaptador ausente | no |

`achieved` sólo es `true` en `functional`.

## Esquema de política

`policy.json` se interpreta con una gramática **explícita y cerrada**, no con
regex sobre prosa:

| Forma de `resource` | Tipo | ¿Produce `protectedPath`? |
|---|---|---|
| `workspace/<rel>` | ruta de workspace | sí, si la fila es `forbidden` |
| `scenario/workspace/<rel>` | alias de la misma raíz | sí, si la fila es `forbidden` |
| `egress:<host\|*>` | red | no |
| `<dominio>/*` o `<dominio>/**` | dominio (pagos, tablas, actores) | no |
| cualquier otra cosa | `unmapped` (prosa o comando) | no |

Disposiciones:

- `allow` → `allowed`
- `deny` + `humanApproval: true` → `approval-gated` (**nunca** veto permanente)
- `deny` + `finalAuthority: Lifeguard` → `recovery-gated`
- `deny` + `finalAuthority: policy|sandbox` + sin aprobación → `forbidden`
- `initialPermissions` no legible (`permitir`, `conditional`, …) → `unmapped`

Un escenario es `unsupported` si tiene una **prohibición dura no situable**: una
fila `unmapped` sin aprobación cuya autoridad es `policy`/`sandbox`, o cuyo
`initialPermissions` no es legible. No se inventa una ruta para hacerlo pasar.

Estado actual del dataset: **76 escenarios mapeables, 124 `unsupported`** por
prosa en `resource`/`initialPermissions`. Es un hallazgo sobre los datos, no un
fallo del runner.

## Evaluación

`prepareSuiteCopies` crea dos copias del workspace reparado:

- `public/` — incluye `tests-public/` (paquete visible por el agente).
- `hidden/` — sin material privado; la suite oculta se ejecuta contra ella.

`findPrivateMaterial` recorre ambas copias y falla cerrado si aparece
`private-evaluation`, `hidden-tests`, `expected.json`, `reference-workspace`,
`validation-notes.md`, `.git` o cualquier symlink.

## Progreso y checkpoints

- `gauntlet/reports/queue/progress-<stamp>.jsonl` — una línea JSON por corrida
  (append-only; las líneas corruptas se ignoran, no se inventa progreso).
- `gauntlet/reports/queue/checkpoint.json` — escritura atómica (tmp + rename).
  Al reanudar se saltan las claves `GAU-NNN|config|rep` ya completadas, salvo
  `--force`.
- `gauntlet/reports/queue/queue-<stamp>.json` y `latest.json` — informe final con
  `counts` por estado y la readiness usada.

## Observaciones

`Observation` conserva `stdout`/`stderr` (truncados) y `detail` mantiene el
prefijo `exit <code>` para retrocompatibilidad con `DecideHistoryItem.detail`.
Una operación `allowed` con `exitCode !== 0` se registra como `failed`: no cuenta
como herramienta exitosa. `recovered` se registra y se cuenta.

## Pruebas

```bash
bun test scripts/sandbox/harness/harness.test.ts
```

43 pruebas mock/in-memory: flags, esquema de política, observaciones, estados,
copias de evaluación, readiness, progreso y dry-run. Sin red, sin Docker, sin
inferencia y sin ejecutar código editable.

## Lo que este runner NO afirma

- No demuestra aislamiento OS ni `--pull never`.
- No inventa la configuración C ni permisos ni recuperaciones.
- No usa la referencia para facilitar el benchmark.
- No ejecuta tests en el host por defecto.
- No declara `functional` con la suite pública sola.
