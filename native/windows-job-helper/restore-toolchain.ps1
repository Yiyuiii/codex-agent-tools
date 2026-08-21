Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-VerifiedHash {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]
        [ValidateSet("SHA256", "SHA512")]
        [string]$Algorithm
    )

    $hasher = switch ($Algorithm) {
        "SHA256" { [System.Security.Cryptography.SHA256]::Create() }
        "SHA512" { [System.Security.Cryptography.SHA512]::Create() }
    }
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            $digest = $hasher.ComputeHash($stream)
        }
        finally {
            $stream.Dispose()
        }
    }
    finally {
        $hasher.Dispose()
    }
    return [System.BitConverter]::ToString($digest).Replace("-", "").ToLowerInvariant()
}

function Assert-Archive {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Package
    )

    $item = Get-Item -LiteralPath $Path
    if ($item.Length -ne [long]$Package.byteLength) {
        throw "windows-native-helper: toolchain archive length mismatch"
    }
    if ((Get-VerifiedHash -Path $Path -Algorithm "SHA256") -cne [string]$Package.sha256) {
        throw "windows-native-helper: toolchain archive SHA-256 mismatch"
    }
    if ((Get-VerifiedHash -Path $Path -Algorithm "SHA512") -cne [string]$Package.sha512) {
        throw "windows-native-helper: toolchain archive SHA-512 mismatch"
    }
}

function Assert-SystemTemporaryPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$TemporaryRoot
    )

    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    $resolvedRoot = [System.IO.Path]::GetFullPath($TemporaryRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "windows-native-helper: toolchain cache escaped the system temporary directory"
    }
    return $resolvedPath
}

function Assert-NoReparsePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$TemporaryRoot
    )

    $resolvedPath = Assert-SystemTemporaryPath -Path $Path -TemporaryRoot $TemporaryRoot
    $pathRoot = [System.IO.Path]::GetPathRoot($resolvedPath)
    $relative = $resolvedPath.Substring($pathRoot.Length)
    $current = $pathRoot.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    foreach ($segment in $relative.Split(@(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ), [System.StringSplitOptions]::RemoveEmptyEntries)) {
        $current = Join-Path $current $segment
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "windows-native-helper: toolchain cache contains a reparse point"
            }
        }
    }
    return $resolvedPath
}

