using System;
using System.Collections.Generic;
using System.Threading;

namespace CodexAgentTools.WindowsJobHelper.Tests
{
    internal static class SessionCoordinatorTests
    {
        internal static int Run()
        {
            int count = 0;
            ControlFrame config = ControlFrame.LaunchConfig(
                "C:\\fixture.exe",
                "C:\\work",
                new string[0]);

            foreach (InitialReadFailure readFailure in new[] {
                InitialReadFailure.Protocol,
                InitialReadFailure.EndOfFile,
                InitialReadFailure.Io
            })
            {
                var initialSession = new FakeSessionKernel(new uint[] { 0 });
                var initialChannel = new FakeSessionControlChannel();
                initialChannel.ConfigToRead = config;
                initialChannel.InitialReadFailure = readFailure;
                int initialStatus = new SessionCoordinator(
                    initialSession,
                    initialChannel).Run();
                TestAssert.Equal(1, initialStatus);
                TestAssert.Equal(0, initialSession.CreateCalls);
                TestAssert.Equal(0, initialSession.ResumeCalls);
                TestAssert.Equal(1, initialChannel.TerminalWrites);
                TestAssert.Equal(1, initialChannel.ShutdownCalls);
                TestAssert.Equal(
                    readFailure == InitialReadFailure.Protocol
                        ? ControlStage.ProtocolInvalid
                        : ControlStage.ControlChannelFailed,
                    initialChannel.Terminal.Stage);
            }
            count++;

            foreach (ControlReason bufferedReason in new[] {
                ControlReason.SessionShutdown,
                ControlReason.ProtocolError
            })
            {
                var bufferedStopSession = new FakeSessionKernel(new uint[] { 0 });
                var bufferedStopChannel = new FakeSessionControlChannel();
                bufferedStopChannel.EmitTerminateOnStart = bufferedReason;
                int bufferedStopStatus = new SessionCoordinator(
                    bufferedStopSession,
                    bufferedStopChannel).Run(config);
                TestAssert.Equal(1, bufferedStopStatus);
                TestAssert.Equal(0, bufferedStopSession.CreateCalls);
                TestAssert.Equal(0, bufferedStopSession.ResumeCalls);
                TestAssert.Equal(
                    bufferedReason == ControlReason.ProtocolError
                        ? ControlStage.ProtocolInvalid
                        : ControlStage.CancelledBeforeReady,
                    bufferedStopChannel.Terminal.Stage);
                TestAssert.Equal(bufferedReason, bufferedStopChannel.Terminal.Reason);
            }
            count++;

            var natural = new FakeSessionKernel(new uint[] { 2, 0 });
            var naturalChannel = new FakeSessionControlChannel();
            int naturalStatus = new SessionCoordinator(natural, naturalChannel).Run(config);
            TestAssert.Equal(0, naturalStatus);
            TestAssert.Equal(1, natural.TerminateCalls);
            TestAssert.Equal(1, naturalChannel.TerminalWrites);
            TestAssert.Equal(TerminalKind.Exit, naturalChannel.Terminal.Kind);
            TestAssert.Equal(ControlReason.NoneOrRootExit, naturalChannel.Terminal.Reason);
            TestAssert.Equal(1, natural.DisposeCalls);
            count++;

            foreach (bool failResume in new[] { false, true })
            {
                using (var completed = new ManualResetEvent(false))
                {
                    var preReadySession = new FakeSessionKernel(new uint[] { 0 });
                    preReadySession.StopAfterCreate = !failResume;
                    preReadySession.FailResume = failResume;
                    var preReadyChannel = new FakeSessionControlChannel();
                    int preReadyStatus = -1;
                    Exception preReadyFailure = null;
                    var coordinator = new Thread(delegate()
                    {
                        try
                        {
                            preReadyStatus = new SessionCoordinator(
                                preReadySession,
                                preReadyChannel).Run(config);
                        }
                        catch (Exception failure)
                        {
                            preReadyFailure = failure;
                        }
                        finally
                        {
                            completed.Set();
                        }
                    });
                    coordinator.IsBackground = true;
                    coordinator.Start();
                    TestAssert.True(completed.WaitOne(5000));
                    TestAssert.True(preReadyFailure == null);
                    TestAssert.Equal(1, preReadyStatus);
                    TestAssert.Equal(1, preReadySession.TerminateCalls);
                    TestAssert.True(preReadySession.Lifecycle.JobWasZero);
                    TestAssert.Equal(1, preReadySession.DisposeCalls);
                }
            }
            count++;

            using (var completed = new ManualResetEvent(false))
            {
                var waitFailureSession = new FakeSessionKernel(new uint[] { 0 });
                waitFailureSession.FailRootWait = true;
                var waitFailureChannel = new FakeSessionControlChannel();
                int waitFailureStatus = -1;
                var coordinator = new Thread(delegate()
                {
                    try
                    {
                        waitFailureStatus = new SessionCoordinator(
                            waitFailureSession,
                            waitFailureChannel).Run(config);
                    }
                    finally
                    {
                        completed.Set();
                    }
                });
                coordinator.IsBackground = true;
                coordinator.Start();
                if (!completed.WaitOne(5000))
                {
                    throw new InvalidOperationException("wait_failure_deadlock");
                }
                TestAssert.Equal(1, waitFailureStatus);
                TestAssert.Equal(1, waitFailureSession.TerminateCalls);
                if (!waitFailureSession.Lifecycle.JobWasZero)
                {
                    throw new InvalidOperationException("wait_failure_job_not_zero");
                }
                if (waitFailureSession.Lifecycle.RootWasCompleted)
                {
                    throw new InvalidOperationException("wait_failure_false_root_complete");
                }
                TestAssert.Equal(ControlStage.WaitFailed, waitFailureSession.Lifecycle.FailureStage);
                TestAssert.Equal(1, waitFailureSession.DisposeCalls);
            }
            count++;

            foreach (ControlReason reason in new[] {
                ControlReason.Cancelled,
                ControlReason.TimedOut,
                ControlReason.SessionShutdown
            })
            {
                var explicitSession = new FakeSessionKernel(new uint[] { 0 });
                var explicitChannel = new FakeSessionControlChannel();
                explicitChannel.OnReady = delegate
                {
                    explicitChannel.EmitTerminate(reason);
                    explicitChannel.EmitTerminate(ControlReason.Cancelled);
                };
                int status = new SessionCoordinator(explicitSession, explicitChannel).Run(config);
                TestAssert.Equal(0, status);
                TestAssert.Equal(1, explicitSession.TerminateCalls);
                TestAssert.Equal(1, explicitChannel.TerminalWrites);
                TestAssert.Equal(TerminalKind.Exit, explicitChannel.Terminal.Kind);
                TestAssert.Equal(reason, explicitChannel.Terminal.Reason);
                TestAssert.Equal(1, explicitSession.DisposeCalls);
            }
            count++;

            var protocolStopSession = new FakeSessionKernel(new uint[] { 0 });
            var protocolStopChannel = new FakeSessionControlChannel();
            protocolStopChannel.OnReady = delegate
            {
                protocolStopChannel.EmitTerminate(ControlReason.ProtocolError);
            };
            int protocolStopStatus = new SessionCoordinator(
                protocolStopSession,
                protocolStopChannel).Run(config);
            TestAssert.Equal(1, protocolStopStatus);
            TestAssert.Equal(1, protocolStopSession.TerminateCalls);
            TestAssert.Equal(TerminalKind.Error, protocolStopChannel.Terminal.Kind);
            TestAssert.Equal(ControlStage.ProtocolInvalid, protocolStopChannel.Terminal.Stage);
            TestAssert.Equal(ControlReason.ProtocolError, protocolStopChannel.Terminal.Reason);
            count++;

            foreach (ControlChannelFailureKind failure in new[] {
                ControlChannelFailureKind.ProtocolInvalid,
                ControlChannelFailureKind.EndOfFile,
                ControlChannelFailureKind.IoFailure
            })
            {
                var failedSession = new FakeSessionKernel(new uint[] { 0 });
                var failedChannel = new FakeSessionControlChannel();
                failedChannel.OnReady = delegate { failedChannel.EmitFailure(failure); };
                int status = new SessionCoordinator(failedSession, failedChannel).Run(config);
                TestAssert.Equal(1, status);
                TestAssert.Equal(1, failedSession.TerminateCalls);
                TestAssert.Equal(1, failedChannel.TerminalWrites);
                TestAssert.Equal(TerminalKind.Error, failedChannel.Terminal.Kind);
                TestAssert.Equal(
                    failure == ControlChannelFailureKind.ProtocolInvalid
                        ? ControlStage.ProtocolInvalid
                        : ControlStage.ControlChannelFailed,
                    failedChannel.Terminal.Stage);
                TestAssert.Equal(1, failedChannel.ShutdownCalls);
                TestAssert.Equal(1, failedSession.DisposeCalls);
            }
            count++;

            foreach (CleanupFault fault in new[] {
                CleanupFault.Terminate,
                CleanupFault.FirstQuery,
                CleanupFault.QueryAfterTerminate
            })
            {
                var cleanupSession = new FakeSessionKernel(
                    fault == CleanupFault.FirstQuery
                        ? new uint[] { 1 }
                        : new uint[] { 0 });
                cleanupSession.Fault = fault;
                var cleanupChannel = new FakeSessionControlChannel();
                if (fault == CleanupFault.Terminate)
                {
                    cleanupChannel.OnReady = delegate
                    {
                        cleanupChannel.EmitTerminate(ControlReason.Cancelled);
                    };
                }
                else if (fault == CleanupFault.QueryAfterTerminate)
                {
                    cleanupChannel.OnReady = delegate
                    {
                        cleanupChannel.EmitFailure(
                            ControlChannelFailureKind.ProtocolInvalid);
                    };
                }
                int status = new SessionCoordinator(cleanupSession, cleanupChannel).Run(config);
                if (status != 1)
                {
                    throw new InvalidOperationException("cleanup_status_" + fault.ToString());
                }
                if (cleanupChannel.TerminalWrites != 1)
                {
                    throw new InvalidOperationException("cleanup_terminal_count_" + fault.ToString());
                }
                if (cleanupChannel.Terminal == null ||
                    cleanupChannel.Terminal.Kind != TerminalKind.Error)
                {
                    throw new InvalidOperationException("cleanup_terminal_kind_" + fault.ToString());
                }
                ControlStage expectedStage = fault == CleanupFault.Terminate
                    ? ControlStage.TerminateJobFailed
                    : fault == CleanupFault.FirstQuery
                        ? ControlStage.QueryJobFailed
                        : ControlStage.ProtocolInvalid;
                if (cleanupChannel.Terminal.Stage != expectedStage)
                {
                    throw new InvalidOperationException("cleanup_stage_" + fault.ToString());
                }
                if (cleanupSession.DisposeCalls != 1)
                {
                    throw new InvalidOperationException("cleanup_dispose_" + fault.ToString());
                }
            }
            count++;

            var terminalEvents = new List<string>();
            var terminalSession = new FakeSessionKernel(new uint[] { 0 });
            terminalSession.Events = terminalEvents;
            var terminalChannel = new FakeSessionControlChannel();
            terminalChannel.Events = terminalEvents;
            terminalChannel.FailTerminalWrite = true;
            int terminalStatus = new SessionCoordinator(
                terminalSession,
                terminalChannel).Run(config);
            if (terminalStatus != 1) { throw new InvalidOperationException("terminal_status"); }
            if (terminalSession.TerminateCalls != 1)
            {
                throw new InvalidOperationException("terminal_natural_zero_terminate");
            }
            if (terminalSession.ReserveCalls != 1) { throw new InvalidOperationException("terminal_reserve"); }
            if (terminalChannel.TerminalWrites != 1) { throw new InvalidOperationException("terminal_writes"); }
            if (terminalChannel.ShutdownCalls != 1) { throw new InvalidOperationException("terminal_shutdown"); }
            if (terminalSession.DisposeCalls != 1) { throw new InvalidOperationException("terminal_dispose"); }
            if (terminalSession.Lifecycle.Terminal != TerminalKind.Exit)
            {
                throw new InvalidOperationException("terminal_kind");
            }
            string terminalSequence = String.Join(",", terminalEvents.ToArray());
            if (terminalSequence !=
                "resume,ready-write,terminate,jobzero,reserve,terminal,shutdown,dispose")
            {
                throw new InvalidOperationException("terminal_sequence_" + terminalSequence);
            }
            count++;

            var shutdownFailureSession = new FakeSessionKernel(new uint[] { 0 });
            var shutdownFailureChannel = new FakeSessionControlChannel();
            shutdownFailureChannel.FailShutdown = true;
            int shutdownFailureStatus = new SessionCoordinator(
                shutdownFailureSession,
                shutdownFailureChannel).Run(config);
            TestAssert.Equal(1, shutdownFailureStatus);
            TestAssert.Equal(1, shutdownFailureChannel.TerminalWrites);
            TestAssert.Equal(1, shutdownFailureChannel.ShutdownCalls);
            TestAssert.Equal(1, shutdownFailureSession.DisposeCalls);
            count++;

            var readyEvents = new List<string>();
            var readyFailureSession = new FakeSessionKernel(new uint[] { 0 });
            readyFailureSession.Events = readyEvents;
            var readyFailureChannel = new FakeSessionControlChannel();
            readyFailureChannel.Events = readyEvents;
            readyFailureChannel.FailReadyWrite = true;
            int readyFailureStatus = new SessionCoordinator(
                readyFailureSession,
                readyFailureChannel).Run(config);
            if (readyFailureStatus != 1)
            {
                throw new InvalidOperationException("ready_failure_status");
            }
            if (readyFailureSession.TerminateCalls != 1)
            {
                throw new InvalidOperationException("ready_failure_terminate");
            }
            if (readyFailureChannel.TerminalWrites != 0)
            {
                throw new InvalidOperationException("ready_failure_terminal");
            }
            if (readyFailureSession.ReserveCalls != 1)
            {
                throw new InvalidOperationException(
                    "ready_failure_reserve_" + readyFailureSession.ReserveCalls.ToString());
            }
            string readySequence = String.Join(",", readyEvents.ToArray());
            if (readySequence != "resume,ready-write,terminate,jobzero,shutdown,dispose")
            {
                throw new InvalidOperationException("ready_failure_sequence_" + readySequence);
            }
            count++;

            return count;
        }
    }

