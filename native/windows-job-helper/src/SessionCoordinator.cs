using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace CodexAgentTools.WindowsJobHelper
{
    internal enum ControlChannelFailureKind
    {
        EndOfFile,
        ProtocolInvalid,
        IoFailure
    }

    internal interface ISessionKernel : IDisposable
    {
        LifecycleMachine Lifecycle { get; }
        bool HasRootProcess { get; }
        void PrepareJob();
        void CreateSuspended(
            string executable,
            string currentDirectory,
            IEnumerable<string> arguments);
        void ResumeAndPublishReady(Action readyWriter);
        void RequestStop(ControlReason reason);
        void ReportControlFailure(bool protocolInvalid);
        bool WaitForRootExit(uint milliseconds);
        uint ReadRootExitCode();
        void TerminateOwnedJob();
        uint QueryActiveProcesses();
        void RecordJobZero();
        TerminalSnapshot TryReserveTerminal();
    }

    internal interface ISessionControlChannel
    {
        ControlFrame ReadLaunchConfig();
        void StartReader(
            Action<ControlReason> terminateCallback,
            Action<ControlChannelFailureKind> failureCallback);
        void WriteReady();
        void WriteTerminal(TerminalSnapshot snapshot);
        void ShutdownAfterTerminal();
    }

    internal sealed class SessionCoordinator
    {
        private const int QueryIntervalMilliseconds = 50;
        private readonly ISessionKernel session;
        private readonly ISessionControlChannel channel;
        private readonly AutoResetEvent changed = new AutoResetEvent(false);
        private bool terminateAttempted;

        internal SessionCoordinator(
            ISessionKernel session,
            ISessionControlChannel channel)
        {
            if (session == null)
            {
                throw new ArgumentNullException("session");
            }
            if (channel == null)
            {
                throw new ArgumentNullException("channel");
            }
            this.session = session;
            this.channel = channel;
        }

        internal int Run()
        {
            return RunCore(null, true);
        }

        internal int Run(ControlFrame config)
        {
            if (config == null)
            {
                throw new ArgumentNullException("config");
            }
            return RunCore(config, false);
        }

        private int RunCore(ControlFrame config, bool readConfig)
        {
            Thread rootWaiter = null;
            TerminalSnapshot terminal = null;
            bool terminalDecisionAttempted = false;
            bool terminalAttempted = false;
            bool cleanupFailed = false;
            int status = 1;
            try
            {
                bool launchAllowed = true;
                if (readConfig)
                {
                    try
                    {
                        config = channel.ReadLaunchConfig();
                        if (config == null)
                        {
                            throw new ProtocolViolationException();
                        }
                    }
                    catch (ProtocolViolationException)
                    {
                        session.ReportControlFailure(true);
                        launchAllowed = false;
                    }
                    catch (EndOfStreamException)
                    {
                        session.ReportControlFailure(false);
                        launchAllowed = false;
                    }
                    catch (IOException)
                    {
                        session.ReportControlFailure(false);
                        launchAllowed = false;
                    }
                }

                if (launchAllowed)
                {
                    channel.StartReader(OnTerminate, OnChannelFailure);
                    try
                    {
                        session.PrepareJob();
                        session.CreateSuspended(
                            config.Executable,
                            config.CurrentDirectory,
                            config.Arguments);

                        if (session.Lifecycle.State == LifecycleState.CreatedAssigned)
                        {
                            session.ResumeAndPublishReady(channel.WriteReady);
                        }
                    }
                    catch
                    {
                        // Launch failures are already latched in the session. The
                        // coordinator must still run the one cleanup/terminal path.
                    }
                }

                if (session.HasRootProcess)
                {
                    rootWaiter = new Thread(new ThreadStart(WaitForRoot));
                    rootWaiter.IsBackground = true;
                    rootWaiter.Start();
                }

                DrainOwnedJob();
                if (session.Lifecycle.RootWasCompleted)
                {
                    session.ReadRootExitCode();
                }
                terminalDecisionAttempted = true;
                terminal = session.TryReserveTerminal();
                if (terminal == null)
                {
                    status = 1;
                }
                else
                {
                    terminalAttempted = true;
                    channel.WriteTerminal(terminal);
                    status = terminal.Kind == TerminalKind.Exit ? 0 : 1;
                }
            }
            catch
            {
                try
                {
                    if (!terminalDecisionAttempted)
                    {
                        terminalDecisionAttempted = true;
                        terminal = session.TryReserveTerminal();
                    }
                    if (terminal != null && !terminalAttempted)
                    {
                        terminalAttempted = true;
                        channel.WriteTerminal(terminal);
                    }
                }
                catch
                {
                }
                status = 1;
            }
            finally
            {
                try
                {
                    channel.ShutdownAfterTerminal();
                }
                catch
                {
                    cleanupFailed = true;
                }
                try
                {
                    session.Dispose();
                }
                catch
                {
                    cleanupFailed = true;
                }
                changed.Dispose();
            }
            return cleanupFailed ? 1 : status;
        }

        private void DrainOwnedJob()
        {
            for (;;)
            {
                LifecycleMachine state = session.Lifecycle;
                if (!session.HasRootProcess)
                {
                    session.RecordJobZero();
                    return;
                }
                if (state.JobWasZero)
                {
                    if (state.RootWasCompleted ||
                        state.FailureStage != ControlStage.None)
                    {
                        return;
                    }
                    changed.WaitOne();
                    continue;
                }

                bool requiresTermination =
                    state.StopReason != ControlReason.NoneOrRootExit ||
                    state.FailureStage != ControlStage.None ||
                    state.RootWasCompleted;
                if (requiresTermination && !terminateAttempted)
                {
                    TryTerminateOnce();
                }

                if (!state.RootWasCompleted && !requiresTermination)
                {
                    changed.WaitOne();
                    continue;
                }

                uint active = session.QueryActiveProcesses();
                if (active == 0)
                {
                    session.RecordJobZero();
                    LifecycleMachine afterZero = session.Lifecycle;
                    if (!afterZero.RootWasCompleted &&
                        afterZero.FailureStage == ControlStage.None)
                    {
                        changed.WaitOne();
                        continue;
                    }
                    return;
                }

                if (session.Lifecycle.RootWasCompleted && !terminateAttempted)
                {
                    TryTerminateOnce();
                }
                changed.WaitOne(QueryIntervalMilliseconds);
            }
        }

        private void TryTerminateOnce()
        {
            terminateAttempted = true;
            session.TerminateOwnedJob();
        }

        private void WaitForRoot()
        {
            try
            {
                session.WaitForRootExit(NativeMethods.Infinite);
            }
            catch
            {
            }
            finally
            {
                try
                {
                    changed.Set();
                }
                catch (ObjectDisposedException)
                {
                }
            }
        }

        private void OnTerminate(ControlReason reason)
        {
            try
            {
                if (reason == ControlReason.ProtocolError)
                {
                    session.ReportControlFailure(true);
                }
                else
                {
                    session.RequestStop(reason);
                }
                changed.Set();
            }
            catch (ObjectDisposedException)
            {
            }
        }

        private void OnChannelFailure(ControlChannelFailureKind kind)
        {
            try
            {
                session.ReportControlFailure(
                    kind == ControlChannelFailureKind.ProtocolInvalid);
                changed.Set();
            }
            catch (ObjectDisposedException)
            {
            }
        }
    }
}
