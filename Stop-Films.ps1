param([string]$DataDirectory = (Join-Path $PSScriptRoot 'data'))
$ErrorActionPreference = 'Stop'
$taskServer = Join-Path $PSScriptRoot 'server.mjs'
$taskPidFile = Join-Path ([IO.Path]::GetFullPath($DataDirectory)) 'server.pid'
if (-not (Test-Path -LiteralPath $taskPidFile)) { Write-Output 'No Films PID file.'; exit 0 }
$taskProcessId = [int](Get-Content -LiteralPath $taskPidFile -Raw)
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $taskProcessId" -ErrorAction SilentlyContinue
if ($taskProcess -and $taskProcess.CommandLine.Contains($taskServer)) {
    Stop-Process -Id $taskProcessId
    Write-Output 'Films stopped. The data directory is preserved.'
} else { Write-Output 'Films is already stopped.' }
