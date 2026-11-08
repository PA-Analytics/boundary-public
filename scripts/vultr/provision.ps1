#Requires -Version 5.1
<#
  BOUNDARY - Vultr provisioning (Fase 1). Idempotente por etiqueta.
  Uso:
    powershell -ExecutionPolicy Bypass -File scripts/vultr/provision.ps1 -Plan
    powershell -ExecutionPolicy Bypass -File scripts/vultr/provision.ps1 -Apply
  Clave: $env:VULTR_API_KEY, luego .secrets/vultr.key, luego HKCU. Nunca se imprime.
#>
[CmdletBinding()]
param(
  [switch]$Plan,
  [switch]$Apply,
  [string]$Region = "ewr",
  [string]$PlanId = "vc2-2c-4gb",
  [int]$OsId = 2284,
  [string]$Label = "boundary-mvp",
  [string]$RepoUrl = "https://github.com/PA-Analytics/boundary.git",
  [switch]$Prompt
)

$ErrorActionPreference = "Stop"
$ApiBase = "https://api.vultr.com/v2"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path

function Get-ApiKey {
  if ($env:VULTR_API_KEY) { return $env:VULTR_API_KEY.Trim() }
  foreach ($name in @("vultr-api", "vultr.key")) {
    $file = Join-Path $root (".secrets/" + $name)
    if (Test-Path $file) { $raw = (Get-Content $file -Raw); if ($raw) { return $raw.Trim() } }
  }
  $reg = [Environment]::GetEnvironmentVariable("VULTR_API_KEY", "User")
  if ($reg) { return $reg.Trim() }
  return $null
}

$key = Get-ApiKey
if (-not $key -and $Prompt) {
  $entered = (Read-Host "VULTR_API_KEY").Trim()
  if ($entered) {
    $dir = Join-Path $root ".secrets"
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $kf = Join-Path $dir "vultr-api"
    Set-Content -Path $kf -Value $entered -NoNewline -Encoding ascii
    try { & icacls $kf /inheritance:r /grant:r ("$env:USERNAME:(R,W)") | Out-Null } catch { }
    $key = $entered
    Write-Output ("KEY_SAVED to .secrets/vultr.key len=" + $key.Length)
  }
}
if (-not $key) { Write-Output "KEY_MISSING: define VULTR_API_KEY (env, .secrets/vultr.key o HKCU) o usa -Prompt"; exit 2 }
Write-Output ("KEY_OK len=" + $key.Length)
$Headers = @{ Authorization = ("Bearer " + $key); Accept = "application/json"; "Content-Type" = "application/json" }

function Invoke-Vultr {
  param([string]$Method, [string]$Path, $Body)
  # curl -4: IPv4 fijo, para que la allowlist de la API key sea predecible.
  $curlArgs = @("-4", "-s", "-m", "45", "-X", $Method, "-H", ("Authorization: Bearer " + $key), "-H", "Accept: application/json")
  $bodyFile = $null
  if ($null -ne $Body) {
    $json = ($Body | ConvertTo-Json -Depth 8 -Compress)
    $bodyFile = Join-Path $env:TEMP ("vultr-body-" + [Guid]::NewGuid().ToString('N') + ".json")
    [System.IO.File]::WriteAllText($bodyFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    $curlArgs += @("-H", "Content-Type: application/json", "--data-binary", ("@" + $bodyFile))
  }
  $curlArgs += ($ApiBase + $Path)
  try { $raw = & curl.exe @curlArgs } finally { if ($bodyFile -and (Test-Path $bodyFile)) { Remove-Item $bodyFile -Force } }
  $text = ($raw | Out-String).Trim()
  if (-not $text) { throw ("Vultr API " + $Method + " " + $Path + " -> respuesta vacía") }
  try { $parsed = $text | ConvertFrom-Json } catch { throw ("Vultr API " + $Method + " " + $Path + " -> JSON inválido: " + $text) }
  if ($parsed.error) {
    $detail = $parsed.error
    if ($detail -match "Unauthorized IP address: (\S+)") {
      Write-Output ("IP_NOT_ALLOWED ip=" + $Matches[1])
      throw ("La API key de Vultr tiene allowlist de IP. Añade " + $Matches[1] + " en Account > API > Access Control, o elimina la restricción de esa key.")
    }
    throw ("Vultr API " + $Method + " " + $Path + " -> " + $detail)
  }
  return $parsed
}

$account = Invoke-Vultr -Method GET -Path "/account"
$instances = Invoke-Vultr -Method GET -Path "/instances"
$existing = @($instances.instances | Where-Object { $_.label -eq $Label })
Write-Output ("ACCOUNT balance=" + $account.account.balance + " pending=" + $account.account.pending_charges + " credit=" + $account.account.credit)
Write-Output ("INSTANCES total=" + @($instances.instances).Count + " matching=" + $existing.Count)
if ($existing.Count -gt 0) {
  $i = $existing[0]
  Write-Output ("EXISTING id=" + $i.id + " ip=" + $i.main_ip + " status=" + $i.status + " power=" + $i.power_status)
  Write-Output ("REUSE " + $i.main_ip)
  exit 0
}

$planInfo = (Invoke-Vultr -Method GET -Path "/plans?type=all").plans | Where-Object { $_.id -eq $PlanId } | Select-Object -First 1
$osInfo = (Invoke-Vultr -Method GET -Path "/os").os | Where-Object { $_.id -eq $OsId } | Select-Object -First 1
$regionInfo = (Invoke-Vultr -Method GET -Path "/regions").regions | Where-Object { $_.id -eq $Region } | Select-Object -First 1
if (-not $planInfo) { throw ("plan no encontrado: " + $PlanId) }
if (-not $osInfo) { throw ("os no encontrado: " + $OsId) }
if (-not $regionInfo) { throw ("region no encontrada: " + $Region) }
if ($planInfo.locations -notcontains $Region) { throw ("plan " + $PlanId + " no disponible en " + $Region) }
Write-Output ("PLAN " + $planInfo.id + " " + $planInfo.vcpu_count + "vCPU/" + $planInfo.ram + "MB USD " + $planInfo.monthly_cost + "/mes USD " + $planInfo.hourly_cost + "/h")
Write-Output ("OS " + $osInfo.name + " (" + $osInfo.id + ") REGION " + $regionInfo.city + " (" + $Region + ")")

if (-not $Apply) { Write-Output "PLAN_ONLY: sin cambios. Ejecuta -Apply para aprovisionar."; exit 0 }

$sshDir = Join-Path $root ".secrets/ssh"
if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Path $sshDir -Force | Out-Null }
$privPath = Join-Path $sshDir "boundary_ed25519"
$pubPath = $privPath + ".pub"
if (-not (Test-Path $privPath)) { & ssh-keygen -t ed25519 -N '""' -C "boundary-mvp" -f $privPath | Out-Null }
$pubKey = (Get-Content $pubPath -Raw).Trim()

