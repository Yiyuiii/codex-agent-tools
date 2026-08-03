using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;

namespace CodexAgentTools.HostAcceptance.Tests
{
    internal static class KernelObserverSessionTests
    {
        private const string Nonce = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
        private const string MarkerId = "completion_marker_01";
        private const string PidToken = "__MCP_PID__";
        private const string MismatchedPidToken = "__MCP_PID_MISMATCH__";

        internal static int Run(string fixturePath)
        {
            CompletesTheRealTwoConnectionKernelSession(fixturePath);
            RejectsARealKernelPeerPidMismatchWithoutReceipt(fixturePath);
            return 2;
        }

        private static void CompletesTheRealTwoConnectionKernelSession(string fixturePath)
        {
            using (var temporary = new PrivateKernelSessionDirectory())
            using (var phases = new PhaseCaptureWriter())
            {
                var pipeName = NewPipeName();
                var materials = CreateMaterials(temporary.Root, pipeName);
                var session = new BackgroundObserverSession(materials, phases);
                session.Start();
                phases.WaitFor("READY");
                TestAssert.True(!File.Exists(materials.ReceiptPath), "READY alone must never publish the receipt.");

                ProcessIdentity oldChat;
                using (var oldFixture = StartJsonFixture(fixturePath, pipeName, BuildHello(materials, PidToken), temporary.BarrierPath))
                {
                    phases.WaitFor("OLD_HOST_BOUND");
                    using (var heldOldChat = HeldProcessIdentity.Open(checked((uint)oldFixture.Id)))
                    {
                        oldChat = heldOldChat.Snapshot();
                        TestAssert.True(!heldOldChat.IsExited, "The real old ChatGPT fixture ancestor must remain live before release.");
                    }
                    TestAssert.True(!oldFixture.HasExited, "The entire old three-level fixture must remain live before release.");
                    TestAssert.True(!phases.Contains("OLD_HOST_EXITED"), "OLD_HOST_EXITED must not precede the release of all three old processes.");
                    TestAssert.True(!File.Exists(materials.ReceiptPath), "The old bound host must not publish a receipt.");
                    AssertFirstInstanceAlreadyExists(pipeName, "The first protected pipe must remain the unique first instance while the old host is bound.");

                    temporary.WriteBarrier();
                    TestAssert.True(oldFixture.WaitForExit(10000), "The released old fixture must exit under the test-local watchdog.");
                    TestAssert.Equal(0, oldFixture.ExitCode, "The released old three-level fixture must exit cleanly.");
                }

                phases.WaitFor("OLD_HOST_EXITED");
                TestAssert.True(!File.Exists(materials.ReceiptPath), "Recreating the second pipe must still not publish a receipt.");
                AssertFirstInstanceAlreadyExists(pipeName, "OLD_HOST_EXITED may be published only after the same-name protected FIRST instance has been recreated.");
                temporary.RemoveBarrier();

                ProcessIdentity newChat;
                using (var newFixture = StartJsonFixture(fixturePath, pipeName, BuildNewConnectionPayload(materials), temporary.BarrierPath))
                {
                    using (var heldNewChat = HeldProcessIdentity.Open(checked((uint)newFixture.Id)))
                    {
                        newChat = heldNewChat.Snapshot();
                        TestAssert.True(!heldNewChat.IsExited, "The real new ChatGPT fixture ancestor must remain live while the request frames are delivered.");
                    }
                    phases.WaitFor("REQUEST_STARTED");
                    TestAssert.True(!File.Exists(materials.ReceiptPath), "The observer must require the exact terminal EOF before publishing a receipt.");
                    temporary.WriteBarrier();
                    TestAssert.True(newFixture.WaitForExit(10000), "The released new fixture must exit under the test-local watchdog.");
                    TestAssert.Equal(0, newFixture.ExitCode, "The released new three-level fixture must exit cleanly.");
                }

                session.WaitForCompletion();
                TestAssert.True(session.Error == null, "The real two-connection observer session must complete without an exception. " + Describe(session.Error));
                TestAssert.True(File.Exists(materials.ReceiptPath), "Only the complete real kernel session may publish a receipt.");
                TestAssert.Equal(
                    "READY|OLD_HOST_BOUND|OLD_HOST_EXITED|REQUEST_STARTED",
                    phases.Joined,
                    "The kernel session must publish only the four actionable phases in exact order.");
                AssertStrictPassedReceipt(materials.ReceiptPath, oldChat, newChat);
            }
        }

