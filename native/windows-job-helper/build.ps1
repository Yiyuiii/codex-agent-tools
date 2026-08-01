param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("preflight", "preflight-current", "test-managed", "test-kernel", "verify", "update-artifact", "test")]
    [string]$Action,
    [string]$Filter = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$nativeRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$configuration = Get-Content -LiteralPath (Join-Path $nativeRoot "build.config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$protocol = Get-Content -LiteralPath (Join-Path $nativeRoot "protocol.v1.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ($configuration.schemaVersion -ne 1 -or $protocol.schemaVersion -ne 1) {
    throw "windows-native-helper: invalid native build contract"
}
if ($configuration.output.root -cne "system-temp" -or -not $configuration.output.repositoryOutputsForbidden) {
    throw "windows-native-helper: invalid native output policy"
}

function Assert-ExactKeys {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Expected
    )

    if ($null -eq $Value) {
        throw "windows-native-helper: invalid protocol contract"
    }
    $actual = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    if (($actual -join "`n") -cne ($Expected -join "`n")) {
        throw "windows-native-helper: invalid protocol contract"
    }
}

function Assert-ProtocolInteger {
    param([Parameter(Mandatory = $true)]$Value)

    if ($Value -isnot [int] -and $Value -isnot [long]) {
        throw "windows-native-helper: invalid protocol contract"
    }
    return [int64]$Value
}

function Assert-NoReparseExistingPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolved = [System.IO.Path]::GetFullPath($Path)
    $pathRoot = [System.IO.Path]::GetPathRoot($resolved)
    $current = $pathRoot.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    if (Test-Path -LiteralPath $current) {
        $rootItem = Get-Item -LiteralPath $current -Force
        if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "windows-native-helper: native path contains a reparse point"
        }
    }
    $relative = $resolved.Substring($pathRoot.Length)
    foreach ($segment in $relative.Split(@(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ), [System.StringSplitOptions]::RemoveEmptyEntries)) {
        $current = Join-Path $current $segment
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "windows-native-helper: native path contains a reparse point"
            }
        }
    }
    return $resolved
}

function New-VerifiedDirectoryChild {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Name
    )

    [void](Assert-NoReparseExistingPath -Path $Parent)
    $resolvedParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $child = [System.IO.Path]::GetFullPath((Join-Path $resolvedParent $Name))
    $prefix = $resolvedParent + [System.IO.Path]::DirectorySeparatorChar
    if (-not $child.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "windows-native-helper: native directory escaped its parent"
    }
    if (Test-Path -LiteralPath $child) {
        $item = Get-Item -LiteralPath $child -Force
        if (-not $item.PSIsContainer) {
            throw "windows-native-helper: native directory path is not a directory"
        }
    }
    else {
        $item = New-Item -Path $child -ItemType Directory -ErrorAction Stop
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "windows-native-helper: native path contains a reparse point"
    }
    return $child
}

