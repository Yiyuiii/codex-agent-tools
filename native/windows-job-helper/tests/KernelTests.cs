using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CodexAgentTools.WindowsJobHelper.Tests
{
    internal static class KernelTests
    {
        internal static int Run(string fixturePath)
        {
            int count = 0;

            TestAssert.Equal(new IntPtr(0x00020002), NativeMethods.ProcThreadAttributeHandleList);
            TestAssert.Equal(new IntPtr(0x0002000D), NativeMethods.ProcThreadAttributeJobList);
            TestAssert.Equal(104, Marshal.SizeOf(typeof(NativeMethods.StartupInfo)));
            TestAssert.Equal(112, Marshal.SizeOf(typeof(NativeMethods.StartupInfoEx)));
            TestAssert.Equal(
                new IntPtr(104),
                Marshal.OffsetOf(typeof(NativeMethods.StartupInfoEx), "AttributeList"));
            TestAssert.Equal(24, Marshal.SizeOf(typeof(NativeMethods.ProcessInformation)));
            TestAssert.Equal(48, Marshal.SizeOf(typeof(NativeMethods.JobBasicAccountingInformation)));
            TestAssert.Equal(64, Marshal.SizeOf(typeof(NativeMethods.JobBasicLimitInformation)));
            TestAssert.Equal(144, Marshal.SizeOf(typeof(NativeMethods.JobExtendedLimitInformation)));
            TestAssert.Equal(32, Marshal.SizeOf(typeof(NativeMethods.NativeOverlapped)));
            count++;

            string root = CreateTemporaryRoot();
            string marker = Path.Combine(root, "resume.marker");
            // CreateProcessW causes the CLR to establish two process-lifetime
            // interop handles on its first use. Exercise the exact suspended Job
            // path once, fully dispose it, then take the stable baseline used by
            // every measured case. No per-invocation growth is accepted.
            WarmUpKernelPath(fixturePath);
            GC.Collect();
            GC.WaitForPendingFinalizers();
            int baselineHandles = NativeMethods.GetCurrentProcessHandleCountChecked();
            string challengeNonce = Guid.NewGuid().ToString("N");
            try
            {
                using (var excludedEvent = InheritableEvent.Create())
                {
                    var recordingApi = new FaultingWin32Api(FaultStep.None, null);
                    using (var session = JobSession.CreateSuspended(
                        recordingApi,
                        fixturePath,
                        root,
                        new[] {
                            "--inspect",
                            marker,
                            excludedEvent.Handle.ToInt64().ToString(
                                System.Globalization.CultureInfo.InvariantCulture),
                            challengeNonce
                        }))
                    {
                        TestAssert.Equal(LifecycleState.CreatedAssigned, session.Lifecycle.State);
                        TestAssert.True(session.IsRootInOwnedJob());
                        TestAssert.True(!session.IsJobHandleInheritable());
                        TestAssert.True(!excludedEvent.IsSignaled());
                        TestAssert.Equal(
                            NativeMethods.CreateSuspended |
                                NativeMethods.ExtendedStartupInfoPresent |
                                NativeMethods.CreateNoWindow,
                            recordingApi.ObservedCreationFlags);
                        TestAssert.True(recordingApi.ObservedInheritHandles);
                        TestAssert.True(recordingApi.ObservedReservedDataEmpty);
                        TestAssert.True(recordingApi.AttributeValuesAliveDuringCreate);
                        TestAssert.True(recordingApi.AttributeListDeletedAfterCreate);
                        Thread.Sleep(100);
                        TestAssert.True(!File.Exists(marker));
                        session.ResumeAndPublishReady(delegate { });
                        TestAssert.True(session.Lifecycle.ReadyWasPublished);
                        TestAssert.True(session.WaitForRootExit(5000));
                        WaitForFile(marker, 5000);
                        string evidence = File.ReadAllText(marker, Encoding.UTF8);
                        TestAssert.True(evidence.Contains("membership=1\n"));
                        TestAssert.True(evidence.Contains("limitFlags=8192\n"));
                        TestAssert.True(evidence.Contains("stdioOnly=1\n"));
                        TestAssert.True(evidence.Contains("reservedDataEmpty=1\n"));
                        TestAssert.True(evidence.Contains("nonce=" + challengeNonce + "\n"));
                        TestAssert.True(!excludedEvent.IsSignaled());
                        TestAssert.Equal(
                            NativeMethods.JobObjectLimitKillOnJobClose,
                            session.QueryLimitFlags());
                    }
                }
            }
            finally
            {
                DeleteTemporaryRoot(root, marker);
            }
            TestAssert.Equal(baselineHandles, NativeMethods.GetCurrentProcessHandleCountChecked());
            count++;

            foreach (FaultStep step in new[] {
                FaultStep.JobCreate,
                FaultStep.JobConfig,
                FaultStep.DuplicateHandle,
                FaultStep.AttributeListSecondInitialize,
                FaultStep.HandleListUpdate,
                FaultStep.JobListUpdate,
                FaultStep.CreateProcess
            })
            {
                AssertCreateFault(fixturePath, step, ExpectedStage(step));
                count++;
            }

            AssertResumeFault(fixturePath, 0, true);
            AssertResumeFault(fixturePath, 2, false);
            count += 2;

            AssertStopBeforeResume(fixturePath);
            count++;

            AssertResumeGate(fixturePath);
            count++;

            return count;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes
        {
            internal int Length;
            internal IntPtr SecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)]
            internal bool InheritHandle;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateEventW(
            ref SecurityAttributes attributes,
            [MarshalAs(UnmanagedType.Bool)] bool manualReset,
            [MarshalAs(UnmanagedType.Bool)] bool initialState,
            string name);

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

        private sealed class InheritableEvent : IDisposable
        {
            internal IntPtr Handle { get; private set; }

            private InheritableEvent(IntPtr handle)
            {
                Handle = handle;
            }

            internal static InheritableEvent Create()
            {
                var attributes = new SecurityAttributes();
                attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
                attributes.InheritHandle = true;
                IntPtr handle = CreateEventW(ref attributes, true, false, null);
                if (handle == IntPtr.Zero)
                {
                    throw new InvalidOperationException("event_create_failed");
                }
                return new InheritableEvent(handle);
            }

            internal bool IsSignaled()
            {
                int error;
                uint result = NativeWin32Api.Instance.WaitForSingleObject(Handle, 0, out error);
                if (result == NativeMethods.WaitTimeout)
                {
                    return false;
                }
                if (result == NativeMethods.WaitObject0)
                {
                    return true;
                }
                throw new InvalidOperationException("event_wait_failed");
            }

            public void Dispose()
            {
                if (Handle != IntPtr.Zero)
                {
                    NativeMethods.CloseHandle(Handle);
                    Handle = IntPtr.Zero;
                }
            }
        }

        internal sealed class ProcessWitness : IDisposable
        {
            private IntPtr handle;

            private ProcessWitness(IntPtr handle)
            {
                this.handle = handle;
            }

            internal static ProcessWitness Duplicate(IntPtr process)
            {
                IntPtr duplicate;
                if (!DuplicateHandle(
                    NativeMethods.CurrentProcess,
                    process,
                    NativeMethods.CurrentProcess,
                    out duplicate,
                    0,
                    false,
                    0x00000002))
                {
                    return null;
                }
                return new ProcessWitness(duplicate);
            }

            internal bool IsInheritable
            {
                get { return NativeMethods.IsHandleInheritable(handle); }
            }

            internal bool WaitForExit(uint milliseconds)
            {
                int error;
                uint result = NativeWin32Api.Instance.WaitForSingleObject(
                    handle, milliseconds, out error);
                if (result == NativeMethods.WaitObject0)
                {
                    return true;
                }
                if (result == NativeMethods.WaitTimeout)
                {
                    return false;
                }
                throw new InvalidOperationException("process_witness_wait_failed");
            }

            public void Dispose()
            {
                if (handle != IntPtr.Zero)
                {
                    NativeMethods.CloseHandle(handle);
                    handle = IntPtr.Zero;
                }
            }
        }

        private static void AssertCreateFault(
            string fixturePath,
            FaultStep step,
            ControlStage expectedStage)
        {
            string root = CreateTemporaryRoot();
            string marker = Path.Combine(root, "fault.marker");
            int baselineHandles = NativeMethods.GetCurrentProcessHandleCountChecked();
            var api = new FaultingWin32Api(step, null);
            try
            {
                try
                {
                    using (JobSession.CreateSuspended(
                        api,
                        fixturePath,
                        root,
                        new[] { "--inspect", marker }))
                    {
                    }
                    throw new InvalidOperationException("fault_did_not_fail");
                }
                catch (JobSessionException failure)
                {
                    TestAssert.Equal(expectedStage, failure.Stage);
                }
                TestAssert.True(!File.Exists(marker));
                if (step == FaultStep.AttributeListSecondInitialize)
                {
                    TestAssert.Equal(2, api.AttributeInitializeCalls);
                }
                if (step == FaultStep.CreateProcess)
                {
                    TestAssert.True(api.AttributeValuesAliveDuringCreate);
                    TestAssert.True(api.AttributeListDeletedAfterCreate);
                }
            }
            finally
            {
                DeleteTemporaryRoot(root, marker);
            }
            TestAssert.Equal(baselineHandles, NativeMethods.GetCurrentProcessHandleCountChecked());
        }

        private static void AssertResumeFault(
            string fixturePath,
            uint resumeResult,
            bool resumeTargetBeforeReportingFault)
        {
            string root = CreateTemporaryRoot();
            string marker = Path.Combine(root, "resume-fault.marker");
            int baselineHandles = NativeMethods.GetCurrentProcessHandleCountChecked();
            var api = new FaultingWin32Api(FaultStep.ResumeThread, resumeResult);
            api.CaptureProcessWitness = true;
            api.ResumeTargetBeforeReportingFault = resumeTargetBeforeReportingFault;
            try
            {
                using (var session = JobSession.CreateSuspended(
                    api,
                    fixturePath,
                    root,
                    new[] { "--block", marker }))
                {
                    TestAssert.True(api.ProcessWitness != null);
                    TestAssert.True(!api.ProcessWitness.IsInheritable);
                    TestAssert.Throws<JobSessionException>(() =>
                        session.ResumeAndPublishReady(delegate { }));
                    TestAssert.Equal(ControlStage.ResumeFailed, session.Lifecycle.FailureStage);
                    if (resumeTargetBeforeReportingFault)
                    {
                        WaitForFile(marker, 5000);
                    }
                    else
                    {
                        Thread.Sleep(100);
                        TestAssert.True(!File.Exists(marker));
                    }
                }
                TestAssert.True(api.ProcessWitness.WaitForExit(5000));
            }
            finally
            {
                if (api.ProcessWitness != null)
                {
                    api.ProcessWitness.Dispose();
                }
                DeleteTemporaryRoot(root, marker);
            }
            TestAssert.Equal(baselineHandles, NativeMethods.GetCurrentProcessHandleCountChecked());
        }

        private static void AssertStopBeforeResume(string fixturePath)
        {
            string root = CreateTemporaryRoot();
            string marker = Path.Combine(root, "stop-before-resume.marker");
            int baselineHandles = NativeMethods.GetCurrentProcessHandleCountChecked();
            var api = new FaultingWin32Api(FaultStep.None, null);
            api.CaptureProcessWitness = true;
            try
            {
                using (var session = JobSession.CreateSuspended(
                    api,
                    fixturePath,
                    root,
                    new[] { "--block", marker }))
                {
                    TestAssert.True(session.IsRootInOwnedJob());
                    TestAssert.True(api.ProcessWitness != null);
                    session.RequestStop(ControlReason.Cancelled);
                    JobSessionException failure = null;
                    try
                    {
                        session.ResumeAndPublishReady(delegate { });
                    }
                    catch (JobSessionException caught)
                    {
                        failure = caught;
                    }
                    TestAssert.True(failure != null);
                    TestAssert.Equal(ControlStage.CancelledBeforeReady, failure.Stage);
                    TestAssert.Equal(0, api.ResumeCalls);
                    Thread.Sleep(100);
                    TestAssert.True(!File.Exists(marker));
                }
                TestAssert.True(api.ProcessWitness.WaitForExit(5000));
                TestAssert.True(!File.Exists(marker));
            }
            finally
            {
                if (api.ProcessWitness != null)
                {
                    api.ProcessWitness.Dispose();
                }
                DeleteTemporaryRoot(root, marker);
            }
            TestAssert.Equal(baselineHandles, NativeMethods.GetCurrentProcessHandleCountChecked());
        }

        private static void AssertResumeGate(string fixturePath)
        {
            string root = CreateTemporaryRoot();
            string marker = Path.Combine(root, "gate.marker");
            var stopEntered = new ManualResetEvent(false);
            Thread stopper = null;
            JobSession session = null;
            var api = new FaultingWin32Api(FaultStep.None, null);
            api.BeforeRealResume = delegate
            {
                stopper = new Thread(new ThreadStart(delegate
                {
                    session.RequestStop(ControlReason.Cancelled);
                    stopEntered.Set();
                }));
                stopper.IsBackground = true;
                stopper.Start();
            };
            try
            {
                using (session = JobSession.CreateSuspended(
                    api,
                    fixturePath,
                    root,
                    new[] { "--inspect", marker }))
                {
                    session.ResumeAndPublishReady(delegate
                    {
                        TestAssert.True(!stopEntered.WaitOne(0));
                    });
                    TestAssert.True(stopEntered.WaitOne(5000));
                    stopper.Join();
                    TestAssert.True(session.Lifecycle.ReadyWasPublished);
                    TestAssert.Equal(ControlReason.Cancelled, session.Lifecycle.StopReason);
                }
            }
            finally
            {
                stopEntered.Dispose();
                DeleteTemporaryRoot(root, marker);
            }
        }

        private static ControlStage ExpectedStage(FaultStep step)
        {
            switch (step)
            {
                case FaultStep.JobCreate:
                    return ControlStage.JobCreateFailed;
                case FaultStep.JobConfig:
                    return ControlStage.JobConfigFailed;
                case FaultStep.DuplicateHandle:
                    return ControlStage.StdioDuplicateFailed;
                case FaultStep.AttributeListSecondInitialize:
                    return ControlStage.AttributeListInitFailed;
                case FaultStep.HandleListUpdate:
                    return ControlStage.HandleListAttributeFailed;
                case FaultStep.JobListUpdate:
                    return ControlStage.JobListAttributeFailed;
                case FaultStep.CreateProcess:
                    return ControlStage.CreateFailed;
                default:
                    throw new InvalidOperationException("invalid_fault_step");
            }
        }

        private static void WarmUpKernelPath(string fixturePath)
        {
            string root = CreateTemporaryRoot();
            try
            {
                using (JobSession.CreateSuspended(
                    NativeWin32Api.Instance,
                    fixturePath,
                    root,
                    new[] { "--warmup" }))
                {
                }
            }
            finally
            {
                if (Directory.Exists(root))
                {
                    Directory.Delete(root, false);
                }
            }
        }

        private static string CreateTemporaryRoot()
        {
            string root = Path.Combine(
                Path.GetTempPath(),
                "codex-agent-tools",
                "windows-job-helper",
                "kernel-v1",
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            return Path.GetFullPath(root);
        }

        private static void DeleteTemporaryRoot(string root, string marker)
        {
            if (File.Exists(marker))
            {
                File.Delete(marker);
            }
            if (Directory.Exists(root))
            {
                Directory.Delete(root, false);
            }
        }

        private static void WaitForFile(string path, int milliseconds)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
            while (!File.Exists(path) && DateTime.UtcNow < deadline)
            {
                Thread.Sleep(10);
            }
            TestAssert.True(File.Exists(path));
        }
    }

    internal enum FaultStep
    {
        None,
        JobCreate,
        JobConfig,
        DuplicateHandle,
        AttributeListSecondInitialize,
        HandleListUpdate,
        JobListUpdate,
        CreateProcess,
        ResumeThread
    }

    internal sealed class FaultingWin32Api : IWin32Api
    {
        private readonly FaultStep fault;
        private readonly uint? resumeResult;
        private IntPtr handleListValue;
        private IntPtr jobListValue;

        internal int AttributeInitializeCalls { get; private set; }
        internal bool AttributeValuesAliveDuringCreate { get; private set; }
        internal bool AttributeListDeletedAfterCreate { get; private set; }
        internal uint ObservedCreationFlags { get; private set; }
        internal bool ObservedInheritHandles { get; private set; }
        internal bool ObservedReservedDataEmpty { get; private set; }
        internal Action BeforeRealResume { get; set; }
        internal int ResumeCalls { get; private set; }
        internal bool CaptureProcessWitness { get; set; }
        internal bool ResumeTargetBeforeReportingFault { get; set; }
        internal KernelTests.ProcessWitness ProcessWitness { get; private set; }

        internal FaultingWin32Api(FaultStep fault, uint? resumeResult)
        {
            this.fault = fault;
            this.resumeResult = resumeResult;
        }

        public IntPtr CreateJobObject(out int error)
        {
            if (fault == FaultStep.JobCreate)
            {
                error = 5;
                return IntPtr.Zero;
            }
            return NativeWin32Api.Instance.CreateJobObject(out error);
        }

        public bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint length,
            out int error)
        {
            if (fault == FaultStep.JobConfig)
            {
                error = 5;
                return false;
            }
            return NativeWin32Api.Instance.SetInformationJobObject(
                job, informationClass, information, length, out error);
        }

        public bool DuplicateHandle(
            IntPtr source,
            out IntPtr duplicate,
            out int error)
        {
            if (fault == FaultStep.DuplicateHandle)
            {
                duplicate = IntPtr.Zero;
                error = 5;
                return false;
            }
            return NativeWin32Api.Instance.DuplicateHandle(source, out duplicate, out error);
        }

        public bool InitializeProcThreadAttributeList(
            IntPtr list,
            int count,
            ref IntPtr size,
            out int error)
        {
            AttributeInitializeCalls++;
            if (fault == FaultStep.AttributeListSecondInitialize &&
                AttributeInitializeCalls == 2)
            {
                error = 5;
                return false;
            }
            return NativeWin32Api.Instance.InitializeProcThreadAttributeList(
                list, count, ref size, out error);
        }

        public bool UpdateProcThreadAttribute(
            IntPtr list,
            IntPtr attribute,
            IntPtr value,
            IntPtr size,
            out int error)
        {
            if (attribute == NativeMethods.ProcThreadAttributeHandleList)
            {
                handleListValue = value;
                if (fault == FaultStep.HandleListUpdate)
                {
                    error = 5;
                    return false;
                }
            }
            else if (attribute == NativeMethods.ProcThreadAttributeJobList)
            {
                jobListValue = value;
                if (fault == FaultStep.JobListUpdate)
                {
                    error = 5;
                    return false;
                }
            }
            return NativeWin32Api.Instance.UpdateProcThreadAttribute(
                list, attribute, value, size, out error);
        }

        public void DeleteProcThreadAttributeList(IntPtr list)
        {
            AttributeListDeletedAfterCreate = true;
            NativeWin32Api.Instance.DeleteProcThreadAttributeList(list);
        }

        public bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            bool inheritHandles,
            uint creationFlags,
            string currentDirectory,
            ref NativeMethods.StartupInfoEx startup,
            out NativeMethods.ProcessInformation information,
            out int error)
        {
            ObservedCreationFlags = creationFlags;
            ObservedInheritHandles = inheritHandles;
            ObservedReservedDataEmpty =
                startup.StartupInfo.cb == Marshal.SizeOf(typeof(NativeMethods.StartupInfoEx)) &&
                startup.StartupInfo.cbReserved2 == 0 &&
                startup.StartupInfo.lpReserved2 == IntPtr.Zero;
            GC.Collect();
            GC.WaitForPendingFinalizers();
            AttributeValuesAliveDuringCreate =
                handleListValue != IntPtr.Zero &&
                jobListValue != IntPtr.Zero &&
                Marshal.ReadIntPtr(handleListValue) != IntPtr.Zero &&
                Marshal.ReadIntPtr(jobListValue) != IntPtr.Zero &&
                !AttributeListDeletedAfterCreate;
            if (fault == FaultStep.CreateProcess)
            {
                information = new NativeMethods.ProcessInformation();
                error = 5;
                return false;
            }
            bool created = NativeWin32Api.Instance.CreateProcess(
                applicationName,
                commandLine,
                inheritHandles,
                creationFlags,
                currentDirectory,
                ref startup,
                out information,
                out error);
            if (created && CaptureProcessWitness)
            {
                ProcessWitness = KernelTests.ProcessWitness.Duplicate(information.Process);
            }
            return created;
        }

        public uint ResumeThread(IntPtr thread, out int error)
        {
            ResumeCalls++;
            if (fault == FaultStep.ResumeThread)
            {
                if (ResumeTargetBeforeReportingFault)
                {
                    int realError;
                    uint realResult = NativeWin32Api.Instance.ResumeThread(thread, out realError);
                    if (realResult != 1)
                    {
                        throw new InvalidOperationException("real_resume_failed");
                    }
                }
                error = 5;
                return resumeResult.Value;
            }
            if (BeforeRealResume != null)
            {
                BeforeRealResume();
            }
            return NativeWin32Api.Instance.ResumeThread(thread, out error);
        }

        public bool QueryInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint length,
            out int error)
        {
            return NativeWin32Api.Instance.QueryInformationJobObject(
                job, informationClass, information, length, out error);
        }

        public bool IsProcessInJob(
            IntPtr process,
            IntPtr job,
            out bool isMember,
            out int error)
        {
            return NativeWin32Api.Instance.IsProcessInJob(
                process, job, out isMember, out error);
        }

        public uint WaitForSingleObject(IntPtr handle, uint milliseconds, out int error)
        {
            return NativeWin32Api.Instance.WaitForSingleObject(handle, milliseconds, out error);
        }
    }
}
