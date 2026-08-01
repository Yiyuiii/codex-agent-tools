using System;

namespace CodexAgentTools.WindowsJobHelper
{
    internal enum LifecycleState
    {
        Configured,
        JobReady,
        Creating,
        CreatedAssigned,
        Running,
        Terminating,
        Terminated,
        Terminal
    }

    internal enum LifecycleActor
    {
        Launcher,
        ControlReader,
        RootWaiter,
        CleanupOwner,
        TerminalWriter
    }

    internal enum LifecycleEvent
    {
        JobPrepared,
        BeginCreate,
        CreateSucceeded,
        CreateFailed,
        ResumeSucceeded,
        ReadyPublished,
        TerminateCancelled,
        TerminateTimedOut,
        TerminateSessionShutdown,
        ControlEof,
        ProtocolError,
        RootCompleted,
        JobZero,
        SealExit,
        SealError
    }

    internal enum CleanupOwner
    {
        None,
        Launcher,
        ControlReader,
        RootWaiter,
        JobWaiter
    }

    internal enum TerminalKind
    {
        None,
        Exit,
        Error
    }

    internal sealed class LifecycleViolationException : Exception
    {
        internal LifecycleViolationException()
            : base("windows_native_lifecycle_invalid")
        {
        }
    }

    internal sealed class LifecycleMachine
    {
        internal static readonly LifecycleMachine Initial = new LifecycleMachine(
            LifecycleState.Configured,
            CleanupOwner.None,
            ControlReason.NoneOrRootExit,
            ControlStage.None,
            TerminalKind.None,
            false,
            false,
            false,
            false);

        internal LifecycleState State { get; private set; }
        internal CleanupOwner Owner { get; private set; }
        internal ControlReason StopReason { get; private set; }
        internal ControlStage FailureStage { get; private set; }
        internal TerminalKind Terminal { get; private set; }
        internal bool WasResumed { get; private set; }
        internal bool ReadyWasPublished { get; private set; }
        internal bool RootWasCompleted { get; private set; }
        internal bool JobWasZero { get; private set; }

        private LifecycleMachine(
            LifecycleState state,
            CleanupOwner owner,
            ControlReason stopReason,
            ControlStage failureStage,
            TerminalKind terminal,
            bool wasResumed,
            bool readyWasPublished,
            bool rootWasCompleted,
            bool jobWasZero)
        {
            State = state;
            Owner = owner;
            StopReason = stopReason;
            FailureStage = failureStage;
            Terminal = terminal;
            WasResumed = wasResumed;
            ReadyWasPublished = readyWasPublished;
            RootWasCompleted = rootWasCompleted;
            JobWasZero = jobWasZero;
        }