function Remove-ExclusiveBuildRoot {
    param(
        [Parameter(Mandatory = $true)][string]$BuildRoot,
        [Parameter(Mandatory = $true)][string]$BuildBase,
        [string]$TemporaryGenerated = ""
    )

    try {
        $resolvedBase = (Assert-NoReparseExistingPath -Path $BuildBase).TrimEnd(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        )
        $resolvedRoot = Assert-NoReparseExistingPath -Path $BuildRoot
        $rootParent = [System.IO.Directory]::GetParent($resolvedRoot)
        if (
            $null -eq $rootParent -or
            -not $rootParent.FullName.Equals($resolvedBase, [System.StringComparison]::OrdinalIgnoreCase) -or
            -not ([System.IO.Path]::GetFileName($resolvedRoot) -cmatch '^[0-9a-f]{32}$') -or
            -not (Test-Path -LiteralPath $resolvedRoot -PathType Container)
        ) {
            throw "unsafe build root"
        }
        $rootItem = Get-Item -LiteralPath $resolvedRoot -Force
        if (
            -not $rootItem.PSIsContainer -or
            ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        ) {
            throw "unsafe build root"
        }

        $generatedDirectory = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot "generated"))
        $generatedPath = [System.IO.Path]::GetFullPath((Join-Path $generatedDirectory "ProtocolV1.g.cs"))
        $allowedFiles = [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::OrdinalIgnoreCase
        )
        [void]$allowedFiles.Add($generatedPath)
        if ($TemporaryGenerated.Length -gt 0) {
            $resolvedTemporaryGenerated = [System.IO.Path]::GetFullPath($TemporaryGenerated)
            $temporaryParent = [System.IO.Directory]::GetParent($resolvedTemporaryGenerated)
            if (
                $null -eq $temporaryParent -or
                -not $temporaryParent.FullName.Equals(
                    $generatedDirectory,
                    [System.StringComparison]::OrdinalIgnoreCase
                ) -or
                -not ([System.IO.Path]::GetFileName($resolvedTemporaryGenerated) -cmatch '^\.ProtocolV1\.[0-9a-f]{32}\.tmp$')
            ) {
                throw "unsafe generated temporary path"
            }
            [void]$allowedFiles.Add($resolvedTemporaryGenerated)
        }

        # Validate the complete cleanup tree before deleting anything. Unexpected
        # files, directories, and reparse points are evidence and remain intact.
        foreach ($rootChild in Get-ChildItem -LiteralPath $resolvedRoot -Force) {
            if (
                -not $rootChild.FullName.Equals($generatedDirectory, [System.StringComparison]::OrdinalIgnoreCase) -or
                -not $rootChild.PSIsContainer -or
                ($rootChild.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
            ) {
                throw "unexpected native build cleanup item"
            }
            foreach ($generatedChild in Get-ChildItem -LiteralPath $generatedDirectory -Force) {
                if (
                    $generatedChild.PSIsContainer -or
                    ($generatedChild.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                    -not $allowedFiles.Contains($generatedChild.FullName)
                ) {
                    throw "unexpected native build cleanup item"
                }
            }
        }

        # Reassert the complete ancestor chain immediately before mutation. Every
        # delete names one known file or one already-empty directory; no recursive
        # operation can follow a directory replacement outside this build root.
        [void](Assert-NoReparseExistingPath -Path $resolvedBase)
        [void](Assert-NoReparseExistingPath -Path $resolvedRoot)
        foreach ($allowedFile in $allowedFiles) {
            if (Test-Path -LiteralPath $allowedFile) {
                [void](Assert-NoReparseExistingPath -Path $allowedFile)
                $allowedItem = Get-Item -LiteralPath $allowedFile -Force
                if (
                    $allowedItem.PSIsContainer -or
                    ($allowedItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
                ) {
                    throw "unexpected native build cleanup item"
                }
                [System.IO.File]::Delete($allowedFile)
            }
        }
        if (Test-Path -LiteralPath $generatedDirectory) {
            [void](Assert-NoReparseExistingPath -Path $generatedDirectory)
            [System.IO.Directory]::Delete($generatedDirectory, $false)
        }
        [void](Assert-NoReparseExistingPath -Path $resolvedRoot)
        [System.IO.Directory]::Delete($resolvedRoot, $false)
    }
    catch {
        throw "windows-native-helper: native build cleanup failed"
    }
}

function Get-GeneratedProtocolConstants {
    param([Parameter(Mandatory = $true)]$Contract)

    Assert-ExactKeys -Value $Contract -Expected @(
        "schemaVersion", "mode", "frame", "limits", "messageType", "invocationKind", "reason", "stage"
    )
    Assert-ExactKeys -Value $Contract.mode -Expected @("control", "probe")
    Assert-ExactKeys -Value $Contract.frame -Expected @("magic", "version", "headerBytes", "maxPayloadBytes")
    Assert-ExactKeys -Value $Contract.limits -Expected @(
        "maxStringBytes", "maxArgCount", "maxCmdUtf16UnitsIncludingNul"
    )
    Assert-ExactKeys -Value $Contract.messageType -Expected @(
        "launchConfig", "ready", "terminate", "error", "exit"
    )
    Assert-ExactKeys -Value $Contract.invocationKind -Expected @("native", "cmd")
    Assert-ExactKeys -Value $Contract.reason -Expected @(
        "noneOrRootExit", "cancelled", "timedOut", "sessionShutdown", "protocolError"
    )
    Assert-ExactKeys -Value $Contract.stage -Expected @(
        "protocolInvalid", "cancelledBeforeReady", "jobCreateFailed", "jobConfigFailed",
        "stdioDuplicateFailed", "attributeListInitFailed", "handleListAttributeFailed",
        "jobListAttributeFailed", "commandLineInvalid", "createFailed", "resumeFailed",
        "terminateJobFailed", "queryJobFailed", "controlChannelFailed", "helperInternal", "waitFailed"
    )
    if ($Contract.schemaVersion -ne 1) {
        throw "windows-native-helper: invalid protocol contract"
    }

    $lines = @(
        "// <auto-generated />",
        "namespace CodexAgentTools.WindowsJobHelper",
        "{",
        "    internal static class ProtocolV1",
        "    {",
        "        internal const string ControlMode = `"$($Contract.mode.control)`";",
        "        internal const string ProbeMode = `"$($Contract.mode.probe)`";",
        "        internal const string Magic = `"$($Contract.frame.magic)`";",
        "        internal const int Version = $(Assert-ProtocolInteger $Contract.frame.version);",
        "        internal const int HeaderBytes = $(Assert-ProtocolInteger $Contract.frame.headerBytes);",
        "        internal const int MaxPayloadBytes = $(Assert-ProtocolInteger $Contract.frame.maxPayloadBytes);",
        "        internal const int MaxStringBytes = $(Assert-ProtocolInteger $Contract.limits.maxStringBytes);",
        "        internal const int MaxArgCount = $(Assert-ProtocolInteger $Contract.limits.maxArgCount);",
        "        internal const int MaxCmdUtf16UnitsIncludingNul = $(Assert-ProtocolInteger $Contract.limits.maxCmdUtf16UnitsIncludingNul);",
        "        internal const int MessageLaunchConfig = $(Assert-ProtocolInteger $Contract.messageType.launchConfig);",
        "        internal const int MessageReady = $(Assert-ProtocolInteger $Contract.messageType.ready);",
        "        internal const int MessageTerminate = $(Assert-ProtocolInteger $Contract.messageType.terminate);",
        "        internal const int MessageError = $(Assert-ProtocolInteger $Contract.messageType.error);",
        "        internal const int MessageExit = $(Assert-ProtocolInteger $Contract.messageType.exit);",
        "        internal const int InvocationNative = $(Assert-ProtocolInteger $Contract.invocationKind.native);",
        "        internal const int InvocationCmd = $(Assert-ProtocolInteger $Contract.invocationKind.cmd);",
        "        internal const int ReasonNoneOrRootExit = $(Assert-ProtocolInteger $Contract.reason.noneOrRootExit);",
        "        internal const int ReasonCancelled = $(Assert-ProtocolInteger $Contract.reason.cancelled);",
        "        internal const int ReasonTimedOut = $(Assert-ProtocolInteger $Contract.reason.timedOut);",
        "        internal const int ReasonSessionShutdown = $(Assert-ProtocolInteger $Contract.reason.sessionShutdown);",
        "        internal const int ReasonProtocolError = $(Assert-ProtocolInteger $Contract.reason.protocolError);",
        "        internal const int StageProtocolInvalid = $(Assert-ProtocolInteger $Contract.stage.protocolInvalid);",
        "        internal const int StageCancelledBeforeReady = $(Assert-ProtocolInteger $Contract.stage.cancelledBeforeReady);",
        "        internal const int StageJobCreateFailed = $(Assert-ProtocolInteger $Contract.stage.jobCreateFailed);",
        "        internal const int StageJobConfigFailed = $(Assert-ProtocolInteger $Contract.stage.jobConfigFailed);",
        "        internal const int StageStdioDuplicateFailed = $(Assert-ProtocolInteger $Contract.stage.stdioDuplicateFailed);",
        "        internal const int StageAttributeListInitFailed = $(Assert-ProtocolInteger $Contract.stage.attributeListInitFailed);",
        "        internal const int StageHandleListAttributeFailed = $(Assert-ProtocolInteger $Contract.stage.handleListAttributeFailed);",
        "        internal const int StageJobListAttributeFailed = $(Assert-ProtocolInteger $Contract.stage.jobListAttributeFailed);",
        "        internal const int StageCommandLineInvalid = $(Assert-ProtocolInteger $Contract.stage.commandLineInvalid);",
        "        internal const int StageCreateFailed = $(Assert-ProtocolInteger $Contract.stage.createFailed);",
        "        internal const int StageResumeFailed = $(Assert-ProtocolInteger $Contract.stage.resumeFailed);",
        "        internal const int StageTerminateJobFailed = $(Assert-ProtocolInteger $Contract.stage.terminateJobFailed);",
        "        internal const int StageQueryJobFailed = $(Assert-ProtocolInteger $Contract.stage.queryJobFailed);",
        "        internal const int StageControlChannelFailed = $(Assert-ProtocolInteger $Contract.stage.controlChannelFailed);",
        "        internal const int StageHelperInternal = $(Assert-ProtocolInteger $Contract.stage.helperInternal);",
        "        internal const int StageWaitFailed = $(Assert-ProtocolInteger $Contract.stage.waitFailed);",
        "    }",
        "}",
        ""
    )
    return [System.Text.UTF8Encoding]::new($false).GetBytes(($lines -join "`n"))
}

$expectedCompilerArguments = @(
    "/noconfig", "/nostdlib+", "/target:exe", "/platform:x64", "/optimize+", "/debug-",
    "/deterministic+", "/checked+", "/unsafe-", "/langversion:latest", "/utf8output", "/filealign:512"
)
if (([string[]]$configuration.compilerArguments -join "`n") -cne ($expectedCompilerArguments -join "`n")) {
    throw "windows-native-helper: invalid compiler arguments"
}

$resolvedNativeSource = [System.IO.Path]::GetFullPath($nativeRoot)
$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
[void](Assert-NoReparseExistingPath -Path $temporaryRoot)
$productRoot = New-VerifiedDirectoryChild -Parent $temporaryRoot -Name "codex-agent-tools"
$helperRoot = New-VerifiedDirectoryChild -Parent $productRoot -Name "windows-job-helper"
$buildBase = New-VerifiedDirectoryChild -Parent $helperRoot -Name "build-v1"
$buildRoot = $null
for ($attempt = 0; $attempt -lt 16 -and $null -eq $buildRoot; $attempt += 1) {
    $candidate = Join-Path $buildBase ([System.Guid]::NewGuid().ToString("N"))
    try {
        $item = New-Item -Path $candidate -ItemType Directory -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "windows-native-helper: native path contains a reparse point"
        }
        $buildRoot = [System.IO.Path]::GetFullPath($item.FullName)
    }
    catch [System.IO.IOException] {
        if (-not (Test-Path -LiteralPath $candidate)) {
            throw
        }
    }
}
if ($null -eq $buildRoot) {
    throw "windows-native-helper: could not create an exclusive native build directory"
}
$temporaryGenerated = ""

try {

Assert-ExactKeys -Value $configuration.generatedProtocolConstants -Expected @("relativePath", "sha256")
$expectedGeneratedRelativePath = "generated/ProtocolV1.g.cs"
$expectedGeneratedSha256 = "83f6475ea08f51d713da8e27e2b85edba6d9714b467ac592906fc792ca17882d"
if (
    $configuration.generatedProtocolConstants.relativePath -cne $expectedGeneratedRelativePath -or
    $configuration.generatedProtocolConstants.sha256 -cne $expectedGeneratedSha256
) {
    throw "windows-native-helper: invalid native build contract"
}

try {
    $generatedBytes = Get-GeneratedProtocolConstants -Contract $protocol
}
catch {
    throw "windows-native-helper: invalid protocol contract"
}
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $generatedDigest = ([System.BitConverter]::ToString($sha256.ComputeHash($generatedBytes))).Replace("-", "").ToLowerInvariant()
}
finally {
    $sha256.Dispose()
}
if ($generatedDigest -cne $expectedGeneratedSha256) {
    throw "windows-native-helper: invalid protocol contract"
}

$generatedPath = [System.IO.Path]::GetFullPath((Join-Path $buildRoot $expectedGeneratedRelativePath))
$buildPrefix = $buildRoot.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
) + [System.IO.Path]::DirectorySeparatorChar
if (-not $generatedPath.StartsWith($buildPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "windows-native-helper: generated protocol source escaped the build directory"
}
$generatedDirectory = New-VerifiedDirectoryChild -Parent $buildRoot -Name "generated"
$temporaryGenerated = Join-Path $generatedDirectory (
    ".ProtocolV1." + [System.Guid]::NewGuid().ToString("N") + ".tmp"
)
$temporaryStream = $null
try {
    $temporaryStream = [System.IO.FileStream]::new(
        $temporaryGenerated,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    $temporaryStream.Write($generatedBytes, 0, $generatedBytes.Length)
    $temporaryStream.Flush($true)
    $temporaryStream.Dispose()
    $temporaryStream = $null
    if (Test-Path -LiteralPath $generatedPath) {
        throw "windows-native-helper: generated protocol destination already exists"
    }
    [System.IO.File]::Move($temporaryGenerated, $generatedPath)
}
finally {
    if ($null -ne $temporaryStream) {
        $temporaryStream.Dispose()
    }
}
if ((Get-FileHash -LiteralPath $generatedPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedGeneratedSha256) {
    throw "windows-native-helper: generated protocol source verification failed"
}
Write-Output "windows-native-helper: generated protocol constants verified"

$pathMap = "/pathmap:" + $resolvedNativeSource + "=" + [string]$configuration.pathMap.virtualRoot
if ($pathMap -notlike "/pathmap:*=/_/native/windows-job-helper") {
    throw "windows-native-helper: invalid native path map"
}

& (Join-Path $nativeRoot "restore-toolchain.ps1") | Out-Null

# Task 1 freezes the deterministic inputs. Later tasks populate the fixed source
# sets and add the corresponding managed/kernel build actions.
throw "windows-native-helper: native sources are not available for this action"
}
finally {
    Remove-ExclusiveBuildRoot `
        -BuildRoot $buildRoot `
        -BuildBase $buildBase `
        -TemporaryGenerated $temporaryGenerated
}