    internal enum CleanupFault
    {
        None,
        Terminate,
        FirstQuery,
        QueryAfterTerminate
    }

    internal enum InitialReadFailure
    {
        None,
        Protocol,
        EndOfFile,
        Io
    }

    internal sealed class FakeSessionKernel : ISessionKernel
    {
        private readonly object gate = new object();
        private readonly Queue<uint> activeProcesses;
        private LifecycleMachine lifecycle = LifecycleMachine.Initial;
        private uint queryCalls;
        private bool reserved;
        private bool hasRootProcess;

        internal CleanupFault Fault { get; set; }
        internal int TerminateCalls { get; private set; }
        internal int DisposeCalls { get; private set; }
        internal int ReserveCalls { get; private set; }
        internal int CreateCalls { get; private set; }
        internal int ResumeCalls { get; private set; }
        internal IList<string> Events { get; set; }
        internal bool StopAfterCreate { get; set; }
        internal bool FailResume { get; set; }
        internal bool FailRootWait { get; set; }

        internal FakeSessionKernel(IEnumerable<uint> activeProcesses)
        {
            this.activeProcesses = new Queue<uint>(activeProcesses);
        }

        public LifecycleMachine Lifecycle
        {
            get
            {
                lock (gate)
                {
                    return lifecycle;
                }
            }
        }
        public bool HasRootProcess { get { return hasRootProcess; } }

