param(
    [ValidateSet("test-managed", "test-kernel")]
    [string]$Action = "test-managed"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ($Action -cne "test-managed" -and $Action -cne "test-kernel") {
    throw "host-acceptance: action casing must be canonical"
}

function Resolve-RepositoryFile {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    if ([System.IO.Path]::IsPathRooted($RelativePath) -or $RelativePath.Contains("\") -or $RelativePath.Contains("..")) {
        throw "host-acceptance: invalid repository-relative build path"
    }
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $RepositoryRoot $RelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)))
    $prefix = $RepositoryRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "host-acceptance: build path escaped repository"
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "host-acceptance: required build input is unavailable"
    }
    return Assert-NoReparseExistingPath -Path $candidate
}

function Assert-NoReparseExistingPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolved = [System.IO.Path]::GetFullPath($Path)
    $pathRoot = [System.IO.Path]::GetPathRoot($resolved)
    $current = $pathRoot.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    $relative = $resolved.Substring($pathRoot.Length)
    foreach ($segment in $relative.Split(@(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ), [System.StringSplitOptions]::RemoveEmptyEntries)) {
        $current = Join-Path $current $segment
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "host-acceptance: build path contains a reparse point"
            }
        }
    }
    return $resolved
}

function Assert-ExactKeys {
    param(
        [Parameter(Mandatory = $true)]$Record,
        [Parameter(Mandatory = $true)][string[]]$Keys
    )

    $actual = @($Record.PSObject.Properties.Name | Sort-Object)
    $expected = @($Keys | Sort-Object)
    if (($actual -join "`n") -cne ($expected -join "`n")) {
        throw "host-acceptance: invalid build configuration keys"
    }
}