        private static void RejectsARealKernelPeerPidMismatchWithoutReceipt(string fixturePath)
        {
            using (var temporary = new PrivateKernelSessionDirectory())
            using (var phases = new PhaseCaptureWriter())
            {
                var pipeName = NewPipeName();
                var materials = CreateMaterials(temporary.Root, pipeName);
                var session = new BackgroundObserverSession(materials, phases);
                session.Start();
                phases.WaitFor("READY");

                using (var fixture = StartJsonFixture(fixturePath, pipeName, BuildHello(materials, MismatchedPidToken), temporary.BarrierPath))
                {
                    session.WaitForCompletion();
                    TestAssert.True(session.Error is ProtocolException, "A real kernel-peer/self-reported PID mismatch must fail as protocol evidence.");
                    TestAssert.True(!phases.Contains("OLD_HOST_BOUND"), "A mismatched HELLO must fail before the old host is bound.");
                    TestAssert.True(!File.Exists(materials.ReceiptPath), "A real PID mismatch must never publish a receipt.");
                    temporary.WriteBarrier();
                    TestAssert.True(fixture.WaitForExit(10000), "The rejected PID fixture must exit under the test-local watchdog.");
                    TestAssert.Equal(0, fixture.ExitCode, "The rejected fixture itself must still close cleanly after release.");
                }
            }
        }

        private static VerifiedSessionMaterials CreateMaterials(string root, string pipeName)
        {
            var observer = new ObserverArtifactIdentity(
                ProtocolV1.ObserverPath,
                Digest('a'),
                ProtocolV1.ProtocolVersion,
                new ArtifactIdentity(ProtocolV1.BuildManifestPath, Digest('b')),
                new ArtifactIdentity(ProtocolV1.ProtocolPath, Digest('c')),
                Digest('e'));
            var beta = new PublicBetaIdentity(
                "0.2.0-beta.1",
                "v0.2.0-beta.1",
                Commit('f'),
                ".release-validation/v0.2.0-beta.1.json",
                Digest('a'),
                Digest('b'),
                observer,
                new NpmIdentity("sha512-" + new string('A', 86) + "==", Commit('c')));
            var runtimeCommit = Commit('d');
            var core = new ReleaseCoreIdentity(
                runtimeCommit,
                new VersionedArtifactIdentity(1, Digest('e')),
                new ArtifactIdentity(ProtocolV1.WindowsJobHelperPath, Digest('f')),
                new CountedArtifactIdentity(ProtocolV1.CapabilityIndexPath, Digest('1'), 8),
                new ArtifactIdentity(ProtocolV1.CurrentHostFreezePrefix + runtimeCommit + ProtocolV1.CurrentHostFreezeSuffix, Digest('2')));
            var binding = new HostAcceptanceBinding(
                Nonce,
                Digest('7'),
                beta,
                core,
                Digest('8'),
                MarkerId,
                Digest('9'));
            var request = new SessionRequestIdentity(
                "kimi-k3", Digest('3'), Digest('4'), null, null,
                binding.InputIdentitySha256, binding.CompletionMarkerId, binding.CompletionMarkerIdentitySha256);
            var descriptor = new SessionDescriptor(Nonce, pipeName, binding.DescriptorSha256, beta, request);
            var markerDirectory = Path.Combine(root, "completion-markers");
            Directory.CreateDirectory(markerDirectory);
            return new VerifiedSessionMaterials(
                descriptor,
                binding,
                Path.Combine(markerDirectory, MarkerId + ".marker"),
                Path.Combine(root, "host-acceptance-receipt.v1.json"));
        }

