[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [ValidateRange(1024, 65535)]
    [int]$Port = 4173,

    [string]$NodePath = "node.exe"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$serverPath = Join-Path $resolvedRoot "preview-server.mjs"
$workerPath = Join-Path $resolvedRoot "dist\server\index.js"
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
    throw "preview-server.mjs was not found under the project root."
}
if (-not (Test-Path -LiteralPath $workerPath -PathType Leaf)) {
    throw "The local build is missing. Run npm run build before enabling the login task."
}

# preview-server.mjs also hard-codes this loopback boundary. These variables make the
# scheduled-task contract explicit and prevent a future wrapper from choosing a public host.
$env:HOST = "127.0.0.1"
$env:INTEL_OS_HOST = "127.0.0.1"
$env:PORT = [string]$Port
$env:NODE_ENV = "production"

Set-Location -LiteralPath $resolvedRoot
& $NodePath $serverPath
exit $LASTEXITCODE
