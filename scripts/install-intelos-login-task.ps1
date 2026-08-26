[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$TaskName = "IntelOS Alpha - Local Only",
    [ValidateRange(1024, 65535)]
    [int]$Port = 4173
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$starter = Join-Path $resolvedRoot "scripts\start-intelos-local.ps1"
if (-not (Test-Path -LiteralPath $starter -PathType Leaf)) {
    throw "The localhost-only startup script is missing: $starter"
}
if (-not (Test-Path -LiteralPath (Join-Path $resolvedRoot "dist\server\index.js") -PathType Leaf)) {
    throw "Run npm run build before installing the login task."
}

$powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$escapedStarter = $starter.Replace('"', '\"')
$escapedRoot = $resolvedRoot.Replace('"', '\"')
$escapedNode = $nodePath.Replace('"', '\"')
$arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$escapedStarter`" -ProjectRoot `"$escapedRoot`" -Port $Port -NodePath `"$escapedNode`""

$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $resolvedRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 6 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited
$task = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Starts IntelOS on the 127.0.0.1 loopback interface only; no browser or deployment."

if ($PSCmdlet.ShouldProcess($TaskName, "Register localhost-only IntelOS login task")) {
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
    Write-Output "Installed scheduled task '$TaskName'. It will listen only on 127.0.0.1:$Port."
}