        private static string BuildHello(VerifiedSessionMaterials materials, string pidExpression)
        {
            var beta = materials.Binding.PublicBeta;
            var observer = beta.ObserverArtifact;
            return
                "{\"schemaVersion\":1,\"protocolVersion\":1,\"type\":\"HELLO\",\"nonce\":\"" + Nonce +
                "\",\"sequence\":0,\"descriptorSha256\":\"" + materials.Binding.DescriptorSha256 +
                "\",\"publicBeta\":{" +
                "\"version\":\"" + beta.Version + "\",\"tag\":\"" + beta.Tag + "\",\"taggedCommit\":\"" + beta.TaggedCommit +
                "\",\"markerPath\":\"" + beta.MarkerPath + "\",\"markerSha256\":\"" + beta.MarkerSha256 +
                "\",\"pluginArtifactTreeDigestSha256\":\"" + beta.PluginArtifactTreeDigestSha256 +
                "\",\"observerArtifact\":{" +
                "\"path\":\"" + observer.Path + "\",\"sha256\":\"" + observer.Sha256 + "\",\"protocolVersion\":1," +
                "\"buildManifest\":{\"path\":\"" + observer.BuildManifest.Path + "\",\"sha256\":\"" + observer.BuildManifest.Sha256 + "\"}," +
                "\"protocol\":{\"path\":\"" + observer.Protocol.Path + "\",\"sha256\":\"" + observer.Protocol.Sha256 + "\"}," +
                "\"inputsDigestSha256\":\"" + observer.InputsDigestSha256 + "\"}," +
                "\"npm\":{\"integrity\":\"" + beta.Npm.Integrity + "\",\"shasum\":\"" + beta.Npm.Shasum + "\"}}," +
                "\"mcp\":{\"pid\":" + pidExpression + ",\"packageName\":\"" + ProtocolV1.PackageName + "\",\"version\":\"" + beta.Version + "\"}}\n";
        }

        private static string BuildNewConnectionPayload(VerifiedSessionMaterials materials)
        {
            var correlation = Digest('d');
            return BuildHello(materials, PidToken) +
                "{\"schemaVersion\":1,\"protocolVersion\":1,\"type\":\"REQUEST_STARTED\",\"nonce\":\"" + Nonce + "\",\"sequence\":1,\"requestIdType\":\"string\",\"requestCorrelationSha256\":\"" + correlation + "\",\"inputIdentitySha256\":\"" + materials.Binding.InputIdentitySha256 + "\",\"completionMarkerId\":\"" + materials.Binding.CompletionMarkerId + "\",\"completionMarkerIdentitySha256\":\"" + materials.Binding.CompletionMarkerIdentitySha256 + "\",\"descriptorSha256\":\"" + materials.Binding.DescriptorSha256 + "\"}\n" +
                "{\"schemaVersion\":1,\"protocolVersion\":1,\"type\":\"REQUEST_ABORTED\",\"nonce\":\"" + Nonce + "\",\"sequence\":2,\"requestIdType\":\"string\",\"requestCorrelationSha256\":\"" + correlation + "\"}\n" +
                "{\"schemaVersion\":1,\"protocolVersion\":1,\"type\":\"OWNED_EXIT\",\"nonce\":\"" + Nonce + "\",\"sequence\":3,\"requestIdType\":\"string\",\"requestCorrelationSha256\":\"" + correlation + "\",\"completion\":\"cancelled\",\"ownershipDrained\":true}\n" +
                "{\"schemaVersion\":1,\"protocolVersion\":1,\"type\":\"HANDLER_CANCELLED\",\"nonce\":\"" + Nonce + "\",\"sequence\":4,\"requestIdType\":\"string\",\"requestCorrelationSha256\":\"" + correlation + "\"}\n" +
                "{\"schemaVersion\":1,\"protocolVersion\":1,\"type\":\"INFLIGHT_REMOVED\",\"nonce\":\"" + Nonce + "\",\"sequence\":5,\"requestIdType\":\"string\",\"requestCorrelationSha256\":\"" + correlation + "\"}\n";
        }

