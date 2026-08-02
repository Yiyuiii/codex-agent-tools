using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace CodexAgentTools.HostAcceptance.Tests
{
    internal static class SessionMaterialTests
    {
        internal static IEnumerable<Action> All()
        {
            yield return LoadsOnlyTheStrictDescriptorAndReceiptBoundMaterials;
            yield return MatchesTheTypeScriptCanonicalHashVectors;
            yield return AcceptsTheFullJavaScriptSafeIntegerTimeoutRange;
            yield return RejectsRegexSuffixLineBreaks;
            yield return RejectsDescriptorAndMarkerDrift;
            yield return RejectsEveryReceiptBoundArtifactDrift;
            yield return RejectsPreexistingSessionOutputs;
        }

        private static void LoadsOnlyTheStrictDescriptorAndReceiptBoundMaterials()
        {
            using (var fixture = MaterialFixture.Create())
            {
                var loaded = SessionMaterials.Load(fixture.RepositoryRoot, fixture.LocalAppData, fixture.DescriptorBytes);
                TestAssert.Equal(fixture.DescriptorSha256, loaded.Binding.DescriptorSha256, "The binding must use the exact raw descriptor hash.");
                TestAssert.Equal(fixture.RuntimeCommit, loaded.Binding.Core.RuntimeFrozenCommit, "The strict beta marker core must be retained.");
                TestAssert.Equal(
                    Path.Combine(fixture.SessionRoot, "completion-markers", MaterialFixture.MarkerId + ".marker"),
                    loaded.CompletionMarkerPath,
                    "The completion marker path must be derived only from LOCALAPPDATA, nonce, and the restricted marker id.");
                TestAssert.Equal(
                    Path.Combine(fixture.SessionRoot, "host-acceptance-receipt.v1.json"),
                    loaded.ReceiptPath,
                    "The receipt path must be fixed inside the private session root.");
            }
        }

        private static void RejectsDescriptorAndMarkerDrift()
        {
            using (var fixture = MaterialFixture.Create())
            {
                var text = Encoding.UTF8.GetString(fixture.DescriptorBytes);
                var withExtraKey = Encoding.UTF8.GetBytes(text.Substring(0, text.Length - 1) + ",\"extra\":true}");
                TestAssert.Throws<ProtocolException>(
                    () => SessionMaterials.Load(fixture.RepositoryRoot, fixture.LocalAppData, withExtraKey),
                    "Unknown descriptor keys must fail closed.");

                File.AppendAllText(fixture.MarkerPath, " ", new UTF8Encoding(false));
                TestAssert.Throws<ProtocolException>(
                    () => SessionMaterials.Load(fixture.RepositoryRoot, fixture.LocalAppData, fixture.DescriptorBytes),
                    "Any raw beta marker drift must fail closed.");
            }
        }

        private static void AcceptsTheFullJavaScriptSafeIntegerTimeoutRange()
        {
            using (var fixture = MaterialFixture.Create())
            {
                const long timeoutMs = 2147483648L;
                var loaded = SessionMaterials.Load(
                    fixture.RepositoryRoot,
                    fixture.LocalAppData,
                    fixture.DescriptorWithTimeout(timeoutMs));
                TestAssert.Equal<long?>(
                    timeoutMs,
                    loaded.Descriptor.Request.TimeoutMs,
                    "The native observer must accept every timeout representable by the TypeScript safe-integer contract.");

                TestAssert.Throws<ProtocolException>(
                    () => SessionMaterials.Load(
                        fixture.RepositoryRoot,
                        fixture.LocalAppData,
                        fixture.DescriptorWithTimeout(9007199254740992L)),
                    "Integers outside the JavaScript safe-integer contract must fail closed.");
            }
        }

        private static void MatchesTheTypeScriptCanonicalHashVectors()
        {
            var promptSha = new string('6', 64);
            var cwdSha = new string('7', 64);
            var sessionSha = new string('8', 64);
            TestAssert.Equal(
                "1fb575e3b432c8b688d7309713c5073553cd5df61143bead1847b28b93ee1688",
                SessionDescriptorParser.ComputeInputIdentitySha256("kimi-k3", promptSha, cwdSha, null, null),
                "The null timeout/session input hash must match the independently generated TypeScript vector.");
            TestAssert.Equal(
                "83f2c7e452f02710cffbf7d1fde16eae4fa2a693b5729bd94cbf03e11cef7d14",
                SessionDescriptorParser.ComputeInputIdentitySha256("kimi-k3", promptSha, cwdSha, 5000L, sessionSha),
                "The finite timeout/session input hash must match the independently generated TypeScript vector.");
            var boundaryInput = SessionDescriptorParser.ComputeInputIdentitySha256(
                "kimi-k3", promptSha, cwdSha, 9007199254740991L, null);
            TestAssert.Equal(
                "14cc275ecadf367d4c3cfd80e20b29858f5be64a93593735b4fc193456b5d75c",
                boundaryInput,
                "The safe-integer boundary input hash must match the independently generated TypeScript vector.");
            TestAssert.Equal(
                "8ce4130b90394e23235bcefba3fe08460ddbeedff6401961af71f32262f647a7",
                SessionDescriptorParser.ComputeCompletionMarkerIdentitySha256(
                    MaterialFixture.Nonce,
                    MaterialFixture.MarkerId,
                    boundaryInput),
                "The completion marker hash must match the independently generated TypeScript vector.");
        }

        private static void RejectsRegexSuffixLineBreaks()
        {
            TestAssert.Throws<ProtocolException>(
                () => ProtocolValues.Digest(new string('a', 64) + "\n"),
                "A digest with a trailing LF must not exploit .NET dollar-anchor semantics.");
            TestAssert.Throws<ProtocolException>(
                () => ProtocolValues.MarkerId(MaterialFixture.MarkerId + "\r"),
                "A marker id with a trailing CR must fail exact full-string matching.");

            using (var fixture = MaterialFixture.Create())
            {
                var bytes = Encoding.UTF8.GetBytes(
                    Encoding.UTF8.GetString(fixture.DescriptorBytes).Replace(
                        "codex-agent-tools-host-acceptance-0123456789abcdef0123456789abcdef",
                        "codex-agent-tools-host-acceptance-0123456789abcdef0123456789abcdef\\n"));
                TestAssert.Throws<ProtocolException>(
                    () => SessionDescriptorParser.Parse(bytes),
                    "A pipe name with a decoded trailing LF must fail exact full-string matching.");
            }
        }

        private static void RejectsEveryReceiptBoundArtifactDrift()
        {
            foreach (var relativePath in new[] {
                ProtocolV1.ProtocolPath,
                ProtocolV1.WindowsJobHelperPath,
                ProtocolV1.CapabilityIndexPath,
                ProtocolV1.CurrentHostFreezePrefix + MaterialFixture.RuntimeCommitValue + ProtocolV1.CurrentHostFreezeSuffix
            })
            {
                using (var fixture = MaterialFixture.Create())
                {
                    File.AppendAllText(fixture.RepositoryPath(relativePath), "drift", new UTF8Encoding(false));
                    TestAssert.Throws<ProtocolException>(
                        () => SessionMaterials.Load(fixture.RepositoryRoot, fixture.LocalAppData, fixture.DescriptorBytes),
                        "Receipt-bound material drift must fail closed: " + relativePath);
                }
            }
        }

        private static void RejectsPreexistingSessionOutputs()
        {
            using (var fixture = MaterialFixture.Create())
            {
                var existingPath = Path.Combine(
                    fixture.SessionRoot,
                    "completion-markers",
                    MaterialFixture.MarkerId + ".marker");
                File.WriteAllText(
                    existingPath,
                    "preexisting",
                    new UTF8Encoding(false));
                TestAssert.Throws<ProtocolException>(
                    () => SessionMaterials.Load(fixture.RepositoryRoot, fixture.LocalAppData, fixture.DescriptorBytes),
                    "A preexisting completion marker must fail closed before observation begins.");
                TestAssert.Equal(
                    "preexisting",
                    File.ReadAllText(existingPath, Encoding.UTF8),
                    "Rejecting a preexisting completion marker must not alter it.");
            }

            using (var fixture = MaterialFixture.Create())
            {
                var existingPath = Path.Combine(fixture.SessionRoot, "host-acceptance-receipt.v1.json");
                File.WriteAllText(
                    existingPath,
                    "preexisting",
                    new UTF8Encoding(false));
                TestAssert.Throws<ProtocolException>(
                    () => SessionMaterials.Load(fixture.RepositoryRoot, fixture.LocalAppData, fixture.DescriptorBytes),
                    "A preexisting receipt must fail closed before observation begins.");
                TestAssert.Equal(
                    "preexisting",
                    File.ReadAllText(existingPath, Encoding.UTF8),
                    "Rejecting a preexisting receipt must not alter it.");
            }
        }

        private sealed class MaterialFixture : IDisposable
        {
            internal const string Nonce = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
            internal const string MarkerId = "completion_marker_01";
            internal const string RuntimeCommitValue = "1111111111111111111111111111111111111111";

            private MaterialFixture(string root)
            {
                Root = root;
                RepositoryRoot = Path.Combine(root, "repository");
                LocalAppData = Path.Combine(root, "local-app-data");
                RuntimeCommit = RuntimeCommitValue;
                SessionRoot = Path.Combine(LocalAppData, "codex-agent-tools", "host-acceptance", "sessions", Nonce);
                Directory.CreateDirectory(Path.Combine(SessionRoot, "completion-markers"));
            }

            internal string Root { get; private set; }
            internal string RepositoryRoot { get; private set; }
            internal string LocalAppData { get; private set; }
            internal string SessionRoot { get; private set; }
            internal string RuntimeCommit { get; private set; }
            internal string MarkerPath { get; private set; }
            internal byte[] DescriptorBytes { get; private set; }
            internal string DescriptorSha256 { get; private set; }

            internal static MaterialFixture Create()
            {
                var root = Path.Combine(Path.GetTempPath(), "cat-ha-mat", Guid.NewGuid().ToString("N"));
                var fixture = new MaterialFixture(root);
                try
                {
                    Directory.CreateDirectory(fixture.RepositoryRoot);
                    var protocolSha = fixture.WriteMaterial(ProtocolV1.ProtocolPath, "protocol-v1");
                    var helperSha = fixture.WriteMaterial(ProtocolV1.WindowsJobHelperPath, "helper-v1");
                    var capabilitySha = fixture.WriteMaterial(ProtocolV1.CapabilityIndexPath, "capability-v1");
                    var freezePath = ProtocolV1.CurrentHostFreezePrefix + RuntimeCommitValue + ProtocolV1.CurrentHostFreezeSuffix;
                    var freezeSha = fixture.WriteMaterial(freezePath, "freeze-v1");

                    var observer = ObserverJson(protocolSha);
                    var markerJson = "{" +
                        "\"schemaVersion\":1,\"kind\":\"beta\"," +
                        "\"package\":{\"name\":\"codex-agent-tools\",\"version\":\"0.2.0-beta.1\",\"tag\":\"v0.2.0-beta.1\",\"npmChannel\":\"next\"}," +
                        "\"core\":{" +
                            "\"runtimeFrozenCommit\":\"" + RuntimeCommitValue + "\"," +
                            "\"canonicalRuntime\":{\"schemaVersion\":1,\"digestSha256\":\"" + Digest('4') + "\"}," +
                            "\"windowsJobHelper\":{\"path\":\"" + ProtocolV1.WindowsJobHelperPath + "\",\"sha256\":\"" + helperSha + "\"}," +
                            "\"capabilityIndex\":{\"path\":\"" + ProtocolV1.CapabilityIndexPath + "\",\"sha256\":\"" + capabilitySha + "\",\"entryCount\":8}," +
                            "\"currentHostFreeze\":{\"path\":\"" + freezePath + "\",\"sha256\":\"" + freezeSha + "\"}" +
                        "}," +
                        "\"pluginArtifactTree\":{\"schemaVersion\":1,\"digestSha256\":\"" + Digest('5') + "\"}," +
                        "\"observerArtifact\":" + observer +
                    "}";
                    fixture.MarkerPath = fixture.RepositoryPath(ProtocolV1.MarkerPrefix + "0.2.0-beta.1" + ProtocolV1.MarkerSuffix);
                    Directory.CreateDirectory(Path.GetDirectoryName(fixture.MarkerPath));
                    File.WriteAllText(fixture.MarkerPath, markerJson, new UTF8Encoding(false));
                    var markerSha = Sha256(File.ReadAllBytes(fixture.MarkerPath));

                    var promptSha = Digest('6');
                    var cwdSha = Digest('7');
                    var inputSha = SessionDescriptorParser.ComputeInputIdentitySha256("kimi-k3", promptSha, cwdSha, null, null);
                    var markerIdentity = SessionDescriptorParser.ComputeCompletionMarkerIdentitySha256(Nonce, MarkerId, inputSha);
                    var descriptorJson = "{" +
                        "\"schemaVersion\":1,\"protocolVersion\":1,\"packageName\":\"codex-agent-tools\"," +
                        "\"nonce\":\"" + Nonce + "\",\"pipeName\":\"codex-agent-tools-host-acceptance-0123456789abcdef0123456789abcdef\"," +
                        "\"publicBeta\":{" +
                            "\"version\":\"0.2.0-beta.1\",\"tag\":\"v0.2.0-beta.1\",\"taggedCommit\":\"" + Digest40('8') + "\"," +
                            "\"markerPath\":\".release-validation/v0.2.0-beta.1.json\",\"markerSha256\":\"" + markerSha + "\"," +
                            "\"pluginArtifactTreeDigestSha256\":\"" + Digest('5') + "\",\"observerArtifact\":" + observer + "," +
                            "\"npm\":{\"integrity\":\"sha512-" + new string('A', 86) + "==\",\"shasum\":\"" + Digest40('9') + "\"}" +
                        "}," +
                        "\"request\":{" +
                            "\"task\":\"delegate\",\"llm\":\"kimi-k3\",\"promptSha256\":\"" + promptSha + "\",\"cwdSha256\":\"" + cwdSha + "\"," +
                            "\"timeoutMs\":null,\"sessionIdSha256\":null,\"inputIdentitySha256\":\"" + inputSha + "\"," +
                            "\"completionMarkerId\":\"" + MarkerId + "\",\"completionMarkerIdentitySha256\":\"" + markerIdentity + "\"}" +
                    "}";
                    fixture.DescriptorBytes = Encoding.UTF8.GetBytes(descriptorJson);
                    fixture.DescriptorSha256 = Sha256(fixture.DescriptorBytes);
                    return fixture;
                }
                catch
                {
                    fixture.Dispose();
                    throw;
                }
            }

            internal string RepositoryPath(string relativePath)
            {
                return Path.Combine(RepositoryRoot, relativePath.Replace('/', Path.DirectorySeparatorChar));
            }

            internal byte[] DescriptorWithTimeout(long timeoutMs)
            {
                var promptSha = Digest('6');
                var cwdSha = Digest('7');
                var oldInputSha = SessionDescriptorParser.ComputeInputIdentitySha256("kimi-k3", promptSha, cwdSha, null, null);
                var newInputSha = SessionDescriptorParser.ComputeInputIdentitySha256("kimi-k3", promptSha, cwdSha, timeoutMs, null);
                var oldMarkerIdentity = SessionDescriptorParser.ComputeCompletionMarkerIdentitySha256(Nonce, MarkerId, oldInputSha);
                var newMarkerIdentity = SessionDescriptorParser.ComputeCompletionMarkerIdentitySha256(Nonce, MarkerId, newInputSha);
                var text = Encoding.UTF8.GetString(DescriptorBytes)
                    .Replace("\"timeoutMs\":null", "\"timeoutMs\":" + timeoutMs.ToString(System.Globalization.CultureInfo.InvariantCulture))
                    .Replace(oldInputSha, newInputSha)
                    .Replace(oldMarkerIdentity, newMarkerIdentity);
                return Encoding.UTF8.GetBytes(text);
            }

            private string WriteMaterial(string relativePath, string value)
            {
                var path = RepositoryPath(relativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                var bytes = Encoding.UTF8.GetBytes(value);
                File.WriteAllBytes(path, bytes);
                return Sha256(bytes);
            }

            private static string ObserverJson(string protocolSha)
            {
                return "{" +
                    "\"path\":\"" + ProtocolV1.ObserverPath + "\",\"sha256\":\"" + Digest('a') + "\",\"protocolVersion\":1," +
                    "\"buildManifest\":{\"path\":\"" + ProtocolV1.BuildManifestPath + "\",\"sha256\":\"" + Digest('b') + "\"}," +
                    "\"protocol\":{\"path\":\"" + ProtocolV1.ProtocolPath + "\",\"sha256\":\"" + protocolSha + "\"}," +
                    "\"inputsDigestSha256\":\"" + Digest('c') + "\"}";
            }

            private static string Digest(char value) { return new string(value, 64); }
            private static string Digest40(char value) { return new string(value, 40); }

            private static string Sha256(byte[] bytes)
            {
                using (var sha = SHA256.Create())
                {
                    var builder = new StringBuilder(64);
                    foreach (var value in sha.ComputeHash(bytes)) builder.Append(value.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
                    return builder.ToString();
                }
            }

            public void Dispose()
            {
                if (Directory.Exists(Root)) Directory.Delete(Root, true);
            }
        }
    }
}