$sshKeys = Invoke-Vultr -Method GET -Path "/ssh-keys"
$matchKey = @($sshKeys.ssh_keys | Where-Object { $_.name -eq "boundary-mvp" })
if ($matchKey.Count -gt 0) { $sshKeyId = $matchKey[0].id } else {
  $created = Invoke-Vultr -Method POST -Path "/ssh-keys" -Body @{ name = "boundary-mvp"; ssh_key = $pubKey }
  $sshKeyId = $created.ssh_key.id
}
Write-Output ("SSHKEY id=" + $sshKeyId)

$fwGroups = Invoke-Vultr -Method GET -Path "/firewalls"
$matchFw = @($fwGroups.firewall_groups | Where-Object { $_.description -eq "boundary-mvp" })
if ($matchFw.Count -gt 0) { $fwId = $matchFw[0].id } else {
  $fw = Invoke-Vultr -Method POST -Path "/firewalls" -Body @{ description = "boundary-mvp" }
  $fwId = $fw.firewall_group.id
  $rules = @(
    @{ protocol = "tcp"; port = "22"; subnet = "0.0.0.0"; subnet_size = 0; ip_type = "v4"; notes = "ssh" },
    @{ protocol = "tcp"; port = "80"; subnet = "0.0.0.0"; subnet_size = 0; ip_type = "v4"; notes = "http" },
    @{ protocol = "tcp"; port = "443"; subnet = "0.0.0.0"; subnet_size = 0; ip_type = "v4"; notes = "https" }
  )
  foreach ($rule in $rules) { Invoke-Vultr -Method POST -Path ("/firewalls/" + $fwId + "/rules") -Body $rule | Out-Null }
}
Write-Output ("FIREWALL id=" + $fwId + " rules=22,80,443")

$ciPath = Join-Path $PSScriptRoot "cloud-init.yaml"
$ci = (Get-Content $ciPath -Raw).Replace("__SSH_PUBKEY__", $pubKey).Replace("__REPO_URL__", $RepoUrl)
$userData = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ci))
$body = @{
  region = $Region; plan = $PlanId; os_id = $OsId; label = $Label; hostname = "boundary";
  sshkey_id = @($sshKeyId); firewall_group_id = $fwId; enable_ipv6 = $false;
  backups = "disabled"; ddos_protection = $false; activate_script = "none"; user_data = $userData
}
$created = Invoke-Vultr -Method POST -Path "/instances" -Body $body
$id = $created.instance.id
Write-Output ("CREATED id=" + $id)

$deadline = (Get-Date).AddMinutes(10)
$ip = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 10
  $cur = Invoke-Vultr -Method GET -Path ("/instances/" + $id)
  $ip = $cur.instance.main_ip
  Write-Output ("WAIT status=" + $cur.instance.status + " power=" + $cur.instance.power_status + " ip=" + $ip)
  if ($cur.instance.status -eq "active" -and $cur.instance.power_status -eq "running" -and $ip -and $ip -ne "0.0.0.0") { break }
}
if (-not $ip -or $ip -eq "0.0.0.0") { throw "la instancia no obtuvo IP a tiempo" }
$state = @("id=" + $id, "ip=" + $ip, "region=" + $Region, "plan=" + $PlanId, "key=" + $privPath) -join "`n"
Set-Content -Path (Join-Path $sshDir "instance.txt") -Value $state -Encoding utf8
Write-Output ("READY ip=" + $ip + " id=" + $id)
Write-Output ("SSH: ssh -i " + $privPath + " boundary@" + $ip)