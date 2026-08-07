[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ExitCode = 1
$LocationPushed = $false
try {
    if ($args.Count -ne 0) {
        throw "invalid arguments"
    }
    $RepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    $EntryPoint = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "start-session.mjs"))
    $Node = Get-Command "node.exe" -CommandType Application -ErrorAction Stop
    Push-Location -LiteralPath $RepositoryRoot
    $LocationPushed = $true
    & $Node.Source $EntryPoint
    $ExitCode = $LASTEXITCODE
}
catch {
    [Console]::Error.WriteLine("host-acceptance: failed")
    $ExitCode = 1
}
finally {
    if ($LocationPushed) {
        Pop-Location
    }
}

exit $ExitCode