        private static Process StartJsonFixture(string fixturePath, string pipeName, string payload, string barrierPath)
        {
            var start = new ProcessStartInfo {
                FileName = fixturePath,
                Arguments = "--ancestor-json " + pipeName + " " + Convert.ToBase64String(new UTF8Encoding(false, true).GetBytes(payload)) + " " + Quote(barrierPath),
                WorkingDirectory = Path.GetDirectoryName(fixturePath),
                UseShellExecute = false,
                CreateNoWindow = true
            };
            var process = Process.Start(start);
            if (process == null) throw new InvalidOperationException("host_acceptance_fixture_start_failed");
            return process;
        }

        private static void AssertFirstInstanceAlreadyExists(string pipeName, string message)
        {
            TestAssert.Throws<InvalidOperationException>(delegate
            {
                using (var competing = CurrentUserNamedPipeServer.Create(pipeName)) { }
            }, message);
        }

        private static void AssertStrictPassedReceipt(string path, ProcessIdentity expectedOldChat, ProcessIdentity expectedNewChat)
        {
            var receipt = StrictJson.ParseUtf8(File.ReadAllBytes(path), false).RequireObject();
            receipt.RequireExactKeys(new[] {
                "schemaVersion", "kind", "beta", "pluginArtifactTreeDigestSha256", "core",
                "observerArtifact", "session", "oldHost", "newHost", "request", "result"
            });
            TestAssert.Equal(1, receipt.RequireInt32("schemaVersion"), "The real receipt schema must remain exact.");
            TestAssert.Equal("host-acceptance", receipt.RequireString("kind"), "The real receipt kind must remain exact.");
            TestAssert.Equal("passed", receipt.RequireString("result"), "The complete real session must emit the strict passed result.");

            var identities = new HashSet<string>(StringComparer.Ordinal);
            var oldHost = receipt.RequireObject("oldHost");
            var oldChat = RequireExitedProcess(oldHost, "chatGpt", identities);
            var oldApp = RequireExitedProcess(oldHost, "appServer", identities);
            var oldMcp = RequireExitedProcess(oldHost, "kernelPeerMcp", identities);
            var newHost = receipt.RequireObject("newHost");
            var newChat = RequireLiveProcess(newHost, "chatGpt", identities);
            var newApp = RequireLiveProcess(newHost, "appServer", identities);
            var newMcp = RequireLiveProcess(newHost, "kernelPeerMcp", identities);
            TestAssert.Equal(6, identities.Count, "The receipt must retain six distinct real kernel process identities.");
            TestAssert.Equal(expectedOldChat.IdentitySha256, oldChat.IdentitySha256, "The old receipt root identity must match the independently opened fixture ancestor.");
            TestAssert.Equal(expectedNewChat.IdentitySha256, newChat.IdentitySha256, "The new receipt root identity must match the independently opened fixture ancestor.");
            TestAssert.True(oldChat.CreatedAt <= oldApp.CreatedAt && oldApp.CreatedAt <= oldMcp.CreatedAt, "The old real creation timeline must be ordered.");
            TestAssert.True(newChat.CreatedAt <= newApp.CreatedAt && newApp.CreatedAt <= newMcp.CreatedAt, "The new real creation timeline must be ordered.");
            TestAssert.True(oldChat.ExitedAt > oldChat.CreatedAt && oldApp.ExitedAt > oldApp.CreatedAt && oldMcp.ExitedAt > oldMcp.CreatedAt, "Every old exit timestamp must be read from an already-held process handle.");
            TestAssert.True(Max(oldChat.ExitedAt, oldApp.ExitedAt, oldMcp.ExitedAt) < newChat.CreatedAt, "The real new host must be created only after every old host process exits.");

            var request = receipt.RequireObject("request");
            TestAssert.True(request.RequireObject("started").RequireBoolean("observed"), "The request-started event must be present.");
            TestAssert.True(request.RequireObject("sdkAbort").RequireBoolean("observed"), "The SDK-abort event must be present.");
            TestAssert.True(request.RequireObject("ownedProcessExit").RequireBoolean("observed"), "The owned-process exit event must be present.");
            TestAssert.True(request.RequireObject("ownershipDrained").RequireBoolean("observed"), "The ownership-drained event must be present.");
            TestAssert.True(request.RequireObject("handlerCancelled").RequireBoolean("observed"), "The handler-cancelled event must be present.");
            TestAssert.True(request.RequireObject("inFlightRemoved").RequireBoolean("observed"), "The in-flight removal event must be present.");
            TestAssert.True(request.RequireObject("completionMarkerChecked").RequireBoolean("absent"), "The exact completion marker must remain absent.");
        }

