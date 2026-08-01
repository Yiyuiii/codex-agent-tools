using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace CodexAgentTools.WindowsJobHelper
{
    internal interface IControlNativeApi
    {
        IntPtr GetFd3Handle();
        bool DuplicateNonInheritable(IntPtr source, out IntPtr duplicate, out int error);
        IntPtr CreateManualResetEvent(out int error);
        IntPtr Allocate(int bytes);
        void Free(IntPtr value);
        bool ReadFile(
            IntPtr handle,
            IntPtr buffer,
            uint length,
            IntPtr overlapped,
            out int error);
        bool WriteFile(
            IntPtr handle,
            IntPtr buffer,
            uint length,
            IntPtr overlapped,
            out int error);
        bool GetOverlappedResult(
            IntPtr handle,
            IntPtr overlapped,
            out uint transferred,
            bool wait,
            out int error);
        bool CancelIoEx(IntPtr handle, IntPtr overlapped, out int error);
        bool FlushFileBuffers(IntPtr handle, out int error);
        uint WaitForSingleObject(IntPtr handle, uint milliseconds, out int error);
        void CloseHandle(IntPtr handle);
    }

    internal sealed class ControlChannel : ISessionControlChannel, IDisposable
    {
        private const int ReadBufferBytes = 4096;
        private const int ErrorIoPending = 997;
        private const int ErrorOperationAborted = 995;
        private const int ErrorNotFound = 1168;
        private readonly object readGate = new object();
        private readonly object writeGate = new object();
        private readonly IControlNativeApi api;
        private readonly ControlProtocol.Decoder decoder =
            new ControlProtocol.Decoder(ControlDirection.NodeToHelper);
        private IntPtr handle;
        private PendingControlOperation pendingRead;
        private readonly List<ControlFrame> bufferedTerminates =
            new List<ControlFrame>();
        private Action<ControlReason> terminateCallback;
        private Action<ControlChannelFailureKind> failureCallback;
        private bool configRead;
        private bool readerStarted;
        private bool terminalWriteAttempted;
        private bool shuttingDown;

        private ControlChannel(IControlNativeApi api, IntPtr handle)
        {
            this.api = api;
            this.handle = handle;
        }

        internal static ControlChannel OpenFd3(IControlNativeApi api)
        {
            if (api == null)
            {
                throw new ArgumentNullException("api");
            }
            IntPtr raw = api.GetFd3Handle();
            if (raw == IntPtr.Zero || raw == new IntPtr(-1))
            {
                throw new IOException("windows_native_control_open_failed");
            }
            IntPtr duplicate;
            int error;
            if (!api.DuplicateNonInheritable(raw, out duplicate, out error) ||
                duplicate == IntPtr.Zero || duplicate == new IntPtr(-1))
            {
                throw new IOException("windows_native_control_duplicate_failed");
            }
            return new ControlChannel(api, duplicate);
        }

        public ControlFrame ReadLaunchConfig()
        {
            if (configRead || readerStarted)
            {
                throw new ProtocolViolationException();
            }
            for (;;)
            {
                byte[] bytes = ReadChunk();
                if (bytes.Length == 0)
                {
                    // Preserve a clean pre-config EOF as a channel failure, but
                    // classify an EOF inside a partial frame as protocol-invalid.
                    decoder.Finish();
                    throw new EndOfStreamException();
                }
                IList<ControlFrame> frames = decoder.Push(bytes, 0, bytes.Length);
                if (frames.Count == 0)
                {
                    continue;
                }
                if (frames[0].Type != ControlMessageType.LaunchConfig)
                {
                    throw new ProtocolViolationException();
                }
                for (int index = 1; index < frames.Count; index++)
                {
                    if (frames[index].Type != ControlMessageType.Terminate)
                    {
                        throw new ProtocolViolationException();
                    }
                    bufferedTerminates.Add(frames[index]);
                }
                configRead = true;
                return frames[0];
            }
        }

        public void StartReader(
            Action<ControlReason> terminateCallback,
            Action<ControlChannelFailureKind> failureCallback)
        {
            if (!configRead || readerStarted || terminateCallback == null || failureCallback == null)
            {
                throw new InvalidOperationException("windows_native_control_reader_invalid");
            }
            this.terminateCallback = terminateCallback;
            this.failureCallback = failureCallback;
            readerStarted = true;
            IList<ControlFrame> initialTerminates;
            lock (readGate)
            {
                initialTerminates = bufferedTerminates.ToArray();
                bufferedTerminates.Clear();
            }
            foreach (ControlFrame initialTerminate in initialTerminates)
            {
                // The frame was already observed together with CONFIG. Apply its
                // disposition before returning so launch cannot race ahead of a
                // previously received termination request.
                terminateCallback(initialTerminate.Reason);
            }
            var reader = new Thread(new ThreadStart(ReadLoop));
            reader.IsBackground = true;
            reader.Start();
        }

        public void WriteReady()
        {
            WriteFrame(ControlProtocol.EncodeReady());
        }

        public void WriteTerminal(TerminalSnapshot snapshot)
        {
            if (snapshot == null)
            {
                throw new ArgumentNullException("snapshot");
            }
            lock (writeGate)
            {
                if (terminalWriteAttempted)
                {
                    throw new InvalidOperationException("windows_native_terminal_duplicate");
                }
                terminalWriteAttempted = true;
                byte[] frame = snapshot.Kind == TerminalKind.Exit
                    ? ControlProtocol.EncodeExit(snapshot.RootExitCode, snapshot.Reason)
                    : ControlProtocol.EncodeError(
                        snapshot.Stage,
                        snapshot.Reason,
                        snapshot.Win32Code);
                WriteFrameLocked(frame);
                int error;
                if (!api.FlushFileBuffers(handle, out error))
                {
                    throw new IOException("windows_native_control_flush_failed");
                }
            }
        }

        public void ShutdownAfterTerminal()
        {
            PendingControlOperation operation = null;
            lock (readGate)
            {
                if (shuttingDown)
                {
                    return;
                }
                shuttingDown = true;
                operation = pendingRead;
                pendingRead = null;
            }

            try
            {
                if (operation != null)
                {
                    RetirePendingRead(operation);
                }
            }
            finally
            {
                IntPtr owned = handle;
                handle = IntPtr.Zero;
                if (owned != IntPtr.Zero)
                {
                    api.CloseHandle(owned);
                }
            }
        }

        public void Dispose()
        {
            ShutdownAfterTerminal();
        }

        private void ReadLoop()
        {
            try
            {
                for (;;)
                {
                    PendingControlOperation operation;
                    PendingControlEventLease waitLease = null;
                    lock (readGate)
                    {
                        if (shuttingDown)
                        {
                            return;
                        }
                        // Publishing the operation is atomic with submission, so
                        // shutdown can never miss a kernel-owned OVERLAPPED.
                        operation = PendingControlOperation.StartRead(
                            api, handle, ReadBufferBytes, ErrorIoPending);
                        if (operation.WasPending)
                        {
                            waitLease = operation.AcquireEventLease();
                        }
                        pendingRead = operation;
                    }

                    try
                    {
                        if (operation.WasPending)
                        {
                            int waitError;
                            if (api.WaitForSingleObject(
                                waitLease.Handle,
                                NativeMethods.Infinite,
                                out waitError) != NativeMethods.WaitObject0)
                            {
                                throw new IOException("windows_native_control_wait_failed");
                            }
                            waitLease.Dispose();
                            waitLease = null;
                        }

                        byte[] bytes;
                        lock (readGate)
                        {
                            if (pendingRead != operation)
                            {
                                return;
                            }
                            try
                            {
                                // The event is already signalled. Keep the operation
                                // published while completing and releasing it so
                                // shutdown cannot close the owned handle underneath
                                // GetOverlappedResult.
                                bytes = operation.CopyCompletedBytes();
                            }
                            finally
                            {
                                operation.Dispose();
                                pendingRead = null;
                            }
                        }
                        if (bytes.Length == 0)
                        {
                            // A clean EOF is only valid at a frame boundary. Finish
                            // converts a truncated header or payload into the
                            // protocol failure reported by the outer handler.
                            decoder.Finish();
                            failureCallback(ControlChannelFailureKind.EndOfFile);
                            return;
                        }
                        IList<ControlFrame> frames = decoder.Push(bytes, 0, bytes.Length);
                        foreach (ControlFrame frame in frames)
                        {
                            terminateCallback(frame.Reason);
                        }
                    }
                    finally
                    {
                        if (waitLease != null)
                        {
                            waitLease.Dispose();
                        }
                    }
                }
            }
            catch (ProtocolViolationException)
            {
                failureCallback(ControlChannelFailureKind.ProtocolInvalid);
            }
            catch
            {
                lock (readGate)
                {
                    if (shuttingDown)
                    {
                        return;
                    }
                }
                failureCallback(ControlChannelFailureKind.IoFailure);
            }
        }

        private byte[] ReadChunk()
        {
            using (var operation = PendingControlOperation.StartRead(
                api, handle, ReadBufferBytes, ErrorIoPending))
            {
                return operation.CopyCompletedBytes();
            }
        }

        private void WriteFrame(byte[] frame)
        {
            lock (writeGate)
            {
                WriteFrameLocked(frame);
            }
        }

        private void WriteFrameLocked(byte[] frame)
        {
            using (var operation = PendingControlOperation.StartWrite(
                api, handle, frame, ErrorIoPending))
            {
                if (operation.Complete() != checked((uint)frame.Length))
                {
                    throw new IOException("windows_native_control_short_write");
                }
            }
        }

        private void RetirePendingRead(PendingControlOperation operation)
        {
            if (!operation.WasPending)
            {
                operation.MarkRetired();
                operation.Dispose();
                return;
            }
            int error;
            bool cancelled = api.CancelIoEx(handle, operation.Overlapped, out error);
            if (!cancelled && error != ErrorNotFound)
            {
                throw new IOException("windows_native_control_cancel_failed");
            }
            int waitError;
            if (api.WaitForSingleObject(
                operation.EventHandle,
                NativeMethods.Infinite,
                out waitError) != NativeMethods.WaitObject0)
            {
                throw new IOException("windows_native_control_cancel_wait_failed");
            }
            uint transferred;
            bool completed = api.GetOverlappedResult(
                handle,
                operation.Overlapped,
                out transferred,
                false,
                out error);
            if (!completed && error != ErrorOperationAborted)
            {
                // The event was signalled and GetOverlappedResult returned a
                // final status. The kernel no longer owns the buffer even when
                // the operation itself failed.
                operation.MarkRetired();
                operation.Dispose();
                throw new IOException("windows_native_control_cancel_completion_failed");
            }
            operation.MarkRetired();
            operation.Dispose();
        }
    }

    internal sealed class PendingControlOperation : IDisposable
    {
        private readonly object resourceGate = new object();
        private readonly IControlNativeApi api;
        private readonly IntPtr handle;
        private readonly int capacity;
        private bool retired;
        private bool disposed;
        private int eventLeaseCount;

        internal IntPtr Buffer { get; private set; }
        internal IntPtr Overlapped { get; private set; }
        internal IntPtr EventHandle { get; private set; }
        internal bool WasPending { get; private set; }

        private PendingControlOperation(IControlNativeApi api, IntPtr handle, int capacity)
        {
            this.api = api;
            this.handle = handle;
            this.capacity = capacity;
            int error;
            EventHandle = api.CreateManualResetEvent(out error);
            if (EventHandle == IntPtr.Zero)
            {
                throw new IOException("windows_native_control_event_failed");
            }
            try
            {
                Buffer = api.Allocate(capacity);
                Overlapped = api.Allocate(Marshal.SizeOf(typeof(NativeMethods.NativeOverlapped)));
                var native = new NativeMethods.NativeOverlapped();
                native.EventHandle = EventHandle;
                Marshal.StructureToPtr(native, Overlapped, false);
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        internal static PendingControlOperation StartRead(
            IControlNativeApi api,
            IntPtr handle,
            int capacity,
            int pendingError)
        {
            var operation = new PendingControlOperation(api, handle, capacity);
            int error;
            bool completed = api.ReadFile(
                handle,
                operation.Buffer,
                checked((uint)capacity),
                operation.Overlapped,
                out error);
            if (!completed && error != pendingError)
            {
                operation.Dispose();
                throw new IOException("windows_native_control_read_failed");
            }
            operation.WasPending = !completed;
            return operation;
        }

        internal static PendingControlOperation StartWrite(
            IControlNativeApi api,
            IntPtr handle,
            byte[] bytes,
            int pendingError)
        {
            var operation = new PendingControlOperation(api, handle, bytes.Length);
            Marshal.Copy(bytes, 0, operation.Buffer, bytes.Length);
            int error;
            bool completed = api.WriteFile(
                handle,
                operation.Buffer,
                checked((uint)bytes.Length),
                operation.Overlapped,
                out error);
            if (!completed && error != pendingError)
            {
                operation.Dispose();
                throw new IOException("windows_native_control_write_failed");
            }
            operation.WasPending = !completed;
            return operation;
        }

        internal uint Complete()
        {
            uint transferred;
            int error;
            bool completed = api.GetOverlappedResult(
                handle, Overlapped, out transferred, true, out error);
            // A blocking completion query has returned a final status. Release
            // ownership before propagating an operation-level I/O failure.
            lock (resourceGate)
            {
                retired = true;
            }
            if (!completed)
            {
                throw new IOException("windows_native_control_completion_failed");
            }
            return transferred;
        }

        internal byte[] CopyCompletedBytes()
        {
            uint transferred = Complete();
            if (transferred > checked((uint)capacity))
            {
                throw new IOException("windows_native_control_overflow");
            }
            var bytes = new byte[transferred];
            if (transferred != 0)
            {
                Marshal.Copy(Buffer, bytes, 0, checked((int)transferred));
            }
            return bytes;
        }

        internal void MarkRetired()
        {
            lock (resourceGate)
            {
                retired = true;
            }
        }

        internal PendingControlEventLease AcquireEventLease()
        {
            lock (resourceGate)
            {
                if (disposed || EventHandle == IntPtr.Zero)
                {
                    throw new ObjectDisposedException("PendingControlOperation");
                }
                eventLeaseCount++;
                return new PendingControlEventLease(this, EventHandle);
            }
        }

        internal void ReleaseEventLease()
        {
            IntPtr eventToClose = IntPtr.Zero;
            lock (resourceGate)
            {
                if (eventLeaseCount <= 0)
                {
                    throw new InvalidOperationException("pending_control_event_lease_invalid");
                }
                eventLeaseCount--;
                if (disposed && eventLeaseCount == 0 && EventHandle != IntPtr.Zero)
                {
                    eventToClose = EventHandle;
                    EventHandle = IntPtr.Zero;
                }
            }
            if (eventToClose != IntPtr.Zero)
            {
                api.CloseHandle(eventToClose);
            }
        }

        public void Dispose()
        {
            IntPtr eventToClose = IntPtr.Zero;
            IntPtr bufferToFree = IntPtr.Zero;
            IntPtr overlappedToFree = IntPtr.Zero;
            lock (resourceGate)
            {
                if (disposed)
                {
                    return;
                }
                if (WasPending && !retired)
                {
                    throw new InvalidOperationException("pending_control_operation_not_retired");
                }
                disposed = true;
                if (eventLeaseCount == 0 && EventHandle != IntPtr.Zero)
                {
                    eventToClose = EventHandle;
                    EventHandle = IntPtr.Zero;
                }
                bufferToFree = Buffer;
                Buffer = IntPtr.Zero;
                overlappedToFree = Overlapped;
                Overlapped = IntPtr.Zero;
            }
            if (eventToClose != IntPtr.Zero)
            {
                api.CloseHandle(eventToClose);
            }
            if (bufferToFree != IntPtr.Zero)
            {
                api.Free(bufferToFree);
            }
            if (overlappedToFree != IntPtr.Zero)
            {
                api.Free(overlappedToFree);
            }
        }
    }

    internal sealed class PendingControlEventLease : IDisposable
    {
        private PendingControlOperation owner;
        internal IntPtr Handle { get; private set; }

        internal PendingControlEventLease(
            PendingControlOperation owner,
            IntPtr handle)
        {
            this.owner = owner;
            Handle = handle;
        }

        public void Dispose()
        {
            PendingControlOperation value = owner;
            if (value == null)
            {
                return;
            }
            owner = null;
            Handle = IntPtr.Zero;
            value.ReleaseEventLease();
        }
    }

    internal sealed class ControlNativeApi : IControlNativeApi
    {
        private const uint DuplicateSameAccess = 0x00000002;
        internal static readonly ControlNativeApi Instance = new ControlNativeApi();

        private ControlNativeApi()
        {
        }

        [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern IntPtr _get_osfhandle(int descriptor);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DuplicateHandle(
            IntPtr sourceProcess,
            IntPtr sourceHandle,
            IntPtr targetProcess,
            out IntPtr targetHandle,
            uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
            uint options);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateEventW(
            IntPtr attributes,
            [MarshalAs(UnmanagedType.Bool)] bool manualReset,
            [MarshalAs(UnmanagedType.Bool)] bool initialState,
            string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ReadFile(
            IntPtr file,
            IntPtr buffer,
            uint bytesToRead,
            IntPtr bytesRead,
            IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WriteFile(
            IntPtr file,
            IntPtr buffer,
            uint bytesToWrite,
            IntPtr bytesWritten,
            IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetOverlappedResult(
            IntPtr file,
            IntPtr overlapped,
            out uint bytesTransferred,
            [MarshalAs(UnmanagedType.Bool)] bool wait);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CancelIoEx(IntPtr file, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FlushFileBuffers(IntPtr file);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        public IntPtr GetFd3Handle() { return _get_osfhandle(3); }

        public bool DuplicateNonInheritable(
            IntPtr source,
            out IntPtr duplicate,
            out int error)
        {
            bool result = DuplicateHandle(
                NativeMethods.CurrentProcess,
                source,
                NativeMethods.CurrentProcess,
                out duplicate,
                0,
                false,
                DuplicateSameAccess);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        public IntPtr CreateManualResetEvent(out int error)
        {
            IntPtr value = CreateEventW(IntPtr.Zero, true, false, null);
            error = value == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            return value;
        }

        public IntPtr Allocate(int bytes) { return Marshal.AllocHGlobal(bytes); }
        public void Free(IntPtr value) { Marshal.FreeHGlobal(value); }

        public bool ReadFile(
            IntPtr handle,
            IntPtr buffer,
            uint length,
            IntPtr overlapped,
            out int error)
        {
            bool result = ReadFile(handle, buffer, length, IntPtr.Zero, overlapped);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        public bool WriteFile(
            IntPtr handle,
            IntPtr buffer,
            uint length,
            IntPtr overlapped,
            out int error)
        {
            bool result = WriteFile(handle, buffer, length, IntPtr.Zero, overlapped);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        public bool GetOverlappedResult(
            IntPtr handle,
            IntPtr overlapped,
            out uint transferred,
            bool wait,
            out int error)
        {
            bool result = GetOverlappedResult(handle, overlapped, out transferred, wait);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        public bool CancelIoEx(IntPtr handle, IntPtr overlapped, out int error)
        {
            bool result = CancelIoEx(handle, overlapped);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        public bool FlushFileBuffers(IntPtr handle, out int error)
        {
            bool result = FlushFileBuffers(handle);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        public uint WaitForSingleObject(IntPtr handle, uint milliseconds, out int error)
        {
            uint result = WaitForSingleObject(handle, milliseconds);
            error = result == NativeMethods.WaitFailed ? Marshal.GetLastWin32Error() : 0;
            return result;
        }

        public void CloseHandle(IntPtr handle)
        {
            NativeMethods.CloseHandle(handle);
        }
    }
}
