using System;
using System.Collections.Generic;
using System.Text;

namespace CodexAgentTools.HostAcceptance.Tests
{
    internal static class StrictJsonTests
    {
        internal static IEnumerable<Action> All()
        {
            yield return ParsesFragmentedAndCoalescedJsonLines;
            yield return RejectsDuplicateDecodedKeys;
            yield return RejectsInvalidUtf8AndRawLineBreaks;
            yield return RejectsOversizedAndUnterminatedFrames;
            yield return RejectsUnknownFrameFieldsAndTypes;
            yield return MatchesTheCheckedInProtocolContract;
            yield return RejectsStablePublicBetaVersions;
        }

        private static void ParsesFragmentedAndCoalescedJsonLines()
        {
            var decoder = new StrictJsonLineDecoder(64);
            var first = decoder.Append(Encoding.UTF8.GetBytes("{\"a\":"));
            TestAssert.Equal(0, first.Count, "An incomplete frame must remain buffered.");
            var values = decoder.Append(Encoding.UTF8.GetBytes("1}\n{\"b\":true}\n"));
            TestAssert.Equal(2, values.Count, "Coalesced frames must be split exactly at LF.");
            TestAssert.Equal("1", values[0].RequireObject().RequireNumber("a").Raw, "The first frame must remain intact.");
            TestAssert.True(values[1].RequireObject().RequireBoolean("b"), "The second frame must remain intact.");
            decoder.Complete();
        }

        private static void RejectsDuplicateDecodedKeys()
        {
            TestAssert.Throws<ProtocolException>(
                () => StrictJson.ParseUtf8(Encoding.UTF8.GetBytes("{\"a\":1,\"\\u0061\":2}"), false),
                "Equivalent decoded keys must be rejected."
            );
        }

        private static void RejectsInvalidUtf8AndRawLineBreaks()
        {
            TestAssert.Throws<ProtocolException>(
                () => StrictJson.ParseUtf8(new byte[] { 0x7b, 0x22, 0x61, 0x22, 0x3a, 0xc3, 0x28, 0x7d }, false),
                "Invalid UTF-8 must fail closed."
            );
            var decoder = new StrictJsonLineDecoder(64);
            TestAssert.Throws<ProtocolException>(
                () => decoder.Append(Encoding.UTF8.GetBytes("{\"a\":1}\r\n")),
                "CRLF is not the protocol terminator."
            );
        }

        private static void RejectsOversizedAndUnterminatedFrames()
        {
            var oversized = new StrictJsonLineDecoder(8);
            TestAssert.Throws<ProtocolException>(
                () => oversized.Append(Encoding.UTF8.GetBytes("{\"a\":12}\n")),
                "The frame byte budget includes its terminator."
            );

            var incomplete = new StrictJsonLineDecoder(64);
            incomplete.Append(Encoding.UTF8.GetBytes("{}"));
            TestAssert.Throws<ProtocolException>(
                () => incomplete.Complete(),
                "EOF before LF must be rejected."
            );
        }

        private static void RejectsUnknownFrameFieldsAndTypes()
        {
            TestAssert.Throws<ProtocolException>(
                () => ObserverFrameParser.Parse(StrictJson.ParseUtf8(Encoding.UTF8.GetBytes("{\"schemaVersion\":1,\"protocolVersion\":1,\"type\":\"MCP_SHUTDOWN\",\"nonce\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"sequence\":1}"), true).RequireObject()),
                "Unspecified global shutdown frames must not enter the protocol."
            );
            TestAssert.Throws<ProtocolException>(
                () => ObserverFrameParser.Parse(StrictJson.ParseUtf8(Encoding.UTF8.GetBytes("{\"schemaVersion\":1,\"protocolVersion\":1,\"type\":\"REQUEST_ABORTED\",\"nonce\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"sequence\":1,\"requestIdType\":\"string\",\"requestCorrelationSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"extra\":true}"), true).RequireObject()),
                "Unknown frame fields must fail closed."
            );
        }