        private static ExitedReceiptProcess RequireExitedProcess(StrictJsonObject host, string role, HashSet<string> identities)
        {
            var process = host.RequireObject(role);
            process.RequireExactKeys(new[] { "identitySha256", "createdAt", "exitedAt" });
            var identity = process.RequireString("identitySha256");
            TestAssert.True(identities.Add(identity), "Every real old/new process identity must be unique.");
            return new ExitedReceiptProcess(identity, ParseTimestamp(process.RequireString("createdAt")), ParseTimestamp(process.RequireString("exitedAt")));
        }

        private static ReceiptProcess RequireLiveProcess(StrictJsonObject host, string role, HashSet<string> identities)
        {
            var process = host.RequireObject(role);
            process.RequireExactKeys(new[] { "identitySha256", "createdAt" });
            var identity = process.RequireString("identitySha256");
            TestAssert.True(identities.Add(identity), "Every real old/new process identity must be unique.");
            return new ReceiptProcess(identity, ParseTimestamp(process.RequireString("createdAt")));
        }

        private static DateTime ParseTimestamp(string value)
        {
            return DateTime.ParseExact(
                value,
                "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
        }

        private static DateTime Max(DateTime first, DateTime second, DateTime third)
        {
            var result = first > second ? first : second;
            return result > third ? result : third;
        }

        private static string Describe(Exception error)
        {
            return error == null ? string.Empty : error.GetType().FullName + ": " + error.Message;
        }

        private static string Quote(string value)
        {
            if (string.IsNullOrEmpty(value) || value.IndexOf('"') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            {
                throw new InvalidOperationException("host_acceptance_fixture_argument_invalid");
            }
            return "\"" + value + "\"";
        }

        private static string NewPipeName()
        {
            return "codex-agent-tools-host-acceptance-" + Guid.NewGuid().ToString("N");
        }

        private static string Digest(char value)
        {
            return new string(value, 64);
        }

        private static string Commit(char value)
        {
            return new string(value, 40);
        }

        private class ReceiptProcess
        {
            internal ReceiptProcess(string identitySha256, DateTime createdAt)
            {
                IdentitySha256 = identitySha256;
                CreatedAt = createdAt;
            }

            internal string IdentitySha256 { get; private set; }
            internal DateTime CreatedAt { get; private set; }
        }

        private sealed class ExitedReceiptProcess : ReceiptProcess
        {
            internal ExitedReceiptProcess(string identitySha256, DateTime createdAt, DateTime exitedAt)
                : base(identitySha256, createdAt)
            {
                ExitedAt = exitedAt;
            }

            internal DateTime ExitedAt { get; private set; }
        }

        private sealed class BackgroundObserverSession
        {
            private readonly VerifiedSessionMaterials materials;
            private readonly PhaseCaptureWriter phases;
            private readonly ManualResetEvent completed = new ManualResetEvent(false);
            private Thread thread;

            internal BackgroundObserverSession(VerifiedSessionMaterials materials, PhaseCaptureWriter phases)
            {
                this.materials = materials;
                this.phases = phases;
            }

            internal Exception Error { get; private set; }

            internal void Start()
            {
                if (thread != null) throw new InvalidOperationException("host_acceptance_test_session_already_started");
                thread = new Thread(new ThreadStart(delegate
                {
                    try
                    {
                        HostAcceptanceObserverSession.Run(materials, new KernelObserverSessionIo(phases));
                    }
                    catch (Exception error)
                    {
                        Error = error;
                    }
                    finally
                    {
                        completed.Set();
                    }
                }));
                thread.IsBackground = true;
                thread.Start();
            }

            internal void WaitForCompletion()
            {
                TestAssert.True(completed.WaitOne(TimeSpan.FromSeconds(10)), "The observer session must complete under the test-local watchdog.");
                TestAssert.True(thread.Join(TimeSpan.FromSeconds(10)), "The completed observer thread must terminate under the test-local watchdog.");
                completed.Dispose();
            }
        }

        private sealed class PhaseCaptureWriter : TextWriter
        {
            private readonly object sync = new object();
            private readonly List<string> phases = new List<string>();
            private readonly AutoResetEvent changed = new AutoResetEvent(false);

            public override Encoding Encoding { get { return Encoding.UTF8; } }

            public override void WriteLine(string value)
            {
                lock (sync)
                {
                    phases.Add(value);
                }
                changed.Set();
            }

            internal bool Contains(string value)
            {
                lock (sync)
                {
                    return phases.Contains(value);
                }
            }

            internal string Joined
            {
                get
                {
                    lock (sync)
                    {
                        return string.Join("|", phases.ToArray());
                    }
                }
            }

            internal void WaitFor(string value)
            {
                var deadline = DateTime.UtcNow.AddSeconds(10);
                while (!Contains(value))
                {
                    var remaining = deadline - DateTime.UtcNow;
                    TestAssert.True(remaining > TimeSpan.Zero && changed.WaitOne(remaining), "The expected kernel observer phase was not published under the test-local watchdog: " + value);
                }
            }

            protected override void Dispose(bool disposing)
            {
                if (disposing) changed.Dispose();
                base.Dispose(disposing);
            }
        }

        private sealed class PrivateKernelSessionDirectory : IDisposable
        {
            private readonly string baseRoot;

            internal PrivateKernelSessionDirectory()
            {
                baseRoot = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "cat-ha-kernel"));
                Directory.CreateDirectory(baseRoot);
                Root = Path.Combine(baseRoot, Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(Root);
                BarrierPath = Path.Combine(Root, "release.barrier");
            }

            internal string Root { get; private set; }
            internal string BarrierPath { get; private set; }

            internal void WriteBarrier()
            {
                using (var stream = new FileStream(BarrierPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.WriteThrough))
                {
                    stream.WriteByte(1);
                    stream.Flush(true);
                }
            }

            internal void RemoveBarrier()
            {
                File.Delete(BarrierPath);
            }

            public void Dispose()
            {
                if (!Directory.Exists(Root)) return;
                var fullRoot = Path.GetFullPath(Root).TrimEnd(Path.DirectorySeparatorChar);
                Guid parsed;
                if (!string.Equals(Path.GetDirectoryName(fullRoot), baseRoot, StringComparison.OrdinalIgnoreCase) ||
                    !Guid.TryParseExact(Path.GetFileName(fullRoot), "N", out parsed) ||
                    (File.GetAttributes(fullRoot) & FileAttributes.ReparsePoint) != 0)
                {
                    throw new InvalidOperationException("host_acceptance_test_cleanup_target_invalid");
                }
                Directory.Delete(fullRoot, true);
            }
        }
    }
}