function ConvertTo-CSharpStringLiteral {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    $escaped = $Value.Replace('\', '\\').Replace('"', '\"')
    $escaped = $escaped.Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
    return '"' + $escaped + '"'
}

function ConvertTo-CSharpStringArray {
    param([Parameter(Mandatory = $true)]$Value)

    if ($Value -isnot [System.Array] -or $Value.Count -eq 0) {
        throw "host-acceptance: invalid observer protocol"
    }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $items = @($Value | ForEach-Object {
        if ($_ -isnot [string] -or [string]::IsNullOrEmpty($_) -or -not $seen.Add($_)) {
            throw "host-acceptance: invalid observer protocol"
        }
        ConvertTo-CSharpStringLiteral -Value $_
    })
    return "new string[] { " + ($items -join ", ") + " }"
}

function Write-GeneratedProtocolSource {
    param(
        [Parameter(Mandatory = $true)]$Protocol,
        [Parameter(Mandatory = $true)][string]$Path
    )

    Assert-ExactKeys -Record $Protocol -Keys @("schemaVersion", "protocolVersion", "descriptor", "hashDomains", "frames")
    Assert-ExactKeys -Record $Protocol.descriptor -Keys @(
        "relativePath", "maximumBytes", "packageName", "noncePattern", "pipeNamePattern",
        "completionMarkerIdPattern", "publicBetaVersionPattern", "sha256Pattern", "sha1Pattern",
        "commitPattern", "npmIntegrityPattern", "llmPattern", "minimumTimeoutMs", "fixedPaths",
        "topLevelKeys", "publicBetaKeys", "observerArtifactKeys", "artifactIdentityKeys",
        "npmKeys", "requestKeys"
    )
    Assert-ExactKeys -Record $Protocol.descriptor.fixedPaths -Keys @(
        "observerArtifact", "buildManifest", "protocol", "markerPrefix", "markerSuffix",
        "windowsJobHelper", "capabilityIndex", "currentHostFreezePrefix", "currentHostFreezeSuffix"
    )
    Assert-ExactKeys -Record $Protocol.hashDomains -Keys @("prompt", "cwd", "sessionId", "requestInput", "completionMarker")
    Assert-ExactKeys -Record $Protocol.frames -Keys @("maximumBytes", "maximumEventsPerConnection", "terminator", "keys", "mcpKeys")
    Assert-ExactKeys -Record $Protocol.frames.keys -Keys @("HELLO", "REQUEST_STARTED", "REQUEST_ABORTED", "OWNED_EXIT", "HANDLER_CANCELLED", "INFLIGHT_REMOVED")
    if (
        $Protocol.schemaVersion -isnot [int] -or
        $Protocol.protocolVersion -isnot [int] -or
        $Protocol.descriptor.maximumBytes -isnot [int] -or
        $Protocol.descriptor.minimumTimeoutMs -isnot [int] -or
        $Protocol.frames.maximumBytes -isnot [int] -or
        $Protocol.frames.maximumEventsPerConnection -isnot [int] -or
        $Protocol.schemaVersion -ne 1 -or
        $Protocol.protocolVersion -ne 1 -or
        $Protocol.descriptor.maximumBytes -lt 1 -or
        $Protocol.descriptor.minimumTimeoutMs -lt 1 -or
        $Protocol.frames.maximumBytes -lt 2 -or
        $Protocol.frames.maximumEventsPerConnection -lt 1 -or
        $Protocol.frames.terminator -cne "`n"
    ) {
        throw "host-acceptance: invalid observer protocol"
    }

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in @(
        "namespace CodexAgentTools.HostAcceptance",
        "{",
        "    internal static class ProtocolV1",
        "    {",
        "        internal const int SchemaVersion = $($Protocol.schemaVersion);",
        "        internal const int ProtocolVersion = $($Protocol.protocolVersion);",
        "        internal const int DescriptorMaximumBytes = $($Protocol.descriptor.maximumBytes);",
        "        internal const int MinimumTimeoutMs = $($Protocol.descriptor.minimumTimeoutMs);",
        "        internal const int MaximumFrameBytes = $($Protocol.frames.maximumBytes);",
        "        internal const int MaximumEventsPerConnection = $($Protocol.frames.maximumEventsPerConnection);",
        "        internal const string FrameTerminator = $(ConvertTo-CSharpStringLiteral -Value $Protocol.frames.terminator);",
        "        internal const string PackageName = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.packageName);",
        "        internal const string NoncePattern = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.noncePattern);",
        "        internal const string PipeNamePattern = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.pipeNamePattern);",
        "        internal const string CompletionMarkerIdPattern = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.completionMarkerIdPattern);",
        "        internal const string PublicBetaVersionPattern = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.publicBetaVersionPattern);",
        "        internal const string Sha256Pattern = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.sha256Pattern);",
        "        internal const string Sha1Pattern = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.sha1Pattern);",
        "        internal const string CommitPattern = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.commitPattern);",
        "        internal const string NpmIntegrityPattern = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.npmIntegrityPattern);",
        "        internal const string LlmPattern = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.llmPattern);",
        "        internal const string ObserverPath = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.fixedPaths.observerArtifact);",
        "        internal const string BuildManifestPath = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.fixedPaths.buildManifest);",
        "        internal const string ProtocolPath = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.fixedPaths.protocol);",
        "        internal const string MarkerPrefix = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.fixedPaths.markerPrefix);",
        "        internal const string MarkerSuffix = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.fixedPaths.markerSuffix);",
        "        internal const string WindowsJobHelperPath = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.fixedPaths.windowsJobHelper);",
        "        internal const string CapabilityIndexPath = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.fixedPaths.capabilityIndex);",
        "        internal const string CurrentHostFreezePrefix = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.fixedPaths.currentHostFreezePrefix);",
        "        internal const string CurrentHostFreezeSuffix = $(ConvertTo-CSharpStringLiteral -Value $Protocol.descriptor.fixedPaths.currentHostFreezeSuffix);",
        "        internal const string PromptHashDomain = $(ConvertTo-CSharpStringLiteral -Value $Protocol.hashDomains.prompt);",
        "        internal const string CwdHashDomain = $(ConvertTo-CSharpStringLiteral -Value $Protocol.hashDomains.cwd);",
        "        internal const string SessionIdHashDomain = $(ConvertTo-CSharpStringLiteral -Value $Protocol.hashDomains.sessionId);",
        "        internal const string RequestInputHashDomain = $(ConvertTo-CSharpStringLiteral -Value $Protocol.hashDomains.requestInput);",
        "        internal const string CompletionMarkerHashDomain = $(ConvertTo-CSharpStringLiteral -Value $Protocol.hashDomains.completionMarker);",
        "        internal const string HelloType = $(ConvertTo-CSharpStringLiteral -Value $Protocol.frames.keys.PSObject.Properties['HELLO'].Name);",
        "        internal const string RequestStartedType = $(ConvertTo-CSharpStringLiteral -Value $Protocol.frames.keys.PSObject.Properties['REQUEST_STARTED'].Name);",
        "        internal const string RequestAbortedType = $(ConvertTo-CSharpStringLiteral -Value $Protocol.frames.keys.PSObject.Properties['REQUEST_ABORTED'].Name);",
        "        internal const string OwnedExitType = $(ConvertTo-CSharpStringLiteral -Value $Protocol.frames.keys.PSObject.Properties['OWNED_EXIT'].Name);",
        "        internal const string HandlerCancelledType = $(ConvertTo-CSharpStringLiteral -Value $Protocol.frames.keys.PSObject.Properties['HANDLER_CANCELLED'].Name);",
        "        internal const string InflightRemovedType = $(ConvertTo-CSharpStringLiteral -Value $Protocol.frames.keys.PSObject.Properties['INFLIGHT_REMOVED'].Name);",
        "        internal static readonly string[] DescriptorTopLevelKeys = $(ConvertTo-CSharpStringArray -Value $Protocol.descriptor.topLevelKeys);",
        "        internal static readonly string[] PublicBetaKeys = $(ConvertTo-CSharpStringArray -Value $Protocol.descriptor.publicBetaKeys);",
        "        internal static readonly string[] ObserverArtifactKeys = $(ConvertTo-CSharpStringArray -Value $Protocol.descriptor.observerArtifactKeys);",
        "        internal static readonly string[] ArtifactIdentityKeys = $(ConvertTo-CSharpStringArray -Value $Protocol.descriptor.artifactIdentityKeys);",
        "        internal static readonly string[] NpmKeys = $(ConvertTo-CSharpStringArray -Value $Protocol.descriptor.npmKeys);",
        "        internal static readonly string[] RequestKeys = $(ConvertTo-CSharpStringArray -Value $Protocol.descriptor.requestKeys);",
        "        internal static readonly string[] HelloKeys = $(ConvertTo-CSharpStringArray -Value $Protocol.frames.keys.HELLO);",
        "        internal static readonly string[] RequestStartedKeys = $(ConvertTo-CSharpStringArray -Value $Protocol.frames.keys.REQUEST_STARTED);",
        "        internal static readonly string[] RequestAbortedKeys = $(ConvertTo-CSharpStringArray -Value $Protocol.frames.keys.REQUEST_ABORTED);",
        "        internal static readonly string[] OwnedExitKeys = $(ConvertTo-CSharpStringArray -Value $Protocol.frames.keys.OWNED_EXIT);",
        "        internal static readonly string[] HandlerCancelledKeys = $(ConvertTo-CSharpStringArray -Value $Protocol.frames.keys.HANDLER_CANCELLED);",
        "        internal static readonly string[] InflightRemovedKeys = $(ConvertTo-CSharpStringArray -Value $Protocol.frames.keys.INFLIGHT_REMOVED);",
        "        internal static readonly string[] McpKeys = $(ConvertTo-CSharpStringArray -Value $Protocol.frames.mcpKeys);",
        "    }",
        "}"
    )) {
        [void]$lines.Add($line)
    }
    [System.IO.File]::WriteAllLines($Path, $lines, [System.Text.UTF8Encoding]::new($false))
}

