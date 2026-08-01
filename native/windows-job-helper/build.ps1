param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("preflight", "test-managed", "test-kernel", "verify", "update-artifact", "test")]
    [string]$Action,
    [string]$Filter = "",
    [string]$InternalNodePath = "",
    [string]$InternalHarnessPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$nativeRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$configuration = Get-Content -LiteralPath (Join-Path $nativeRoot "build.config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$protocol = Get-Content -LiteralPath (Join-Path $nativeRoot "protocol.v1.json") -Raw -Encoding UTF8 | ConvertFrom-Json

function Assert-ExactKeys {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Expected,
        [string]$FailureMessage = "windows-native-helper: invalid protocol contract"
    )

    if ($null -eq $Value) {
        throw $FailureMessage
    }
    $actual = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    if (($actual -join "`n") -cne ($Expected -join "`n")) {
        throw $FailureMessage
    }
}

function Assert-ProtocolInteger {
    param([Parameter(Mandatory = $true)]$Value)

    if ($Value -isnot [int] -and $Value -isnot [long]) {
        throw "windows-native-helper: invalid protocol contract"
    }
    return [int64]$Value
}

$invalidBuildContract = "windows-native-helper: invalid native build contract"
Assert-ExactKeys -Value $configuration -Expected @(
    "schemaVersion", "targetFramework", "configuration", "platform",
    "compilerArguments", "references", "pathMap", "sourceSets", "output",
    "generatedProtocolConstants"
) -FailureMessage $invalidBuildContract
Assert-ExactKeys -Value $configuration.pathMap -Expected @(
    "sourceRoot", "virtualRoot"
) -FailureMessage $invalidBuildContract
Assert-ExactKeys -Value $configuration.output -Expected @(
    "root", "repositoryOutputsForbidden"
) -FailureMessage $invalidBuildContract
Assert-ExactKeys -Value $configuration.generatedProtocolConstants -Expected @(
    "relativePath", "sha256"
) -FailureMessage $invalidBuildContract
Assert-ExactKeys -Value $configuration.sourceSets -Expected @(
    "preflight", "production", "managedTests", "kernelTests", "fixtures"
) -FailureMessage $invalidBuildContract