        internal LifecycleMachine Apply(LifecycleActor actor, LifecycleEvent lifecycleEvent)
        {
            if (State == LifecycleState.Terminal)
            {
                if (lifecycleEvent == LifecycleEvent.SealExit || lifecycleEvent == LifecycleEvent.SealError)
                {
                    RequireActor(actor, lifecycleEvent);
                    bool sameTerminal =
                        lifecycleEvent == LifecycleEvent.SealExit && Terminal == TerminalKind.Exit ||
                        lifecycleEvent == LifecycleEvent.SealError && Terminal == TerminalKind.Error;
                    if (!sameTerminal)
                    {
                        throw new LifecycleViolationException();
                    }
                }
                return this;
            }
            RequireActor(actor, lifecycleEvent);

            if (IsStopEvent(lifecycleEvent))
            {
                bool transportFailure =
                    lifecycleEvent == LifecycleEvent.ControlEof ||
                    lifecycleEvent == LifecycleEvent.ProtocolError;
                if (State == LifecycleState.Creating && HasDisposition())
                {
                    return this;
                }
                if (FailureStage != ControlStage.None)
                {
                    return this;
                }
                if (State == LifecycleState.Terminated &&
                    !transportFailure)
                {
                    // Once normal completion is fully observed, a late ordinary
                    // cancellation does not replace the natural EXIT disposition.
                    return this;
                }
                if (!transportFailure && HasDisposition())
                {
                    return this;
                }
                return ApplyStop(lifecycleEvent);
            }
            if (lifecycleEvent == LifecycleEvent.RootCompleted && RootWasCompleted)
            {
                return this;
            }
            if (lifecycleEvent == LifecycleEvent.JobZero && JobWasZero)
            {
                return this;
            }

            switch (State)
            {
                case LifecycleState.Configured:
                    if (lifecycleEvent == LifecycleEvent.JobPrepared)
                    {
                        return Copy(state: LifecycleState.JobReady);
                    }
                    break;
                case LifecycleState.JobReady:
                    if (lifecycleEvent == LifecycleEvent.BeginCreate)
                    {
                        return Copy(state: LifecycleState.Creating);
                    }
                    break;
                case LifecycleState.Creating:
                    if (lifecycleEvent == LifecycleEvent.CreateSucceeded)
                    {
                        if (HasDisposition())
                        {
                            return Copy(state: LifecycleState.Terminating, owner: CleanupOwner.Launcher);
                        }
                        return Copy(state: LifecycleState.CreatedAssigned);
                    }
                    if (lifecycleEvent == LifecycleEvent.CreateFailed)
                    {
                        return Copy(
                            state: LifecycleState.Terminated,
                            owner: CleanupOwner.Launcher,
                            failureStage: FailureStage == ControlStage.None
                                ? ControlStage.CreateFailed
                                : FailureStage);
                    }
                    break;
                case LifecycleState.CreatedAssigned:
                    if (lifecycleEvent == LifecycleEvent.ResumeSucceeded)
                    {
                        return Copy(state: LifecycleState.Running, wasResumed: true);
                    }
                    break;
                case LifecycleState.Running:
                    if (lifecycleEvent == LifecycleEvent.ReadyPublished)
                    {
                        if (ReadyWasPublished)
                        {
                            break;
                        }
                        return Copy(readyWasPublished: true);
                    }
                    if (lifecycleEvent == LifecycleEvent.RootCompleted)
                    {
                        return RecordCompletion(true, false, CleanupOwner.RootWaiter);
                    }
                    if (lifecycleEvent == LifecycleEvent.JobZero)
                    {
                        return RecordCompletion(false, true, CleanupOwner.JobWaiter);
                    }
                    break;
                case LifecycleState.Terminating:
                    if (lifecycleEvent == LifecycleEvent.ReadyPublished && WasResumed && !ReadyWasPublished)
                    {
                        return Copy(readyWasPublished: true);
                    }
                    if (lifecycleEvent == LifecycleEvent.RootCompleted)
                    {
                        return RecordCompletion(true, false, Owner);
                    }
                    if (lifecycleEvent == LifecycleEvent.JobZero)
                    {
                        return RecordCompletion(false, true, Owner);
                    }
                    break;
                case LifecycleState.Terminated:
                    if (lifecycleEvent == LifecycleEvent.RootCompleted)
                    {
                        return Copy(rootWasCompleted: true);
                    }
                    if (lifecycleEvent == LifecycleEvent.JobZero)
                    {
                        return Copy(jobWasZero: true);
                    }
                    if (lifecycleEvent == LifecycleEvent.ReadyPublished &&
                        WasResumed &&
                        !ReadyWasPublished)
                    {
                        // The child may exit between ResumeThread and the READY
                        // write. READY is still the mandatory ordering barrier
                        // before a successful EXIT can be sealed.
                        return Copy(readyWasPublished: true);
                    }
                    if (lifecycleEvent == LifecycleEvent.SealExit &&
                        FailureStage == ControlStage.None &&
                        ReadyWasPublished &&
                        (RootWasCompleted && JobWasZero || !WasResumed))
                    {
                        return Copy(state: LifecycleState.Terminal, terminal: TerminalKind.Exit);
                    }
                    if (lifecycleEvent == LifecycleEvent.SealError &&
                        FailureStage != ControlStage.None &&
                        (!WasResumed || ReadyWasPublished))
                    {
                        return Copy(state: LifecycleState.Terminal, terminal: TerminalKind.Error);
                    }
                    break;
            }

            throw new LifecycleViolationException();
        }

