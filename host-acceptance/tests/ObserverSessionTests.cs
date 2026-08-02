using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace CodexAgentTools.HostAcceptance.Tests
{
    internal static class ObserverSessionTests
    {
        internal static IEnumerable<Action> All()
        {
            yield return PublishesOnlyAfterTheExactDisposedTwoPipeSequence;
            yield return RejectsKernelAndHelloPidMismatchWithoutWriting;
            yield return RejectsExtraFramesAndPresentMarkerWithoutWriting;
            yield return RejectsAnUnprotectedPipeBeforeReady;
            yield return ReadsExactlyOneBoundedRawDescriptor;
            yield return PublishesOnlyTheActionableFixedPhaseLines;
            yield return RedactsExecutableStartupFailures;
        }

        private static void PublishesOnlyAfterTheExactDisposedTwoPipeSequence()
        {
            var fixture = SessionFixture.Valid();
            HostAcceptanceObserverSession.Run(fixture.Materials, fixture.Io);

            TestAssert.Equal(1, fixture.Io.WriteCount, "Only the observer session may publish one receipt.");
            TestAssert.Equal(
                "create:old|dacl:old|phase:Ready|accept:old|read:old|phase:OldHostBound|wait:old|eof:old|dispose-connection:old|dispose-pipe:old|" +
                "create:new|dacl:new|phase:OldHostExited|accept:new|read:new|read:new|phase:RequestStarted|read:new|read:new|read:new|read:new|eof:new|" +
                "dispose-connection:new|dispose-pipe:new|marker-absent|write-receipt",
                string.Join("|", fixture.Io.Operations.ToArray()),
                "The second pipe must exist before OLD_HOST_EXITED, and every fallible pipe cleanup must precede the final marker check and receipt write.");
            var receipt = StrictJson.ParseUtf8(fixture.Io.ReceiptBytes, false).RequireObject();
            TestAssert.Equal("passed", receipt.RequireString("result"), "The exact session must produce the strict passed receipt.");
        }

        private static void RejectsKernelAndHelloPidMismatchWithoutWriting()
        {
            var fixture = SessionFixture.Valid();
            fixture.Old.ReplaceFirstFrame(fixture.Hello(99));
            TestAssert.Throws<ProtocolException>(
                () => HostAcceptanceObserverSession.Run(fixture.Materials, fixture.Io),
                "HELLO self-reporting must match the named-pipe kernel peer PID before the state machine accepts it.");
            TestAssert.Equal(0, fixture.Io.WriteCount, "A PID mismatch must never publish a receipt.");
            TestAssert.True(
                fixture.Io.Operations.Contains("dispose-connection:old") && fixture.Io.Operations.Contains("dispose-pipe:old"),
                "A rejected old connection must still release held handles and the first pipe.");
        }

        private static void RejectsExtraFramesAndPresentMarkerWithoutWriting()
        {
            var extra = SessionFixture.Valid();
            extra.New.CleanEof = false;
            TestAssert.Throws<ProtocolException>(
                () => HostAcceptanceObserverSession.Run(extra.Materials, extra.Io),
                "Any extra or residual new-host frame must fail strict EOF.");
            TestAssert.Equal(0, extra.Io.WriteCount, "Extra frames must never publish a receipt.");

            var marker = SessionFixture.Valid();
            marker.Io.MarkerAbsent = false;
            TestAssert.Throws<ProtocolException>(
                () => HostAcceptanceObserverSession.Run(marker.Materials, marker.Io),
                "The derived completion marker must still be absent after every connection and handle has been disposed.");
            TestAssert.Equal(0, marker.Io.WriteCount, "A present completion marker must never publish a receipt.");
            TestAssert.True(
                marker.Io.Operations.IndexOf("dispose-pipe:new") < marker.Io.Operations.IndexOf("marker-absent"),
                "The final marker observation must follow all pipe cleanup.");
        }

        private static void RejectsAnUnprotectedPipeBeforeReady()
        {
            var fixture = SessionFixture.Valid();
            fixture.Old.Protected = false;
            TestAssert.Throws<ProtocolException>(
                () => HostAcceptanceObserverSession.Run(fixture.Materials, fixture.Io),
                "READY must not be published for a pipe without the exact protected current-user ACL.");
            TestAssert.Equal(0, fixture.Io.WriteCount, "An unprotected pipe must never publish a receipt.");
            TestAssert.True(!fixture.Io.Operations.Contains("phase:Ready"), "READY must follow the DACL proof.");
        }

        private static void ReadsExactlyOneBoundedRawDescriptor()
        {
            var expected = new byte[] { 0x7b, 0x7d };
            TestAssert.Equal(
                expected.Length,
                Program.ReadBoundedDescriptor(new MemoryStream(expected, false)).Length,
                "The executable must read the raw descriptor bytes through EOF without text normalization.");
            TestAssert.Throws<ProtocolException>(
                () => Program.ReadBoundedDescriptor(new MemoryStream(new byte[0], false)),
                "An empty stdin payload must fail closed.");
            var maximum = new byte[ProtocolV1.DescriptorMaximumBytes];
            TestAssert.Equal(
                maximum.Length,
                Program.ReadBoundedDescriptor(new MemoryStream(maximum, false)).Length,
                "The exact descriptor byte maximum must remain accepted.");
            TestAssert.Throws<ProtocolException>(
                () => Program.ReadBoundedDescriptor(
                    new MemoryStream(new byte[ProtocolV1.DescriptorMaximumBytes + 1], false)),
                "Any byte beyond the descriptor maximum must fail closed.");
        }

        private static void PublishesOnlyTheActionableFixedPhaseLines()
        {
            var output = new StringWriter(new StringBuilder(), System.Globalization.CultureInfo.InvariantCulture);
            var io = new KernelObserverSessionIo(output);
            io.PublishPhase(ObserverPhase.Ready);
            io.PublishPhase(ObserverPhase.OldHostBound);
            io.PublishPhase(ObserverPhase.OldHostExited);
            io.PublishPhase(ObserverPhase.RequestStarted);
            TestAssert.Equal(
                "READY\r\nOLD_HOST_BOUND\r\nOLD_HOST_EXITED\r\nREQUEST_STARTED\r\n",
                output.ToString(),
                "The launcher control surface must contain only fixed action-gating lines and no PASS line.");
        }

        private static void RedactsExecutableStartupFailures()
        {
            const string secret = "SUPER_SECRET_DESCRIPTOR_OR_ARGUMENT";
            foreach (var invocation in new[] {
                new { Args = new[] { secret }, Bytes = new byte[] { 0x7b, 0x7d } },
                new { Args = new string[0], Bytes = Encoding.UTF8.GetBytes(secret) }
            })
            {
                var output = new StringWriter(System.Globalization.CultureInfo.InvariantCulture);
                var error = new StringWriter(System.Globalization.CultureInfo.InvariantCulture);
                var exitCode = Program.Run(
                    invocation.Args,
                    new MemoryStream(invocation.Bytes, false),
                    output,
                    error,
                    "C:\\" + secret,
                    "C:\\" + secret);
                TestAssert.Equal(1, exitCode, "Invalid executable startup input must return the fixed failure exit code.");
                TestAssert.Equal(string.Empty, output.ToString(), "Startup failure must not emit READY or PASS output.");
                TestAssert.Equal(
                    "host-acceptance: failed\r\n",
                    error.ToString(),
                    "Startup failure must emit exactly one fixed non-secret stderr line.");
                TestAssert.True(error.ToString().IndexOf(secret, StringComparison.Ordinal) < 0, "Startup failure must redact arguments, descriptor bytes, and paths.");
            }
        }

        private sealed class SessionFixture
        {
            private SessionFixture(VerifiedSessionMaterials materials, FakeSessionIo io, FakePipe oldPipe, FakePipe newPipe)
            {
                Materials = materials;
                Io = io;
                Old = oldPipe;
                New = newPipe;
            }

            internal VerifiedSessionMaterials Materials { get; private set; }
            internal FakeSessionIo Io { get; private set; }
            internal FakePipe Old { get; private set; }
            internal FakePipe New { get; private set; }

            internal static SessionFixture Valid()
            {
                var binding = StateMachineTests.FixtureBinding();
                var request = new SessionRequestIdentity(
                    "kimi-k3", HashReceiptTests.Digest('3'), HashReceiptTests.Digest('4'), null, null,
                    binding.InputIdentitySha256, binding.CompletionMarkerId, binding.CompletionMarkerIdentitySha256);
                var descriptor = new SessionDescriptor(
                    StateMachineTests.Nonce,
                    "codex-agent-tools-host-acceptance-0123456789abcdef0123456789abcdef",
                    binding.DescriptorSha256,
                    binding.PublicBeta,
                    request);
                var materials = new VerifiedSessionMaterials(
                    descriptor,
                    binding,
                    "C:\\fixed-session\\completion-markers\\completion_marker_01.marker",
                    "C:\\fixed-session\\host-acceptance-receipt.v1.json");

                var operations = new List<string>();
                var oldHost = new HostChain(Process('1', 1), Process('2', 2), Process('3', 3));
                var oldExited = new ExitedHostChain(
                    new ExitedProcessIdentity(oldHost.ChatGpt, At(4)),
                    new ExitedProcessIdentity(oldHost.AppServer, At(5)),
                    new ExitedProcessIdentity(oldHost.KernelPeerMcp, At(6)));
                var newHost = new HostChain(Process('4', 7), Process('5', 8), Process('6', 9));
                var oldPipe = new FakePipe("old", operations, 42, oldHost, oldExited, new ObserverFrame[] {
                    Hello(binding, 42)
                });
                var correlation = HashReceiptTests.Digest('d');
                var newPipe = new FakePipe("new", operations, 52, newHost, null, new ObserverFrame[] {
                    Hello(binding, 52),
                    StateMachineTests.RequestStarted(),
                    new RequestAbortedFrame(StateMachineTests.Nonce, 2, "string", correlation),
                    new OwnedExitFrame(StateMachineTests.Nonce, 3, "string", correlation, "cancelled", true),
                    new HandlerCancelledFrame(StateMachineTests.Nonce, 4, "string", correlation),
                    new InflightRemovedFrame(StateMachineTests.Nonce, 5, "string", correlation)
                });
                var io = new FakeSessionIo(operations, oldPipe, newPipe);
                return new SessionFixture(materials, io, oldPipe, newPipe);
            }

            internal HelloFrame Hello(int pid)
            {
                return Hello(Materials.Binding, pid);
            }

            private static HelloFrame Hello(HostAcceptanceBinding binding, int pid)
            {
                return new HelloFrame(
                    StateMachineTests.Nonce, 0, binding.DescriptorSha256,
                    binding.PublicBeta, pid, ProtocolV1.PackageName, binding.PublicBeta.Version);
            }

            private static ProcessIdentity Process(char digest, int millisecond)
            {
                return new ProcessIdentity(HashReceiptTests.Digest(digest), At(millisecond));
            }

            private static DateTime At(int millisecond)
            {
                return StateMachineTests.At(millisecond);
            }
        }

        private sealed class FakeSessionIo : IObserverSessionIo
        {
            private readonly Queue<FakePipe> pipes;

            internal FakeSessionIo(List<string> operations, params FakePipe[] pipes)
            {
                Operations = operations;
                this.pipes = new Queue<FakePipe>(pipes);
                MarkerAbsent = true;
            }

            internal List<string> Operations { get; private set; }
            internal bool MarkerAbsent { get; set; }
            internal int WriteCount { get; private set; }
            internal byte[] ReceiptBytes { get; private set; }

            public IObserverPipe CreatePipe(string pipeName)
            {
                if (pipes.Count == 0) throw new ProtocolException();
                var pipe = pipes.Dequeue();
                Operations.Add("create:" + pipe.Name);
                return pipe;
            }

            public void PublishPhase(ObserverPhase phase)
            {
                Operations.Add("phase:" + phase.ToString());
            }

            public DateTime ObserveUtcNow()
            {
                return StateMachineTests.At(10 + Operations.Count);
            }

            public void RequireCompletionMarkerAbsent(string path)
            {
                Operations.Add("marker-absent");
                if (!MarkerAbsent) throw new ProtocolException();
            }

            public void WriteReceiptNew(string path, byte[] receiptUtf8)
            {
                Operations.Add("write-receipt");
                WriteCount += 1;
                ReceiptBytes = receiptUtf8;
            }
        }

        private sealed class FakePipe : IObserverPipe
        {
            private readonly List<string> operations;
            private readonly FakeConnection connection;

            internal FakePipe(
                string name,
                List<string> operations,
                uint peerPid,
                HostChain host,
                ExitedHostChain exits,
                ObserverFrame[] frames)
            {
                Name = name;
                this.operations = operations;
                Protected = true;
                connection = new FakeConnection(name, operations, peerPid, host, exits, frames);
            }

            internal string Name { get; private set; }
            internal bool Protected { get; set; }
            internal bool CleanEof { get { return connection.CleanEof; } set { connection.CleanEof = value; } }
            internal void ReplaceFirstFrame(ObserverFrame frame) { connection.ReplaceFirstFrame(frame); }
            public bool HasProtectedCurrentUserOnlyDacl() { operations.Add("dacl:" + Name); return Protected; }
            public IObserverConnection Accept() { operations.Add("accept:" + Name); return connection; }
            public void Dispose() { operations.Add("dispose-pipe:" + Name); }
        }

        private sealed class FakeConnection : IObserverConnection
        {
            private readonly string name;
            private readonly List<string> operations;
            private readonly List<ObserverFrame> frames;
            private readonly ExitedHostChain exits;
            private int frameIndex;

            internal FakeConnection(string name, List<string> operations, uint peerPid, HostChain host, ExitedHostChain exits, ObserverFrame[] frames)
            {
                this.name = name;
                this.operations = operations;
                KernelPeerProcessId = peerPid;
                Host = host;
                this.exits = exits;
                this.frames = new List<ObserverFrame>(frames);
                CleanEof = true;
            }

            public uint KernelPeerProcessId { get; private set; }
            public HostChain Host { get; private set; }
            internal bool CleanEof { get; set; }
            public ObserverFrame ReadFrame()
            {
                operations.Add("read:" + name);
                if (frameIndex >= frames.Count) throw new ProtocolException();
                return frames[frameIndex++];
            }
            public ExitedHostChain WaitForActualExits()
            {
                operations.Add("wait:" + name);
                if (exits == null) throw new ProtocolException();
                return exits;
            }
            public void RequireCleanEof()
            {
                operations.Add("eof:" + name);
                if (!CleanEof || frameIndex != frames.Count) throw new ProtocolException();
            }
            internal void ReplaceFirstFrame(ObserverFrame frame) { frames[0] = frame; }
            public void Dispose() { operations.Add("dispose-connection:" + name); }
        }
    }
}