$expectedGeneratedRelativePath = "generated/ProtocolV1.g.cs"
$expectedGeneratedSha256 = "0611bac55aeb67c5aa0bad23bd23e4cd6503fd56495d0d5d9b13f6d61a357d04"
$expectedCompilerArguments = @(
    "/noconfig", "/nostdlib+", "/target:exe", "/platform:x64", "/optimize+", "/debug-",
    "/deterministic+", "/checked+", "/unsafe-", "/langversion:latest", "/utf8output", "/filealign:512"
)
$expectedReferences = @("mscorlib.dll", "System.dll", "System.Core.dll")
if (
    $configuration.schemaVersion -ne 1 -or
    $configuration.targetFramework -cne "net48" -or
    $configuration.configuration -cne "Release" -or
    $configuration.platform -cne "x64" -or
    $configuration.pathMap.sourceRoot -cne "native/windows-job-helper" -or
    $configuration.pathMap.virtualRoot -cne "/_/native/windows-job-helper" -or
    $configuration.output.root -cne "system-temp" -or
    $configuration.output.repositoryOutputsForbidden -isnot [bool] -or
    -not $configuration.output.repositoryOutputsForbidden -or
    $configuration.generatedProtocolConstants.relativePath -cne $expectedGeneratedRelativePath -or
    $configuration.generatedProtocolConstants.sha256 -cne $expectedGeneratedSha256 -or
    ([string[]]$configuration.compilerArguments -join "`n") -cne ($expectedCompilerArguments -join "`n") -or
    ([string[]]$configuration.references -join "`n") -cne ($expectedReferences -join "`n")
) {
    throw $invalidBuildContract
}
foreach ($reference in [string[]]$configuration.references) {
    if (
        [string]::IsNullOrEmpty($reference) -or
        [System.IO.Path]::GetFileName($reference) -cne $reference -or
        -not ($reference -cmatch '^[A-Za-z0-9][A-Za-z0-9.]*\.dll$')
    ) {
        throw $invalidBuildContract
    }
}
if ($protocol.schemaVersion -ne 1) {
    throw $invalidBuildContract
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
        [string[]]$ActionOutputNames = @(),
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
        $validOutputNames = @(
            "Fd3Preflight.exe", "ManagedTests.exe", "KernelTests.exe",
            "KernelFixture.exe", "WindowsJobHelper.exe"
        )
        foreach ($actionOutputName in $ActionOutputNames) {
            if ($validOutputNames -cnotcontains $actionOutputName) {
                throw "unsafe action output name"
            }
            [void]$allowedFiles.Add(
                [System.IO.Path]::GetFullPath((Join-Path $generatedDirectory $actionOutputName))
            )
        }
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
        "schemaVersion", "mode", "frame", "limits", "messageType", "reason", "stage"
    )
    Assert-ExactKeys -Value $Contract.mode -Expected @("control", "probe")
    Assert-ExactKeys -Value $Contract.frame -Expected @("magic", "version", "headerBytes", "maxPayloadBytes")
    Assert-ExactKeys -Value $Contract.limits -Expected @(
        "maxStringBytes", "maxArgCount", "maxNativeCommandLineUtf16UnitsIncludingNul"
    )
    Assert-ExactKeys -Value $Contract.messageType -Expected @(
        "launchConfig", "ready", "terminate", "error", "exit"
    )
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
        "        internal const int MaxNativeCommandLineUtf16UnitsIncludingNul = $(Assert-ProtocolInteger $Contract.limits.maxNativeCommandLineUtf16UnitsIncludingNul);",
        "        internal const int MessageLaunchConfig = $(Assert-ProtocolInteger $Contract.messageType.launchConfig);",
        "        internal const int MessageReady = $(Assert-ProtocolInteger $Contract.messageType.ready);",
        "        internal const int MessageTerminate = $(Assert-ProtocolInteger $Contract.messageType.terminate);",
        "        internal const int MessageError = $(Assert-ProtocolInteger $Contract.messageType.error);",
        "        internal const int MessageExit = $(Assert-ProtocolInteger $Contract.messageType.exit);",
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

$resolvedNativeSource = [System.IO.Path]::GetFullPath($nativeRoot)
$outputNames = @()
if ($Action -eq "preflight") {
    $outputNames = @("Fd3Preflight.exe")
}
elseif ($Action -eq "test-managed") {
    $outputNames = @("ManagedTests.exe")
}
elseif ($Action -eq "test-kernel") {
    $outputNames = @("KernelFixture.exe", "WindowsJobHelper.exe", "KernelTests.exe")
}
$outputNames = @([string[]]$outputNames)
$outputName = if ($outputNames.Count -gt 0) { $outputNames[$outputNames.Count - 1] } else { "" }
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

# Restore remains ahead of action/source availability checks so the exclusive
# build-root cleanup contract is exercised on every accepted action.
& (Join-Path $nativeRoot "restore-toolchain.ps1") | Out-Null

function Get-ValidatedSourceSet {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Directory
    )

    $property = $configuration.sourceSets.PSObject.Properties[$Name]
    if ($null -eq $property) {
        throw "windows-native-helper: invalid native build contract"
    }
    $values = @([string[]]$property.Value)
    if ($values.Count -eq 0) {
        throw "windows-native-helper: invalid native build contract"
    }
    $seen = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::Ordinal
    )
    foreach ($value in $values) {
        if (
            [string]::IsNullOrEmpty($value) -or
            -not ($value -cmatch ('^' + [regex]::Escape($Directory) + '/[A-Za-z0-9][A-Za-z0-9.-]*\.cs$')) -or
            -not $seen.Add($value)
        ) {
            throw "windows-native-helper: invalid native build contract"
        }
    }
    for ($index = 1; $index -lt $values.Count; $index += 1) {
        if ([string]::CompareOrdinal($values[$index - 1], $values[$index]) -ge 0) {
            throw "windows-native-helper: invalid native build contract"
        }
    }
    return [string[]]$values
}

