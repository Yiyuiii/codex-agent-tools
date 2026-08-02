using System;
using System.IO;

namespace CodexAgentTools.HostAcceptance
{
    internal enum ObserverPhase
    {
        Ready,
        OldHostBound,
        OldHostExited,
        RequestStarted
    }

    internal interface IObserverSessionIo
    {
        IObserverPipe CreatePipe(string pipeName);
        void PublishPhase(ObserverPhase phase);
        DateTime ObserveUtcNow();
        void RequireCompletionMarkerAbsent(string path);
        void WriteReceiptNew(string path, byte[] receiptUtf8);
    }

    internal interface IObserverPipe : IDisposable
    {
        bool HasProtectedCurrentUserOnlyDacl();
        IObserverConnection Accept();
    }

    internal interface IObserverConnection : IDisposable
    {
        uint KernelPeerProcessId { get; }
        HostChain Host { get; }
        ObserverFrame ReadFrame();
        ExitedHostChain WaitForActualExits();
        void RequireCleanEof();
    }

    internal static class HostAcceptanceObserverSession
    {
        internal static void Run(VerifiedSessionMaterials materials, IObserverSessionIo io)
        {
            if (materials == null) throw new ArgumentNullException("materials");
            if (io == null) throw new ArgumentNullException("io");

            var machine = new HostAcceptanceStateMachine(materials.Binding);
            using (var pipe = RequireProtectedPipe(io.CreatePipe(materials.Descriptor.PipeName)))
            {
                io.PublishPhase(ObserverPhase.Ready);
                using (var connection = pipe.Accept())
                {
                    var hello = RequireHello(connection.ReadFrame(), connection.KernelPeerProcessId);
                    machine.ObserveOldHello(hello, connection.Host);
                    io.PublishPhase(ObserverPhase.OldHostBound);
                    var exits = connection.WaitForActualExits();
                    RequireMatchingExitedHost(connection.Host, exits);
                    machine.ObserveOldExited(
                        exits.ChatGpt.ExitedAt,
                        exits.AppServer.ExitedAt,
                        exits.KernelPeerMcp.ExitedAt);
                    connection.RequireCleanEof();
                }
            }

            using (var pipe = RequireProtectedPipe(io.CreatePipe(materials.Descriptor.PipeName)))
            {
                io.PublishPhase(ObserverPhase.OldHostExited);
                using (var connection = pipe.Accept())
                {
                    var hello = RequireHello(connection.ReadFrame(), connection.KernelPeerProcessId);
                    machine.ObserveNewHello(hello, connection.Host);
                    for (var index = 0; index < 5; index += 1)
                    {
                        machine.Observe(connection.ReadFrame(), io.ObserveUtcNow());
                        if (index == 0) io.PublishPhase(ObserverPhase.RequestStarted);
                    }
                    connection.RequireCleanEof();
                }
            }

            io.RequireCompletionMarkerAbsent(materials.CompletionMarkerPath);
            machine.ObserveCompletionMarker(false, io.ObserveUtcNow());
            io.WriteReceiptNew(materials.ReceiptPath, machine.BuildReceiptUtf8());
        }

        private static IObserverPipe RequireProtectedPipe(IObserverPipe pipe)
        {
            if (pipe == null) throw new ProtocolException();
            try
            {
                if (!pipe.HasProtectedCurrentUserOnlyDacl()) throw new ProtocolException();
                return pipe;
            }
            catch
            {
                pipe.Dispose();
                throw;
            }
        }

        private static HelloFrame RequireHello(ObserverFrame frame, uint kernelPeerProcessId)
        {
            var hello = frame as HelloFrame;
            if (hello == null || checked((uint)hello.McpPid) != kernelPeerProcessId)
            {
                throw new ProtocolException();
            }
            return hello;
        }

        private static void RequireMatchingExitedHost(HostChain host, ExitedHostChain exited)
        {
            if (host == null || exited == null ||
                !Same(host.ChatGpt, exited.ChatGpt.Process) ||
                !Same(host.AppServer, exited.AppServer.Process) ||
                !Same(host.KernelPeerMcp, exited.KernelPeerMcp.Process))
            {
                throw new ProtocolException();
            }
        }