        internal LifecycleMachine ApplyFailure(LifecycleActor actor, ControlStage stage)
        {
            if (State == LifecycleState.Terminal)
            {
                return this;
            }
            if (!IsNativeFailureStage(stage))
            {
                throw new LifecycleViolationException();
            }
            RequireFailureActor(actor, stage);
            if (FailureStage != ControlStage.None)
            {
                return this;
            }

            if (State == LifecycleState.Configured &&
                actor == LifecycleActor.Launcher &&
                (stage == ControlStage.JobCreateFailed || stage == ControlStage.JobConfigFailed))
            {
                return Copy(
                    state: LifecycleState.Terminated,
                    owner: CleanupOwner.Launcher,
                    failureStage: stage);
            }
            if (State == LifecycleState.JobReady &&
                actor == LifecycleActor.Launcher &&
                IsLaunchPreparationFailure(stage))
            {
                return Copy(
                    state: LifecycleState.Terminated,
                    owner: CleanupOwner.Launcher,
                    failureStage: stage);
            }
            if (State == LifecycleState.CreatedAssigned &&
                actor == LifecycleActor.Launcher &&
                stage == ControlStage.ResumeFailed)
            {
                return Copy(
                    state: LifecycleState.Terminating,
                    owner: CleanupOwner.Launcher,
                    failureStage: stage);
            }
            if (State == LifecycleState.Running &&
                actor == LifecycleActor.RootWaiter &&
                stage == ControlStage.WaitFailed)
            {
                return Copy(
                    state: LifecycleState.Terminating,
                    owner: CleanupOwner.RootWaiter,
                    failureStage: stage);
            }
            if (State == LifecycleState.Terminating)
            {
                if (actor == LifecycleActor.RootWaiter && stage == ControlStage.WaitFailed)
                {
                    return Copy(
                        state: JobWasZero ? LifecycleState.Terminated : LifecycleState.Terminating,
                        failureStage: stage);
                }
                if (actor == LifecycleActor.CleanupOwner &&
                    (stage == ControlStage.TerminateJobFailed ||
                     stage == ControlStage.QueryJobFailed ||
                     stage == ControlStage.HelperInternal))
                {
                    return Copy(
                        state: JobWasZero ? LifecycleState.Terminated : LifecycleState.Terminating,
                        failureStage: stage);
                }
            }

            throw new LifecycleViolationException();
        }

        private LifecycleMachine ApplyStop(LifecycleEvent lifecycleEvent)
        {
            ControlReason reason;
            ControlStage stage;
            switch (lifecycleEvent)
            {
                case LifecycleEvent.TerminateCancelled:
                    reason = ControlReason.Cancelled;
                    stage = IsBeforeReadyCreation() ? ControlStage.CancelledBeforeReady : ControlStage.None;
                    break;
                case LifecycleEvent.TerminateTimedOut:
                    reason = ControlReason.TimedOut;
                    stage = IsBeforeReadyCreation() ? ControlStage.CancelledBeforeReady : ControlStage.None;
                    break;
                case LifecycleEvent.TerminateSessionShutdown:
                    reason = ControlReason.SessionShutdown;
                    stage = IsBeforeReadyCreation() ? ControlStage.CancelledBeforeReady : ControlStage.None;
                    break;
                case LifecycleEvent.ControlEof:
                    reason = ControlReason.SessionShutdown;
                    stage = ControlStage.ControlChannelFailed;
                    break;
                case LifecycleEvent.ProtocolError:
                    reason = ControlReason.ProtocolError;
                    stage = ControlStage.ProtocolInvalid;
                    break;
                default:
                    throw new LifecycleViolationException();
            }
            ControlReason nextReason = StopReason == ControlReason.NoneOrRootExit
                ? reason
                : StopReason;

            if (State == LifecycleState.Configured || State == LifecycleState.JobReady)
            {
                return Copy(
                    state: LifecycleState.Terminated,
                    owner: CleanupOwner.ControlReader,
                    stopReason: nextReason,
                    failureStage: stage);
            }
            if (State == LifecycleState.Creating)
            {
                return Copy(stopReason: nextReason, failureStage: stage);
            }
            if (State == LifecycleState.CreatedAssigned || State == LifecycleState.Running || State == LifecycleState.Terminating)
            {
                return Copy(
                    state: LifecycleState.Terminating,
                    owner: Owner == CleanupOwner.None ? CleanupOwner.ControlReader : Owner,
                    stopReason: nextReason,
                    failureStage: stage);
            }
            if (State == LifecycleState.Terminated && stage != ControlStage.None)
            {
                // The transport remains authoritative until the terminal frame is
                // sealed. A late protocol/EOF failure must not be reported as EXIT.
                return Copy(stopReason: nextReason, failureStage: stage);
            }
            throw new LifecycleViolationException();
        }

        private LifecycleMachine RecordCompletion(bool root, bool jobZero, CleanupOwner owner)
        {
            bool nextRoot = RootWasCompleted || root;
            bool nextJobZero = JobWasZero || jobZero;
            return Copy(
                state: nextJobZero && (nextRoot || FailureStage != ControlStage.None)
                    ? LifecycleState.Terminated
                    : LifecycleState.Terminating,
                owner: Owner == CleanupOwner.None ? owner : Owner,
                rootWasCompleted: nextRoot,
                jobWasZero: nextJobZero);
        }

