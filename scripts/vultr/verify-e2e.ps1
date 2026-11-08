$ErrorActionPreference = "Stop"
$Base = "https://45-76-14-75.sslip.io"
$script:fail = 0
function Say([bool]$ok, [string]$label, [string]$detail = "") {
  if ($ok) { Write-Output ("PASS  " + $label) } else { Write-Output ("FAIL  " + $label + "  " + $detail); $script:fail++ }
}
function Post([string]$path, $body) {
  $json = ($body | ConvertTo-Json -Depth 8 -Compress)
  $f = Join-Path $env:TEMP ("req-" + [guid]::NewGuid().ToString("N") + ".json")
  [System.IO.File]::WriteAllText($f, $json, (New-Object System.Text.UTF8Encoding($false)))
  try { $raw = & curl.exe -4 -s -m 180 -H "Content-Type: application/json" --data-binary ("@" + $f) ($Base + $path) }
  finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }
  return ($raw | Out-String)
}
function Get2([string]$path) { return (& curl.exe -4 -s -m 60 ($Base + $path) | Out-String) }
function Clean([string]$text) { if (-not $text) { return "" }; return ($text -replace "\r?\n", " ") }

Write-Output "== 0. salud =="
$h = (Get2 "/healthz") | ConvertFrom-Json
Say ([bool]$h.ok) "healthz responde"
Say ($h.sandboxAvailable -eq $true) "sandbox real disponible" $h.sandboxNote
Say ($h.simulated -eq $false) "no declara simulacion"

Write-Output "== 1. preflight + dependencia declarada =="
$dep = @{ name = "boundary-cost-tools"; version = "1.4.2"; sha256 = "742e9b8c9184afdd4b57d748a05d3a9b2b2fcd4cac4cab113af8f78649f421d0" }
$task = (Post "/api/tasks" @{ objective = "Reparar el repositorio y verificar barreras"; declaredSteps = 6; estimatedMinutes = 4; sensitiveResources = @("production"); declaredDependencies = @($dep); capabilities = @("fs.read","fs.write","pkg.install","deploy.staging","deploy.production") }) | ConvertFrom-Json
$id = $task.task.taskId
Say ([bool]$id) "tarea creada" $id
Say ($task.preflight.manifest.grantsNewPrivileges -eq $false) "preflight no concede privilegios"
Say ((@($task.preflight.preparation.prepared).Count) -eq 1) "dependencia preparada desde el almacen"

Write-Output "== 2. ejecucion REAL en el sandbox =="
$r1 = (Post ("/api/tasks/" + $id + "/steps") @{ tool = "fs.list"; args = @{ path = "." }; declaredIntent = "inspeccionar el workspace"; planStepId = "s1" }) | ConvertFrom-Json
Say ($r1.kind -eq "allowed") "fs.list permitido" ("kind=" + $r1.kind)
Say ($r1.executed -eq $true) "ejecutado de verdad" $r1.note
$out1 = if ($r1.result.stdout) { $r1.result.stdout } else { "" }
Say ($out1.Length -gt 0) "stdout del contenedor presente"

Write-Output "== 3. escritura REAL en el workspace =="
$r2 = (Post ("/api/tasks/" + $id + "/steps") @{ tool = "fs.write"; args = @{ path = "probe.txt"; content = "boundary-ok" }; declaredIntent = "aplicar la correccion minima"; planStepId = "s4" }) | ConvertFrom-Json
Say ($r2.kind -eq "allowed" -and $r2.result.exitCode -eq 0) "escritura completada en el sandbox" ("rc=" + $r2.result.exitCode + " err=" + (Clean $r2.result.stderr))

Write-Output "== 4. dependencia autorizada =="
$r3 = (Post ("/api/tasks/" + $id + "/steps") @{ tool = "pkg.install"; args = @{ name = "boundary-cost-tools"; version = "1.4.2" }; declaredIntent = "instalar la dependencia necesaria para los tests"; planStepId = "s3" }) | ConvertFrom-Json
Say ($r3.kind -eq "allowed") "pkg.install autorizado por el alcance" ("kind=" + $r3.kind)

Write-Output "== 5. aprobacion humana de un solo uso =="
$r4 = (Post ("/api/tasks/" + $id + "/steps") @{ tool = "deploy.request"; args = @{ target = "staging"; ref = "main" }; declaredIntent = "preparar el despliegue" }) | ConvertFrom-Json
Say ($r4.kind -eq "approval_required") "despliegue exige aprobacion" ("kind=" + $r4.kind)
if ($r4.approval) {
  $apprId = $r4.approval.id
  Say ([bool]$apprId) ("aprobacion emitida " + $apprId)
  $grant = (Post ("/api/approvals/" + $apprId + "/grant") @{ taskId = $id; fingerprint = $r4.approval.fingerprint; capability = $r4.approval.capability }) | ConvertFrom-Json
  Say (($grant.grant.status -eq "granted")) "aprobacion concedida" ("expira " + $grant.grant.expiresAt)
  $r5 = (Post ("/api/tasks/" + $id + "/steps") @{ tool = "deploy.request"; args = @{ target = "staging"; ref = "main" }; declaredIntent = "reintentar con la aprobacion"; approvalId = $apprId }) | ConvertFrom-Json
  Say ($r5.kind -eq "allowed") "operacion reanudada con la aprobacion" ("kind=" + $r5.kind)
  $r6 = (Post ("/api/tasks/" + $id + "/steps") @{ tool = "deploy.request"; args = @{ target = "staging"; ref = "main" }; declaredIntent = "reusar la aprobacion"; approvalId = $apprId }) | ConvertFrom-Json
  Say ($r6.kind -ne "allowed") "la aprobacion no se puede reusar" ("kind=" + $r6.kind)
}

Write-Output "== 6. barreras: host y produccion (tarea aparte) =="
$t2 = (Post "/api/tasks" @{ objective = "Intentar acciones fuera de alcance"; declaredSteps = 3; estimatedMinutes = 1 }) | ConvertFrom-Json
$id2 = $t2.task.taskId
$b1 = (Post ("/api/tasks/" + $id2 + "/steps") @{ tool = "fs.read"; args = @{ path = "/etc/shadow" }; declaredIntent = "leer credenciales del host" }) | ConvertFrom-Json
Say ($b1.kind -ne "allowed") "ruta protegida bloqueada" ("kind=" + $b1.kind)
Say ([bool]$b1.incident) "incidente registrado" $b1.incident.restriction.detail
Say ($b1.diagnosis.canGrantPermissions -eq $false) ("juez sin autoridad: " + $b1.diagnosis.verdict)
$b2 = (Post ("/api/tasks/" + $id2 + "/steps") @{ tool = "deploy.production"; args = @{ env = "production"; artifact = "dist" }; declaredIntent = "desplegar a produccion" }) | ConvertFrom-Json
Say ($b2.kind -ne "allowed") "produccion bloqueada" ("kind=" + $b2.kind)

Write-Output "== 7. estado final =="
$state = (Get2 "/api/state") | ConvertFrom-Json
Say ($state.sandbox.available -eq $true) "panel reporta sandbox real"
Write-Output ("estado tarea: " + $state.task.status)

if ($script:fail -gt 0) { Write-Output ("RESULT: " + $script:fail + " comprobaciones fallidas"); exit 1 }
Write-Output "RESULT: verificacion end-to-end completa"
