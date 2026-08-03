param(
    [ValidateSet("test-managed", "test-kernel", "verify", "update-artifact")]
    [string]$Action = "test-managed"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (
    $Action -cne "test-managed" -and
    $Action -cne "test-kernel" -and
    $Action -cne "verify" -and
    $Action -cne "update-artifact"
) {
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

function New-VerifiedDirectoryChild {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $resolvedParent = (Assert-NoReparseExistingPath -Path $Parent).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $child = [System.IO.Path]::GetFullPath((Join-Path $resolvedParent $Name))
    if (
        [System.IO.Path]::GetDirectoryName($child) -cne $resolvedParent -or
        [System.IO.Path]::GetFileName($child) -cne $Name
    ) {
        throw "host-acceptance: artifact directory escaped its parent"
    }
    if (Test-Path -LiteralPath $child) {
        $item = Get-Item -LiteralPath $child -Force
        if (-not $item.PSIsContainer) {
            throw "host-acceptance: artifact directory is invalid"
        }
    }
    else {
        $item = New-Item -Path $child -ItemType Directory -ErrorAction Stop
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "host-acceptance: build path contains a reparse point"
    }
    return [System.IO.Path]::GetFullPath($item.FullName)
}

function Test-ExactBytes {
    param(
        [Parameter(Mandatory = $true)][byte[]]$Left,
        [Parameter(Mandatory = $true)][byte[]]$Right
    )

    if ($Left.Length -ne $Right.Length) {
        return $false
    }
    for ($index = 0; $index -lt $Left.Length; $index += 1) {
        if ($Left[$index] -ne $Right[$index]) {
            return $false
        }
    }
    return $true
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Assert-X64ManagedPe {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    if ($Bytes.Length -lt 64 -or $Bytes[0] -ne 0x4d -or $Bytes[1] -ne 0x5a) {
        throw "host-acceptance: canonical observer verification failed"
    }
    $peOffset = [System.BitConverter]::ToUInt32($Bytes, 0x3c)
    if ($peOffset -gt ($Bytes.Length - 24)) {
        throw "host-acceptance: canonical observer verification failed"
    }
    $optionalHeader = [int]$peOffset + 24
    if (
        $Bytes[[int]$peOffset] -ne 0x50 -or
        $Bytes[[int]$peOffset + 1] -ne 0x45 -or
        $Bytes[[int]$peOffset + 2] -ne 0 -or
        $Bytes[[int]$peOffset + 3] -ne 0 -or
        [System.BitConverter]::ToUInt16($Bytes, [int]$peOffset + 4) -ne 0x8664 -or
        [System.BitConverter]::ToUInt16($Bytes, $optionalHeader) -ne 0x020b
    ) {
        throw "host-acceptance: canonical observer verification failed"
    }
    $optionalHeaderBytes = [System.BitConverter]::ToUInt16($Bytes, [int]$peOffset + 20)
    $clrDirectory = $optionalHeader + 112 + (14 * 8)
    if (
        $optionalHeaderBytes -lt (112 + (15 * 8)) -or
        $clrDirectory -gt ($Bytes.Length - 8) -or
        [System.BitConverter]::ToUInt32($Bytes, $optionalHeader + 108) -lt 15 -or
        [System.BitConverter]::ToUInt32($Bytes, $clrDirectory) -eq 0 -or
        [System.BitConverter]::ToUInt32($Bytes, $clrDirectory + 4) -eq 0
    ) {
        throw "host-acceptance: canonical observer verification failed"
    }
}

function Get-CanonicalObserverArtifactPaths {
    param([Parameter(Mandatory = $true)][string]$HostRoot)

    $resolvedHostRoot = Assert-NoReparseExistingPath -Path $HostRoot
    $artifactRoot = Join-Path $resolvedHostRoot "win32-x64"
    if (-not (Test-Path -LiteralPath $artifactRoot -PathType Container)) {
        throw "host-acceptance: canonical observer verification failed"
    }
    $artifactRoot = Assert-NoReparseExistingPath -Path $artifactRoot
    return @{
        HostRoot = $resolvedHostRoot
        ArtifactRoot = [System.IO.Path]::GetFullPath($artifactRoot)
        Executable = [System.IO.Path]::GetFullPath((Join-Path $artifactRoot "codex-host-acceptance-observer.exe"))
        Manifest = [System.IO.Path]::GetFullPath((Join-Path $resolvedHostRoot "observer-build-inputs.v1.json"))
    }
}

function Write-AtomicObserverFile {
    param(
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [Parameter(Mandatory = $true)][byte[]]$Bytes
    )

    $resolvedDestination = [System.IO.Path]::GetFullPath($DestinationPath)
    $resolvedParent = (Assert-NoReparseExistingPath -Path ([System.IO.Path]::GetDirectoryName($resolvedDestination))).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $destinationName = [System.IO.Path]::GetFileName($resolvedDestination)
    $destinationExists = Test-Path -LiteralPath $resolvedDestination
    if ($destinationExists) {
        [void](Assert-NoReparseExistingPath -Path $resolvedDestination)
        $existing = Get-Item -LiteralPath $resolvedDestination -Force
        if (
            $existing -isnot [System.IO.FileInfo] -or
            $existing.PSIsContainer -or
            ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        ) {
            throw "host-acceptance: canonical observer verification failed"
        }
    }

    $temporaryPath = Join-Path $resolvedParent ("." + $destinationName + "." + [System.Guid]::NewGuid().ToString("N") + ".tmp")
    try {
        $stream = [System.IO.FileStream]::new(
            $temporaryPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $stream.Write($Bytes, 0, $Bytes.Length)
            $stream.Flush($true)
        }
        finally {
            $stream.Dispose()
        }
        [void](Assert-NoReparseExistingPath -Path $temporaryPath)
        if ($destinationExists) {
            [System.IO.File]::Replace(
                $temporaryPath,
                $resolvedDestination,
                [System.Management.Automation.Language.NullString]::Value
            )
        }
        else {
            [System.IO.File]::Move($temporaryPath, $resolvedDestination)
        }
        [void](Assert-NoReparseExistingPath -Path $resolvedDestination)
        if (-not (Test-ExactBytes -Left $Bytes -Right ([System.IO.File]::ReadAllBytes($resolvedDestination)))) {
            throw "host-acceptance: canonical observer verification failed"
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            [System.IO.File]::Delete($temporaryPath)
        }
    }
}

function Install-CanonicalObserverArtifactPair {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)][byte[]]$ExecutableBytes,
        [Parameter(Mandatory = $true)][byte[]]$ManifestBytes
    )

    $resolvedHostRoot = (Assert-NoReparseExistingPath -Path $Paths.HostRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $resolvedArtifactRoot = (Assert-NoReparseExistingPath -Path $Paths.ArtifactRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $expectedArtifactRoot = [System.IO.Path]::GetFullPath((Join-Path $resolvedHostRoot "win32-x64"))
    if (
        -not $resolvedArtifactRoot.Equals($expectedArtifactRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [System.IO.Path]::GetFullPath($Paths.Executable).Equals(
            [System.IO.Path]::GetFullPath((Join-Path $resolvedArtifactRoot "codex-host-acceptance-observer.exe")),
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        -not [System.IO.Path]::GetFullPath($Paths.Manifest).Equals(
            [System.IO.Path]::GetFullPath((Join-Path $resolvedHostRoot "observer-build-inputs.v1.json")),
            [System.StringComparison]::OrdinalIgnoreCase
        )
    ) {
        throw "host-acceptance: canonical observer verification failed"
    }
    $artifactEntries = @(Get-ChildItem -LiteralPath $resolvedArtifactRoot -Force)
    if (
        $artifactEntries.Count -gt 1 -or
        ($artifactEntries.Count -eq 1 -and $artifactEntries[0].Name -cne "codex-host-acceptance-observer.exe")
    ) {
        throw "host-acceptance: canonical observer verification failed"
    }
    $manifestEntries = @(Get-ChildItem -LiteralPath $resolvedHostRoot -Force | Where-Object {
        $_.Name.Equals("observer-build-inputs.v1.json", [System.StringComparison]::OrdinalIgnoreCase)
    })
    if ($manifestEntries.Count -gt 1 -or ($manifestEntries.Count -eq 1 -and $manifestEntries[0].Name -cne "observer-build-inputs.v1.json")) {
        throw "host-acceptance: canonical observer verification failed"
    }

    Write-AtomicObserverFile `
        -DestinationPath $Paths.Executable `
        -Bytes $ExecutableBytes
    Write-AtomicObserverFile `
        -DestinationPath $Paths.Manifest `
        -Bytes $ManifestBytes
}

function ConvertFrom-StrictUtf8JsonBytes {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    if (
        $Bytes.Length -ge 3 -and
        $Bytes[0] -eq 0xef -and
        $Bytes[1] -eq 0xbb -and
        $Bytes[2] -eq 0xbf
    ) {
        throw "host-acceptance: build input JSON must be UTF-8 without BOM"
    }
    try {
        $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($Bytes)
        return ($text | ConvertFrom-Json)
    }
    catch {
        throw "host-acceptance: build input JSON is invalid"
    }
}

function Get-ObserverBuildInputSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string[]]$ProductionRelative
    )

    $inputPaths = [System.Collections.Generic.List[string]]::new()
    foreach ($relativePath in @(
        "native/windows-job-helper/toolchain.lock.json",
        "native/windows-job-helper/build.config.json",
        "native/windows-job-helper/restore-toolchain.ps1",
        "host-acceptance/build.config.json",
        "host-acceptance/build.ps1",
        "host-acceptance/protocol/observer-protocol.v1.json"
    )) {
        [void]$inputPaths.Add($relativePath)
    }
    foreach ($relativeSource in $ProductionRelative) {
        [void]$inputPaths.Add("host-acceptance/" + $relativeSource)
    }
    [void]$inputPaths.Sort([System.StringComparer]::Ordinal)

    $inputs = [System.Collections.Generic.List[object]]::new()
    foreach ($inputPath in $inputPaths) {
        $resolvedInput = Resolve-RepositoryFile -RepositoryRoot $RepositoryRoot -RelativePath $inputPath
        $bytes = [System.IO.File]::ReadAllBytes($resolvedInput)
        [void]$inputs.Add([pscustomobject]@{
            Path = $inputPath
            Sha256 = Get-Sha256Hex -Bytes $bytes
            Bytes = $bytes
        })
    }
    return [pscustomobject]@{ Inputs = [object[]]$inputs.ToArray() }
}

function Get-ObserverSnapshotEntry {
    param(
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $matches = @($Snapshot.Inputs | Where-Object { $_.Path -ceq $Path })
    if ($matches.Count -ne 1) {
        throw "host-acceptance: observer build input is unavailable"
    }
    return $matches[0]
}

function Get-ExpectedObserverManifest {
    param([Parameter(Mandatory = $true)]$Snapshot)

    $inputs = @($Snapshot.Inputs)
    $compactItems = @($inputs | ForEach-Object {
        '{"path":"' + $_.Path + '","sha256":"' + $_.Sha256 + '"}'
    })
    $digestProjection = '{"schemaVersion":1,"inputs":[' + ($compactItems -join ',') + ']}'
    $inputsDigest = Get-Sha256Hex -Bytes ([System.Text.UTF8Encoding]::new($false).GetBytes($digestProjection))
    $protocolPath = "host-acceptance/protocol/observer-protocol.v1.json"
    $protocolInput = @($inputs | Where-Object { $_.Path -ceq $protocolPath })
    if ($protocolInput.Count -ne 1) {
        throw "host-acceptance: observer protocol input is unavailable"
    }

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in @(
        "{",
        '  "schemaVersion": 1,',
        '  "artifactPath": "host-acceptance/win32-x64/codex-host-acceptance-observer.exe",',
        '  "protocol": {',
        '    "path": "host-acceptance/protocol/observer-protocol.v1.json",',
        ('    "sha256": "' + $protocolInput[0].Sha256 + '"'),
        '  },',
        '  "inputs": ['
    )) {
        [void]$lines.Add($line)
    }
    for ($index = 0; $index -lt $inputs.Count; $index += 1) {
        $suffix = if ($index -eq ($inputs.Count - 1)) { "" } else { "," }
        [void]$lines.Add("    {")
        [void]$lines.Add('      "path": "' + $inputs[$index].Path + '",')
        [void]$lines.Add('      "sha256": "' + $inputs[$index].Sha256 + '"')
        [void]$lines.Add("    }" + $suffix)
    }
    foreach ($line in @(
        "  ],",
        ('  "inputsDigestSha256": "' + $inputsDigest + '"'),
        "}"
    )) {
        [void]$lines.Add($line)
    }
    $manifestText = ($lines -join "`n") + "`n"
    return [pscustomobject]@{
        Bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($manifestText)
        InputsDigestSha256 = $inputsDigest
        ProtocolSha256 = $protocolInput[0].Sha256
    }
}

function Assert-ObserverBuildInputsUnchanged {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string[]]$ProductionRelative,
        [Parameter(Mandatory = $true)][byte[]]$ExpectedManifestBytes
    )

    $currentSnapshot = Get-ObserverBuildInputSnapshot `
        -RepositoryRoot $RepositoryRoot `
        -ProductionRelative $ProductionRelative
    $currentManifest = Get-ExpectedObserverManifest -Snapshot $currentSnapshot
    if (-not (Test-ExactBytes -Left $ExpectedManifestBytes -Right $currentManifest.Bytes)) {
        throw "host-acceptance: observer build inputs changed during compilation"
    }
}

