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
        }

        private static void TemporaryCleanupIsNarrowAndNonRecursive()
        {
            var script = BuildScript();
            TestAssert.True(script.IndexOf("Remove-Item", StringComparison.Ordinal) < 0, "The observer build entry must not use broad Remove-Item cleanup.");
            TestAssert.True(script.IndexOf("Get-ChildItem -LiteralPath $resolvedRoot -Force -Recurse", StringComparison.Ordinal) < 0, "Cleanup must reject a child directory before traversal.");
            TestAssert.True(script.IndexOf("[System.IO.File]::Delete($items[0].FullName)", StringComparison.Ordinal) >= 0, "Cleanup must delete only the verified test executable.");
            TestAssert.True(script.IndexOf("[System.IO.Directory]::Delete($resolvedRoot, $false)", StringComparison.Ordinal) >= 0, "Cleanup must delete only an empty GUID directory.");
            TestAssert.True(script.IndexOf("$item.Name -cne \"ManagedTests.exe\"", StringComparison.Ordinal) >= 0, "Cleanup must allow only the fixed test executable name.");
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

        private static string BuildScript()
        {
            return File.ReadAllText(Path.Combine(Directory.GetCurrentDirectory(), "host-acceptance", "build.ps1"));
        }
    }
}