        private static bool Same(ProcessIdentity left, ProcessIdentity right)
        {
            return left != null && right != null &&
                left.IdentitySha256 == right.IdentitySha256 && left.CreatedAt == right.CreatedAt;
        }
    }

    internal sealed class KernelObserverSessionIo : IObserverSessionIo
    {
        private readonly TextWriter output;

        internal KernelObserverSessionIo(TextWriter output)
        {
            if (output == null) throw new ArgumentNullException("output");
            this.output = output;
        }

        public IObserverPipe CreatePipe(string pipeName)
        {
            return new KernelObserverPipe(CurrentUserNamedPipeServer.Create(pipeName));
        }

        public void PublishPhase(ObserverPhase phase)
        {
            string value;
            switch (phase)
            {
                case ObserverPhase.Ready: value = "READY"; break;
                case ObserverPhase.OldHostBound: value = "OLD_HOST_BOUND"; break;
                case ObserverPhase.OldHostExited: value = "OLD_HOST_EXITED"; break;
                case ObserverPhase.RequestStarted: value = "REQUEST_STARTED"; break;
                default: throw new ProtocolException();
            }
            output.WriteLine(value);
            output.Flush();
        }

        public DateTime ObserveUtcNow()
        {
            return DateTime.UtcNow;
        }

        public void RequireCompletionMarkerAbsent(string path)
        {
            SessionMaterials.RequireOutputAbsent(path);
        }

        public void WriteReceiptNew(string path, byte[] receiptUtf8)
        {
            AtomicReceiptWriter.WriteNew(path, receiptUtf8);
        }
    }

    internal sealed class KernelObserverPipe : IObserverPipe
    {
        private readonly CurrentUserNamedPipeServer server;
        private bool accepted;

        internal KernelObserverPipe(CurrentUserNamedPipeServer server)
        {
            if (server == null) throw new ArgumentNullException("server");
            this.server = server;
        }

        public bool HasProtectedCurrentUserOnlyDacl()
        {
            return server.HasProtectedCurrentUserOnlyDacl();
        }

        public IObserverConnection Accept()
        {
            if (accepted) throw new ProtocolException();
            accepted = true;
            var chain = server.AcceptProcessChain();
            try
            {
                var connection = new KernelObserverConnection(server, chain);
                chain = null;
                return connection;
            }
            finally
            {
                if (chain != null) chain.Dispose();
            }
        }

        public void Dispose()
        {
            server.Dispose();
        }
    }

    internal sealed class KernelObserverConnection : IObserverConnection
    {
        private readonly CurrentUserNamedPipeServer server;
        private readonly HeldProcessChain chain;
        private readonly StrictJsonLineDecoder decoder = new StrictJsonLineDecoder();
        private bool eof;

        internal KernelObserverConnection(CurrentUserNamedPipeServer server, HeldProcessChain chain)
        {
            if (server == null || chain == null) throw new ArgumentNullException();
            this.server = server;
            this.chain = chain;
            KernelPeerProcessId = chain.Peer.ProcessId;
            Host = chain.Snapshot();
        }

        public uint KernelPeerProcessId { get; private set; }
        public HostChain Host { get; private set; }

        public ObserverFrame ReadFrame()
        {
            if (eof) throw new ProtocolException();
            while (true)
            {
                byte value;
                if (!server.TryReadClientByte(out value))
                {
                    eof = true;
                    decoder.Complete();
                    throw new ProtocolException();
                }
                var decoded = decoder.Append(new[] { value });
                if (decoded.Count == 0) continue;
                if (decoded.Count != 1) throw new ProtocolException();
                return ObserverFrameParser.Parse(decoded[0].RequireObject());
            }
        }

        public ExitedHostChain WaitForActualExits()
        {
            return chain.WaitForActualExits();
        }

        public void RequireCleanEof()
        {
            if (eof)
            {
                decoder.Complete();
                return;
            }
            byte value;
            while (server.TryReadClientByte(out value))
            {
                var decoded = decoder.Append(new[] { value });
                if (decoded.Count != 0) throw new ProtocolException();
            }
            eof = true;
            decoder.Complete();
        }

        public void Dispose()
        {
            chain.Dispose();
        }
    }
}