function Remove-VerifiedGeneratedProtocolSource {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$TemporaryRoot
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $resolved = Assert-NoReparseExistingPath -Path $Path
    if (
        [System.IO.Path]::GetDirectoryName($resolved) -cne $TemporaryRoot -or
        [System.IO.Path]::GetFileName($resolved) -cne "ProtocolV1.g.cs" -or
        -not (Test-Path -LiteralPath $resolved -PathType Leaf)
    ) {
        throw "host-acceptance: invalid generated protocol source"
    }
    [System.IO.File]::Delete($resolved)
}

function Assert-SharedBuildConfiguration {
    param([Parameter(Mandatory = $true)]$Configuration)

    if (
        $Configuration.targetFramework -cne "net48" -or
        $Configuration.configuration -cne "Release" -or
        $Configuration.platform -cne "x64" -or
        $Configuration.compilerArguments -isnot [System.Array] -or
        $Configuration.references -isnot [System.Array] -or
        $Configuration.compilerArguments.Count -eq 0 -or
        $Configuration.references.Count -eq 0
    ) {
        throw "host-acceptance: invalid shared compiler contract"
    }
    $compilerArguments = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($argument in $Configuration.compilerArguments) {
        if (
            $argument -isnot [string] -or
            [string]::IsNullOrEmpty($argument) -or
            $argument.Length -gt 256 -or
            $argument[0] -cne '/' -or
            $argument.Contains("`0") -or
            $argument.Contains("`r") -or
            $argument.Contains("`n") -or
            -not $compilerArguments.Add($argument)
        ) {
            throw "host-acceptance: invalid shared compiler contract"
        }
    }
    $references = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($reference in $Configuration.references) {
        if (
            $reference -isnot [string] -or
            [string]::IsNullOrEmpty($reference) -or
            [System.IO.Path]::GetFileName($reference) -cne $reference -or
            $reference -cnotmatch '^[A-Za-z0-9][A-Za-z0-9.]*\.dll$' -or
            -not $references.Add($reference)
        ) {
            throw "host-acceptance: invalid shared compiler contract"
        }
    }
}