function Assert-CanonicalObserverArtifact {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)][byte[]]$ExpectedExecutableBytes,
        [Parameter(Mandatory = $true)][byte[]]$ExpectedManifestBytes
    )

    $artifactEntries = @(Get-ChildItem -LiteralPath $Paths.ArtifactRoot -Force | ForEach-Object { $_.Name } | Sort-Object)
    if (($artifactEntries -join "`n") -cne "codex-host-acceptance-observer.exe") {
        throw "host-acceptance: canonical observer verification failed"
    }
    [void](Assert-NoReparseExistingPath -Path $Paths.Executable)
    [void](Assert-NoReparseExistingPath -Path $Paths.Manifest)
    foreach ($canonicalPath in @($Paths.Executable, $Paths.Manifest)) {
        $item = Get-Item -LiteralPath $canonicalPath -Force
        if ($item -isnot [System.IO.FileInfo] -or $item.PSIsContainer) {
            throw "host-acceptance: canonical observer verification failed"
        }
    }
    $actualExecutableBytes = [System.IO.File]::ReadAllBytes($Paths.Executable)
    Assert-X64ManagedPe -Bytes $actualExecutableBytes
    if (
        -not (Test-ExactBytes -Left $ExpectedExecutableBytes -Right $actualExecutableBytes) -or
        -not (Test-ExactBytes -Left $ExpectedManifestBytes -Right ([System.IO.File]::ReadAllBytes($Paths.Manifest)))
    ) {
        throw "host-acceptance: canonical observer verification failed"
    }
    return Get-Sha256Hex -Bytes $actualExecutableBytes
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
            (
                $name -cne "ManagedTests.exe" -and
                $name -cne "KernelTests.exe" -and
                $name -cne "ProcessFixture.exe" -and
                $name -cne "Observer.exe"
            ) -or
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
$configurationPath = Resolve-RepositoryFile -RepositoryRoot $repositoryRoot -RelativePath "host-acceptance/build.config.json"
$configurationBytes = [System.IO.File]::ReadAllBytes($configurationPath)
$configuration = ConvertFrom-StrictUtf8JsonBytes -Bytes $configurationBytes
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
if ($productionRelative.Count -eq 0) {
    throw "host-acceptance: production sources must be unique and sorted"
}
for ($index = 0; $index -lt $productionRelative.Count; $index += 1) {
    $relativePath = $productionRelative[$index]
    if ($relativePath -cnotmatch '^src/[A-Za-z0-9]+\.cs$') {
        throw "host-acceptance: invalid production source path"
    }
    if (
        $index -gt 0 -and
        [string]::CompareOrdinal($productionRelative[$index - 1], $relativePath) -ge 0
    ) {
        throw "host-acceptance: production sources must be unique and sorted"
    }
}

