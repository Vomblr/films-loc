#requires -Version 7.4
$ErrorActionPreference = 'Stop'
$taskShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Films.loc.lnk'
if (Test-Path -LiteralPath $taskShortcutPath) { throw 'Films.loc.lnk already exists; inspect it before replacing it.' }
$taskShell = New-Object -ComObject WScript.Shell
$taskShortcut = $taskShell.CreateShortcut($taskShortcutPath)
$taskShortcut.TargetPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
$taskShortcut.Arguments = '-NoProfile -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'Start-Films.ps1') + '"'
$taskShortcut.WorkingDirectory = $PSScriptRoot
$taskShortcut.WindowStyle = 7
$taskShortcut.Description = 'Start the home Films.loc server after sign-in'
$taskShortcut.Save()
Write-Output "Created current-user startup shortcut: $taskShortcutPath"
