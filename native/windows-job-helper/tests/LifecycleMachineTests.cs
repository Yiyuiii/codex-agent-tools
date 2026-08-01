using System;

namespace CodexAgentTools.WindowsJobHelper.Tests
{
    internal static class LifecycleMachineTests
    {
        internal static int Run()
        {
            var count = 0;

            // The machine exposes only production-reachable phases. READY is a
            // fact within Running, not a synthetic Cartesian state.
            var configured = LifecycleMachine.Initial;
            TestAssert.Equal(LifecycleState.Configured, configured.State);
            var jobReady = configured.Apply(LifecycleActor.Launcher, LifecycleEvent.JobPrepared);
            TestAssert.Equal(LifecycleState.JobReady, jobReady.State);
            var creating = jobReady.Apply(LifecycleActor.Launcher, LifecycleEvent.BeginCreate);
            TestAssert.Equal(LifecycleState.Creating, creating.State);
            var createdAssigned = creating.Apply(LifecycleActor.Launcher, LifecycleEvent.CreateSucceeded);
            TestAssert.Equal(LifecycleState.CreatedAssigned, createdAssigned.State);
            TestAssert.Throws<LifecycleViolationException>(() =>
                createdAssigned.Apply(LifecycleActor.Launcher, LifecycleEvent.ReadyPublished));
            var running = createdAssigned.Apply(LifecycleActor.Launcher, LifecycleEvent.ResumeSucceeded);
            TestAssert.Equal(LifecycleState.Running, running.State);
            TestAssert.True(running.WasResumed);
            TestAssert.Throws<LifecycleViolationException>(() =>
                running.Apply(LifecycleActor.ControlReader, LifecycleEvent.ReadyPublished));
            var readyRunning = running.Apply(LifecycleActor.Launcher, LifecycleEvent.ReadyPublished);
            TestAssert.True(readyRunning.ReadyWasPublished);
            TestAssert.Throws<LifecycleViolationException>(() =>
                readyRunning.Apply(LifecycleActor.Launcher, LifecycleEvent.ReadyPublished));
            count++;

            // During CreateProcess only the launcher may publish the result. A
            // pending disposition is latched until that result arrives.
            var pending = creating.Apply(LifecycleActor.ControlReader, LifecycleEvent.TerminateCancelled);
            TestAssert.Equal(LifecycleState.Creating, pending.State);
            TestAssert.Equal(CleanupOwner.None, pending.Owner);
            TestAssert.Equal(TerminalKind.None, pending.Terminal);
            TestAssert.Equal(ControlReason.Cancelled, pending.StopReason);
            TestAssert.Equal(ControlStage.CancelledBeforeReady, pending.FailureStage);
            TestAssert.Equal(
                pending,
                pending.Apply(LifecycleActor.ControlReader, LifecycleEvent.TerminateTimedOut));
            TestAssert.Equal(
                pending,
                pending.Apply(LifecycleActor.ControlReader, LifecycleEvent.ControlEof));
            var createSucceededAfterStop = pending.Apply(
                LifecycleActor.Launcher,
                LifecycleEvent.CreateSucceeded);
            TestAssert.Equal(LifecycleState.Terminating, createSucceededAfterStop.State);
            TestAssert.Equal(CleanupOwner.Launcher, createSucceededAfterStop.Owner);
            TestAssert.Throws<LifecycleViolationException>(() =>
                createSucceededAfterStop.Apply(LifecycleActor.Launcher, LifecycleEvent.ResumeSucceeded));
            TestAssert.Throws<LifecycleViolationException>(() =>
                createSucceededAfterStop.Apply(LifecycleActor.Launcher, LifecycleEvent.ReadyPublished));
            var launcherCleanup = createSucceededAfterStop
                .Apply(LifecycleActor.CleanupOwner, LifecycleEvent.JobZero)
                .Apply(LifecycleActor.RootWaiter, LifecycleEvent.RootCompleted);
            TestAssert.Equal(LifecycleState.Terminated, launcherCleanup.State);
            TestAssert.Equal(CleanupOwner.Launcher, launcherCleanup.Owner);
            TestAssert.Equal(
                TerminalKind.Error,
                launcherCleanup.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealError).Terminal);
            count++;