function Get-StreamSha256 {
    param([Parameter(Mandatory = $true)][System.IO.Stream]$Stream)

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash($Stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-ArchiveManifest {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$ExpandedPath
    )

    $files = [System.Collections.Generic.Dictionary[string, object]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $directories = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $expandedPrefix = [System.IO.Path]::GetFullPath($ExpandedPath).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        foreach ($entry in $archive.Entries) {
            $entryName = [string]$entry.FullName
            if (
                [string]::IsNullOrEmpty($entryName) -or
                $entryName.Contains("\") -or
                $entryName.StartsWith("/", [System.StringComparison]::Ordinal) -or
                $entryName.Contains(":")
            ) {
                throw "windows-native-helper: toolchain archive path escaped its package root"
            }
            $isDirectory = $entryName.EndsWith("/", [System.StringComparison]::Ordinal)
            $relative = $entryName.TrimEnd("/")
            $segments = $relative.Split('/')
            if ($segments.Count -eq 0 -or @($segments | Where-Object { $_ -eq "" -or $_ -eq "." -or $_ -eq ".." }).Count -ne 0) {
                throw "windows-native-helper: toolchain archive path escaped its package root"
            }
            $candidate = [System.IO.Path]::GetFullPath((Join-Path $ExpandedPath (
                $relative.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
            )))
            if (-not ($candidate + $(if ($isDirectory) { [System.IO.Path]::DirectorySeparatorChar } else { "" })).StartsWith(
                $expandedPrefix,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
                throw "windows-native-helper: toolchain archive path escaped its package root"
            }

            for ($index = 1; $index -lt $segments.Count; $index += 1) {
                [void]$directories.Add(($segments[0..($index - 1)] -join "/"))
            }
            if ($isDirectory) {
                if ($files.ContainsKey($relative)) {
                    throw "windows-native-helper: duplicate toolchain archive path"
                }
                [void]$directories.Add($relative)
                continue
            }
            if ($files.ContainsKey($relative) -or $directories.Contains($relative)) {
                throw "windows-native-helper: duplicate toolchain archive path"
            }
            $stream = $entry.Open()
            try {
                $entryHash = Get-StreamSha256 -Stream $stream
            }
            finally {
                $stream.Dispose()
            }
            $files.Add($relative, [pscustomobject]@{
                Length = [long]$entry.Length
                Sha256 = $entryHash
            })
        }
    }
    finally {
        $archive.Dispose()
    }
    return [pscustomobject]@{ Files = $files; Directories = $directories }
}

function Assert-ExpandedPackage {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$ExpandedPath,
        [Parameter(Mandatory = $true)][string]$TemporaryRoot
    )

    [void](Assert-NoReparsePath -Path $ArchivePath -TemporaryRoot $TemporaryRoot)
    [void](Assert-NoReparsePath -Path $ExpandedPath -TemporaryRoot $TemporaryRoot)
    if (-not (Test-Path -LiteralPath $ExpandedPath -PathType Container)) {
        throw "windows-native-helper: expanded toolchain file set mismatch"
    }
    $rootItem = Get-Item -LiteralPath $ExpandedPath -Force
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "windows-native-helper: expanded toolchain contains a reparse point"
    }

    $manifest = Get-ArchiveManifest -ArchivePath $ArchivePath -ExpandedPath $ExpandedPath
    $actualFiles = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $actualDirectories = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )

    function Visit-ExpandedDirectory {
        param(
            [Parameter(Mandatory = $true)][string]$Directory,
            [Parameter(Mandatory = $true)][AllowEmptyString()][string]$RelativeDirectory
        )

        foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "windows-native-helper: expanded toolchain contains a reparse point"
            }
            $relative = if ($RelativeDirectory.Length -eq 0) {
                $item.Name
            }
            else {
                $RelativeDirectory + "/" + $item.Name
            }
            if ($item.PSIsContainer) {
                [void]$actualDirectories.Add($relative)
                Visit-ExpandedDirectory -Directory $item.FullName -RelativeDirectory $relative
                continue
            }
            if (-not ($item -is [System.IO.FileInfo])) {
                throw "windows-native-helper: expanded toolchain file set mismatch"
            }
            [void]$actualFiles.Add($relative)
            if (-not $manifest.Files.ContainsKey($relative)) {
                throw "windows-native-helper: expanded toolchain file set mismatch"
            }
            $expected = $manifest.Files[$relative]
            if (
                $item.Length -ne $expected.Length -or
                (Get-VerifiedHash -Path $item.FullName -Algorithm "SHA256") -cne $expected.Sha256
            ) {
                throw "windows-native-helper: expanded toolchain content mismatch"
            }
        }
    }

    Visit-ExpandedDirectory -Directory $ExpandedPath -RelativeDirectory ""
    if (
        $actualFiles.Count -ne $manifest.Files.Count -or
        $actualDirectories.Count -ne $manifest.Directories.Count
    ) {
        throw "windows-native-helper: expanded toolchain file set mismatch"
    }
    foreach ($path in $manifest.Files.Keys) {
        if (-not $actualFiles.Contains($path)) {
            throw "windows-native-helper: expanded toolchain file set mismatch"
        }
    }
    foreach ($path in $manifest.Directories) {
        if (-not $actualDirectories.Contains($path)) {
            throw "windows-native-helper: expanded toolchain file set mismatch"
        }
    }
}

$nativeRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$lockPath = Join-Path $nativeRoot "toolchain.lock.json"
$toolchain = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($toolchain.schemaVersion -ne 1 -or $toolchain.nugetPackages.Count -ne 2) {
    throw "windows-native-helper: invalid toolchain lock"
}

