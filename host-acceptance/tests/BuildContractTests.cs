using System;
using System.Collections.Generic;
using System.IO;

namespace CodexAgentTools.HostAcceptance.Tests
{
    internal static class BuildContractTests
    {
        internal static IEnumerable<Action> All()
        {
            yield return TemporaryCleanupIsNarrowAndNonRecursive;
            yield return SharedCompilerConfigurationIsConsumedWithoutCopyingIt;
            yield return GeneratedProtocolSourceIsEphemeral;
            yield return KernelBuildAndNativeScopeRemainExplicit;
        }

        private static void TemporaryCleanupIsNarrowAndNonRecursive()
        {
            var script = BuildScript();
            TestAssert.True(script.IndexOf("Remove-Item", StringComparison.Ordinal) < 0, "The observer build entry must not use broad Remove-Item cleanup.");
            TestAssert.True(script.IndexOf("Get-ChildItem -LiteralPath $resolvedRoot -Force -Recurse", StringComparison.Ordinal) < 0, "Cleanup must reject a child directory before traversal.");
            TestAssert.True(script.IndexOf("[System.IO.File]::Delete($item.FullName)", StringComparison.Ordinal) >= 0, "Cleanup must delete only verified test executables.");
            TestAssert.True(script.IndexOf("[System.IO.Directory]::Delete($resolvedRoot, $false)", StringComparison.Ordinal) >= 0, "Cleanup must delete only an empty GUID directory.");
            TestAssert.True(script.IndexOf("$name -cne \"ManagedTests.exe\"", StringComparison.Ordinal) >= 0, "Cleanup must allow only fixed test executable names.");
            TestAssert.True(script.IndexOf("$name -cne \"KernelTests.exe\"", StringComparison.Ordinal) >= 0, "Kernel test output must be explicitly allowlisted.");
            TestAssert.True(script.IndexOf("$name -cne \"ProcessFixture.exe\"", StringComparison.Ordinal) >= 0, "Fixture output must be explicitly allowlisted.");
        }

        private static void SharedCompilerConfigurationIsConsumedWithoutCopyingIt()
        {
            var script = BuildScript();
            TestAssert.True(script.IndexOf("expectedCompilerArguments", StringComparison.OrdinalIgnoreCase) < 0, "The thin entry must not copy the shared compiler argument list.");
            TestAssert.True(script.IndexOf("expectedReferences", StringComparison.OrdinalIgnoreCase) < 0, "The thin entry must not copy the shared reference list.");
            TestAssert.True(script.IndexOf("$Configuration.targetFramework -cne \"net48\"", StringComparison.Ordinal) >= 0, "The shared target framework must be structurally checked.");
            TestAssert.True(script.IndexOf("foreach ($argument in $sharedBuild.compilerArguments)", StringComparison.Ordinal) >= 0, "Compilation must consume the shared arguments.");
            TestAssert.True(script.IndexOf("foreach ($reference in $sharedBuild.references)", StringComparison.Ordinal) >= 0, "Compilation must consume the shared references.");
        }

        private static void GeneratedProtocolSourceIsEphemeral()
        {
            var repositoryRoot = Directory.GetCurrentDirectory();
            TestAssert.True(!File.Exists(Path.Combine(repositoryRoot, "host-acceptance", "src", "ProtocolV1.g.cs")), "Generated protocol source must never be tracked beside production sources.");
            var script = BuildScript();
            TestAssert.True(script.IndexOf("Write-GeneratedProtocolSource -Protocol $protocol", StringComparison.Ordinal) >= 0, "Every compile must derive protocol constants from the checked-in JSON.");
            TestAssert.True(script.IndexOf("Remove-VerifiedGeneratedProtocolSource", StringComparison.Ordinal) >= 0, "The derived source must be removed before outer cleanup.");
        }

        private static void KernelBuildAndNativeScopeRemainExplicit()
        {
            var script = BuildScript();
            TestAssert.True(script.IndexOf("[ValidateSet(\"test-managed\", \"test-kernel\")]", StringComparison.Ordinal) >= 0, "The build entry must expose only the two reviewed test actions.");
            TestAssert.True(script.IndexOf("$Action -cne \"test-managed\" -and $Action -cne \"test-kernel\"", StringComparison.Ordinal) >= 0, "The build entry must reject non-canonical action casing before selecting sources.");
            TestAssert.True(script.IndexOf("ProcessFixture.exe", StringComparison.Ordinal) >= 0, "The real kernel fixture must be built explicitly.");

            var repositoryRoot = Directory.GetCurrentDirectory();
            var native = File.ReadAllText(Path.Combine(repositoryRoot, "host-acceptance", "src", "WindowsNative.cs"));
            var chain = File.ReadAllText(Path.Combine(repositoryRoot, "host-acceptance", "src", "ProcessChain.cs"));
            foreach (var forbidden in new[] { "CreateToolhelp32Snapshot", "Process.GetProcesses", "GetProcessById", "taskkill", "Win32_Process" })
            {
                TestAssert.True(native.IndexOf(forbidden, StringComparison.OrdinalIgnoreCase) < 0, "The native observer must not contain a system process scanner.");
                TestAssert.True(chain.IndexOf(forbidden, StringComparison.OrdinalIgnoreCase) < 0, "The retained process chain must not reopen or scan by PID.");
            }
            TestAssert.True(native.IndexOf("ProcessQueryLimitedInformation", StringComparison.Ordinal) >= 0, "Process handles must request only limited query access plus synchronize.");
            TestAssert.True(native.IndexOf("FileFlagFirstPipeInstance", StringComparison.Ordinal) >= 0, "The named pipe must be the first instance.");
            TestAssert.True(native.IndexOf("PipeRejectRemoteClients", StringComparison.Ordinal) >= 0, "Remote pipe clients must be rejected.");
            TestAssert.True(native.IndexOf("WaitForSingleObject(process, Infinite)", StringComparison.Ordinal) >= 0, "Production process waits must not impose a timeout budget.");
        }

        private static string BuildScript()
        {
            return File.ReadAllText(Path.Combine(Directory.GetCurrentDirectory(), "host-acceptance", "build.ps1"));
        }
    }
}
