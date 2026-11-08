$ErrorActionPreference = "Stop"
$Base = "https://45-76-14-75.sslip.io"
# The API token is never stored in this file. Provide it through the environment:
#   PowerShell:  $env:BOUNDARY_API_TOKEN = "<token>"
$Token = $env:BOUNDARY_API_TOKEN
if (-not $Token) { Write-Error "BOUNDARY_API_TOKEN is not set"; exit 2 }
Write-Output "== panel y estado (lectura) =="
$h = (& curl.exe -4 -s -m 30 "$Base/healthz") | ConvertFrom-Json
Write-Output ("healthz ok=" + $h.ok + " sandbox=" + $h.sandboxAvailable)
$code = (& curl.exe -4 -s -m 20 -o NUL -w "%{http_code}" "$Base/")
Write-Output ("panel_http=" + $code)
Write-Output "== mutacion sin token =="
$f = Join-Path $env:TEMP "sec1.json"
[System.IO.File]::WriteAllText($f, '{"objective":"intento sin token","declaredSteps":1,"estimatedMinutes":1}', (New-Object System.Text.UTF8Encoding($false)))
$r1 = (& curl.exe -4 -s -m 30 -o NUL -w "%{http_code}" -H "Content-Type: application/json" --data-binary ("@"+$f) "$Base/api/tasks")
Write-Output ("sin_token_http=" + $r1)
Write-Output "== mutacion con token =="
$r2 = (& curl.exe -4 -s -m 60 -o NUL -w "%{http_code}" -H ("Authorization: Bearer " + $Token) -H "Content-Type: application/json" --data-binary ("@"+$f) "$Base/api/tasks")
Write-Output ("con_token_http=" + $r2)
Write-Output "== token incorrecto =="
$r3 = (& curl.exe -4 -s -m 30 -o NUL -w "%{http_code}" -H "Authorization: Bearer wrong-token" -H "Content-Type: application/json" --data-binary ("@"+$f) "$Base/api/tasks")
Write-Output ("token_malo_http=" + $r3)
Write-Output "== secretos en el codigo =="
$leaks = (Select-String -Path "src/*.ts","web/*","bench/*.ts" -Pattern "XHWEACF|YKHAZHP|OSMIX" -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Output ("secretos_en_codigo=" + $leaks)
Write-Output "== secrets en git =="
$tracked = (git ls-files | Select-String -Pattern "^\.secrets/" | Measure-Object).Count
Write-Output ("archivos_secretos_versionados=" + $tracked)
Write-Output "== endpooints publicos =="
$r4 = (& curl.exe -4 -s -m 20 -o NUL -w "%{http_code}" "$Base/api/state")
Write-Output ("state_get_http=" + $r4)