        private bool HasDisposition()
        {
            return StopReason != ControlReason.NoneOrRootExit || FailureStage != ControlStage.None;
        }

        private static bool IsLaunchPreparationFailure(ControlStage stage)
        {
            return stage == ControlStage.StdioDuplicateFailed ||
                stage == ControlStage.AttributeListInitFailed ||
                stage == ControlStage.HandleListAttributeFailed ||
                stage == ControlStage.JobListAttributeFailed ||
                stage == ControlStage.CommandLineInvalid;
        }

        private static bool IsNativeFailureStage(ControlStage stage)
        {
            return stage == ControlStage.JobCreateFailed ||
                stage == ControlStage.JobConfigFailed ||
                IsLaunchPreparationFailure(stage) ||
                stage == ControlStage.ResumeFailed ||
                stage == ControlStage.TerminateJobFailed ||
                stage == ControlStage.QueryJobFailed ||
                stage == ControlStage.HelperInternal ||
                stage == ControlStage.WaitFailed;
        }

        private static void RequireFailureActor(LifecycleActor actor, ControlStage stage)
        {
            bool valid;
            if (stage == ControlStage.WaitFailed)
            {
                valid = actor == LifecycleActor.RootWaiter;
            }
            else if (stage == ControlStage.TerminateJobFailed ||
                stage == ControlStage.QueryJobFailed ||
                stage == ControlStage.HelperInternal)
            {
                valid = actor == LifecycleActor.CleanupOwner;
            }
            else
            {
                valid = actor == LifecycleActor.Launcher;
            }
            if (!valid)
            {
                throw new LifecycleViolationException();
            }
        }

        private bool IsBeforeReadyCreation()
        {
            return State == LifecycleState.Configured ||
                State == LifecycleState.JobReady ||
                State == LifecycleState.Creating ||
                State == LifecycleState.CreatedAssigned;
        }

        private static bool IsStopEvent(LifecycleEvent lifecycleEvent)
        {
            return lifecycleEvent == LifecycleEvent.TerminateCancelled ||
                lifecycleEvent == LifecycleEvent.TerminateTimedOut ||
                lifecycleEvent == LifecycleEvent.TerminateSessionShutdown ||
                lifecycleEvent == LifecycleEvent.ControlEof ||
                lifecycleEvent == LifecycleEvent.ProtocolError;
        }

        private static void RequireActor(LifecycleActor actor, LifecycleEvent lifecycleEvent)
        {
            bool valid;
            switch (lifecycleEvent)
            {
                case LifecycleEvent.JobPrepared:
                case LifecycleEvent.BeginCreate:
                case LifecycleEvent.CreateSucceeded:
                case LifecycleEvent.CreateFailed:
                case LifecycleEvent.ResumeSucceeded:
                case LifecycleEvent.ReadyPublished:
                    valid = actor == LifecycleActor.Launcher;
                    break;
                case LifecycleEvent.TerminateCancelled:
                case LifecycleEvent.TerminateTimedOut:
                case LifecycleEvent.TerminateSessionShutdown:
                case LifecycleEvent.ControlEof:
                case LifecycleEvent.ProtocolError:
                    valid = actor == LifecycleActor.ControlReader;
                    break;
                case LifecycleEvent.RootCompleted:
                    valid = actor == LifecycleActor.RootWaiter;
                    break;
                case LifecycleEvent.JobZero:
                    valid = actor == LifecycleActor.CleanupOwner;
                    break;
                case LifecycleEvent.SealExit:
                case LifecycleEvent.SealError:
                    valid = actor == LifecycleActor.TerminalWriter;
                    break;
                default:
                    valid = false;
                    break;
            }
            if (!valid)
            {
                throw new LifecycleViolationException();
            }
        }

        private LifecycleMachine Copy(
            LifecycleState? state = null,
            CleanupOwner? owner = null,
            ControlReason? stopReason = null,
            ControlStage? failureStage = null,
            TerminalKind? terminal = null,
            bool? wasResumed = null,
            bool? readyWasPublished = null,
            bool? rootWasCompleted = null,
            bool? jobWasZero = null)
        {
            return new LifecycleMachine(
                state ?? State,
                owner ?? Owner,
                stopReason ?? StopReason,
                failureStage ?? FailureStage,
                terminal ?? Terminal,
                wasResumed ?? WasResumed,
                readyWasPublished ?? ReadyWasPublished,
                rootWasCompleted ?? RootWasCompleted,
                jobWasZero ?? JobWasZero);
        }
    }
}