        private static void MatchesTheCheckedInProtocolContract()
        {
            var protocolPath = System.IO.Path.Combine(
                System.IO.Directory.GetCurrentDirectory(),
                "host-acceptance", "protocol", "observer-protocol.v1.json");
            var protocol = StrictJson.ParseUtf8(System.IO.File.ReadAllBytes(protocolPath), false).RequireObject();
            TestAssert.Equal(ProtocolV1.SchemaVersion, protocol.RequireInt32("schemaVersion"), "The managed protocol schema must match the checked-in source.");
            TestAssert.Equal(ProtocolV1.ProtocolVersion, protocol.RequireInt32("protocolVersion"), "The managed protocol version must match the checked-in source.");

            var frames = protocol.RequireObject("frames");
            TestAssert.Equal(ProtocolV1.MaximumFrameBytes, frames.RequireInt32("maximumBytes"), "The frame byte budget must remain aligned.");
            TestAssert.Equal(ProtocolV1.MaximumEventsPerConnection, frames.RequireInt32("maximumEventsPerConnection"), "The connection event budget must remain aligned.");
            TestAssert.Equal(ProtocolV1.FrameTerminator, frames.RequireString("terminator"), "Only LF terminates a frame.");
            var keys = frames.RequireObject("keys");
            AssertStringArray(keys, "HELLO", ProtocolV1.HelloKeys);
            AssertStringArray(keys, "REQUEST_STARTED", ProtocolV1.RequestStartedKeys);
            AssertStringArray(keys, "REQUEST_ABORTED", ProtocolV1.RequestAbortedKeys);
            AssertStringArray(keys, "OWNED_EXIT", ProtocolV1.OwnedExitKeys);
            AssertStringArray(keys, "HANDLER_CANCELLED", ProtocolV1.HandlerCancelledKeys);
            AssertStringArray(keys, "INFLIGHT_REMOVED", ProtocolV1.InflightRemovedKeys);
            keys.RequireExactKeys(new[] { "HELLO", "REQUEST_STARTED", "REQUEST_ABORTED", "OWNED_EXIT", "HANDLER_CANCELLED", "INFLIGHT_REMOVED" });

            var domains = protocol.RequireObject("hashDomains");
            domains.RequireExactKeys(new[] { "prompt", "cwd", "sessionId", "requestInput", "completionMarker" });
            TestAssert.Equal(ProtocolV1.PromptHashDomain, domains.RequireString("prompt"), "The prompt domain must remain aligned.");
            TestAssert.Equal(ProtocolV1.CwdHashDomain, domains.RequireString("cwd"), "The cwd domain must remain aligned.");
            TestAssert.Equal(ProtocolV1.SessionIdHashDomain, domains.RequireString("sessionId"), "The session domain must remain aligned.");
            TestAssert.Equal(ProtocolV1.RequestInputHashDomain, domains.RequireString("requestInput"), "The input domain must remain aligned.");
            TestAssert.Equal(ProtocolV1.CompletionMarkerHashDomain, domains.RequireString("completionMarker"), "The marker domain must remain aligned.");

            var descriptor = protocol.RequireObject("descriptor");
            TestAssert.Equal(ProtocolV1.DescriptorMaximumBytes, descriptor.RequireInt32("maximumBytes"), "The descriptor byte budget must remain aligned.");
            TestAssert.Equal(ProtocolV1.MinimumTimeoutMs, descriptor.RequireInt32("minimumTimeoutMs"), "The minimum timeout must remain aligned.");
            TestAssert.Equal(ProtocolV1.PackageName, descriptor.RequireString("packageName"), "The package name must remain aligned.");
            TestAssert.Equal(ProtocolV1.NoncePattern, descriptor.RequireString("noncePattern"), "The nonce pattern must remain aligned.");
            TestAssert.Equal(ProtocolV1.CompletionMarkerIdPattern, descriptor.RequireString("completionMarkerIdPattern"), "The marker pattern must remain aligned.");
            TestAssert.Equal(ProtocolV1.PublicBetaVersionPattern, descriptor.RequireString("publicBetaVersionPattern"), "The beta version pattern must remain aligned.");
            TestAssert.Equal(ProtocolV1.Sha256Pattern, descriptor.RequireString("sha256Pattern"), "The digest pattern must remain aligned.");
            TestAssert.Equal(ProtocolV1.CommitPattern, descriptor.RequireString("commitPattern"), "The commit pattern must remain aligned.");
            TestAssert.Equal(ProtocolV1.NpmIntegrityPattern, descriptor.RequireString("npmIntegrityPattern"), "The integrity pattern must remain aligned.");

            var fixedPaths = descriptor.RequireObject("fixedPaths");
            TestAssert.Equal(ProtocolV1.ObserverPath, fixedPaths.RequireString("observerArtifact"), "The observer path must remain aligned.");
            TestAssert.Equal(ProtocolV1.BuildManifestPath, fixedPaths.RequireString("buildManifest"), "The manifest path must remain aligned.");
            TestAssert.Equal(ProtocolV1.ProtocolPath, fixedPaths.RequireString("protocol"), "The protocol path must remain aligned.");
        }

        private static void RejectsStablePublicBetaVersions()
        {
            TestAssert.Throws<ProtocolException>(
                () => new PublicBetaIdentity(
                    "1.0.0", "v1.0.0", HashReceiptTests.Commit('a'), ".release-validation/v1.0.0.json",
                    HashReceiptTests.Digest('b'), HashReceiptTests.Digest('c'),
                    new ObserverArtifactIdentity(
                        ProtocolV1.ObserverPath, HashReceiptTests.Digest('d'), ProtocolV1.ProtocolVersion,
                        new ArtifactIdentity(ProtocolV1.BuildManifestPath, HashReceiptTests.Digest('e')),
                        new ArtifactIdentity(ProtocolV1.ProtocolPath, HashReceiptTests.Digest('f')),
                        HashReceiptTests.Digest('1')),
                    new NpmIdentity("sha512-" + new string('A', 86) + "==", HashReceiptTests.Commit('2'))),
                "A host-acceptance session can only bind a prerelease public beta."
            );
        }

        private static void AssertStringArray(StrictJsonObject owner, string key, string[] expected)
        {
            var array = owner.Require(key) as StrictJsonArray;
            if (array == null) throw new ProtocolException();
            TestAssert.Equal(expected.Length, array.Values.Count, "The protocol key list length must remain exact.");
            for (var index = 0; index < expected.Length; index += 1)
            {
                var value = array.Values[index] as StrictJsonString;
                if (value == null) throw new ProtocolException();
                TestAssert.Equal(expected[index], value.Value, "The protocol key order must remain exact.");
            }
        }
    }
}