$inputSnapshot = Get-ObserverBuildInputSnapshot `
    -RepositoryRoot $repositoryRoot `
    -ProductionRelative $productionRelative
$capturedConfiguration = Get-ObserverSnapshotEntry `
    -Snapshot $inputSnapshot `
    -Path "host-acceptance/build.config.json"
if (-not (Test-ExactBytes -Left $configurationBytes -Right $capturedConfiguration.Bytes)) {
    throw "host-acceptance: observer build inputs changed during capture"
}
$sharedBuildConfigInput = Get-ObserverSnapshotEntry `
    -Snapshot $inputSnapshot `
    -Path ([string]$configuration.sharedBuildContract.buildConfigPath)
$toolchainLockInput = Get-ObserverSnapshotEntry `
    -Snapshot $inputSnapshot `
    -Path ([string]$configuration.sharedBuildContract.toolchainLockPath)
$protocolInput = Get-ObserverSnapshotEntry `
    -Snapshot $inputSnapshot `
    -Path "host-acceptance/protocol/observer-protocol.v1.json"
$restoreToolchainPath = Resolve-RepositoryFile -RepositoryRoot $repositoryRoot -RelativePath ([string]$configuration.sharedBuildContract.restoreToolchainPath)
$sharedBuild = ConvertFrom-StrictUtf8JsonBytes -Bytes $sharedBuildConfigInput.Bytes
$toolchainLock = ConvertFrom-StrictUtf8JsonBytes -Bytes $toolchainLockInput.Bytes
$protocol = ConvertFrom-StrictUtf8JsonBytes -Bytes $protocolInput.Bytes
if ($sharedBuild.schemaVersion -ne 1 -or $toolchainLock.schemaVersion -ne 1) {
    throw "host-acceptance: unsupported shared build contract"
}
Assert-SharedBuildConfiguration -Configuration $sharedBuild