$preflightSources = Get-ValidatedSourceSet -Name "preflight" -Directory "src"
$productionSources = Get-ValidatedSourceSet -Name "production" -Directory "src"
$managedTestSources = Get-ValidatedSourceSet -Name "managedTests" -Directory "tests"
$kernelTestSources = Get-ValidatedSourceSet -Name "kernelTests" -Directory "tests"
$fixtureSources = Get-ValidatedSourceSet -Name "fixtures" -Directory "fixtures"

$selectedSources = @()
if ($Action -eq "preflight") {
    $selectedSources = $preflightSources
}
elseif ($Action -eq "test-managed") {
    if (
        -not [string]::IsNullOrEmpty($Filter) -and
        $Filter -cne "Protocol" -and
        $Filter -cne "CommandLine" -and
        $Filter -cne "ControlChannel" -and
        $Filter -cne "LifecycleMachine" -and
        $Filter -cne "SessionCoordinator"
    ) {
        throw "windows-native-helper: unsupported managed test filter"
    }
    $selectedSources = @($productionSources) + @($managedTestSources)
}
elseif ($Action -eq "test-kernel") {
    if (-not [string]::IsNullOrEmpty($Filter)) {
        throw "windows-native-helper: unsupported kernel test filter"
    }
    $selectedSources = @($productionSources) + @($kernelTestSources)
}
else {
    # Later tasks populate kernel, artifact, and aggregate actions.
    throw "windows-native-helper: native sources are not available for this action"
}