function Assert-FixedTemporaryBuildRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Base
    )

    $resolvedBase = Assert-NoReparseExistingPath -Path $Base
    $resolvedRoot = Assert-NoReparseExistingPath -Path $Path
    if (
        [System.IO.Path]::GetDirectoryName($resolvedRoot) -cne $resolvedBase -or
        [System.IO.Path]::GetFileName($resolvedRoot) -cnotmatch '^[a-f0-9]{32}$'
    ) {
        throw "host-acceptance: invalid temporary build root"
    }
    return $resolvedRoot
}

function Remove-VerifiedTemporaryBuildRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Base,
        [Parameter(Mandatory = $true)][string[]]$AllowedFileNames
    )

    $resolvedRoot = Assert-FixedTemporaryBuildRoot -Path $Path -Base $Base
    $allowed = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($name in $AllowedFileNames) {
        if (
            ($name -cne "ManagedTests.exe" -and $name -cne "KernelTests.exe" -and $name -cne "ProcessFixture.exe") -or
            -not $allowed.Add($name)
        ) {
            throw "host-acceptance: invalid temporary cleanup allowlist"
        }
    }
    $items = @(Get-ChildItem -LiteralPath $resolvedRoot -Force)
    if ($items.Count -gt $allowed.Count) {
        throw "host-acceptance: unexpected temporary build output"
    }
    foreach ($item in $items) {
        if (
            ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            $item.PSIsContainer -or
            -not $allowed.Contains($item.Name) -or
            [System.IO.Path]::GetFullPath($item.DirectoryName) -cne $resolvedRoot
        ) {
            throw "host-acceptance: unexpected temporary build output"
        }
    }
    foreach ($item in $items) {
        [void](Assert-NoReparseExistingPath -Path $item.FullName)
        [System.IO.File]::Delete($item.FullName)
    }
    [void](Assert-FixedTemporaryBuildRoot -Path $resolvedRoot -Base $Base)
    if (@(Get-ChildItem -LiteralPath $resolvedRoot -Force).Count -ne 0) {
        throw "host-acceptance: temporary build root is not empty"
    }
    [System.IO.Directory]::Delete($resolvedRoot, $false)
}

$hostRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $hostRoot ".."))
[void](Assert-NoReparseExistingPath -Path $repositoryRoot)
$configurationPath = Join-Path $hostRoot "build.config.json"
$configuration = Get-Content -LiteralPath $configurationPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-ExactKeys -Record $configuration -Keys @("schemaVersion", "sharedBuildContract", "sourceSets", "artifact")
Assert-ExactKeys -Record $configuration.sharedBuildContract -Keys @("toolchainLockPath", "buildConfigPath", "restoreToolchainPath")
Assert-ExactKeys -Record $configuration.sourceSets -Keys @("production")
Assert-ExactKeys -Record $configuration.artifact -Keys @("path")
if (
    $configuration.schemaVersion -ne 1 -or
    [string]$configuration.sharedBuildContract.toolchainLockPath -cne "native/windows-job-helper/toolchain.lock.json" -or
    [string]$configuration.sharedBuildContract.buildConfigPath -cne "native/windows-job-helper/build.config.json" -or
    [string]$configuration.sharedBuildContract.restoreToolchainPath -cne "native/windows-job-helper/restore-toolchain.ps1" -or
    [string]$configuration.artifact.path -cne "host-acceptance/win32-x64/codex-host-acceptance-observer.exe"
) {
    throw "host-acceptance: invalid shared build contract"
}

$productionRelative = @($configuration.sourceSets.production | ForEach-Object { [string]$_ })
if ($productionRelative.Count -eq 0 -or ($productionRelative -join "`n") -cne (($productionRelative | Sort-Object -Unique) -join "`n")) {
    throw "host-acceptance: production sources must be unique and sorted"
}
foreach ($relativePath in $productionRelative) {
    if ($relativePath -cnotmatch '^src/[A-Za-z0-9]+\.cs$') {
        throw "host-acceptance: invalid production source path"
    }
}

