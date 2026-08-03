using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace CodexAgentTools.WindowsJobHelper.Tests
{
    internal static class ControlChannelTests
    {
        internal static int Run()
        {
            int count = 0;
            foreach (bool cancelAlreadyCompleted in new[] { false, true })
            {
                using (var api = new FakeControlNativeApi(
                    ControlProtocol.EncodeLaunchConfig(
                        "C:\\fixture.exe",
                        "C:\\work",
                        new string[0]),
                    cancelAlreadyCompleted))
                using (var channel = ControlChannel.OpenFd3(api))
                {
                    ControlFrame config = channel.ReadLaunchConfig();
                    TestAssert.Equal(ControlMessageType.LaunchConfig, config.Type);
                    channel.StartReader(
                        delegate(ControlReason reason)
                        {
                            throw new InvalidOperationException("unexpected_terminate");
                        },
                        delegate(ControlChannelFailureKind failure)
                        {
                            throw new InvalidOperationException("unexpected_failure");
                        });
                    TestAssert.True(api.PendingReadStarted.WaitOne(5000));

                    var terminal = new TerminalSnapshot(
                        TerminalKind.Exit,
                        ControlStage.None,
                        ControlReason.NoneOrRootExit,
                        null,
                        17);
                    channel.WriteTerminal(terminal);
                    channel.ShutdownAfterTerminal();
                    TestAssert.True(api.PendingEventClosed.WaitOne(5000));

                    TestAssert.Equal(1, api.TerminalWriteCalls);
                    TestAssert.Equal(1, api.FlushCalls);
                    TestAssert.Equal(1, api.CancelCalls);
                    TestAssert.Equal(api.OwnedControlHandle, api.CancelHandle);
                    TestAssert.Equal(api.PendingOverlapped, api.CancelOverlapped);
                    TestAssert.True(api.PendingCompletionObserved);
                    TestAssert.True(api.PendingEventClosedAfterCompletion);
                    TestAssert.Equal(1, api.PendingEventCloseCalls);
                    TestAssert.Equal(1, api.PendingBufferFreeCalls);
                    TestAssert.Equal(1, api.PendingOverlappedFreeCalls);
                    TestAssert.True(api.OwnedControlClosed);
                    TestAssert.True(!api.RawFd3Closed);
                    TestAssert.Equal("terminal-write", api.TerminalOrder[0]);
                    TestAssert.Equal("flush", api.TerminalOrder[1]);
                    TestAssert.Equal("cancel", api.TerminalOrder[2]);
                    TestAssert.Equal("completion", api.TerminalOrder[3]);
                    TestAssert.True(
                        api.TerminalOrder.IndexOf("buffer-free") > 3 &&
                        api.TerminalOrder.IndexOf("overlapped-free") > 3 &&
                        api.TerminalOrder.IndexOf("control-close") > 3);
                }
            }
            count++;

            using (var shutdownReturned = new ManualResetEvent(false))
            using (var api = new FakeControlNativeApi(
                ControlProtocol.EncodeLaunchConfig(
                    "C:\\fixture.exe",
                    "C:\\work",
                    new string[0]),
                false))
            using (var channel = ControlChannel.OpenFd3(api))
            {
                api.BlockFirstReaderWait = true;
                channel.ReadLaunchConfig();
                channel.StartReader(delegate { }, delegate { });
                TestAssert.True(api.PendingReadStarted.WaitOne(5000));
                TestAssert.True(api.ReaderWaitEntered.WaitOne(5000));
                var shutdown = new Thread(delegate()
                {
                    channel.ShutdownAfterTerminal();
                    shutdownReturned.Set();
                });
                shutdown.IsBackground = true;
                shutdown.Start();
                TestAssert.True(shutdownReturned.WaitOne(5000));

                // Logical retirement may complete, but the physical event close
                // must wait for the reader's stable lease.
                TestAssert.Equal(0, api.PendingEventCloseCalls);
                TestAssert.Equal(1, api.PendingBufferFreeCalls);
                TestAssert.Equal(1, api.PendingOverlappedFreeCalls);
                TestAssert.True(api.OwnedControlClosed);
                api.ReleaseReaderWait.Set();
                TestAssert.True(api.PendingEventClosed.WaitOne(5000));
                TestAssert.True(!api.ReaderWaitedOnClosedEvent);
                TestAssert.Equal(1, api.PendingEventCloseCalls);
            }
            count++;

            using (var callbackObserved = new ManualResetEvent(false))
            using (var api = new FakeControlNativeApi(
                ControlProtocol.EncodeLaunchConfig(
                    "C:\\fixture.exe",
                    "C:\\work",
                    new string[0]),
                false))
            using (var channel = ControlChannel.OpenFd3(api))
            {
                api.PendingReadCompletesNaturally = true;
                api.FailPendingCompletion = true;
                channel.ReadLaunchConfig();
                ControlChannelFailureKind? observedFailure = null;
                channel.StartReader(
                    delegate { },
                    delegate(ControlChannelFailureKind failure)
                    {
                        observedFailure = failure;
                        callbackObserved.Set();
                    });
                TestAssert.True(callbackObserved.WaitOne(5000));
                TestAssert.Equal(ControlChannelFailureKind.IoFailure, observedFailure.Value);
                channel.ShutdownAfterTerminal();
                TestAssert.Equal(1, api.PendingBufferFreeCalls);
                TestAssert.Equal(1, api.PendingOverlappedFreeCalls);
                TestAssert.True(api.OwnedControlClosed);
            }
            count++;

            using (var api = new FakeControlNativeApi(
                ControlProtocol.EncodeLaunchConfig(
                    "C:\\fixture.exe",
                    "C:\\work",
                    new string[0]),
                false))
            using (var channel = ControlChannel.OpenFd3(api))
            {
                api.CancelCompletionFinalError = true;
                channel.ReadLaunchConfig();
                channel.StartReader(delegate { }, delegate { });
                TestAssert.True(api.PendingReadStarted.WaitOne(5000));
                TestAssert.Throws<System.IO.IOException>(() =>
                    channel.ShutdownAfterTerminal());
                TestAssert.Equal(1, api.PendingBufferFreeCalls);
                TestAssert.Equal(1, api.PendingOverlappedFreeCalls);
                TestAssert.True(api.OwnedControlClosed);
            }
            count++;

            using (var callbackObserved = new ManualResetEvent(false))
            using (var shutdownStarted = new ManualResetEvent(false))
            using (var shutdownReturned = new ManualResetEvent(false))
            using (var api = new FakeControlNativeApi(
                ControlProtocol.EncodeLaunchConfig(
                    "C:\\fixture.exe",
                    "C:\\work",
                    new string[0]),
                false))
            using (var channel = ControlChannel.OpenFd3(api))
            {
                api.PendingReadCompletesNaturally = true;
                api.BlockPendingCompletion = true;
                channel.ReadLaunchConfig();
                channel.StartReader(
                    delegate
                    {
                        throw new InvalidOperationException("unexpected_terminate");
                    },
                    delegate(ControlChannelFailureKind failure)
                    {
                        TestAssert.Equal(ControlChannelFailureKind.EndOfFile, failure);
                        callbackObserved.Set();
                    });
                TestAssert.True(api.PendingReadStarted.WaitOne(5000));
                TestAssert.True(api.CompletionEntered.WaitOne(5000));

                var shutdown = new Thread(delegate()
                {
                    shutdownStarted.Set();
                    channel.ShutdownAfterTerminal();
                    shutdownReturned.Set();
                });
                shutdown.IsBackground = true;
                shutdown.Start();
                TestAssert.True(shutdownStarted.WaitOne(5000));

                // While the reader owns retirement, shutdown must not close the
                // control handle or return before completion releases its buffer.
                TestAssert.True(!api.OwnedControlClosedEvent.WaitOne(500));
                TestAssert.True(!shutdownReturned.WaitOne(0));
                api.ReleaseCompletion.Set();

                TestAssert.True(callbackObserved.WaitOne(5000));
                TestAssert.True(shutdownReturned.WaitOne(5000));
                TestAssert.True(!api.PendingCompletionUsedClosedControl);
                TestAssert.Equal(1, api.PendingBufferFreeCalls);
                TestAssert.Equal(1, api.PendingOverlappedFreeCalls);
                TestAssert.True(api.OwnedControlClosed);
            }
            count++;

            foreach (bool partialConfig in new[] { false, true })
            {
                byte[] initial = partialConfig
                    ? new[] { (byte)'C' }
                    : new byte[0];
                using (var api = new FakeControlNativeApi(initial, false))
                using (var channel = ControlChannel.OpenFd3(api))
                {
                    api.ReaderOutcome = ReaderOutcome.EndOfFile;
                    if (partialConfig)
                    {
                        TestAssert.Throws<ProtocolViolationException>(() =>
                            channel.ReadLaunchConfig());
                    }
                    else
                    {
                        TestAssert.Throws<System.IO.EndOfStreamException>(() =>
                            channel.ReadLaunchConfig());
                    }
                }
            }
            count++;

            byte[] mergedConfig = ControlProtocol.EncodeLaunchConfig(
                "C:\\fixture.exe",
                "C:\\work",
                new string[0]);
            byte[] mergedTerminate = ControlProtocol.EncodeTerminate(
                ControlReason.SessionShutdown);
            byte[] repeatedTerminate = ControlProtocol.EncodeTerminate(
                ControlReason.TimedOut);
            byte[] protocolTerminate = ControlProtocol.EncodeTerminate(
                ControlReason.ProtocolError);
            byte[] merged = new byte[
                mergedConfig.Length + mergedTerminate.Length +
                repeatedTerminate.Length + protocolTerminate.Length];
            Buffer.BlockCopy(mergedConfig, 0, merged, 0, mergedConfig.Length);
            Buffer.BlockCopy(
                mergedTerminate,
                0,
                merged,
                mergedConfig.Length,
                mergedTerminate.Length);
            Buffer.BlockCopy(
                repeatedTerminate,
                0,
                merged,
                mergedConfig.Length + mergedTerminate.Length,
                repeatedTerminate.Length);
            Buffer.BlockCopy(
                protocolTerminate,
                0,
                merged,
                mergedConfig.Length + mergedTerminate.Length + repeatedTerminate.Length,
                protocolTerminate.Length);
            using (var callbackObserved = new ManualResetEvent(false))
            using (var api = new FakeControlNativeApi(merged, false))
            using (var channel = ControlChannel.OpenFd3(api))
            {
                ControlFrame config = channel.ReadLaunchConfig();
                TestAssert.Equal(ControlMessageType.LaunchConfig, config.Type);
                var observed = new List<ControlReason>();
                var deliveryGate = new object();
                lock (deliveryGate)
                {
                    channel.StartReader(
                        delegate(ControlReason reason)
                        {
                            lock (deliveryGate)
                            {
                                observed.Add(reason);
                                callbackObserved.Set();
                            }
                        },
                        delegate
                        {
                            throw new InvalidOperationException("unexpected_failure");
                        });
                    TestAssert.Equal(3, observed.Count);
                    TestAssert.Equal(ControlReason.SessionShutdown, observed[0]);
                    TestAssert.Equal(ControlReason.TimedOut, observed[1]);
                    TestAssert.Equal(ControlReason.ProtocolError, observed[2]);
                }
                TestAssert.True(callbackObserved.WaitOne(5000));
                TestAssert.True(api.ReadCalls >= 1);
                channel.ShutdownAfterTerminal();
            }
            count++;

            foreach (ReaderOutcome outcome in new[] {
                ReaderOutcome.Terminate,
                ReaderOutcome.EndOfFile,
                ReaderOutcome.PartialThenEof,
                ReaderOutcome.IoFailure
            })
            {
                using (var signal = new ManualResetEvent(false))
                using (var api = new FakeControlNativeApi(
                    ControlProtocol.EncodeLaunchConfig(
                        "C:\\fixture.exe",
                        "C:\\work",
                        new string[0]),
                    false))
                using (var channel = ControlChannel.OpenFd3(api))
                {
                    api.ReaderOutcome = outcome;
                    channel.ReadLaunchConfig();
                    TestAssert.Throws<ProtocolViolationException>(() =>
                        channel.ReadLaunchConfig());
                    ControlReason observedReason = ControlReason.NoneOrRootExit;
                    ControlChannelFailureKind? observedFailure = null;
                    channel.StartReader(
                        delegate(ControlReason reason)
                        {
                            observedReason = reason;
                            signal.Set();
                        },
                        delegate(ControlChannelFailureKind failure)
                        {
                            observedFailure = failure;
                            signal.Set();
                        });
                    TestAssert.True(signal.WaitOne(5000));
                    if (outcome == ReaderOutcome.Terminate)
                    {
                        TestAssert.Equal(ControlReason.Cancelled, observedReason);
                        TestAssert.True(!observedFailure.HasValue);
                    }
                    else
                    {
                        ControlChannelFailureKind expected =
                            outcome == ReaderOutcome.PartialThenEof
                                ? ControlChannelFailureKind.ProtocolInvalid
                                : outcome == ReaderOutcome.EndOfFile
                                    ? ControlChannelFailureKind.EndOfFile
                                    : ControlChannelFailureKind.IoFailure;
                        TestAssert.Equal(expected, observedFailure.Value);
                    }
                    channel.ShutdownAfterTerminal();
                }
            }
            count++;

            using (var api = new FakeControlNativeApi(
                ControlProtocol.EncodeLaunchConfig(
                    "C:\\fixture.exe",
                    "C:\\work",
                    new string[0]),
                false))
            using (var channel = ControlChannel.OpenFd3(api))
            {
                channel.ReadLaunchConfig();
                channel.StartReader(delegate { }, delegate { });
                TestAssert.True(api.PendingReadStarted.WaitOne(5000));
                api.FailTerminalWrite = true;
                var terminal = new TerminalSnapshot(
                    TerminalKind.Exit,
                    ControlStage.None,
                    ControlReason.NoneOrRootExit,
                    null,
                    17);
                TestAssert.Throws<System.IO.IOException>(() =>
                    channel.WriteTerminal(terminal));
                TestAssert.Throws<InvalidOperationException>(() =>
                    channel.WriteTerminal(terminal));
                TestAssert.Equal(1, api.TerminalWriteCalls);
                TestAssert.Equal(0, api.FlushCalls);
                channel.ShutdownAfterTerminal();
            }
            count++;
            return count;
        }
    }

    internal enum ReaderOutcome
    {
        Pending,
        Terminate,
        EndOfFile,
        PartialThenEof,
        IoFailure
    }

    internal sealed class FakeControlNativeApi : IControlNativeApi, IDisposable
    {
        private const int ErrorIoPending = 997;
        private const int ErrorOperationAborted = 995;
        private const int ErrorNotFound = 1168;
        private readonly byte[] config;
        private readonly bool cancelAlreadyCompleted;
        private int readCalls;
        private int nextEvent = 100;
        private readonly IDictionary<IntPtr, uint> completed =
            new Dictionary<IntPtr, uint>();
        private readonly ManualResetEvent cancelIssued = new ManualResetEvent(false);
        private int readerWaitClaimed;

        internal readonly ManualResetEvent PendingReadStarted = new ManualResetEvent(false);
        internal readonly ManualResetEvent CompletionEntered = new ManualResetEvent(false);
        internal readonly ManualResetEvent ReleaseCompletion = new ManualResetEvent(false);
        internal readonly ManualResetEvent OwnedControlClosedEvent = new ManualResetEvent(false);
        internal readonly ManualResetEvent ReaderWaitEntered = new ManualResetEvent(false);
        internal readonly ManualResetEvent ReleaseReaderWait = new ManualResetEvent(false);
        internal readonly ManualResetEvent PendingEventClosed = new ManualResetEvent(false);
        internal readonly List<string> TerminalOrder = new List<string>();
        internal IntPtr OwnedControlHandle { get { return new IntPtr(20); } }
        internal IntPtr PendingOverlapped { get; private set; }
        internal IntPtr PendingBuffer { get; private set; }
        internal IntPtr PendingEvent { get; private set; }
        internal IntPtr CancelHandle { get; private set; }
        internal IntPtr CancelOverlapped { get; private set; }
        internal int TerminalWriteCalls { get; private set; }
        internal int FlushCalls { get; private set; }
        internal int CancelCalls { get; private set; }
        internal bool PendingCompletionObserved { get; private set; }
        internal bool PendingEventClosedAfterCompletion { get; private set; }
        internal bool OwnedControlClosed { get; private set; }
        internal bool RawFd3Closed { get; private set; }
        internal int PendingBufferFreeCalls { get; private set; }
        internal int PendingOverlappedFreeCalls { get; private set; }
        internal ReaderOutcome ReaderOutcome { get; set; }
        internal bool FailTerminalWrite { get; set; }
        internal bool PendingReadCompletesNaturally { get; set; }
        internal bool BlockPendingCompletion { get; set; }
        internal bool PendingCompletionUsedClosedControl { get; private set; }
        internal int ReadCalls { get { return readCalls; } }
        internal bool FailPendingCompletion { get; set; }
        internal bool CancelCompletionFinalError { get; set; }
        internal bool BlockFirstReaderWait { get; set; }
        internal bool ReaderWaitedOnClosedEvent { get; private set; }
        internal int PendingEventCloseCalls { get; private set; }

        internal FakeControlNativeApi(byte[] config, bool cancelAlreadyCompleted)
        {
            this.config = config;
            this.cancelAlreadyCompleted = cancelAlreadyCompleted;
        }

        public IntPtr GetFd3Handle()
        {
            return new IntPtr(10);
        }

        public bool DuplicateNonInheritable(
            IntPtr source,
            out IntPtr duplicate,
            out int error)
        {
            duplicate = OwnedControlHandle;
            error = 0;
            return source == new IntPtr(10);
        }

        public IntPtr CreateManualResetEvent(out int error)
        {
            error = 0;
            return new IntPtr(nextEvent++);
        }

        public IntPtr Allocate(int bytes)
        {
            return Marshal.AllocHGlobal(bytes);
        }

        public void Free(IntPtr value)
        {
            if (value == PendingBuffer)
            {
                PendingBufferFreeCalls++;
                TerminalOrder.Add("buffer-free");
            }
            else if (value == PendingOverlapped)
            {
                PendingOverlappedFreeCalls++;
                TerminalOrder.Add("overlapped-free");
            }
            Marshal.FreeHGlobal(value);
        }

        public bool ReadFile(
            IntPtr handle,
            IntPtr buffer,
            uint length,
            IntPtr overlapped,
            out int error)
        {
            readCalls++;
            if (readCalls == 1)
            {
                int bytes = Math.Min(config.Length, checked((int)length));
                Marshal.Copy(config, 0, buffer, bytes);
                completed[overlapped] = checked((uint)bytes);
                error = 0;
                return true;
            }
            if (ReaderOutcome == ReaderOutcome.Terminate && readCalls == 2)
            {
                byte[] terminate = ControlProtocol.EncodeTerminate(ControlReason.Cancelled);
                Marshal.Copy(terminate, 0, buffer, terminate.Length);
                completed[overlapped] = checked((uint)terminate.Length);
                error = 0;
                return true;
            }
            if (ReaderOutcome == ReaderOutcome.EndOfFile ||
                ReaderOutcome == ReaderOutcome.PartialThenEof && readCalls == 3)
            {
                completed[overlapped] = 0;
                error = 0;
                return true;
            }
            if (ReaderOutcome == ReaderOutcome.PartialThenEof && readCalls == 2)
            {
                Marshal.WriteByte(buffer, 0, (byte)'C');
                completed[overlapped] = 1;
                error = 0;
                return true;
            }
            if (ReaderOutcome == ReaderOutcome.IoFailure)
            {
                error = 5;
                return false;
            }
            PendingOverlapped = overlapped;
            PendingBuffer = buffer;
            PendingEvent = Marshal.ReadIntPtr(overlapped, 24);
            error = ErrorIoPending;
            PendingReadStarted.Set();
            return false;
        }

        public bool WriteFile(
            IntPtr handle,
            IntPtr buffer,
            uint length,
            IntPtr overlapped,
            out int error)
        {
            TerminalWriteCalls++;
            TerminalOrder.Add("terminal-write");
            if (FailTerminalWrite)
            {
                error = 5;
                return false;
            }
            completed[overlapped] = length;
            error = 0;
            return true;
        }

        public bool GetOverlappedResult(
            IntPtr handle,
            IntPtr overlapped,
            out uint transferred,
            bool wait,
            out int error)
        {
            if (overlapped == PendingOverlapped)
            {
                PendingCompletionObserved = true;
                TerminalOrder.Add("completion");
                CompletionEntered.Set();
                if (BlockPendingCompletion)
                {
                    ReleaseCompletion.WaitOne();
                }
                PendingCompletionUsedClosedControl = OwnedControlClosed;
                if (PendingReadCompletesNaturally)
                {
                    transferred = 0;
                    if (FailPendingCompletion)
                    {
                        error = 109;
                        return false;
                    }
                    error = 0;
                    return true;
                }
                transferred = 0;
                if (CancelCompletionFinalError)
                {
                    error = 109;
                    return false;
                }
                if (cancelAlreadyCompleted)
                {
                    error = 0;
                    return true;
                }
                error = ErrorOperationAborted;
                return false;
            }
            transferred = completed[overlapped];
            error = 0;
            return true;
        }

        public bool CancelIoEx(IntPtr handle, IntPtr overlapped, out int error)
        {
            CancelCalls++;
            CancelHandle = handle;
            CancelOverlapped = overlapped;
            TerminalOrder.Add("cancel");
            cancelIssued.Set();
            error = cancelAlreadyCompleted ? ErrorNotFound : 0;
            return !cancelAlreadyCompleted;
        }

        public bool FlushFileBuffers(IntPtr handle, out int error)
        {
            FlushCalls++;
            TerminalOrder.Add("flush");
            error = 0;
            return true;
        }

        public uint WaitForSingleObject(IntPtr handle, uint milliseconds, out int error)
        {
            if (handle == PendingEvent)
            {
                if (BlockFirstReaderWait &&
                    Interlocked.CompareExchange(ref readerWaitClaimed, 1, 0) == 0)
                {
                    ReaderWaitEntered.Set();
                    ReleaseReaderWait.WaitOne();
                    ReaderWaitedOnClosedEvent = PendingEventCloseCalls != 0;
                }
                if (!PendingReadCompletesNaturally)
                {
                    cancelIssued.WaitOne();
                }
            }
            error = 0;
            return NativeMethods.WaitObject0;
        }

        public void Dispose()
        {
            // Shutdown may return after logical retirement while the background
            // reader still owns the event lease. Unblock every fake wait and do
            // not tear down its synchronization objects until that lease is
            // observably returned.
            ReleaseReaderWait.Set();
            ReleaseCompletion.Set();
            cancelIssued.Set();
            if (PendingReadStarted.WaitOne(0))
            {
                TestAssert.True(PendingEventClosed.WaitOne(5000));
            }
            PendingReadStarted.Dispose();
            CompletionEntered.Dispose();
            ReleaseCompletion.Dispose();
            OwnedControlClosedEvent.Dispose();
            ReaderWaitEntered.Dispose();
            ReleaseReaderWait.Dispose();
            PendingEventClosed.Dispose();
            cancelIssued.Dispose();
        }

        public void CloseHandle(IntPtr handle)
        {
            if (handle == new IntPtr(10))
            {
                RawFd3Closed = true;
            }
            else if (handle == OwnedControlHandle)
            {
                OwnedControlClosed = true;
                OwnedControlClosedEvent.Set();
                TerminalOrder.Add("control-close");
            }
            else if (handle == PendingEvent)
            {
                PendingEventCloseCalls++;
                PendingEventClosedAfterCompletion = PendingCompletionObserved;
                TerminalOrder.Add("event-close");
                PendingEventClosed.Set();
            }
        }
    }
}
