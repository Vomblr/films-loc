#requires -Version 7.4
param(
    [int]$Port = 8766,
    [string]$BindAddress = '127.0.0.1',
    [string]$DataDirectory = (Join-Path $PSScriptRoot 'data')
)
$ErrorActionPreference = 'Stop'
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskData = [IO.Path]::GetFullPath($DataDirectory)
$taskServer = Join-Path $PSScriptRoot 'server.mjs'
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
$taskPidFile = Join-Path $taskData 'server.pid'
if (Test-Path -LiteralPath $taskPidFile) {
    $taskPreviousId = [int](Get-Content -LiteralPath $taskPidFile -Raw)
    $taskPrevious = Get-CimInstance Win32_Process -Filter "ProcessId = $taskPreviousId" -ErrorAction SilentlyContinue
    if ($taskPrevious -and $taskPrevious.CommandLine.Contains($taskServer)) {
        Write-Output "Films is already running (PID $taskPreviousId)."
        exit 0
    }
}
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList @('--disable-warning=ExperimentalWarning', ('"{0}"' -f $taskServer)) -WorkingDirectory $PSScriptRoot -Environment @{ PORT = [string]$Port; HOST = $BindAddress; FILMS_DATA_DIR = $taskData } -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskData 'server.log') -RedirectStandardError (Join-Path $taskData 'server-error.log')
Set-Content -LiteralPath $taskPidFile -Value $taskProcess.Id -Encoding ascii
Start-Sleep -Milliseconds 700
if ($taskProcess.HasExited) { throw "Films exited. Inspect $taskData\server-error.log" }
Write-Output "Films started (PID $($taskProcess.Id)): http://localhost:$Port/"
