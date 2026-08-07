using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace CodexAgentTools.WindowsJobHelper
{
    internal sealed class JobSessionException : Exception
    {
        internal ControlStage Stage { get; private set; }
        internal int? Win32Code { get; private set; }

        internal JobSessionException(ControlStage stage, int error)
            : base("windows_native_job_session_failed")
        {
            Stage = stage;
            Win32Code = error == 0 ? (int?)null : error;
        }
    }

    internal sealed class TerminalSnapshot
    {
        internal TerminalKind Kind { get; private set; }
        internal ControlStage Stage { get; private set; }
        internal ControlReason Reason { get; private set; }
        internal uint? Win32Code { get; private set; }
        internal uint RootExitCode { get; private set; }

        internal TerminalSnapshot(
            TerminalKind kind,
            ControlStage stage,
            ControlReason reason,
            uint? win32Code,
            uint rootExitCode)
        {
            Kind = kind;
            Stage = stage;
            Reason = reason;
            Win32Code = win32Code;
            RootExitCode = rootExitCode;
        }
    }

    internal sealed class JobSession : ISessionKernel, IDisposable
    {
        private readonly object gate = new object();
        private readonly IWin32Api api;
        private SafeJobHandle job;
        private SafeProcessHandle process;
        private SafeThreadHandle thread;
        private LifecycleMachine lifecycle;
        private uint? failureWin32Code;
        private uint rootExitCode;
        private bool rootExitCodeKnown;
        private bool terminalReserved;
        private bool disposed;

        internal JobSession(IWin32Api api)
        {
            if (api == null)
            {
                throw new ArgumentNullException("api");
            }
            NativeMethods.ValidateCurrentHostLayouts();
            this.api = api;
            lifecycle = LifecycleMachine.Initial;
        }

        internal LifecycleMachine Lifecycle
        {
            get
            {
                lock (gate)
                {
                    return lifecycle;
                }
            }
        }

        internal static JobSession CreateSuspended(
            IWin32Api api,
            string executable,
            string currentDirectory,
            IEnumerable<string> arguments)
        {
            var session = new JobSession(api);
            try
            {
                session.PrepareJob();
                session.CreateSuspended(executable, currentDirectory, arguments);
                return session;
            }
            catch
            {
                session.Dispose();
                throw;
            }
        }

        internal void PrepareJob()
        {
            lock (gate)
            {
                RequireNotDisposed();
                if (lifecycle.State != LifecycleState.Configured)
                {
                    ThrowCurrentFailureOrViolation();
                }

                SafeJobHandle preparedJob = null;
                SafeNativeBuffer limits = null;
                try
                {
                    int error;
                    IntPtr rawJob = api.CreateJobObject(out error);
                    if (rawJob == IntPtr.Zero || rawJob == new IntPtr(-1))
                    {
                        lifecycle = lifecycle.ApplyFailure(
                            LifecycleActor.Launcher,
                            ControlStage.JobCreateFailed);
                        RecordFirstWin32Code(ControlStage.JobCreateFailed, error);
                        throw new JobSessionException(ControlStage.JobCreateFailed, error);
                    }
                    preparedJob = new SafeJobHandle(rawJob);

                    var limitValue = new NativeMethods.JobExtendedLimitInformation();
                    limitValue.BasicLimitInformation.LimitFlags =
                        NativeMethods.JobObjectLimitKillOnJobClose;
                    int limitBytes = Marshal.SizeOf(
                        typeof(NativeMethods.JobExtendedLimitInformation));
                    limits = AllocateZeroed(limitBytes);
                    Marshal.StructureToPtr(limitValue, limits.DangerousGetHandle(), false);
                    if (!api.SetInformationJobObject(
                        preparedJob.DangerousGetHandle(),
                        NativeMethods.JobObjectExtendedLimitInformation,
                        limits.DangerousGetHandle(),
                        checked((uint)limitBytes),
                        out error))
                    {
                        lifecycle = lifecycle.ApplyFailure(
                            LifecycleActor.Launcher,
                            ControlStage.JobConfigFailed);
                        RecordFirstWin32Code(ControlStage.JobConfigFailed, error);
                        throw new JobSessionException(ControlStage.JobConfigFailed, error);
                    }

                    job = preparedJob;
                    preparedJob = null;
                    lifecycle = lifecycle.Apply(
                        LifecycleActor.Launcher,
                        LifecycleEvent.JobPrepared);
                }
                finally
                {
                    if (limits != null)
                    {
                        limits.Dispose();
                    }
                    if (preparedJob != null)
                    {
                        preparedJob.Dispose();
                    }
                }
            }
        }

        internal void CreateSuspended(
            string executable,
            string currentDirectory,
            IEnumerable<string> arguments)
        {
            SafeProcessHandle process = null;
            SafeThreadHandle thread = null;
            var inherited = new List<SafeInheritedHandle>();
            SafeNativeBuffer handleValues = null;
            SafeNativeBuffer jobValue = null;
            ProcThreadAttributeList attributes = null;
            bool transferred = false;
            try
            {
                WindowsCommandLineSpec commandLine;
                NativeMethods.StartupInfoEx startup;
                int error = 0;
                lock (gate)
                {
                    RequireNotDisposed();
                    if (lifecycle.State != LifecycleState.JobReady)
                    {
                        ThrowCurrentFailureOrViolation();
                    }

                    try
                    {
                        commandLine = WindowsCommandLine.Build(
                            executable, currentDirectory, arguments);
                    }
                    catch (CommandLineContractException)
                    {
                        lifecycle = lifecycle.ApplyFailure(
                            LifecycleActor.Launcher,
                            ControlStage.CommandLineInvalid);
                        throw new JobSessionException(ControlStage.CommandLineInvalid, 0);
                    }

                    int[] standardHandles = {
                        NativeMethods.StandardInputHandle,
                        NativeMethods.StandardOutputHandle,
                        NativeMethods.StandardErrorHandle
                    };
                    foreach (int standardHandle in standardHandles)
                    {
                        IntPtr source = NativeMethods.StandardHandle(standardHandle);
                        IntPtr duplicate = IntPtr.Zero;
                        if (source == IntPtr.Zero || source == new IntPtr(-1) ||
                            !api.DuplicateHandle(source, out duplicate, out error) ||
                            duplicate == IntPtr.Zero || duplicate == new IntPtr(-1))
                        {
                            if (duplicate != IntPtr.Zero && duplicate != new IntPtr(-1))
                            {
                                new SafeInheritedHandle(duplicate).Dispose();
                            }
                            lifecycle = lifecycle.ApplyFailure(
                                LifecycleActor.Launcher,
                                ControlStage.StdioDuplicateFailed);
                            throw new JobSessionException(
                                ControlStage.StdioDuplicateFailed, error);
                        }
                        inherited.Add(new SafeInheritedHandle(duplicate));
                    }

                    attributes = ProcThreadAttributeList.Create(api, 2, out error);
                    if (attributes == null)
                    {
                        lifecycle = lifecycle.ApplyFailure(
                            LifecycleActor.Launcher,
                            ControlStage.AttributeListInitFailed);
                        throw new JobSessionException(
                            ControlStage.AttributeListInitFailed, error);
                    }

                    handleValues = AllocateZeroed(checked(IntPtr.Size * inherited.Count));
                    for (int index = 0; index < inherited.Count; index++)
                    {
                        Marshal.WriteIntPtr(
                            handleValues.DangerousGetHandle(),
                            checked(index * IntPtr.Size),
                            inherited[index].DangerousGetHandle());
                    }
                    if (!api.UpdateProcThreadAttribute(
                        attributes.DangerousGetHandle(),
                        NativeMethods.ProcThreadAttributeHandleList,
                        handleValues.DangerousGetHandle(),
                        new IntPtr(checked(IntPtr.Size * inherited.Count)),
                        out error))
                    {
                        lifecycle = lifecycle.ApplyFailure(
                            LifecycleActor.Launcher,
                            ControlStage.HandleListAttributeFailed);
                        throw new JobSessionException(
                            ControlStage.HandleListAttributeFailed, error);
                    }

                    jobValue = AllocateZeroed(IntPtr.Size);
                    Marshal.WriteIntPtr(jobValue.DangerousGetHandle(), job.DangerousGetHandle());
                    if (!api.UpdateProcThreadAttribute(
                        attributes.DangerousGetHandle(),
                        NativeMethods.ProcThreadAttributeJobList,
                        jobValue.DangerousGetHandle(),
                        new IntPtr(IntPtr.Size),
                        out error))
                    {
                        lifecycle = lifecycle.ApplyFailure(
                            LifecycleActor.Launcher,
                            ControlStage.JobListAttributeFailed);
                        throw new JobSessionException(
                            ControlStage.JobListAttributeFailed, error);
                    }

                    startup = new NativeMethods.StartupInfoEx();
                    startup.StartupInfo.cb = Marshal.SizeOf(
                        typeof(NativeMethods.StartupInfoEx));
                    startup.StartupInfo.dwFlags = NativeMethods.StartfUseStdHandles;
                    startup.StartupInfo.cbReserved2 = 0;
                    startup.StartupInfo.lpReserved2 = IntPtr.Zero;
                    startup.StartupInfo.hStdInput = inherited[0].DangerousGetHandle();
                    startup.StartupInfo.hStdOutput = inherited[1].DangerousGetHandle();
                    startup.StartupInfo.hStdError = inherited[2].DangerousGetHandle();
                    startup.AttributeList = attributes.DangerousGetHandle();

                    lifecycle = lifecycle.Apply(
                        LifecycleActor.Launcher,
                        LifecycleEvent.BeginCreate);
                }
                var writableCommandLine = new StringBuilder(
                    commandLine.CommandLine,
                    checked(commandLine.CommandLine.Length + 1));
                NativeMethods.ProcessInformation information;
                bool created = api.CreateProcess(
                    commandLine.ApplicationName,
                    writableCommandLine,
                    true,
                    NativeMethods.CreateSuspended |
                        NativeMethods.ExtendedStartupInfoPresent |
                        NativeMethods.CreateNoWindow,
                    commandLine.CurrentDirectory,
                    ref startup,
                    out information,
                    out error);

                // Keep the exact handle-value buffers and the SafeHandle owners
                // alive through CreateProcessW. Attribute storage is deleted only
                // after that call returns.
                GC.KeepAlive(handleValues);
                GC.KeepAlive(jobValue);
                GC.KeepAlive(inherited);
                GC.KeepAlive(job);
                GC.KeepAlive(attributes);

                if (!created ||
                    information.Process == IntPtr.Zero ||
                    information.Thread == IntPtr.Zero)
                {
                    CloseReturnedProcessInformation(information);
                    lock (gate)
                    {
                        ControlStage beforeCreateFailure = lifecycle.FailureStage;
                        lifecycle = lifecycle.Apply(
                            LifecycleActor.Launcher,
                            LifecycleEvent.CreateFailed);
                        if (beforeCreateFailure == ControlStage.None)
                        {
                            RecordFirstWin32Code(ControlStage.CreateFailed, error);
                        }
                        throw new JobSessionException(lifecycle.FailureStage, error);
                    }
                }

                process = new SafeProcessHandle(information.Process);
                thread = new SafeThreadHandle(information.Thread);
                lock (gate)
                {
                    RequireNotDisposed();
                    this.process = process;
                    this.thread = thread;
                    lifecycle = lifecycle.Apply(
                        LifecycleActor.Launcher,
                        LifecycleEvent.CreateSucceeded);
                    transferred = true;
                }
            }
            finally
            {
                if (attributes != null)
                {
                    attributes.Dispose();
                }
                if (jobValue != null)
                {
                    jobValue.Dispose();
                }
                if (handleValues != null)
                {
                    handleValues.Dispose();
                }
                foreach (SafeInheritedHandle handle in inherited)
                {
                    handle.Dispose();
                }
                if (!transferred)
                {
                    if (thread != null)
                    {
                        thread.Dispose();
                    }
                    if (process != null)
                    {
                        process.Dispose();
                    }
                }
            }
        }

        internal void ResumeAndPublishReady(Action readyWriter)
        {
            if (readyWriter == null)
            {
                throw new ArgumentNullException("readyWriter");
            }
            lock (gate)
            {
                RequireNotDisposed();
                if (lifecycle.State != LifecycleState.CreatedAssigned)
                {
                    if (lifecycle.FailureStage != ControlStage.None)
                    {
                        throw new JobSessionException(lifecycle.FailureStage, 0);
                    }
                    throw new LifecycleViolationException();
                }
                int error;
                uint previousSuspendCount = api.ResumeThread(
                    thread.DangerousGetHandle(),
                    out error);
                if (previousSuspendCount != 1)
                {
                    lifecycle = lifecycle.ApplyFailure(
                        LifecycleActor.Launcher,
                        ControlStage.ResumeFailed);
                    RecordFirstWin32Code(ControlStage.ResumeFailed, error);
                    throw new JobSessionException(ControlStage.ResumeFailed, error);
                }

                lifecycle = lifecycle.Apply(
                    LifecycleActor.Launcher,
                    LifecycleEvent.ResumeSucceeded);
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
                lifecycle = lifecycle.Apply(
                    LifecycleActor.Launcher,
                    LifecycleEvent.ReadyPublished);
            }
        }

        internal void RequestStop(ControlReason reason)
        {
            LifecycleEvent stopEvent;
            switch (reason)
            {
                case ControlReason.Cancelled:
                    stopEvent = LifecycleEvent.TerminateCancelled;
                    break;
                case ControlReason.TimedOut:
                    stopEvent = LifecycleEvent.TerminateTimedOut;
                    break;
                case ControlReason.SessionShutdown:
                    stopEvent = LifecycleEvent.TerminateSessionShutdown;
                    break;
                default:
                    throw new ArgumentOutOfRangeException("reason");
            }
            lock (gate)
            {
                RequireNotDisposed();
                lifecycle = lifecycle.Apply(LifecycleActor.ControlReader, stopEvent);
            }
        }

        internal void ReportControlFailure(bool protocolInvalid)
        {
            lock (gate)
            {
                RequireNotDisposed();
                lifecycle = lifecycle.Apply(
                    LifecycleActor.ControlReader,
                    protocolInvalid
                        ? LifecycleEvent.ProtocolError
                        : LifecycleEvent.ControlEof);
            }
        }

        internal bool WaitForRootExit(uint milliseconds)
        {
            SafeProcessHandle stableProcess;
            bool addedReference = false;
            lock (gate)
            {
                RequireNotDisposed();
                stableProcess = process;
                stableProcess.DangerousAddRef(ref addedReference);
            }

            int error;
            uint result;
            try
            {
                result = api.WaitForSingleObject(
                    stableProcess.DangerousGetHandle(),
                    milliseconds,
                    out error);
            }
            finally
            {
                if (addedReference)
                {
                    stableProcess.DangerousRelease();
                }
            }

            lock (gate)
            {
                RequireNotDisposed();
                if (result == NativeMethods.WaitObject0)
                {
                    lifecycle = lifecycle.Apply(
                        LifecycleActor.RootWaiter,
                        LifecycleEvent.RootCompleted);
                    return true;
                }
                if (result == NativeMethods.WaitTimeout)
                {
                    return false;
                }
                lifecycle = lifecycle.ApplyFailure(
                    LifecycleActor.RootWaiter,
                    ControlStage.WaitFailed);
                RecordFirstWin32Code(ControlStage.WaitFailed, error);
                throw new JobSessionException(ControlStage.WaitFailed, error);
            }
        }

        internal uint QueryLimitFlags()
        {
            lock (gate)
            {
                RequireNotDisposed();
                int size = Marshal.SizeOf(typeof(NativeMethods.JobExtendedLimitInformation));
                using (SafeNativeBuffer buffer = AllocateZeroed(size))
                {
                    int error;
                    uint returnLength;
                    if (!api.QueryInformationJobObject(
                        job.DangerousGetHandle(),
                        NativeMethods.JobObjectExtendedLimitInformation,
                        buffer.DangerousGetHandle(),
                        checked((uint)size),
                        out returnLength,
                        out error))
                    {
                        throw new JobSessionException(ControlStage.QueryJobFailed, error);
                    }
                    if (returnLength != checked((uint)size))
                    {
                        throw new JobSessionException(ControlStage.QueryJobFailed, 0);
                    }
                    return ((NativeMethods.JobExtendedLimitInformation)Marshal.PtrToStructure(
                        buffer.DangerousGetHandle(),
                        typeof(NativeMethods.JobExtendedLimitInformation)))
                        .BasicLimitInformation.LimitFlags;
                }
            }
        }

        internal bool IsJobHandleInheritable()
        {
            lock (gate)
            {
                RequireNotDisposed();
                return NativeMethods.IsHandleInheritable(job.DangerousGetHandle());
            }
        }

        internal bool IsRootInOwnedJob()
        {
            lock (gate)
            {
                RequireNotDisposed();
                bool isMember;
                int error;
                if (!api.IsProcessInJob(
                    process.DangerousGetHandle(),
                    job.DangerousGetHandle(),
                    out isMember,
                    out error))
                {
                    throw new JobSessionException(ControlStage.QueryJobFailed, error);
                }
                return isMember;
            }
        }

        internal bool HasRootProcess
        {
            get
            {
                lock (gate)
                {
                    return process != null;
                }
            }
        }

        internal void TerminateOwnedJob()
        {
            lock (gate)
            {
                RequireNotDisposed();
                int error;
                if (!api.TerminateJobObject(job.DangerousGetHandle(), 1, out error))
                {
                    ControlStage before = lifecycle.FailureStage;
                    lifecycle = lifecycle.ApplyFailure(
                        LifecycleActor.CleanupOwner,
                        ControlStage.TerminateJobFailed);
                    if (before == ControlStage.None)
                    {
                        RecordFirstWin32Code(ControlStage.TerminateJobFailed, error);
                    }
                    throw new JobSessionException(ControlStage.TerminateJobFailed, error);
                }
            }
        }

        internal uint QueryActiveProcesses()
        {
            lock (gate)
            {
                RequireNotDisposed();
                int size = Marshal.SizeOf(typeof(NativeMethods.JobBasicAccountingInformation));
                using (SafeNativeBuffer buffer = AllocateZeroed(size))
                {
                    int error;
                    uint returnLength;
                    bool queried = api.QueryInformationJobObject(
                        job.DangerousGetHandle(),
                        NativeMethods.JobObjectBasicAccountingInformation,
                        buffer.DangerousGetHandle(),
                        checked((uint)size),
                        out returnLength,
                        out error);
                    if (!queried || returnLength != checked((uint)size))
                    {
                        ControlStage before = lifecycle.FailureStage;
                        lifecycle = lifecycle.ApplyFailure(
                            LifecycleActor.CleanupOwner,
                            ControlStage.QueryJobFailed);
                        if (before == ControlStage.None)
                        {
                            RecordFirstWin32Code(ControlStage.QueryJobFailed, error);
                        }
                        throw new JobSessionException(ControlStage.QueryJobFailed, error);
                    }
                    return ((NativeMethods.JobBasicAccountingInformation)
                        Marshal.PtrToStructure(
                            buffer.DangerousGetHandle(),
                            typeof(NativeMethods.JobBasicAccountingInformation)))
                        .ActiveProcesses;
                }
            }
        }

        internal void RecordJobZero()
        {
            lock (gate)
            {
                RequireNotDisposed();
                lifecycle = lifecycle.Apply(
                    LifecycleActor.CleanupOwner,
                    LifecycleEvent.JobZero);
            }
        }

        internal uint ReadRootExitCode()
        {
            lock (gate)
            {
                RequireNotDisposed();
                if (rootExitCodeKnown)
                {
                    return rootExitCode;
                }
                int error;
                uint value;
                if (!api.GetExitCodeProcess(process.DangerousGetHandle(), out value, out error))
                {
                    ControlStage before = lifecycle.FailureStage;
                    lifecycle = lifecycle.ApplyFailure(
                        LifecycleActor.CleanupOwner,
                        ControlStage.HelperInternal);
                    if (before == ControlStage.None)
                    {
                        RecordFirstWin32Code(ControlStage.HelperInternal, error);
                    }
                    throw new JobSessionException(ControlStage.HelperInternal, error);
                }
                rootExitCode = value;
                rootExitCodeKnown = true;
                return value;
            }
        }

        internal TerminalSnapshot TryReserveTerminal()
        {
            lock (gate)
            {
                RequireNotDisposed();
                if (terminalReserved)
                {
                    return null;
                }
                TerminalKind kind = lifecycle.FailureStage == ControlStage.None
                    ? TerminalKind.Exit
                    : TerminalKind.Error;
                lifecycle = lifecycle.Apply(
                    LifecycleActor.TerminalWriter,
                    kind == TerminalKind.Exit
                        ? LifecycleEvent.SealExit
                        : LifecycleEvent.SealError);
                terminalReserved = true;
                return new TerminalSnapshot(
                    kind,
                    lifecycle.FailureStage,
                    lifecycle.StopReason,
                    failureWin32Code,
                    rootExitCodeKnown ? rootExitCode : 0);
            }
        }

        public void Dispose()
        {
            SafeThreadHandle threadToClose;
            SafeJobHandle jobToClose;
            SafeProcessHandle processToClose;
            lock (gate)
            {
                if (disposed)
                {
                    return;
                }
                disposed = true;
                threadToClose = thread;
                jobToClose = job;
                processToClose = process;
                thread = null;
                job = null;
                process = null;
            }
            if (threadToClose != null)
            {
                threadToClose.Dispose();
            }
            if (jobToClose != null)
            {
                // KILL_ON_JOB_CLOSE is the final exception fallback when an
                // explicit cleanup path could not prove Job-zero.
                jobToClose.Dispose();
            }
            if (processToClose != null)
            {
                int ignoredError;
                api.WaitForSingleObject(
                    processToClose.DangerousGetHandle(),
                    NativeMethods.Infinite,
                    out ignoredError);
                processToClose.Dispose();
            }
        }

        private void RequireNotDisposed()
        {
            if (disposed)
            {
                throw new ObjectDisposedException("JobSession");
            }
        }

        private void ThrowCurrentFailureOrViolation()
        {
            if (lifecycle.FailureStage != ControlStage.None)
            {
                throw new JobSessionException(lifecycle.FailureStage, 0);
            }
            throw new LifecycleViolationException();
        }

        private void RecordFirstWin32Code(ControlStage stage, int error)
        {
            if (failureWin32Code == null &&
                lifecycle.FailureStage == stage &&
                error != 0)
            {
                failureWin32Code = checked((uint)error);
            }
        }

        private static SafeNativeBuffer AllocateZeroed(int bytes)
        {
            SafeNativeBuffer buffer = SafeNativeBuffer.Allocate(bytes);
            for (int offset = 0; offset < bytes; offset++)
            {
                Marshal.WriteByte(buffer.DangerousGetHandle(), offset, 0);
            }
            return buffer;
        }

        private static void CloseReturnedProcessInformation(
            NativeMethods.ProcessInformation information)
        {
            if (information.Thread != IntPtr.Zero && information.Thread != new IntPtr(-1))
            {
                new SafeThreadHandle(information.Thread).Dispose();
            }
            if (information.Process != IntPtr.Zero && information.Process != new IntPtr(-1))
            {
                new SafeProcessHandle(information.Process).Dispose();
            }
        }

        LifecycleMachine ISessionKernel.Lifecycle { get { return Lifecycle; } }
        bool ISessionKernel.HasRootProcess { get { return HasRootProcess; } }
        void ISessionKernel.PrepareJob() { PrepareJob(); }
        void ISessionKernel.CreateSuspended(
            string executable,
            string currentDirectory,
            IEnumerable<string> arguments)
        {
            CreateSuspended(executable, currentDirectory, arguments);
        }
        void ISessionKernel.ResumeAndPublishReady(Action readyWriter)
        {
            ResumeAndPublishReady(readyWriter);
        }
        void ISessionKernel.RequestStop(ControlReason reason) { RequestStop(reason); }
        void ISessionKernel.ReportControlFailure(bool protocolInvalid)
        {
            ReportControlFailure(protocolInvalid);
        }
        bool ISessionKernel.WaitForRootExit(uint milliseconds)
        {
            return WaitForRootExit(milliseconds);
        }
        uint ISessionKernel.ReadRootExitCode() { return ReadRootExitCode(); }
        void ISessionKernel.TerminateOwnedJob() { TerminateOwnedJob(); }
        uint ISessionKernel.QueryActiveProcesses() { return QueryActiveProcesses(); }
        void ISessionKernel.RecordJobZero() { RecordJobZero(); }
        TerminalSnapshot ISessionKernel.TryReserveTerminal() { return TryReserveTerminal(); }
    }
}