$sharedBuildConfigPath = Resolve-RepositoryFile -RepositoryRoot $repositoryRoot -RelativePath ([string]$configuration.sharedBuildContract.buildConfigPath)
$toolchainLockPath = Resolve-RepositoryFile -RepositoryRoot $repositoryRoot -RelativePath ([string]$configuration.sharedBuildContract.toolchainLockPath)
$restoreToolchainPath = Resolve-RepositoryFile -RepositoryRoot $repositoryRoot -RelativePath ([string]$configuration.sharedBuildContract.restoreToolchainPath)
$protocolPath = Resolve-RepositoryFile -RepositoryRoot $repositoryRoot -RelativePath "host-acceptance/protocol/observer-protocol.v1.json"
$sharedBuild = Get-Content -LiteralPath $sharedBuildConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$toolchainLock = Get-Content -LiteralPath $toolchainLockPath -Raw -Encoding UTF8 | ConvertFrom-Json
$protocol = Get-Content -LiteralPath $protocolPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($sharedBuild.schemaVersion -ne 1 -or $toolchainLock.schemaVersion -ne 1) {
    throw "host-acceptance: unsupported shared build contract"
}
Assert-SharedBuildConfiguration -Configuration $sharedBuild

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restoreToolchainPath
if ($LASTEXITCODE -ne 0) {
    throw "host-acceptance: shared toolchain restore failed"
}

$compilerPackage = @($toolchainLock.nugetPackages | Where-Object { [string]$_.id -ceq "Microsoft.Net.Compilers.Toolset" })
$referencePackage = @($toolchainLock.nugetPackages | Where-Object { [string]$_.id -ceq "Microsoft.NETFramework.ReferenceAssemblies.net48" })
if ($compilerPackage.Count -ne 1 -or $referencePackage.Count -ne 1) {
    throw "host-acceptance: required shared toolchain packages are unavailable"
}
$packageRoot = Join-Path ([System.IO.Path]::GetTempPath()) "codex-agent-tools\windows-job-helper\toolchain-v1\packages"
$compilerPath = Join-Path $packageRoot (([string]$compilerPackage[0].id).ToLowerInvariant() + "." + [string]$compilerPackage[0].version + "\tasks\net472\csc.exe")
$referenceRoot = Join-Path $packageRoot (([string]$referencePackage[0].id).ToLowerInvariant() + "." + [string]$referencePackage[0].version + "\build\.NETFramework\v4.8")
if (-not (Test-Path -LiteralPath $compilerPath -PathType Leaf)) {
    throw "host-acceptance: shared compiler is unavailable"
}
$compilerPath = Assert-NoReparseExistingPath -Path $compilerPath
$referenceRoot = Assert-NoReparseExistingPath -Path $referenceRoot

