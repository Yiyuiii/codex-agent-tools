using System;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace CodexAgentTools.HostAcceptance
{
    internal sealed class HeldProcessIdentity : IDisposable
    {
        private readonly SafeKernelObjectHandle handle;

        private HeldProcessIdentity(uint processId, ulong creationFileTime, SafeKernelObjectHandle handle)
        {
            ProcessId = processId;
            CreationFileTime = creationFileTime;
            CreatedAt = DateTime.FromFileTimeUtc(checked((long)creationFileTime));
            IdentitySha256 = ComputeIdentitySha256(processId, creationFileTime);
            this.handle = handle;
        }

        internal uint ProcessId { get; private set; }
        internal ulong CreationFileTime { get; private set; }
        internal DateTime CreatedAt { get; private set; }
        internal string IdentitySha256 { get; private set; }
        internal bool IsExited { get { return WindowsNative.IsProcessExited(handle); } }
        internal SafeKernelObjectHandle Handle { get { return handle; } }

        internal static HeldProcessIdentity Open(uint processId)
        {
            var handle = WindowsNative.OpenProcessForObservation(processId);
            try
            {
                var identity = new HeldProcessIdentity(processId, WindowsNative.GetProcessCreationFileTime(handle), handle);
                if (identity.IsExited) throw new InvalidOperationException("host_acceptance_process_already_exited");
                return identity;
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }

        internal void WaitForExit()
        {
            WindowsNative.WaitForProcessExit(handle);
        }

        internal ProcessIdentity Snapshot()
        {
            return new ProcessIdentity(IdentitySha256, CreatedAt);
        }

        internal ExitedProcessIdentity SnapshotExited()
        {
            if (!IsExited) throw new InvalidOperationException("host_acceptance_process_not_exited");
            var exitFileTime = WindowsNative.GetProcessExitFileTime(handle);
            return new ExitedProcessIdentity(Snapshot(), DateTime.FromFileTimeUtc(checked((long)exitFileTime)));
        }

        internal static string ComputeIdentitySha256(uint processId, ulong creationFileTime)
        {
            var input = new byte[12];
            WriteUInt32LittleEndian(input, 0, processId);
            WriteUInt64LittleEndian(input, 4, creationFileTime);
            using (var sha256 = SHA256.Create())
            {
                var digest = sha256.ComputeHash(input);
                var builder = new StringBuilder(64);
                foreach (var item in digest) builder.Append(item.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
                return builder.ToString();
            }
        }

        private static void WriteUInt32LittleEndian(byte[] buffer, int offset, uint value)
        {
            for (var index = 0; index < 4; index += 1) buffer[offset + index] = unchecked((byte)(value >> (index * 8)));
        }

        private static void WriteUInt64LittleEndian(byte[] buffer, int offset, ulong value)
        {
            for (var index = 0; index < 8; index += 1) buffer[offset + index] = unchecked((byte)(value >> (index * 8)));
        }

        public void Dispose()
        {
            handle.Dispose();
        }
    }

    internal sealed class HeldProcessChain : IDisposable
    {
        internal HeldProcessChain(HeldProcessIdentity peer, HeldProcessIdentity parent, HeldProcessIdentity grandparent)
        {
            if (peer == null || parent == null || grandparent == null ||
                peer.ProcessId == parent.ProcessId || peer.ProcessId == grandparent.ProcessId || parent.ProcessId == grandparent.ProcessId ||
                grandparent.CreatedAt > parent.CreatedAt || parent.CreatedAt > peer.CreatedAt)
            {
                throw new ProtocolException();
            }
            Peer = peer;
            Parent = parent;
            Grandparent = grandparent;
        }

        internal HeldProcessIdentity Peer { get; private set; }
        internal HeldProcessIdentity Parent { get; private set; }
        internal HeldProcessIdentity Grandparent { get; private set; }

        internal static HeldProcessChain OpenFromPipe(SafeKernelObjectHandle pipe)
        {
            HeldProcessIdentity peer = null;
            HeldProcessIdentity parent = null;
            HeldProcessIdentity grandparent = null;
            try
            {
                peer = HeldProcessIdentity.Open(WindowsNative.GetPipeClientProcessId(pipe));
                parent = HeldProcessIdentity.Open(WindowsNative.GetDirectParentProcessId(peer.Handle));
                grandparent = HeldProcessIdentity.Open(WindowsNative.GetDirectParentProcessId(parent.Handle));
                var result = new HeldProcessChain(peer, parent, grandparent);
                peer = null;
                parent = null;
                grandparent = null;
                return result;
            }
            finally
            {
                if (peer != null) peer.Dispose();
                if (parent != null) parent.Dispose();
                if (grandparent != null) grandparent.Dispose();
            }
        }

        internal void WaitForExit()
        {
            Peer.WaitForExit();
            Parent.WaitForExit();
            Grandparent.WaitForExit();
        }

        internal HostChain Snapshot()
        {
            return new HostChain(Grandparent.Snapshot(), Parent.Snapshot(), Peer.Snapshot());
        }

        internal ExitedHostChain WaitForActualExits()
        {
            WaitForExit();
            return new ExitedHostChain(
                Grandparent.SnapshotExited(),
                Parent.SnapshotExited(),
                Peer.SnapshotExited());
        }

        public void Dispose()
        {
            Peer.Dispose();
            Parent.Dispose();
            Grandparent.Dispose();
        }
    }

    internal sealed class CurrentUserNamedPipeServer : IDisposable
    {
        private static readonly Regex PipeNamePattern = new Regex(ProtocolV1.PipeNamePattern, RegexOptions.CultureInvariant);
        private readonly SafeKernelObjectHandle pipe;
        private bool connected;
        private bool disposed;

        private CurrentUserNamedPipeServer(string pipePath, SafeKernelObjectHandle pipe)
        {
            PipePath = pipePath;
            this.pipe = pipe;
        }

        internal string PipePath { get; private set; }

        internal static CurrentUserNamedPipeServer Create(string pipeName)
        {
            ProtocolValues.ExactMatch(pipeName, PipeNamePattern, 128);
            var pipePath = "\\\\.\\pipe\\" + pipeName;
            return new CurrentUserNamedPipeServer(pipePath, WindowsNative.CreateCurrentUserPipe(pipePath));
        }

        internal HeldProcessChain AcceptProcessChain()
        {
            if (connected) throw new InvalidOperationException("host_acceptance_pipe_already_connected");
            WindowsNative.ConnectPipe(pipe);
            connected = true;
            return HeldProcessChain.OpenFromPipe(pipe);
        }

        internal bool HasProtectedCurrentUserOnlyDacl()
        {
            return WindowsNative.HasProtectedCurrentUserOnlyDacl(pipe);
        }

        internal byte ReadClientByte()
        {
            if (!connected) throw new InvalidOperationException("host_acceptance_pipe_not_connected");
            return WindowsNative.ReadPipeByte(pipe);
        }

        internal bool TryReadClientByte(out byte value)
        {
            if (!connected) throw new InvalidOperationException("host_acceptance_pipe_not_connected");
            return WindowsNative.TryReadPipeByte(pipe, out value);
        }

        internal void WriteClientByte(byte value)
        {
            if (!connected) throw new InvalidOperationException("host_acceptance_pipe_not_connected");
            WindowsNative.WritePipeByte(pipe, value);
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            if (connected) WindowsNative.DisconnectPipe(pipe);
            pipe.Dispose();
        }
    }
}