$sourcePrefix = $resolvedNativeSource.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
) + [System.IO.Path]::DirectorySeparatorChar
$sourcesToResolve = @($selectedSources)
if ($Action -eq "test-kernel") {
    $sourcesToResolve += @($fixtureSources)
}
$sourcePathsByRelative = @{}
foreach ($relativeSource in $sourcesToResolve) {
    $unresolvedSourcePath = Join-Path $nativeRoot $relativeSource
    if (-not (Test-Path -LiteralPath $unresolvedSourcePath -PathType Leaf)) {
        throw "windows-native-helper: native sources are not available for this action"
    }
    $sourcePath = Assert-NoReparseExistingPath -Path $unresolvedSourcePath
    if (-not $sourcePath.StartsWith($sourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "windows-native-helper: native source escaped its root"
    }
    $sourcePathsByRelative.Add($relativeSource, $sourcePath)
}
$sourcePaths = [System.Collections.Generic.List[string]]::new()
foreach ($relativeSource in $selectedSources) {
    $sourcePaths.Add([string]$sourcePathsByRelative[$relativeSource])
}

$toolchainPackageRoot = Join-Path $helperRoot "toolchain-v1\packages"
$compilerPath = Assert-NoReparseExistingPath -Path (
    Join-Path $toolchainPackageRoot "microsoft.net.compilers.toolset.4.14.0\tasks\net472\csc.exe"
)
$referenceRoot = Assert-NoReparseExistingPath -Path (
    Join-Path $toolchainPackageRoot "microsoft.netframework.referenceassemblies.net48.1.0.3\build\.NETFramework\v4.8"
)
$referencePrefix = $referenceRoot.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
) + [System.IO.Path]::DirectorySeparatorChar
$resolvedReferences = [System.Collections.Generic.List[string]]::new()
foreach ($reference in [string[]]$configuration.references) {
    $referencePath = [System.IO.Path]::GetFullPath((Join-Path $referenceRoot $reference))
    if (
        -not $referencePath.StartsWith(
            $referencePrefix,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        [System.IO.Path]::GetFileName($referencePath) -cne $reference
    ) {
        throw $invalidBuildContract
    }
    $resolvedReferences.Add((Assert-NoReparseExistingPath -Path $referencePath))
}
$nativeOutput = [System.IO.Path]::GetFullPath((Join-Path $generatedDirectory $outputName))

if ($Action -eq "test-kernel") {
    $fixtureOutput = [System.IO.Path]::GetFullPath((Join-Path $generatedDirectory "KernelFixture.exe"))
    $fixtureCompilerArguments = [System.Collections.Generic.List[string]]::new()
    foreach ($argument in $expectedCompilerArguments) {
        $fixtureCompilerArguments.Add($argument)
    }
    $fixtureCompilerArguments.Add($pathMap)
    $fixtureCompilerArguments.Add("/out:" + $fixtureOutput)
    $fixtureCompilerArguments.Add("/main:CodexAgentTools.WindowsJobHelper.Fixtures.KernelFixture")
    foreach ($referencePath in $resolvedReferences) {
        $fixtureCompilerArguments.Add("/reference:" + $referencePath)
    }
    $fixtureCompilerArguments.Add($generatedPath)
    foreach ($relativeFixture in $fixtureSources) {
        $fixtureCompilerArguments.Add([string]$sourcePathsByRelative[$relativeFixture])
    }
    $fixtureCompilerOutput = & $compilerPath @fixtureCompilerArguments 2>&1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $fixtureOutput -PathType Leaf)) {
        if ($fixtureCompilerOutput) {
            $fixtureCompilerOutput | Write-Output
        }
        throw "windows-native-helper: native kernel fixture compilation failed"
    }
    [void](Assert-NoReparseExistingPath -Path $fixtureOutput)

    $helperOutput = [System.IO.Path]::GetFullPath((Join-Path $generatedDirectory "WindowsJobHelper.exe"))
    $helperCompilerArguments = [System.Collections.Generic.List[string]]::new()
    foreach ($argument in $expectedCompilerArguments) {
        $helperCompilerArguments.Add($argument)
    }
    $helperCompilerArguments.Add($pathMap)
    $helperCompilerArguments.Add("/out:" + $helperOutput)
    $helperCompilerArguments.Add("/main:CodexAgentTools.WindowsJobHelper.Program")
    foreach ($referencePath in $resolvedReferences) {
        $helperCompilerArguments.Add("/reference:" + $referencePath)
    }
    $helperCompilerArguments.Add($generatedPath)
    foreach ($relativeProduction in $productionSources) {
        $helperCompilerArguments.Add([string]$sourcePathsByRelative[$relativeProduction])
    }
    $helperCompilerOutput = & $compilerPath @helperCompilerArguments 2>&1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $helperOutput -PathType Leaf)) {
        if ($helperCompilerOutput) {
            $helperCompilerOutput | Write-Output
        }
        throw "windows-native-helper: production helper compilation failed"
    }
    [void](Assert-NoReparseExistingPath -Path $helperOutput)
}

$compilerArguments = [System.Collections.Generic.List[string]]::new()
foreach ($argument in $expectedCompilerArguments) {
    $compilerArguments.Add($argument)
}
$compilerArguments.Add($pathMap)
$compilerArguments.Add("/out:" + $nativeOutput)
if ($Action -eq "test-managed") {
    $compilerArguments.Add("/main:CodexAgentTools.WindowsJobHelper.Tests.TestRunner")
}
elseif ($Action -eq "test-kernel") {
    $compilerArguments.Add("/main:CodexAgentTools.WindowsJobHelper.Tests.KernelTestRunner")
}
foreach ($referencePath in $resolvedReferences) {
    $compilerArguments.Add("/reference:" + $referencePath)
}
$compilerArguments.Add($generatedPath)
foreach ($sourcePath in $sourcePaths) {
    $compilerArguments.Add($sourcePath)
}