& $restoreToolchainPath

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
    "tests/ObserverSessionTests.cs",
    "tests/ReceiptWriterTests.cs",
    "tests/SessionMaterialTests.cs",
    "tests/StateMachineTests.cs",
    "tests/StrictJsonTests.cs",
    "tests/TestAssert.cs"
)
$kernelTestRelative = @(
    "tests/KernelObserverSessionTests.cs",
    "tests/KernelTestRunner.cs",
    "tests/KernelTests.cs",
    "tests/TestAssert.cs"
)
$fixtureRelative = "tests/ProcessFixture.cs"
$nodePipeCloseFixtureRelative = "tests/node-pipe-close-fixture.mjs"
$selectedTestRelative = if ($Action -ceq "test-managed") {
    $managedTestRelative
} elseif ($Action -ceq "test-kernel") {
    $kernelTestRelative
} else {
    @()
}
$testSources = @($selectedTestRelative | ForEach-Object {
    Resolve-RepositoryFile -RepositoryRoot $hostRoot -RelativePath $_
})
$fixtureSource = if ($Action -ceq "test-kernel") {
    Resolve-RepositoryFile -RepositoryRoot $hostRoot -RelativePath $fixtureRelative
} else { $null }
$nodePipeCloseFixture = if ($Action -ceq "test-kernel") {
    Resolve-RepositoryFile -RepositoryRoot $hostRoot -RelativePath $nodePipeCloseFixtureRelative
} else { $null }
$nodeExecutable = if ($Action -ceq "test-kernel") {
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if ($null -eq $nodeCommand -or [string]::IsNullOrEmpty($nodeCommand.Source)) {
        throw "host-acceptance: current-host Node executable is unavailable"
    }
    Assert-NoReparseExistingPath -Path $nodeCommand.Source
} else { $null }
$isArtifactAction = $Action -ceq "verify" -or $Action -ceq "update-artifact"
$expectedManifestBefore = if ($isArtifactAction) {
    Get-ExpectedObserverManifest -Snapshot $inputSnapshot
} else { $null }
$systemTemporaryRoot = Assert-NoReparseExistingPath -Path ([System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()))
$temporaryProductRoot = New-VerifiedDirectoryChild -Parent $systemTemporaryRoot -Name "codex-agent-tools"
$temporaryObserverRoot = New-VerifiedDirectoryChild -Parent $temporaryProductRoot -Name "host-acceptance"
$temporaryBase = New-VerifiedDirectoryChild -Parent $temporaryObserverRoot -Name "build-v1"
$temporaryRoot = $null
for ($attempt = 0; $attempt -lt 16 -and $null -eq $temporaryRoot; $attempt += 1) {
    $candidate = Join-Path $temporaryBase ([Guid]::NewGuid().ToString("N"))
    try {
        $createdRoot = New-Item -Path $candidate -ItemType Directory -ErrorAction Stop
        if (($createdRoot.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "host-acceptance: build path contains a reparse point"
        }
        $temporaryRoot = [System.IO.Path]::GetFullPath($createdRoot.FullName)
    }
    catch [System.IO.IOException] {
        if (-not (Test-Path -LiteralPath $candidate)) {
            throw
        }
    }
}
if ($null -eq $temporaryRoot) {
    throw "host-acceptance: could not create an exclusive build directory"
}
$temporaryRoot = Assert-FixedTemporaryBuildRoot -Path $temporaryRoot -Base $temporaryBase
try {
    $outputExecutableName = if ($Action -ceq "test-managed") {
        "ManagedTests.exe"
    } elseif ($Action -ceq "test-kernel") {
        "KernelTests.exe"
    } else {
        "Observer.exe"
    }
    $outputMain = if ($Action -ceq "test-managed") {
        "CodexAgentTools.HostAcceptance.Tests.ManagedTestRunner"
    } elseif ($Action -ceq "test-kernel") {
        "CodexAgentTools.HostAcceptance.Tests.KernelTestRunner"
    } else {
        "CodexAgentTools.HostAcceptance.Program"
    }
    $outputExecutable = Join-Path $temporaryRoot $outputExecutableName
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
        [void]$arguments.Add("/out:" + $outputExecutable)
        [void]$arguments.Add("/main:" + $outputMain)
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
    [void](Assert-NoReparseExistingPath -Path $outputExecutable)
    if ($isArtifactAction) {
        Assert-ObserverBuildInputsUnchanged `
            -RepositoryRoot $repositoryRoot `
            -ProductionRelative $productionRelative `
            -ExpectedManifestBytes $expectedManifestBefore.Bytes
        $builtBytes = [System.IO.File]::ReadAllBytes($outputExecutable)
        Assert-X64ManagedPe -Bytes $builtBytes
        $mutexIdentity = [System.Text.UTF8Encoding]::new($false).GetBytes($hostRoot.ToLowerInvariant())
        $mutexDigest = Get-Sha256Hex -Bytes $mutexIdentity
        $artifactMutex = [System.Threading.Mutex]::new(
            $false,
            "Local\CodexAgentTools.HostAcceptance.ObserverArtifactV1." + $mutexDigest.Substring(0, 32)
        )
        $ownsArtifactMutex = $false
        try {
            try {
                $ownsArtifactMutex = $artifactMutex.WaitOne()
            }
            catch [System.Threading.AbandonedMutexException] {
                $ownsArtifactMutex = $true
            }
            if (-not $ownsArtifactMutex) {
                throw "host-acceptance: could not acquire observer artifact mutex"
            }
            Assert-ObserverBuildInputsUnchanged `
                -RepositoryRoot $repositoryRoot `
                -ProductionRelative $productionRelative `
                -ExpectedManifestBytes $expectedManifestBefore.Bytes
            $paths = Get-CanonicalObserverArtifactPaths -HostRoot $hostRoot
            if ($Action -ceq "update-artifact") {
                Install-CanonicalObserverArtifactPair `
                    -Paths $paths `
                    -ExecutableBytes $builtBytes `
                    -ManifestBytes $expectedManifestBefore.Bytes
            }
            $verifiedDigest = Assert-CanonicalObserverArtifact `
                -Paths $paths `
                -ExpectedExecutableBytes $builtBytes `
                -ExpectedManifestBytes $expectedManifestBefore.Bytes
            Assert-ObserverBuildInputsUnchanged `
                -RepositoryRoot $repositoryRoot `
                -ProductionRelative $productionRelative `
                -ExpectedManifestBytes $expectedManifestBefore.Bytes
            if ($Action -ceq "update-artifact") {
                Write-Output "host-acceptance: updated canonical observer sha256=$verifiedDigest"
            }
            else {
                Write-Output "host-acceptance: verified canonical observer sha256=$verifiedDigest"
            }
        }
        finally {
            if ($ownsArtifactMutex) {
                $artifactMutex.ReleaseMutex()
            }
            $artifactMutex.Dispose()
        }
    }
    else {
        Push-Location $repositoryRoot
        try {
            if ($Action -ceq "test-kernel") {
                & $outputExecutable $fixtureExecutable $nodeExecutable $nodePipeCloseFixture
            }
            else {
                & $outputExecutable
            }
            if ($LASTEXITCODE -ne 0) {
                throw "host-acceptance: $Action tests failed"
            }
        }
        finally {
            Pop-Location
        }
    }
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        $cleanupNames = if ($Action -ceq "test-managed") {
            @("ManagedTests.exe")
        } elseif ($Action -ceq "test-kernel") {
            @("KernelTests.exe", "ProcessFixture.exe")
        } else {
            @("Observer.exe")
        }
        Remove-VerifiedTemporaryBuildRoot -Path $temporaryRoot -Base $temporaryBase -AllowedFileNames $cleanupNames
    }
}
