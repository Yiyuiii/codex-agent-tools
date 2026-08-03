using System;
using System.Collections.Generic;
using System.Text;

namespace CodexAgentTools.HostAcceptance.Tests
{
    internal static class HashReceiptTests
    {
        internal static IEnumerable<Action> All()
        {
            yield return MatchesJavaScriptRequestAndEventHashDomains;
            yield return EmitsTheExactReceiptShape;
        }

        private static void MatchesJavaScriptRequestAndEventHashDomains()
        {
            var binding = HostAcceptanceHash.ComputeRequestBindingSha256(
                Digest('1'), Digest('2'), Digest('3'), Digest('4'), Digest('5'), Digest('6'), Digest('7'));
            TestAssert.Equal("5789c74d290fbeb755ce11b3632379d1e54adfdca21433483d2776e2fdbe6dae", binding, "The request binding must match the TypeScript verifier.");
            var eventHash = HostAcceptanceHash.ComputeEventSha256(
                "request-started", "2026-08-02T01:02:03.004Z", binding,
                "bound:" + Digest('6') + ":" + Digest('7'));
            TestAssert.Equal("404b1aecaf5b70f38bcbba286cb6772f166b69d0ecf7dad632c76f6c2e1a32fb", eventHash, "The event hash must match the TypeScript verifier.");
        }

        private static void EmitsTheExactReceiptShape()
        {
            var machine = StateMachineTests.CompletedMachine();
            var bytes = machine.BuildReceiptUtf8();
            var receipt = StrictJson.ParseUtf8(bytes, false).RequireObject();
            receipt.RequireExactKeys(new[] {
                "schemaVersion", "kind", "beta", "pluginArtifactTreeDigestSha256", "core",
                "observerArtifact", "session", "oldHost", "newHost", "request", "result"
            });
            TestAssert.Equal("host-acceptance", receipt.RequireString("kind"), "The receipt kind must be exact.");
            TestAssert.Equal("passed", receipt.RequireString("result"), "Only a complete state may emit passed.");
            receipt.RequireObject("beta").RequireExactKeys(new[] { "version", "tag", "taggedCommit", "npm" });
            receipt.RequireObject("request").RequireExactKeys(new[] {
                "correlationSha256", "completionMarkerIdentitySha256", "bindingSha256", "started",
                "sdkAbort", "ownedProcessExit", "ownershipDrained", "handlerCancelled",
                "inFlightRemoved", "completionMarkerChecked"
            });
            TestAssert.True(Encoding.UTF8.GetString(bytes).IndexOf("passed:true", StringComparison.Ordinal) < 0, "The receipt must not contain a second truth channel.");
        }

        internal static string Digest(char value)
        {
            return new string(value, 64);
        }

        internal static string Commit(char value)
        {
            return new string(value, 40);
        }
    }
}