            TestAssert.Throws<LifecycleViolationException>(() =>
                creating.Apply(LifecycleActor.ControlReader, LifecycleEvent.CreateSucceeded));
            TestAssert.Throws<LifecycleViolationException>(() =>
                creating.Apply(LifecycleActor.RootWaiter, LifecycleEvent.CreateFailed));
            TestAssert.Throws<LifecycleViolationException>(() =>
                createdAssigned.Apply(LifecycleActor.Launcher, LifecycleEvent.CreateFailed));
            var createFailed = creating.Apply(LifecycleActor.Launcher, LifecycleEvent.CreateFailed);
            TestAssert.Throws<LifecycleViolationException>(() =>
                createFailed.Apply(LifecycleActor.Launcher, LifecycleEvent.CreateSucceeded));
            count++;

            var createFailedAfterTimeout = creating
                .Apply(LifecycleActor.ControlReader, LifecycleEvent.TerminateTimedOut)
                .Apply(LifecycleActor.Launcher, LifecycleEvent.CreateFailed);
            TestAssert.Equal(LifecycleState.Terminated, createFailedAfterTimeout.State);
            TestAssert.Equal(CleanupOwner.Launcher, createFailedAfterTimeout.Owner);
            TestAssert.Equal(ControlStage.CancelledBeforeReady, createFailedAfterTimeout.FailureStage);
            TestAssert.Equal(ControlReason.TimedOut, createFailedAfterTimeout.StopReason);
            count++;

            TestAssert.Equal(LifecycleState.Terminated, createFailed.State);
            TestAssert.Equal(CleanupOwner.Launcher, createFailed.Owner);
            TestAssert.Equal(ControlStage.CreateFailed, createFailed.FailureStage);
            TestAssert.Equal(ControlReason.NoneOrRootExit, createFailed.StopReason);
            TestAssert.Throws<LifecycleViolationException>(() =>
                createFailed.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealExit));
            var sealedCreateFailure = createFailed.Apply(
                LifecycleActor.TerminalWriter,
                LifecycleEvent.SealError);
            TestAssert.Equal(TerminalKind.Error, sealedCreateFailure.Terminal);
            count++;

            var creatingEof = creating.Apply(LifecycleActor.ControlReader, LifecycleEvent.ControlEof);
            var eofAfterSuccess = creatingEof.Apply(LifecycleActor.Launcher, LifecycleEvent.CreateSucceeded);
            var eofAfterFailure = creatingEof.Apply(LifecycleActor.Launcher, LifecycleEvent.CreateFailed);
            TestAssert.Equal(LifecycleState.Terminating, eofAfterSuccess.State);
            TestAssert.Equal(LifecycleState.Terminated, eofAfterFailure.State);
            TestAssert.Equal(CleanupOwner.Launcher, eofAfterSuccess.Owner);
            TestAssert.Equal(CleanupOwner.Launcher, eofAfterFailure.Owner);
            TestAssert.Equal(ControlReason.SessionShutdown, eofAfterSuccess.StopReason);
            TestAssert.Equal(ControlStage.ControlChannelFailed, eofAfterFailure.FailureStage);
            count++;

            var creatingShutdown = creating.Apply(
                LifecycleActor.ControlReader,
                LifecycleEvent.TerminateSessionShutdown);
            var shutdownAfterSuccess = creatingShutdown.Apply(
                LifecycleActor.Launcher,
                LifecycleEvent.CreateSucceeded);
            var shutdownAfterFailure = creatingShutdown.Apply(
                LifecycleActor.Launcher,
                LifecycleEvent.CreateFailed);
            TestAssert.Equal(LifecycleState.Terminating, shutdownAfterSuccess.State);
            TestAssert.Equal(LifecycleState.Terminated, shutdownAfterFailure.State);
            TestAssert.Equal(ControlReason.SessionShutdown, shutdownAfterSuccess.StopReason);
            TestAssert.Equal(ControlStage.CancelledBeforeReady, shutdownAfterFailure.FailureStage);
            count++;

