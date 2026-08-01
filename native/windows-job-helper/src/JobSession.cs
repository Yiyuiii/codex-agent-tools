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

    internal sealed class JobSession : IDisposable
    {
        private readonly object gate = new object();
        private readonly IWin32Api api;
        private SafeJobHandle job;
        private SafeProcessHandle process;
        private SafeThreadHandle thread;
        private LifecycleMachine lifecycle;
        private bool disposed;

        private JobSession(
            IWin32Api api,
            SafeJobHandle job,
            SafeProcessHandle process,
            SafeThreadHandle thread,
            LifecycleMachine lifecycle)
        {
            this.api = api;
            this.job = job;
            this.process = process;
            this.thread = thread;
            this.lifecycle = lifecycle;
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
            if (api == null)
            {
                throw new ArgumentNullException("api");
            }
            NativeMethods.ValidateCurrentHostLayouts();

            LifecycleMachine machine = LifecycleMachine.Initial;
            SafeJobHandle job = null;
            SafeProcessHandle process = null;
            SafeThreadHandle thread = null;
            var inherited = new List<SafeInheritedHandle>();
            SafeNativeBuffer limits = null;
            SafeNativeBuffer handleValues = null;
            SafeNativeBuffer jobValue = null;
            ProcThreadAttributeList attributes = null;
            bool transferred = false;
            try
            {
                int error;
                IntPtr rawJob = api.CreateJobObject(out error);
                if (rawJob == IntPtr.Zero || rawJob == new IntPtr(-1))
                {
                    machine = machine.ApplyFailure(
                        LifecycleActor.Launcher,
                        ControlStage.JobCreateFailed);
                    throw new JobSessionException(ControlStage.JobCreateFailed, error);
                }
                job = new SafeJobHandle(rawJob);

                var limitValue = new NativeMethods.JobExtendedLimitInformation();
                limitValue.BasicLimitInformation.LimitFlags =
                    NativeMethods.JobObjectLimitKillOnJobClose;
                int limitBytes = Marshal.SizeOf(typeof(NativeMethods.JobExtendedLimitInformation));
                limits = AllocateZeroed(limitBytes);
                Marshal.StructureToPtr(limitValue, limits.DangerousGetHandle(), false);
                if (!api.SetInformationJobObject(
                    job.DangerousGetHandle(),
                    NativeMethods.JobObjectExtendedLimitInformation,
                    limits.DangerousGetHandle(),
                    checked((uint)limitBytes),
                    out error))
                {
                    machine = machine.ApplyFailure(
                        LifecycleActor.Launcher,
                        ControlStage.JobConfigFailed);
                    throw new JobSessionException(ControlStage.JobConfigFailed, error);
                }
                machine = machine.Apply(LifecycleActor.Launcher, LifecycleEvent.JobPrepared);

                WindowsCommandLineSpec commandLine;
                try
                {
                    commandLine = WindowsCommandLine.Build(
                        executable, currentDirectory, arguments);
                }
                catch (CommandLineContractException)
                {
                    machine = machine.ApplyFailure(
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
                        machine = machine.ApplyFailure(
                            LifecycleActor.Launcher,
                            ControlStage.StdioDuplicateFailed);
                        throw new JobSessionException(ControlStage.StdioDuplicateFailed, error);
                    }
                    inherited.Add(new SafeInheritedHandle(duplicate));
                }

                attributes = ProcThreadAttributeList.Create(api, 2, out error);
                if (attributes == null)
                {
                    machine = machine.ApplyFailure(
                        LifecycleActor.Launcher,
                        ControlStage.AttributeListInitFailed);
                    throw new JobSessionException(ControlStage.AttributeListInitFailed, error);
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
                    machine = machine.ApplyFailure(
                        LifecycleActor.Launcher,
                        ControlStage.HandleListAttributeFailed);
                    throw new JobSessionException(ControlStage.HandleListAttributeFailed, error);
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
                    machine = machine.ApplyFailure(
                        LifecycleActor.Launcher,
                        ControlStage.JobListAttributeFailed);
                    throw new JobSessionException(ControlStage.JobListAttributeFailed, error);
                }

                var startup = new NativeMethods.StartupInfoEx();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(NativeMethods.StartupInfoEx));
                startup.StartupInfo.dwFlags = NativeMethods.StartfUseStdHandles;
                startup.StartupInfo.cbReserved2 = 0;
                startup.StartupInfo.lpReserved2 = IntPtr.Zero;
                startup.StartupInfo.hStdInput = inherited[0].DangerousGetHandle();
                startup.StartupInfo.hStdOutput = inherited[1].DangerousGetHandle();
                startup.StartupInfo.hStdError = inherited[2].DangerousGetHandle();
                startup.AttributeList = attributes.DangerousGetHandle();

                machine = machine.Apply(LifecycleActor.Launcher, LifecycleEvent.BeginCreate);
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
                    machine = machine.Apply(
                        LifecycleActor.Launcher,
                        LifecycleEvent.CreateFailed);
                    throw new JobSessionException(ControlStage.CreateFailed, error);
                }

                process = new SafeProcessHandle(information.Process);
                thread = new SafeThreadHandle(information.Thread);
                machine = machine.Apply(
                    LifecycleActor.Launcher,
                    LifecycleEvent.CreateSucceeded);
                var result = new JobSession(api, job, process, thread, machine);
                transferred = true;
                return result;
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
                if (limits != null)
                {
                    limits.Dispose();
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
                    if (job != null)
                    {
                        job.Dispose();
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
                    if (!api.QueryInformationJobObject(
                        job.DangerousGetHandle(),
                        NativeMethods.JobObjectExtendedLimitInformation,
                        buffer.DangerousGetHandle(),
                        checked((uint)size),
                        out error))
                    {
                        throw new JobSessionException(ControlStage.QueryJobFailed, error);
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

        public void Dispose()
        {
            lock (gate)
            {
                if (disposed)
                {
                    return;
                }
                disposed = true;
                if (thread != null)
                {
                    thread.Dispose();
                    thread = null;
                }
                if (job != null)
                {
                    // The final Job handle is intentionally closed last. Its only
                    // configured limit is KILL_ON_JOB_CLOSE.
                    job.Dispose();
                    job = null;
                }
                if (process != null)
                {
                    int ignoredError;
                    api.WaitForSingleObject(
                        process.DangerousGetHandle(),
                        NativeMethods.Infinite,
                        out ignoredError);
                    process.Dispose();
                    process = null;
                }
            }
        }

        private void RequireNotDisposed()
        {
            if (disposed)
            {
                throw new ObjectDisposedException("JobSession");
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
    }
}