$compilerOutput = & $compilerPath @compilerArguments 2>&1
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $nativeOutput -PathType Leaf)) {
    if ($compilerOutput) {
        $compilerOutput | Write-Output
    }
    if ($Action -eq "preflight") {
        throw "windows-native-helper: native preflight compilation failed"
    }
    if ($Action -eq "test-kernel") {
        throw "windows-native-helper: native kernel compilation failed"
    }
    throw "windows-native-helper: native managed compilation failed"
}
[void](Assert-NoReparseExistingPath -Path $nativeOutput)

if ($Action -eq "test-managed") {
    $managedArguments = @()
    if (-not [string]::IsNullOrEmpty($Filter)) {
        $managedArguments = @("--filter", $Filter)
    }
    & $nativeOutput @managedArguments
    if ($LASTEXITCODE -ne 0) {
        throw "windows-native-helper: managed tests failed"
    }
    return
}

if ($Action -eq "test-kernel") {
    $expectedCarrierHarness = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Directory]::GetParent($nativeRoot).Parent.FullName) "scripts\windows-native-helper.mjs"))
    if (
        [string]::IsNullOrEmpty($InternalNodePath) -or
        [string]::IsNullOrEmpty($InternalHarnessPath) -or
        -not [System.IO.Path]::GetFullPath($InternalHarnessPath).Equals(
            $expectedCarrierHarness,
            [System.StringComparison]::OrdinalIgnoreCase)
    ) {
        throw "windows-native-helper: invalid production carrier harness"
    }
    $carrierNodePath = Assert-NoReparseExistingPath -Path $InternalNodePath
    $carrierHarnessPath = Assert-NoReparseExistingPath -Path $InternalHarnessPath
    $env:CODEX_WINDOWS_NATIVE_CRASH_INTERNAL = "1"
    try {
        & $nativeOutput $fixtureOutput $carrierNodePath $carrierHarnessPath $helperOutput
        if ($LASTEXITCODE -ne 0) {
            throw "windows-native-helper: kernel tests failed"
        }
    }
    finally {
        Remove-Item Env:CODEX_WINDOWS_NATIVE_CRASH_INTERNAL -ErrorAction SilentlyContinue
    }
    $env:CODEX_WINDOWS_NATIVE_CARRIER_INTERNAL = "1"
    try {
        & $carrierNodePath $carrierHarnessPath "__production-carrier-v1" $helperOutput $fixtureOutput
        if ($LASTEXITCODE -ne 0) {
            throw "windows-native-helper: production carrier failed"
        }
    }
    finally {
        Remove-Item Env:CODEX_WINDOWS_NATIVE_CARRIER_INTERNAL -ErrorAction SilentlyContinue
    }
    return
}

$expectedHarness = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Directory]::GetParent($nativeRoot).Parent.FullName) "scripts\windows-native-helper.mjs"))
if (
    [string]::IsNullOrEmpty($InternalNodePath) -or
    [string]::IsNullOrEmpty($InternalHarnessPath) -or
    -not [System.IO.Path]::GetFullPath($InternalHarnessPath).Equals($expectedHarness, [System.StringComparison]::OrdinalIgnoreCase)
) {
    throw "windows-native-helper: invalid preflight harness"
}
$nodePath = Assert-NoReparseExistingPath -Path $InternalNodePath
$harnessPath = Assert-NoReparseExistingPath -Path $InternalHarnessPath
$env:CODEX_WINDOWS_NATIVE_PREFLIGHT_INTERNAL = "1"
try {
    & $nodePath $harnessPath "__preflight-harness-v1" $nativeOutput
    if ($LASTEXITCODE -ne 0) {
        throw "windows-native-helper: fd3 preflight failed"
    }
}
finally {
    Remove-Item Env:CODEX_WINDOWS_NATIVE_PREFLIGHT_INTERNAL -ErrorAction SilentlyContinue
}
}
finally {
    Remove-ExclusiveBuildRoot `
        -BuildRoot $buildRoot `
        -BuildBase $buildBase `
        -ActionOutputNames $outputNames `
        -TemporaryGenerated $temporaryGenerated
}