            var creatingProtocolError = creating.Apply(
                LifecycleActor.ControlReader,
                LifecycleEvent.ProtocolError);
            var protocolAfterSuccess = creatingProtocolError.Apply(
                LifecycleActor.Launcher,
                LifecycleEvent.CreateSucceeded);
            var protocolAfterFailure = creatingProtocolError.Apply(
                LifecycleActor.Launcher,
                LifecycleEvent.CreateFailed);
            TestAssert.Equal(LifecycleState.Terminating, protocolAfterSuccess.State);
            TestAssert.Equal(LifecycleState.Terminated, protocolAfterFailure.State);
            TestAssert.Equal(ControlReason.ProtocolError, protocolAfterSuccess.StopReason);
            TestAssert.Equal(ControlStage.ProtocolInvalid, protocolAfterFailure.FailureStage);
            count++;

            // Before the launcher owns a child, the control reader owns cleanup.
            var configuredCancelled = configured.Apply(
                LifecycleActor.ControlReader,
                LifecycleEvent.TerminateCancelled);
            TestAssert.Equal(LifecycleState.Terminated, configuredCancelled.State);
            TestAssert.Equal(CleanupOwner.ControlReader, configuredCancelled.Owner);
            TestAssert.Equal(ControlStage.CancelledBeforeReady, configuredCancelled.FailureStage);
            var configuredEof = configured.Apply(LifecycleActor.ControlReader, LifecycleEvent.ControlEof);
            TestAssert.Equal(ControlStage.ControlChannelFailed, configuredEof.FailureStage);
            var preparedTimeout = jobReady.Apply(
                LifecycleActor.ControlReader,
                LifecycleEvent.TerminateTimedOut);
            TestAssert.Equal(ControlReason.TimedOut, preparedTimeout.StopReason);
            TestAssert.Equal(ControlStage.CancelledBeforeReady, preparedTimeout.FailureStage);
            var preparedProtocol = jobReady.Apply(
                LifecycleActor.ControlReader,
                LifecycleEvent.ProtocolError);
            TestAssert.Equal(ControlStage.ProtocolInvalid, preparedProtocol.FailureStage);
            count++;

            // Assignment exists but the child has not resumed, so every stop is
            // an error disposition and Resume can never happen afterwards.
            var assignedCancelled = createdAssigned.Apply(
                LifecycleActor.ControlReader,
                LifecycleEvent.TerminateCancelled);
            TestAssert.Equal(LifecycleState.Terminating, assignedCancelled.State);
            TestAssert.Equal(CleanupOwner.ControlReader, assignedCancelled.Owner);
            TestAssert.Equal(ControlStage.CancelledBeforeReady, assignedCancelled.FailureStage);
            TestAssert.Throws<LifecycleViolationException>(() =>
                assignedCancelled.Apply(LifecycleActor.Launcher, LifecycleEvent.ResumeSucceeded));
            var assignedEof = createdAssigned.Apply(LifecycleActor.ControlReader, LifecycleEvent.ControlEof);
            TestAssert.Equal(ControlStage.ControlChannelFailed, assignedEof.FailureStage);
            var assignedProtocol = createdAssigned.Apply(
                LifecycleActor.ControlReader,
                LifecycleEvent.ProtocolError);
            TestAssert.Equal(ControlStage.ProtocolInvalid, assignedProtocol.FailureStage);
            count++;