        public void PrepareJob()
        {
            lock (gate)
            {
                lifecycle = lifecycle.Apply(LifecycleActor.Launcher, LifecycleEvent.JobPrepared);
            }
        }

        public void CreateSuspended(string executable, string cwd, IEnumerable<string> arguments)
        {
            lock (gate)
            {
                CreateCalls++;
                lifecycle = lifecycle.Apply(LifecycleActor.Launcher, LifecycleEvent.BeginCreate);
                lifecycle = lifecycle.Apply(LifecycleActor.Launcher, LifecycleEvent.CreateSucceeded);
                hasRootProcess = true;
                if (StopAfterCreate)
                {
                    lifecycle = lifecycle.Apply(
                        LifecycleActor.ControlReader,
                        LifecycleEvent.TerminateCancelled);
                }
            }
        }

        public void ResumeAndPublishReady(Action readyWriter)
        {
            lock (gate)
            {
                ResumeCalls++;
                if (FailResume)
                {
                    lifecycle = lifecycle.ApplyFailure(
                        LifecycleActor.Launcher,
                        ControlStage.ResumeFailed);
                    throw new JobSessionException(ControlStage.ResumeFailed, 5);
                }
                lifecycle = lifecycle.Apply(LifecycleActor.Launcher, LifecycleEvent.ResumeSucceeded);
                AddEvent("resume");
                try
                {
                    readyWriter();
                }
                catch
                {
                    lifecycle = lifecycle.ApplyFailure(
                        LifecycleActor.Launcher,
                        ControlStage.ControlChannelFailed);
                    throw new JobSessionException(ControlStage.ControlChannelFailed, 0);
                }
                lifecycle = lifecycle.Apply(LifecycleActor.Launcher, LifecycleEvent.ReadyPublished);
            }
        }