$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$cacheRoot = Assert-SystemTemporaryPath -Path (
    Join-Path $temporaryRoot "codex-agent-tools\windows-job-helper\toolchain-v1"
) -TemporaryRoot $temporaryRoot
$archiveRoot = Join-Path $cacheRoot "archives"
$packageRoot = Join-Path $cacheRoot "packages"
$mutexHasher = [System.Security.Cryptography.SHA256]::Create()
try {
    $mutexBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($cacheRoot.ToLowerInvariant())
    $mutexDigest = ([System.BitConverter]::ToString($mutexHasher.ComputeHash($mutexBytes))).Replace("-", "").ToLowerInvariant()
}
finally {
    $mutexHasher.Dispose()
}
$mutexName = "Local\CodexAgentTools.WindowsJobHelper.ToolchainV1." + $mutexDigest.Substring(0, 32)
$cacheMutex = [System.Threading.Mutex]::new($false, $mutexName)
$ownsCacheMutex = $false
try {
    try {
        $ownsCacheMutex = $cacheMutex.WaitOne()
    }
    catch [System.Threading.AbandonedMutexException] {
        $ownsCacheMutex = $true
    }
    if (-not $ownsCacheMutex) {
        throw "windows-native-helper: could not acquire the toolchain cache mutex"
    }

    [void](Assert-NoReparsePath -Path $cacheRoot -TemporaryRoot $temporaryRoot)
    [System.IO.Directory]::CreateDirectory($archiveRoot) | Out-Null
    [System.IO.Directory]::CreateDirectory($packageRoot) | Out-Null
    [void](Assert-NoReparsePath -Path $cacheRoot -TemporaryRoot $temporaryRoot)
    [void](Assert-NoReparsePath -Path $archiveRoot -TemporaryRoot $temporaryRoot)
    [void](Assert-NoReparsePath -Path $packageRoot -TemporaryRoot $temporaryRoot)

    Add-Type -AssemblyName System.Net.Http
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $httpClient = [System.Net.Http.HttpClient]::new()
    try {
        foreach ($package in $toolchain.nugetPackages) {
        $archiveName = (([string]$package.id).ToLowerInvariant() + "." + [string]$package.version + ".nupkg")
        $archivePath = Assert-SystemTemporaryPath -Path (Join-Path $archiveRoot $archiveName) -TemporaryRoot $temporaryRoot

        if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
            $temporaryArchive = Assert-SystemTemporaryPath -Path (
                $archivePath + "." + [System.Guid]::NewGuid().ToString("N") + ".tmp"
            ) -TemporaryRoot $temporaryRoot
            try {
                $archiveBytes = $httpClient.GetByteArrayAsync([string]$package.url).GetAwaiter().GetResult()
                [System.IO.File]::WriteAllBytes($temporaryArchive, $archiveBytes)
                Assert-Archive -Path $temporaryArchive -Package $package
                [System.IO.File]::Move($temporaryArchive, $archivePath)
            }
            finally {
                if (Test-Path -LiteralPath $temporaryArchive -PathType Leaf) {
                    Remove-Item -LiteralPath $temporaryArchive -Force
                }
            }
        }

        Assert-Archive -Path $archivePath -Package $package
        [void](Assert-NoReparsePath -Path $archivePath -TemporaryRoot $temporaryRoot)
        $expandedPath = Assert-SystemTemporaryPath -Path (
            Join-Path $packageRoot (([string]$package.id).ToLowerInvariant() + "." + [string]$package.version)
        ) -TemporaryRoot $temporaryRoot
        if (-not (Test-Path -LiteralPath $expandedPath -PathType Container)) {
            $temporaryExpanded = Assert-SystemTemporaryPath -Path (
                $expandedPath + "." + [System.Guid]::NewGuid().ToString("N") + ".tmp"
            ) -TemporaryRoot $temporaryRoot
            try {
                [System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $temporaryExpanded)
                Assert-ExpandedPackage -ArchivePath $archivePath -ExpandedPath $temporaryExpanded -TemporaryRoot $temporaryRoot
                [System.IO.Directory]::Move($temporaryExpanded, $expandedPath)
            }
            finally {
                if (Test-Path -LiteralPath $temporaryExpanded -PathType Container) {
                    Remove-Item -LiteralPath $temporaryExpanded -Recurse -Force
                }
            }
        }
        Assert-ExpandedPackage -ArchivePath $archivePath -ExpandedPath $expandedPath -TemporaryRoot $temporaryRoot
        }

        $compilerPath = Join-Path $packageRoot "microsoft.net.compilers.toolset.4.14.0\tasks\net472\csc.exe"
        $referenceRoot = Join-Path $packageRoot "microsoft.netframework.referenceassemblies.net48.1.0.3\build\.NETFramework\v4.8"
        foreach ($requiredPath in @(
            $compilerPath,
            (Join-Path $referenceRoot "mscorlib.dll"),
            (Join-Path $referenceRoot "System.dll"),
            (Join-Path $referenceRoot "System.Core.dll")
        )) {
            if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
                throw "windows-native-helper: restored toolchain is incomplete"
            }
        }
    }
    finally {
        $httpClient.Dispose()
    }
}
finally {
    if ($ownsCacheMutex) {
        $cacheMutex.ReleaseMutex()
    }
    $cacheMutex.Dispose()
}

Write-Output "windows-native-helper: restore complete"