            // An ordinary stop after resume preserves its first reason and can
            // still publish READY before the owned cleanup completes.
            var stopping = running
                .Apply(LifecycleActor.ControlReader, LifecycleEvent.TerminateSessionShutdown)
                .Apply(LifecycleActor.Launcher, LifecycleEvent.ReadyPublished);
            TestAssert.Equal(CleanupOwner.ControlReader, stopping.Owner);
            TestAssert.Equal(ControlReason.SessionShutdown, stopping.StopReason);
            TestAssert.Throws<LifecycleViolationException>(() =>
                stopping.Apply(LifecycleActor.Launcher, LifecycleEvent.ResumeSucceeded));
            var stopped = stopping
                .Apply(LifecycleActor.CleanupOwner, LifecycleEvent.JobZero)
                .Apply(LifecycleActor.RootWaiter, LifecycleEvent.RootCompleted);
            TestAssert.Equal(CleanupOwner.ControlReader, stopped.Owner);
            var sealedStopped = stopped.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealExit);
            TestAssert.Equal(TerminalKind.Exit, sealedStopped.Terminal);
            TestAssert.Equal(ControlReason.SessionShutdown, sealedStopped.StopReason);
            count++;

            // Natural completion supports both waiter orders while preserving a
            // single cleanup owner and refusing to seal on a half-observed exit.
            var rootFirst = readyRunning.Apply(LifecycleActor.RootWaiter, LifecycleEvent.RootCompleted);
            TestAssert.Equal(LifecycleState.Terminating, rootFirst.State);
            TestAssert.Equal(CleanupOwner.RootWaiter, rootFirst.Owner);
            TestAssert.Equal(rootFirst, rootFirst.Apply(LifecycleActor.RootWaiter, LifecycleEvent.RootCompleted));
            TestAssert.Throws<LifecycleViolationException>(() =>
                rootFirst.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealExit));
            var rootFirstDone = rootFirst.Apply(LifecycleActor.CleanupOwner, LifecycleEvent.JobZero);
            TestAssert.Equal(LifecycleState.Terminated, rootFirstDone.State);
            TestAssert.Equal(CleanupOwner.RootWaiter, rootFirstDone.Owner);
            var rootFirstExit = rootFirstDone.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealExit);
            TestAssert.Equal(TerminalKind.Exit, rootFirstExit.Terminal);
            count++;

            var jobFirst = readyRunning.Apply(LifecycleActor.CleanupOwner, LifecycleEvent.JobZero);
            TestAssert.Equal(LifecycleState.Terminating, jobFirst.State);
            TestAssert.Equal(CleanupOwner.JobWaiter, jobFirst.Owner);
            TestAssert.Equal(jobFirst, jobFirst.Apply(LifecycleActor.CleanupOwner, LifecycleEvent.JobZero));
            TestAssert.Throws<LifecycleViolationException>(() =>
                jobFirst.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealExit));
            var jobFirstDone = jobFirst.Apply(LifecycleActor.RootWaiter, LifecycleEvent.RootCompleted);
            TestAssert.Equal(LifecycleState.Terminated, jobFirstDone.State);
            TestAssert.Equal(CleanupOwner.JobWaiter, jobFirstDone.Owner);
            TestAssert.Equal(
                TerminalKind.Exit,
                jobFirstDone.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealExit).Terminal);
            count++;

            // A very short-lived child can finish after ResumeThread but before
            // the launcher publishes READY. Completion must not deadlock the
            // READY-before-EXIT barrier, regardless of waiter order.
            var earlyRootFirst = running
                .Apply(LifecycleActor.RootWaiter, LifecycleEvent.RootCompleted)
                .Apply(LifecycleActor.CleanupOwner, LifecycleEvent.JobZero);
            TestAssert.Equal(LifecycleState.Terminated, earlyRootFirst.State);
            TestAssert.Throws<LifecycleViolationException>(() =>
                earlyRootFirst.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealExit));
            earlyRootFirst = earlyRootFirst.Apply(
                LifecycleActor.Launcher,
                LifecycleEvent.ReadyPublished);
            TestAssert.Equal(
                TerminalKind.Exit,
                earlyRootFirst.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealExit).Terminal);
            var earlyJobFirst = running
                .Apply(LifecycleActor.CleanupOwner, LifecycleEvent.JobZero)
                .Apply(LifecycleActor.RootWaiter, LifecycleEvent.RootCompleted)
                .Apply(LifecycleActor.Launcher, LifecycleEvent.ReadyPublished)
                .Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealExit);
            TestAssert.Equal(TerminalKind.Exit, earlyJobFirst.Terminal);
            count++;

            var protocolFailure = readyRunning
                .Apply(LifecycleActor.ControlReader, LifecycleEvent.ProtocolError)
                .Apply(LifecycleActor.RootWaiter, LifecycleEvent.RootCompleted)
                .Apply(LifecycleActor.CleanupOwner, LifecycleEvent.JobZero);
            TestAssert.Throws<LifecycleViolationException>(() =>
                protocolFailure.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealExit));
            var sealedProtocolFailure = protocolFailure.Apply(
                LifecycleActor.TerminalWriter,
                LifecycleEvent.SealError);
            TestAssert.Equal(TerminalKind.Error, sealedProtocolFailure.Terminal);
            TestAssert.Equal(ControlStage.ProtocolInvalid, sealedProtocolFailure.FailureStage);
            count++;

            // Root and job completion are not a terminal seal. Transport errors
            // observed in this interval must still replace the pending EXIT.
            TestAssert.Equal(
                rootFirstDone,
                rootFirstDone.Apply(LifecycleActor.ControlReader, LifecycleEvent.TerminateCancelled));
            var lateProtocol = rootFirstDone.Apply(
                LifecycleActor.ControlReader,
                LifecycleEvent.ProtocolError);
            TestAssert.Equal(ControlStage.ProtocolInvalid, lateProtocol.FailureStage);
            TestAssert.Equal(ControlReason.ProtocolError, lateProtocol.StopReason);
            TestAssert.Throws<LifecycleViolationException>(() =>
                lateProtocol.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealExit));
            TestAssert.Equal(
                TerminalKind.Error,
                lateProtocol.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealError).Terminal);
            var lateEof = jobFirstDone.Apply(LifecycleActor.ControlReader, LifecycleEvent.ControlEof);
            TestAssert.Equal(ControlStage.ControlChannelFailed, lateEof.FailureStage);
            TestAssert.Equal(ControlReason.SessionShutdown, lateEof.StopReason);
            count++;

            // Native setup failures are explicit finite transitions. They are
            // not inferred from impossible state/event Cartesian products.
            AssertFailure(
                configured.ApplyFailure(LifecycleActor.Launcher, ControlStage.JobCreateFailed),
                LifecycleState.Terminated,
                CleanupOwner.Launcher,
                ControlStage.JobCreateFailed);
            AssertFailure(
                configured.ApplyFailure(LifecycleActor.Launcher, ControlStage.JobConfigFailed),
                LifecycleState.Terminated,
                CleanupOwner.Launcher,
                ControlStage.JobConfigFailed);
            AssertFailure(
                jobReady.ApplyFailure(LifecycleActor.Launcher, ControlStage.StdioDuplicateFailed),
                LifecycleState.Terminated,
                CleanupOwner.Launcher,
                ControlStage.StdioDuplicateFailed);
            AssertFailure(
                jobReady.ApplyFailure(LifecycleActor.Launcher, ControlStage.AttributeListInitFailed),
                LifecycleState.Terminated,
                CleanupOwner.Launcher,
                ControlStage.AttributeListInitFailed);
            AssertFailure(
                jobReady.ApplyFailure(LifecycleActor.Launcher, ControlStage.HandleListAttributeFailed),
                LifecycleState.Terminated,
                CleanupOwner.Launcher,
                ControlStage.HandleListAttributeFailed);
            AssertFailure(
                jobReady.ApplyFailure(LifecycleActor.Launcher, ControlStage.JobListAttributeFailed),
                LifecycleState.Terminated,
                CleanupOwner.Launcher,
                ControlStage.JobListAttributeFailed);
            AssertFailure(
                jobReady.ApplyFailure(LifecycleActor.Launcher, ControlStage.CommandLineInvalid),
                LifecycleState.Terminated,
                CleanupOwner.Launcher,
                ControlStage.CommandLineInvalid);
            TestAssert.Throws<LifecycleViolationException>(() =>
                jobReady.ApplyFailure(LifecycleActor.ControlReader, ControlStage.JobConfigFailed));
            TestAssert.Throws<LifecycleViolationException>(() =>
                jobReady.ApplyFailure(LifecycleActor.Launcher, ControlStage.JobConfigFailed));
            count++;

            AssertFailure(
                createFailed,
                LifecycleState.Terminated,
                CleanupOwner.Launcher,
                ControlStage.CreateFailed);
            TestAssert.Throws<LifecycleViolationException>(() =>
                creating.ApplyFailure(LifecycleActor.Launcher, ControlStage.CreateFailed));
            var resumeFailure = createdAssigned.ApplyFailure(
                LifecycleActor.Launcher,
                ControlStage.ResumeFailed);
            AssertFailure(
                resumeFailure,
                LifecycleState.Terminating,
                CleanupOwner.Launcher,
                ControlStage.ResumeFailed);
            TestAssert.Throws<LifecycleViolationException>(() =>
                resumeFailure.Apply(LifecycleActor.Launcher, LifecycleEvent.ResumeSucceeded));
            count++;

            var cancelledAfterReady = readyRunning.Apply(
                LifecycleActor.ControlReader,
                LifecycleEvent.TerminateCancelled);
            var terminateFailure = cancelledAfterReady.ApplyFailure(
                LifecycleActor.CleanupOwner,
                ControlStage.TerminateJobFailed);
            AssertFailure(
                terminateFailure,
                LifecycleState.Terminating,
                CleanupOwner.ControlReader,
                ControlStage.TerminateJobFailed);
            TestAssert.Equal(ControlReason.Cancelled, terminateFailure.StopReason);
            TestAssert.Equal(
                terminateFailure,
                terminateFailure.ApplyFailure(
                    LifecycleActor.CleanupOwner,
                    ControlStage.QueryJobFailed));
            TestAssert.Throws<LifecycleViolationException>(() =>
                terminateFailure.ApplyFailure(
                    LifecycleActor.RootWaiter,
                    ControlStage.QueryJobFailed));
            TestAssert.Equal(
                terminateFailure,
                terminateFailure.Apply(LifecycleActor.ControlReader, LifecycleEvent.ProtocolError));
            var queryFailure = rootFirst.ApplyFailure(
                LifecycleActor.CleanupOwner,
                ControlStage.QueryJobFailed);
            TestAssert.Equal(ControlStage.QueryJobFailed, queryFailure.FailureStage);
            var waitFailure = jobFirst.ApplyFailure(
                LifecycleActor.RootWaiter,
                ControlStage.WaitFailed);
            TestAssert.Equal(LifecycleState.Terminated, waitFailure.State);
            TestAssert.Equal(ControlStage.WaitFailed, waitFailure.FailureStage);
            TestAssert.True(!waitFailure.RootWasCompleted);
            TestAssert.True(waitFailure.JobWasZero);
            TestAssert.Equal(
                TerminalKind.Error,
                waitFailure.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealError).Terminal);
            var waitBeforeJobZero = running.ApplyFailure(
                LifecycleActor.RootWaiter,
                ControlStage.WaitFailed);
            TestAssert.Equal(LifecycleState.Terminating, waitBeforeJobZero.State);
            waitBeforeJobZero = waitBeforeJobZero.Apply(
                LifecycleActor.CleanupOwner,
                LifecycleEvent.JobZero);
            TestAssert.Equal(LifecycleState.Terminated, waitBeforeJobZero.State);
            TestAssert.True(!waitBeforeJobZero.RootWasCompleted);
            TestAssert.Throws<LifecycleViolationException>(() =>
                waitBeforeJobZero.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealError));
            waitBeforeJobZero = waitBeforeJobZero.Apply(
                LifecycleActor.Launcher,
                LifecycleEvent.ReadyPublished);
            TestAssert.Equal(
                TerminalKind.Error,
                waitBeforeJobZero.Apply(
                    LifecycleActor.TerminalWriter,
                    LifecycleEvent.SealError).Terminal);
            var internalFailure = stopping.ApplyFailure(
                LifecycleActor.CleanupOwner,
                ControlStage.HelperInternal);
            TestAssert.Equal(ControlStage.HelperInternal, internalFailure.FailureStage);
            count++;

            // Ordinary post-resume cancellation is only a requested disposition.
            // A later transport failure before terminal seal upgrades it to ERROR.
            var cancelledThenProtocol = cancelledAfterReady.Apply(
                LifecycleActor.ControlReader,
                LifecycleEvent.ProtocolError);
            TestAssert.Equal(ControlStage.ProtocolInvalid, cancelledThenProtocol.FailureStage);
            TestAssert.Equal(ControlReason.Cancelled, cancelledThenProtocol.StopReason);
            TestAssert.Equal(CleanupOwner.ControlReader, cancelledThenProtocol.Owner);
            var timedOutThenEof = running
                .Apply(LifecycleActor.ControlReader, LifecycleEvent.TerminateTimedOut)
                .Apply(LifecycleActor.ControlReader, LifecycleEvent.ControlEof);
            TestAssert.Equal(ControlStage.ControlChannelFailed, timedOutThenEof.FailureStage);
            TestAssert.Equal(ControlReason.TimedOut, timedOutThenEof.StopReason);
            TestAssert.Equal(CleanupOwner.ControlReader, timedOutThenEof.Owner);
            var failedBeforeReady = timedOutThenEof
                .Apply(LifecycleActor.RootWaiter, LifecycleEvent.RootCompleted)
                .Apply(LifecycleActor.CleanupOwner, LifecycleEvent.JobZero);
            TestAssert.Throws<LifecycleViolationException>(() =>
                failedBeforeReady.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealError));
            failedBeforeReady = failedBeforeReady.Apply(
                LifecycleActor.Launcher,
                LifecycleEvent.ReadyPublished);
            TestAssert.Equal(
                TerminalKind.Error,
                failedBeforeReady.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealError).Terminal);
            // CREATING remains the intentional exception: its first disposition
            // stays latched until only the launcher publishes the create result.
            TestAssert.Equal(
                pending,
                pending.Apply(LifecycleActor.ControlReader, LifecycleEvent.ProtocolError));
            count++;

            // Once a terminal frame is sealed, late lifecycle input is inert;
            // only the same seal is idempotent and a cross-kind seal is illegal.
            TestAssert.Equal(
                rootFirstExit,
                rootFirstExit.Apply(LifecycleActor.ControlReader, LifecycleEvent.ProtocolError));
            TestAssert.Equal(
                rootFirstExit,
                rootFirstExit.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealExit));
            TestAssert.Throws<LifecycleViolationException>(() =>
                rootFirstExit.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealError));
            TestAssert.Equal(
                sealedProtocolFailure,
                sealedProtocolFailure.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealError));
            TestAssert.Equal(
                sealedProtocolFailure,
                sealedProtocolFailure.Apply(LifecycleActor.ControlReader, LifecycleEvent.ControlEof));
            TestAssert.Throws<LifecycleViolationException>(() =>
                sealedProtocolFailure.Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealExit));
            TestAssert.Equal(
                sealedProtocolFailure,
                sealedProtocolFailure.ApplyFailure(
                    LifecycleActor.CleanupOwner,
                    ControlStage.QueryJobFailed));
            TestAssert.Throws<LifecycleViolationException>(() =>
                running.ApplyFailure(LifecycleActor.Launcher, ControlStage.None));
            TestAssert.Throws<LifecycleViolationException>(() =>
                running.ApplyFailure(
                    LifecycleActor.Launcher,
                    ControlStage.CancelledBeforeReady));
            TestAssert.Throws<LifecycleViolationException>(() =>
                running.ApplyFailure(LifecycleActor.Launcher, ControlStage.ProtocolInvalid));
            // Terminal writes are a distinct authority. A READY write failure
            // is linearized by the launcher before READY is published. It must
            // transfer cleanup ownership without pretending the reader saw EOF.
            var readyWriteFailed = running.ApplyFailure(
                LifecycleActor.Launcher,
                ControlStage.ControlChannelFailed);
            AssertFailure(
                readyWriteFailed,
                LifecycleState.Terminating,
                CleanupOwner.Launcher,
                ControlStage.ControlChannelFailed);
            TestAssert.True(!readyWriteFailed.ReadyWasPublished);
            TestAssert.Throws<LifecycleViolationException>(() =>
                running.ApplyFailure(
                    LifecycleActor.ControlReader,
                    ControlStage.ControlChannelFailed));

            var terminateBeforeReadyWrite = running.Apply(
                LifecycleActor.ControlReader,
                LifecycleEvent.TerminateCancelled);
            var racedReadyWriteFailed = terminateBeforeReadyWrite.ApplyFailure(
                LifecycleActor.Launcher,
                ControlStage.ControlChannelFailed);
            TestAssert.Equal(LifecycleState.Terminating, racedReadyWriteFailed.State);
            TestAssert.Equal(CleanupOwner.ControlReader, racedReadyWriteFailed.Owner);
            TestAssert.Equal(ControlReason.Cancelled, racedReadyWriteFailed.StopReason);
            TestAssert.Equal(ControlStage.ControlChannelFailed, racedReadyWriteFailed.FailureStage);
            count++;

            // If cleanup cannot prove Job zero, the helper must still be able to
            // make one best-effort ERROR write and then close its final Job
            // handle. Sealing remains illegal for ordinary in-progress cleanup.
            var cleanupRequested = readyRunning.Apply(
                LifecycleActor.ControlReader,
                LifecycleEvent.TerminateCancelled);
            var terminateJobFailed = cleanupRequested.ApplyFailure(
                LifecycleActor.CleanupOwner,
                ControlStage.TerminateJobFailed);
            TestAssert.True(!terminateJobFailed.JobWasZero);
            TestAssert.True(terminateJobFailed.MaySealErrorBeforeJobZero);
            TestAssert.Equal(
                TerminalKind.Error,
                terminateJobFailed
                    .Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealError)
                    .Terminal);

            var queryJobFailed = cleanupRequested.ApplyFailure(
                LifecycleActor.CleanupOwner,
                ControlStage.QueryJobFailed);
            TestAssert.True(!queryJobFailed.JobWasZero);
            TestAssert.True(queryJobFailed.MaySealErrorBeforeJobZero);
            TestAssert.Equal(
                TerminalKind.Error,
                queryJobFailed
                    .Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealError)
                    .Terminal);
            TestAssert.Throws<LifecycleViolationException>(() =>
                cleanupRequested.Apply(
                    LifecycleActor.TerminalWriter,
                    LifecycleEvent.SealError));

            var resumeThenCleanupFailed = createdAssigned
                .ApplyFailure(LifecycleActor.Launcher, ControlStage.ResumeFailed)
                .ApplyFailure(LifecycleActor.CleanupOwner, ControlStage.QueryJobFailed);
            TestAssert.Equal(ControlStage.ResumeFailed, resumeThenCleanupFailed.FailureStage);
            TestAssert.True(resumeThenCleanupFailed.MaySealErrorBeforeJobZero);
            TestAssert.Equal(
                TerminalKind.Error,
                resumeThenCleanupFailed
                    .Apply(LifecycleActor.TerminalWriter, LifecycleEvent.SealError)
                    .Terminal);
            count++;

            return count;
        }

        private static void AssertFailure(
            LifecycleMachine machine,
            LifecycleState state,
            CleanupOwner owner,
            ControlStage stage)
        {
            TestAssert.Equal(state, machine.State);
            TestAssert.Equal(owner, machine.Owner);
            TestAssert.Equal(stage, machine.FailureStage);
            TestAssert.Equal(TerminalKind.None, machine.Terminal);
        }
    }
}