$productionSources = @($productionRelative | ForEach-Object {
    Resolve-RepositoryFile -RepositoryRoot $hostRoot -RelativePath $_
})
$managedTestRelative = @(
    "tests/BuildContractTests.cs",
    "tests/HashReceiptTests.cs",
    "tests/ManagedTestRunner.cs",
    "tests/ReceiptWriterTests.cs",
    "tests/SessionMaterialTests.cs",
    "tests/StateMachineTests.cs",
    "tests/StrictJsonTests.cs",
    "tests/TestAssert.cs"
)
$kernelTestRelative = @(
    "tests/KernelTestRunner.cs",
    "tests/KernelTests.cs",
    "tests/TestAssert.cs"
)
$fixtureRelative = "tests/ProcessFixture.cs"
$selectedTestRelative = if ($Action -ceq "test-managed") { $managedTestRelative } else { $kernelTestRelative }
$testSources = @($selectedTestRelative | ForEach-Object {
    Resolve-RepositoryFile -RepositoryRoot $hostRoot -RelativePath $_
})
$fixtureSource = if ($Action -ceq "test-kernel") {
    Resolve-RepositoryFile -RepositoryRoot $hostRoot -RelativePath $fixtureRelative
} else { $null }
$temporaryBase = Join-Path ([System.IO.Path]::GetTempPath()) "codex-agent-tools\host-acceptance\build-v1"
[void][System.IO.Directory]::CreateDirectory($temporaryBase)
$temporaryBase = Assert-NoReparseExistingPath -Path $temporaryBase
$temporaryRoot = Join-Path $temporaryBase ([Guid]::NewGuid().ToString("N"))
[void][System.IO.Directory]::CreateDirectory($temporaryRoot)
$temporaryRoot = Assert-FixedTemporaryBuildRoot -Path $temporaryRoot -Base $temporaryBase
try {
    $testExecutableName = if ($Action -ceq "test-managed") { "ManagedTests.exe" } else { "KernelTests.exe" }
    $testMain = if ($Action -ceq "test-managed") {
        "CodexAgentTools.HostAcceptance.Tests.ManagedTestRunner"
    } else {
        "CodexAgentTools.HostAcceptance.Tests.KernelTestRunner"
    }
    $testExecutable = Join-Path $temporaryRoot $testExecutableName
    $fixtureExecutable = if ($Action -ceq "test-kernel") { Join-Path $temporaryRoot "ProcessFixture.exe" } else { $null }
    $generatedProtocolPath = Join-Path $temporaryRoot "ProtocolV1.g.cs"
    $compilerExitCode = 1
    try {
        Write-GeneratedProtocolSource -Protocol $protocol -Path $generatedProtocolPath
        $generatedProtocolPath = Assert-NoReparseExistingPath -Path $generatedProtocolPath
        if ($Action -ceq "test-kernel") {
            $fixtureArguments = [System.Collections.Generic.List[string]]::new()
            foreach ($argument in $sharedBuild.compilerArguments) {
                [void]$fixtureArguments.Add([string]$argument)
            }
            [void]$fixtureArguments.Add("/out:" + $fixtureExecutable)
            [void]$fixtureArguments.Add("/main:CodexAgentTools.HostAcceptance.Tests.ProcessFixture")
            [void]$fixtureArguments.Add("/pathmap:" + $hostRoot + "=/_/host-acceptance")
            foreach ($reference in $sharedBuild.references) {
                [void]$fixtureArguments.Add("/reference:" + (Assert-NoReparseExistingPath -Path (Join-Path $referenceRoot ([string]$reference))))
            }
            [void]$fixtureArguments.Add($fixtureSource)
            & $compilerPath @fixtureArguments
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $fixtureExecutable -PathType Leaf)) {
                throw "host-acceptance: process fixture compilation failed"
            }
            [void](Assert-NoReparseExistingPath -Path $fixtureExecutable)
        }
        $arguments = [System.Collections.Generic.List[string]]::new()
        foreach ($argument in $sharedBuild.compilerArguments) {
            [void]$arguments.Add([string]$argument)
        }
        [void]$arguments.Add("/out:" + $testExecutable)
        [void]$arguments.Add("/main:" + $testMain)
        [void]$arguments.Add("/pathmap:" + $hostRoot + "=/_/host-acceptance," + $temporaryRoot + "=/_/host-acceptance/generated")
        foreach ($reference in $sharedBuild.references) {
            $referencePath = Join-Path $referenceRoot ([string]$reference)
            if (-not (Test-Path -LiteralPath $referencePath -PathType Leaf)) {
                throw "host-acceptance: shared framework reference is unavailable"
            }
            $referencePath = Assert-NoReparseExistingPath -Path $referencePath
            [void]$arguments.Add("/reference:" + $referencePath)
        }
        [void]$arguments.Add($generatedProtocolPath)
        foreach ($source in @($productionSources + $testSources)) {
            [void]$arguments.Add($source)
        }

        & $compilerPath @arguments
        $compilerExitCode = $LASTEXITCODE
    }
    finally {
        Remove-VerifiedGeneratedProtocolSource -Path $generatedProtocolPath -TemporaryRoot $temporaryRoot
    }
    if ($compilerExitCode -ne 0) {
        throw "host-acceptance: $Action compilation failed"
    }
    Push-Location $repositoryRoot
    try {
        if ($Action -ceq "test-kernel") {
            & $testExecutable $fixtureExecutable
        }
        else {
            & $testExecutable
        }
        if ($LASTEXITCODE -ne 0) {
            throw "host-acceptance: $Action tests failed"
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        $cleanupNames = if ($Action -ceq "test-managed") {
            @("ManagedTests.exe")
        } else {
            @("KernelTests.exe", "ProcessFixture.exe")
        }
        Remove-VerifiedTemporaryBuildRoot -Path $temporaryRoot -Base $temporaryBase -AllowedFileNames $cleanupNames
    }
}