        public void RequestStop(ControlReason reason)
        {
            LifecycleEvent value = reason == ControlReason.Cancelled
                ? LifecycleEvent.TerminateCancelled
                : reason == ControlReason.TimedOut
                    ? LifecycleEvent.TerminateTimedOut
                    : LifecycleEvent.TerminateSessionShutdown;
            lock (gate)
            {
                lifecycle = lifecycle.Apply(LifecycleActor.ControlReader, value);
            }
        }

        public void ReportControlFailure(bool protocolInvalid)
        {
            lock (gate)
            {
                lifecycle = lifecycle.Apply(
                    LifecycleActor.ControlReader,
                    protocolInvalid ? LifecycleEvent.ProtocolError : LifecycleEvent.ControlEof);
            }
        }

        public bool WaitForRootExit(uint milliseconds)
        {
            lock (gate)
            {
                if (FailRootWait)
                {
                    lifecycle = lifecycle.ApplyFailure(
                        LifecycleActor.RootWaiter,
                        ControlStage.WaitFailed);
                    throw new JobSessionException(ControlStage.WaitFailed, 5);
                }
                lifecycle = lifecycle.Apply(LifecycleActor.RootWaiter, LifecycleEvent.RootCompleted);
                return true;
            }
        }

        public uint ReadRootExitCode()
        {
            return 17;
        }

        public void TerminateOwnedJob()
        {
            lock (gate)
            {
                TerminateCalls++;
                AddEvent("terminate");
                if (Fault == CleanupFault.Terminate)
                {
                    lifecycle = lifecycle.ApplyFailure(
                        LifecycleActor.CleanupOwner,
                        ControlStage.TerminateJobFailed);
                    throw new JobSessionException(ControlStage.TerminateJobFailed, 5);
                }
            }
        }

        public uint QueryActiveProcesses()
        {
            lock (gate)
            {
                queryCalls++;
                if (Fault == CleanupFault.FirstQuery && queryCalls == 1 ||
                    Fault == CleanupFault.QueryAfterTerminate && TerminateCalls > 0)
                {
                    lifecycle = lifecycle.ApplyFailure(
                        LifecycleActor.CleanupOwner,
                        ControlStage.QueryJobFailed);
                    throw new JobSessionException(ControlStage.QueryJobFailed, 5);
                }
                return activeProcesses.Count == 0 ? 0 : activeProcesses.Dequeue();
            }
        }

        public void RecordJobZero()
        {
            lock (gate)
            {
                lifecycle = lifecycle.Apply(LifecycleActor.CleanupOwner, LifecycleEvent.JobZero);
                AddEvent("jobzero");
            }
        }

        public TerminalSnapshot TryReserveTerminal()
        {
            lock (gate)
            {
                ReserveCalls++;
                if (reserved)
                {
                    return null;
                }
                TerminalKind kind = lifecycle.FailureStage == ControlStage.None
                    ? TerminalKind.Exit
                    : TerminalKind.Error;
                lifecycle = lifecycle.Apply(
                    LifecycleActor.TerminalWriter,
                    kind == TerminalKind.Exit ? LifecycleEvent.SealExit : LifecycleEvent.SealError);
                reserved = true;
                AddEvent("reserve");
                return new TerminalSnapshot(
                    kind,
                    lifecycle.FailureStage,
                    lifecycle.StopReason,
                    null,
                    17);
            }
        }

        public void Dispose()
        {
            lock (gate)
            {
                DisposeCalls++;
                AddEvent("dispose");
            }
        }

        private void AddEvent(string value)
        {
            if (Events != null)
            {
                Events.Add(value);
            }
        }
    }

    internal sealed class FakeSessionControlChannel : ISessionControlChannel
    {
        private Action<ControlReason> terminate;
        private Action<ControlChannelFailureKind> failure;

        internal Action OnReady { get; set; }
        internal ControlReason? EmitTerminateOnStart { get; set; }
        internal bool FailTerminalWrite { get; set; }
        internal bool FailReadyWrite { get; set; }
        internal bool FailShutdown { get; set; }
        internal ControlFrame ConfigToRead { get; set; }
        internal InitialReadFailure InitialReadFailure { get; set; }
        internal int TerminalWrites { get; private set; }
        internal int ShutdownCalls { get; private set; }
        internal TerminalSnapshot Terminal { get; private set; }
        internal IList<string> Events { get; set; }

        public ControlFrame ReadLaunchConfig()
        {
            if (InitialReadFailure == InitialReadFailure.Protocol)
            {
                throw new ProtocolViolationException();
            }
            if (InitialReadFailure == InitialReadFailure.EndOfFile)
            {
                throw new System.IO.EndOfStreamException();
            }
            if (InitialReadFailure == InitialReadFailure.Io)
            {
                throw new System.IO.IOException("initial_read_failed");
            }
            return ConfigToRead;
        }

        public void StartReader(
            Action<ControlReason> terminateCallback,
            Action<ControlChannelFailureKind> failureCallback)
        {
            terminate = terminateCallback;
            failure = failureCallback;
            if (EmitTerminateOnStart.HasValue)
            {
                terminate(EmitTerminateOnStart.Value);
            }
        }

        public void WriteReady()
        {
            AddEvent("ready-write");
            if (FailReadyWrite)
            {
                throw new InvalidOperationException("ready_write_failed");
            }
            if (OnReady != null)
            {
                OnReady();
            }
        }

        public void WriteTerminal(TerminalSnapshot snapshot)
        {
            TerminalWrites++;
            Terminal = snapshot;
            AddEvent("terminal");
            if (FailTerminalWrite)
            {
                throw new InvalidOperationException("terminal_write_failed");
            }
        }

        public void ShutdownAfterTerminal()
        {
            ShutdownCalls++;
            AddEvent("shutdown");
            if (FailShutdown)
            {
                throw new InvalidOperationException("shutdown_failed");
            }
        }

        internal void EmitTerminate(ControlReason reason)
        {
            terminate(reason);
        }

        internal void EmitFailure(ControlChannelFailureKind kind)
        {
            failure(kind);
        }

        private void AddEvent(string value)
        {
            if (Events != null)
            {
                Events.Add(value);
            }
        }
    }
}
