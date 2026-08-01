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

            AssertNamedEqual("abi_handle_list", new IntPtr(0x00020002), NativeMethods.ProcThreadAttributeHandleList);
            AssertNamedEqual("abi_job_list", new IntPtr(0x0002000D), NativeMethods.ProcThreadAttributeJobList);
            AssertNamedEqual("abi_startup", 104, Marshal.SizeOf(typeof(NativeMethods.StartupInfo)));
            AssertNamedEqual("abi_startup_ex", 112, Marshal.SizeOf(typeof(NativeMethods.StartupInfoEx)));
            AssertNamedEqual(
                "abi_attribute_offset",
                new IntPtr(104),
                Marshal.OffsetOf(typeof(NativeMethods.StartupInfoEx), "AttributeList"));
            AssertNamedEqual("abi_process", 24, Marshal.SizeOf(typeof(NativeMethods.ProcessInformation)));
            AssertNamedEqual("abi_accounting", 48, Marshal.SizeOf(typeof(NativeMethods.JobBasicAccountingInformation)));
            AssertNamedEqual("abi_basic_limit", 64, Marshal.SizeOf(typeof(NativeMethods.JobBasicLimitInformation)));
            AssertNamedEqual("abi_extended_limit", 144, Marshal.SizeOf(typeof(NativeMethods.JobExtendedLimitInformation)));
            AssertNamedEqual("abi_overlapped", 32, Marshal.SizeOf(typeof(NativeMethods.NativeOverlapped)));
            count++;

            string root = CreateTemporaryRoot();
            string marker = Path.Combine(root, "resume.marker");
            // CreateProcessW causes the CLR to establish two process-lifetime
            // interop handles on its first use. Exercise the exact suspended Job
            // path once, fully dispose it, then take the stable baseline used by
            // every measured case. WarmUpKernelPath also creates one managed
            // Thread wrapper; two finalizer passes retire that completed wrapper
            // before the exact baseline. No per-invocation growth is accepted.
            WarmUpKernelPath(fixturePath);
            GC.Collect();
            GC.WaitForPendingFinalizers();
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
                        AssertNamedEqual("launch_state", LifecycleState.CreatedAssigned, session.Lifecycle.State);
                        TestAssert.True(session.IsRootInOwnedJob());
                        TestAssert.True(!session.IsJobHandleInheritable());
                        TestAssert.True(!excludedEvent.IsSignaled());
                        AssertNamedEqual(
                            "launch_flags",
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
                        AssertNamedEqual(
                            "launch_limit_flags",
                            NativeMethods.JobObjectLimitKillOnJobClose,
                            session.QueryLimitFlags());
                    }
                }
            }
            finally
            {
                DeleteTemporaryRoot(root, marker);
            }
            AssertNamedEqual(
                "launch_handle_baseline",
                baselineHandles,
                NativeMethods.GetCurrentProcessHandleCountChecked());
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

            AssertStopDuringCreate(fixturePath);
            count++;

            AssertResumeGate(fixturePath);
            count++;

            AssertNaturalRootExitDrainsGrandchild(fixturePath);
            count++;

            AssertExplicitCancelDrainsOwnedJob(fixturePath);
            count++;

            AssertRootWaitFailurePreservesWin32Code(fixturePath);
            count++;

            AssertExitCodeFailureSealsError(fixturePath);
            count++;

            AssertTerminateFailureDrainsByJobClose(fixturePath);
            count++;

            AssertPreZeroQueryFailureDrainsByJobClose(fixturePath);
            count++;

            AssertFinalZeroQueryFailurePreservesFirstError(fixturePath);
            count++;

            AssertTerminalWriteFailureDoesNotRetry(fixturePath);
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

        [DllImport("kernel32.dll", EntryPoint = "TerminateProcess", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcessForTest(
            IntPtr process,
            uint exitCode);

        [DllImport("kernel32.dll", EntryPoint = "GetExitCodeProcess", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcessForTest(
            IntPtr process,
            out uint exitCode);

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

            internal bool TerminateForTest(uint exitCode, out int error)
            {
                bool result = TerminateProcessForTest(handle, exitCode);
                error = result ? 0 : Marshal.GetLastWin32Error();
                return result;
            }

            internal uint ReadExitCode()
            {
                uint exitCode;
                if (!GetExitCodeProcessForTest(handle, out exitCode))
                {
                    throw new InvalidOperationException("process_witness_exit_code_failed");
                }
                return exitCode;
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

        private static void AssertStopDuringCreate(string fixturePath)
        {
            AssertStopDuringCreateCase(fixturePath, false);
            AssertStopDuringCreateCase(fixturePath, true);
        }

        private static void AssertStopDuringCreateCase(
            string fixturePath,
            bool failCreate)
        {
            int baselineHandles = NativeMethods.GetCurrentProcessHandleCountChecked();
            RunStopDuringCreateCase(fixturePath, failCreate);
            // The target and Job have already been explicitly drained inside the
            // case. Two managed finalizer passes only retire the completed CLR
            // Thread wrapper before measuring the process-handle baseline.
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            GC.WaitForPendingFinalizers();
            int finalHandles = NativeMethods.GetCurrentProcessHandleCountChecked();
            if (baselineHandles != finalHandles)
            {
                throw new InvalidOperationException(
                    (failCreate
                        ? "creating_race_failure_handle_leak_"
                        : "creating_race_success_handle_leak_") +
                    baselineHandles.ToString() + "_" + finalHandles.ToString());
            }
        }

        private static void RunStopDuringCreateCase(
            string fixturePath,
            bool failCreate)
        {
            string root = CreateTemporaryRoot();
            string marker = Path.Combine(root, "stop-during-create.marker");
            var createReached = new ManualResetEvent(false);
            var releaseCreate = new ManualResetEvent(false);
            var api = new FaultingWin32Api(FaultStep.None, null);
            api.CaptureProcessWitness = !failCreate;
            api.FailCreateAfterPause = failCreate;
            api.AfterRealCreateBeforeReturn = delegate
            {
                createReached.Set();
                releaseCreate.WaitOne();
            };
            JobSession session = null;
            Exception createFailure = null;
            Thread creator = null;
            try
            {
                session = new JobSession(api);
                session.PrepareJob();
                creator = new Thread(new ThreadStart(delegate
                {
                    try
                    {
                        session.CreateSuspended(
                            fixturePath,
                            root,
                            new[] { "--block", marker });
                    }
                    catch (Exception failure)
                    {
                        createFailure = failure;
                    }
                }));
                creator.IsBackground = true;
                creator.Start();
                TestAssert.True(createReached.WaitOne(5000));
                session.RequestStop(ControlReason.Cancelled);
                releaseCreate.Set();
                TestAssert.True(creator.Join(5000));
                JobSessionException expectedCreateFailure = createFailure as JobSessionException;
                if (failCreate)
                {
                    TestAssert.True(expectedCreateFailure != null);
                    TestAssert.Equal(
                        ControlStage.CancelledBeforeReady,
                        expectedCreateFailure.Stage);
                }
                else
                {
                    TestAssert.True(createFailure == null);
                }
                LifecycleState expectedState = failCreate
                    ? LifecycleState.Terminated
                    : LifecycleState.Terminating;
                if (session.Lifecycle.State != expectedState)
                {
                    throw new InvalidOperationException("creating_race_state");
                }
                if (session.Lifecycle.FailureStage != ControlStage.CancelledBeforeReady)
                {
                    throw new InvalidOperationException("creating_race_stage");
                }
                TestAssert.Throws<JobSessionException>(() =>
                    session.ResumeAndPublishReady(delegate { }));
                if (api.ResumeCalls != 0)
                {
                    throw new InvalidOperationException("creating_race_resumed");
                }
                Thread.Sleep(100);
                TestAssert.True(!File.Exists(marker));
                session.Dispose();
                session = null;
                if (!failCreate)
                {
                    TestAssert.True(api.ProcessWitness.WaitForExit(5000));
                }
            }
            finally
            {
                releaseCreate.Set();
                if (creator != null)
                {
                    creator.Join(5000);
                }
                if (session != null)
                {
                    session.Dispose();
                }
                if (api.ProcessWitness != null)
                {
                    api.ProcessWitness.Dispose();
                }
                createReached.Dispose();
                releaseCreate.Dispose();
                DeleteTemporaryRoot(root, marker);
            }
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

        private static void AssertNaturalRootExitDrainsGrandchild(string fixturePath)
        {
            string root = CreateTemporaryRoot();
            string rootMarker = Path.Combine(root, "root-exit.marker");
            string childMarker = Path.Combine(root, "grandchild.marker");
            var api = new FaultingWin32Api(FaultStep.None, null);
            api.CaptureProcessWitness = true;
            var channel = new KernelSessionControlChannel(false);
            try
            {
                int status = new SessionCoordinator(
                    new JobSession(api),
                    channel).Run(ControlFrame.LaunchConfig(
                        fixturePath,
                        root,
                        new[] { "--root-with-grandchild", rootMarker, childMarker }));

                if (status != 0)
                {
                    throw new InvalidOperationException(
                        "natural_status_" + status.ToString() + "_" +
                        (channel.Terminal == null
                            ? "no_terminal"
                            : channel.Terminal.Kind.ToString() + "_" +
                                channel.Terminal.Stage.ToString() + "_" +
                                (channel.Terminal.Win32Code.HasValue
                                    ? channel.Terminal.Win32Code.Value.ToString()
                                    : "none")) + "_terminate_" +
                        api.TerminateCalls.ToString() + "_query_" +
                        api.AccountingQueryCalls.ToString() + "_terminate_result_" +
                        api.LastTerminateResult.ToString() + "_terminate_error_" +
                        api.LastTerminateError.ToString());
                }
                TestAssert.True(File.Exists(rootMarker));
                TestAssert.True(File.Exists(childMarker));
                TestAssert.True(api.ProcessWitness != null);
                TestAssert.True(api.ProcessWitness.WaitForExit(5000));
                AssertNamedEqual("natural_terminate", 1, api.TerminateCalls);
                AssertNamedEqual(
                    "natural_job_handle", api.CreatedJobHandle, api.TerminatedJobHandle);
                TestAssert.True(api.AccountingQueryCalls >= 1);
                AssertNamedEqual("natural_ready", 1, channel.ReadyWrites);
                AssertNamedEqual("natural_terminal", 1, channel.TerminalWrites);
                AssertNamedEqual("natural_shutdown", 1, channel.ShutdownCalls);
                AssertNamedEqual("natural_kind", TerminalKind.Exit, channel.Terminal.Kind);
                AssertNamedEqual(
                    "natural_reason", ControlReason.NoneOrRootExit, channel.Terminal.Reason);
                AssertNamedEqual("natural_exit", (uint)0, channel.Terminal.RootExitCode);
            }
            finally
            {
                if (api.ProcessWitness != null)
                {
                    api.ProcessWitness.Dispose();
                }
                DeleteTemporaryRoot(root, rootMarker, childMarker);
            }
        }

        private static void AssertExplicitCancelDrainsOwnedJob(string fixturePath)
        {
            string root = CreateTemporaryRoot();
            string marker = Path.Combine(root, "coordinator-cancel.marker");
            var api = new FaultingWin32Api(FaultStep.None, null);
            api.CaptureProcessWitness = true;
            var channel = new KernelSessionControlChannel(true);
            try
            {
                int status = new SessionCoordinator(
                    new JobSession(api),
                    channel).Run(ControlFrame.LaunchConfig(
                        fixturePath,
                        root,
                        new[] { "--block", marker }));

                AssertNamedEqual("cancel_status", 0, status);
                TestAssert.True(api.ProcessWitness != null);
                TestAssert.True(api.ProcessWitness.WaitForExit(5000));
                AssertNamedEqual("cancel_terminate", 1, api.TerminateCalls);
                AssertNamedEqual(
                    "cancel_job_handle", api.CreatedJobHandle, api.TerminatedJobHandle);
                TestAssert.True(api.AccountingQueryCalls >= 1);
                AssertNamedEqual("cancel_ready", 1, channel.ReadyWrites);
                AssertNamedEqual("cancel_terminal", 1, channel.TerminalWrites);
                AssertNamedEqual("cancel_shutdown", 1, channel.ShutdownCalls);
                AssertNamedEqual("cancel_kind", TerminalKind.Exit, channel.Terminal.Kind);
                AssertNamedEqual(
                    "cancel_reason", ControlReason.Cancelled, channel.Terminal.Reason);
            }
            finally
            {
                if (api.ProcessWitness != null)
                {
                    api.ProcessWitness.Dispose();
                }
                DeleteTemporaryRoot(root, marker);
            }
        }

        private static void AssertRootWaitFailurePreservesWin32Code(string fixturePath)
        {
            string root = CreateTemporaryRoot();
            string marker = Path.Combine(root, "wait-failure.marker");
            var api = new FaultingWin32Api(FaultStep.RootWait, null);
            api.CaptureProcessWitness = true;
            api.FailTerminateAfterRootWait = true;
            var channel = new KernelSessionControlChannel(false);
            try
            {
                int status = new SessionCoordinator(
                    new JobSession(api),
                    channel).Run(ControlFrame.LaunchConfig(
                        fixturePath,
                        root,
                        new[] { "--block", marker }));

                AssertNamedEqual("wait_failure_status", 1, status);
                AssertNamedEqual("wait_failure_terminate", 1, api.TerminateCalls);
                AssertNamedEqual(
                    "wait_failure_stage", ControlStage.WaitFailed, channel.Terminal.Stage);
                TestAssert.True(channel.Terminal.Win32Code.HasValue);
                AssertNamedEqual("wait_failure_code", (uint)5, channel.Terminal.Win32Code.Value);
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
        }

        private static void AssertExitCodeFailureSealsError(string fixturePath)
        {
            string root = CreateTemporaryRoot();
            var api = new FaultingWin32Api(FaultStep.ExitCode, null);
            api.CaptureProcessWitness = true;
            var channel = new KernelSessionControlChannel(false);
            try
            {
                int status = new SessionCoordinator(
                    new JobSession(api),
                    channel).Run(ControlFrame.LaunchConfig(
                        fixturePath,
                        root,
                        new[] { "--exit-now" }));

                AssertNamedEqual("exit_code_failure_status", 1, status);
                AssertNamedEqual(
                    "exit_code_failure_terminal", 1, channel.TerminalWrites);
                AssertNamedEqual(
                    "exit_code_failure_kind", TerminalKind.Error, channel.Terminal.Kind);
                AssertNamedEqual(
                    "exit_code_failure_stage",
                    ControlStage.HelperInternal,
                    channel.Terminal.Stage);
                TestAssert.True(channel.Terminal.Win32Code.HasValue);
                AssertNamedEqual(
                    "exit_code_failure_code", (uint)5, channel.Terminal.Win32Code.Value);
                AssertNamedEqual("exit_code_failure_terminate", 1, api.TerminateCalls);
                TestAssert.True(api.AccountingQueryCalls >= 1);
                TestAssert.True(api.ProcessWitness.WaitForExit(5000));
            }
            finally
            {
                if (api.ProcessWitness != null)
                {
                    api.ProcessWitness.Dispose();
                }
                DeleteTemporaryRoot(root);
            }
        }

        private static void AssertTerminateFailureDrainsByJobClose(string fixturePath)
        {
            string root = CreateTemporaryRoot();
            string marker = Path.Combine(root, "terminate-failure.marker");
            var api = new FaultingWin32Api(FaultStep.TerminateJob, null);
            api.CaptureProcessWitness = true;
            var channel = new KernelSessionControlChannel(true);
            try
            {
                int status = new SessionCoordinator(
                    new JobSession(api),
                    channel).Run(ControlFrame.LaunchConfig(
                        fixturePath,
                        root,
                        new[] { "--block", marker }));

                AssertNamedEqual("terminate_failure_status", 1, status);
                AssertNamedEqual("terminate_failure_calls", 1, api.TerminateCalls);
                AssertNamedEqual("terminate_failure_queries", 0, api.AccountingQueryCalls);
                AssertNamedEqual(
                    "terminate_failure_job_handle",
                    api.CreatedJobHandle,
                    api.TerminatedJobHandle);
                AssertNamedEqual("terminate_failure_ready", 1, channel.ReadyWrites);
                AssertNamedEqual("terminate_failure_terminal", 1, channel.TerminalWrites);
                AssertNamedEqual("terminate_failure_shutdown", 1, channel.ShutdownCalls);
                AssertNamedEqual(
                    "terminate_failure_kind", TerminalKind.Error, channel.Terminal.Kind);
                AssertNamedEqual(
                    "terminate_failure_stage",
                    ControlStage.TerminateJobFailed,
                    channel.Terminal.Stage);
                TestAssert.True(channel.Terminal.Win32Code.HasValue);
                AssertNamedEqual(
                    "terminate_failure_code", (uint)5, channel.Terminal.Win32Code.Value);
                TestAssert.True(api.ProcessWitness != null);
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
        }

        private static void AssertPreZeroQueryFailureDrainsByJobClose(string fixturePath)
        {
            string root = CreateTemporaryRoot();
            string marker = Path.Combine(root, "query-pre-zero-failure.marker");
            var api = new FaultingWin32Api(FaultStep.QueryPreZero, null);
            api.CaptureProcessWitness = true;
            var channel = new KernelSessionControlChannel(true);
            try
            {
                int status = new SessionCoordinator(
                    new JobSession(api),
                    channel).Run(ControlFrame.LaunchConfig(
                        fixturePath,
                        root,
                        new[] { "--block", marker }));

                AssertNamedEqual("query_pre_zero_status", 1, status);
                AssertNamedEqual("query_pre_zero_terminate", 1, api.TerminateCalls);
                AssertNamedEqual("query_pre_zero_real_terminate", 0, api.RealTerminateCalls);
                AssertNamedEqual("query_pre_zero_calls", 1, api.AccountingQueryCalls);
                TestAssert.True(api.ObservedPreZeroQuery);
                TestAssert.True(!api.ObservedFinalZeroQuery);
                AssertNamedEqual("query_pre_zero_ready", 1, channel.ReadyWrites);
                AssertNamedEqual("query_pre_zero_terminal", 1, channel.TerminalWrites);
                AssertNamedEqual("query_pre_zero_shutdown", 1, channel.ShutdownCalls);
                AssertNamedEqual(
                    "query_pre_zero_kind", TerminalKind.Error, channel.Terminal.Kind);
                AssertNamedEqual(
                    "query_pre_zero_stage",
                    ControlStage.QueryJobFailed,
                    channel.Terminal.Stage);
                TestAssert.True(channel.Terminal.Win32Code.HasValue);
                AssertNamedEqual(
                    "query_pre_zero_code", (uint)5, channel.Terminal.Win32Code.Value);
                TestAssert.True(api.ProcessWitness != null);
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
        }

        private static void AssertFinalZeroQueryFailurePreservesFirstError(
            string fixturePath)
        {
            string root = CreateTemporaryRoot();
            string marker = Path.Combine(root, "query-final-zero-failure.marker");
            var api = new FaultingWin32Api(FaultStep.QueryFinalZero, null);
            api.CaptureProcessWitness = true;
            var channel = new KernelSessionControlChannel(true);
            try
            {
                int status = new SessionCoordinator(
                    new JobSession(api),
                    channel).Run(ControlFrame.LaunchConfig(
                        fixturePath,
                        root,
                        new[] { "--block", marker }));

                AssertNamedEqual("query_final_zero_status", 1, status);
                AssertNamedEqual("query_final_zero_terminate", 1, api.TerminateCalls);
                AssertNamedEqual("query_final_zero_real_terminate", 1, api.RealTerminateCalls);
                AssertNamedEqual("query_final_zero_calls", 2, api.AccountingQueryCalls);
                TestAssert.True(api.ObservedPreZeroQuery);
                TestAssert.True(api.ObservedFinalZeroQuery);
                TestAssert.True(api.FinalZeroTerminationTriggered);
                AssertNamedEqual("query_final_zero_ready", 1, channel.ReadyWrites);
                AssertNamedEqual("query_final_zero_terminal", 1, channel.TerminalWrites);
                AssertNamedEqual("query_final_zero_shutdown", 1, channel.ShutdownCalls);
                AssertNamedEqual(
                    "query_final_zero_kind", TerminalKind.Error, channel.Terminal.Kind);
                AssertNamedEqual(
                    "query_final_zero_stage",
                    ControlStage.QueryJobFailed,
                    channel.Terminal.Stage);
                TestAssert.True(channel.Terminal.Win32Code.HasValue);
                AssertNamedEqual(
                    "query_final_zero_code", (uint)5, channel.Terminal.Win32Code.Value);
                TestAssert.True(api.ProcessWitness != null);
                TestAssert.True(api.ProcessWitness.WaitForExit(0));
            }
            finally
            {
                if (api.ProcessWitness != null)
                {
                    api.ProcessWitness.Dispose();
                }
                DeleteTemporaryRoot(root, marker);
            }
        }

        private static void AssertTerminalWriteFailureDoesNotRetry(string fixturePath)
        {
            string root = CreateTemporaryRoot();
            string marker = Path.Combine(root, "terminal-write-failure.marker");
            var api = new FaultingWin32Api(FaultStep.None, null);
            api.CaptureProcessWitness = true;
            var channel = new KernelSessionControlChannel(true, true);
            var session = new JobSession(api);
            try
            {
                int status = new SessionCoordinator(
                    session,
                    channel).Run(ControlFrame.LaunchConfig(
                        fixturePath,
                        root,
                        new[] { "--block", marker }));

                AssertNamedEqual("terminal_write_failure_status", 1, status);
                AssertNamedEqual("terminal_write_failure_terminate", 1, api.TerminateCalls);
                AssertNamedEqual(
                    "terminal_write_failure_real_terminate", 1, api.RealTerminateCalls);
                TestAssert.True(api.AccountingQueryCalls >= 1);
                TestAssert.True(api.ObservedFinalZeroQuery);
                TestAssert.True(api.ProcessWitness != null);
                TestAssert.True(api.ProcessWitness.WaitForExit(0));
                TestAssert.True(session.Lifecycle.JobWasZero);
                AssertNamedEqual(
                    "terminal_write_failure_state",
                    LifecycleState.Terminal,
                    session.Lifecycle.State);
                AssertNamedEqual(
                    "terminal_write_failure_reserved_kind",
                    TerminalKind.Exit,
                    session.Lifecycle.Terminal);
                AssertNamedEqual("terminal_write_failure_ready", 1, channel.ReadyWrites);
                AssertNamedEqual("terminal_write_failure_terminal", 1, channel.TerminalWrites);
                AssertNamedEqual("terminal_write_failure_shutdown", 1, channel.ShutdownCalls);
                AssertNamedEqual(
                    "terminal_write_failure_kind", TerminalKind.Exit, channel.Terminal.Kind);
                AssertNamedEqual(
                    "terminal_write_failure_reason",
                    ControlReason.Cancelled,
                    channel.Terminal.Reason);
            }
            finally
            {
                if (api.ProcessWitness != null)
                {
                    api.ProcessWitness.Dispose();
                }
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

        private static void AssertNamedEqual<T>(string name, T expected, T actual)
        {
            if (!EqualityComparer<T>.Default.Equals(expected, actual))
            {
                throw new InvalidOperationException(
                    name + "_" + expected.ToString() + "_" + actual.ToString());
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
                Thread managedThread = new Thread(new ThreadStart(delegate { }));
                managedThread.Start();
                managedThread.Join();
                managedThread = null;
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

        private static void DeleteTemporaryRoot(string root, params string[] markers)
        {
            foreach (string marker in markers)
            {
                if (File.Exists(marker))
                {
                    File.Delete(marker);
                }
            }
            if (Directory.Exists(root))
            {
                DateTime deadline = DateTime.UtcNow.AddSeconds(5);
                for (;;)
                {
                    try
                    {
                        Directory.Delete(root, false);
                        break;
                    }
                    catch (IOException)
                    {
                        if (DateTime.UtcNow >= deadline)
                        {
                            throw;
                        }
                        Thread.Sleep(10);
                    }
                    catch (UnauthorizedAccessException)
                    {
                        if (DateTime.UtcNow >= deadline)
                        {
                            throw;
                        }
                        Thread.Sleep(10);
                    }
                }
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

        private sealed class KernelSessionControlChannel : ISessionControlChannel
        {
            private readonly bool cancelOnReady;
            private readonly bool failTerminalWrite;
            private Action<ControlReason> terminate;

            internal int ReadyWrites { get; private set; }
            internal int TerminalWrites { get; private set; }
            internal int ShutdownCalls { get; private set; }
            internal TerminalSnapshot Terminal { get; private set; }

            internal KernelSessionControlChannel(bool cancelOnReady)
                : this(cancelOnReady, false)
            {
            }

            internal KernelSessionControlChannel(
                bool cancelOnReady,
                bool failTerminalWrite)
            {
                this.cancelOnReady = cancelOnReady;
                this.failTerminalWrite = failTerminalWrite;
            }

            public ControlFrame ReadLaunchConfig()
            {
                throw new InvalidOperationException("kernel_channel_config_unused");
            }

            public void StartReader(
                Action<ControlReason> terminateCallback,
                Action<ControlChannelFailureKind> failureCallback)
            {
                terminate = terminateCallback;
            }

            public void WriteReady()
            {
                ReadyWrites++;
                if (cancelOnReady)
                {
                    terminate(ControlReason.Cancelled);
                }
            }

            public void WriteTerminal(TerminalSnapshot snapshot)
            {
                TerminalWrites++;
                Terminal = snapshot;
                if (failTerminalWrite)
                {
                    throw new IOException("kernel_terminal_write_failed");
                }
            }

            public void ShutdownAfterTerminal()
            {
                ShutdownCalls++;
            }
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
        ResumeThread,
        RootWait,
        ExitCode,
        TerminateJob,
        QueryPreZero,
        QueryFinalZero
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
        internal Action AfterRealCreateBeforeReturn { get; set; }
        internal bool FailCreateAfterPause { get; set; }
        internal int TerminateCalls { get; private set; }
        internal int RealTerminateCalls { get; private set; }
        internal int AccountingQueryCalls { get; private set; }
        internal bool ObservedPreZeroQuery { get; private set; }
        internal bool ObservedFinalZeroQuery { get; private set; }
        internal bool FinalZeroTerminationTriggered { get; private set; }
        internal IntPtr CreatedJobHandle { get; private set; }
        internal IntPtr TerminatedJobHandle { get; private set; }
        internal bool RootWaitFailureObserved { get; private set; }
        internal bool FailTerminateAfterRootWait { get; set; }
        internal bool LastTerminateResult { get; private set; }
        internal int LastTerminateError { get; private set; }

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
            CreatedJobHandle = NativeWin32Api.Instance.CreateJobObject(out error);
            return CreatedJobHandle;
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
            if (FailCreateAfterPause)
            {
                if (AfterRealCreateBeforeReturn != null)
                {
                    AfterRealCreateBeforeReturn();
                }
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
            if (created && AfterRealCreateBeforeReturn != null)
            {
                AfterRealCreateBeforeReturn();
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
            out uint returnLength,
            out int error)
        {
            bool isAccounting =
                informationClass == NativeMethods.JobObjectBasicAccountingInformation;
            if (isAccounting)
            {
                AccountingQueryCalls++;
            }
            bool result = NativeWin32Api.Instance.QueryInformationJobObject(
                job, informationClass, information, length, out returnLength, out error);
            if (isAccounting && result &&
                returnLength == checked((uint)Marshal.SizeOf(
                    typeof(NativeMethods.JobBasicAccountingInformation))))
            {
                uint active = ((NativeMethods.JobBasicAccountingInformation)
                    Marshal.PtrToStructure(
                        information,
                        typeof(NativeMethods.JobBasicAccountingInformation)))
                    .ActiveProcesses;
                if (active > 0)
                {
                    ObservedPreZeroQuery = true;
                }
                else
                {
                    ObservedFinalZeroQuery = true;
                }
                if (fault == FaultStep.QueryPreZero)
                {
                    if (active == 0)
                    {
                        throw new InvalidOperationException(
                            "query_pre_zero_did_not_observe_active_process");
                    }
                    error = 5;
                    return false;
                }
                if (fault == FaultStep.QueryFinalZero)
                {
                    if (!ObservedPreZeroQuery)
                    {
                        throw new InvalidOperationException(
                            "query_final_zero_missing_pre_zero_observation");
                    }
                    if (active > 0)
                    {
                        if (FinalZeroTerminationTriggered)
                        {
                            throw new InvalidOperationException(
                                "query_final_zero_repeated_pre_zero_observation");
                        }
                        RealTerminateCalls++;
                        int terminateError;
                        bool terminated = NativeWin32Api.Instance.TerminateJobObject(
                            job,
                            1,
                            out terminateError);
                        LastTerminateResult = terminated;
                        LastTerminateError = terminateError;
                        if (!terminated)
                        {
                            throw new InvalidOperationException(
                                "query_final_zero_real_terminate_failed");
                        }
                        FinalZeroTerminationTriggered = true;
                        if (ProcessWitness == null || !ProcessWitness.WaitForExit(5000))
                        {
                            throw new InvalidOperationException(
                                "query_final_zero_witness_did_not_exit");
                        }
                    }
                    else
                    {
                        error = 5;
                        return false;
                    }
                }
            }
            return result;
        }

        public bool TerminateJobObject(IntPtr job, uint exitCode, out int error)
        {
            TerminateCalls++;
            TerminatedJobHandle = job;
            if (fault == FaultStep.TerminateJob)
            {
                error = 5;
                LastTerminateError = error;
                LastTerminateResult = false;
                return false;
            }
            if (fault == FaultStep.QueryPreZero ||
                fault == FaultStep.QueryFinalZero)
            {
                error = 0;
                LastTerminateError = error;
                LastTerminateResult = true;
                return true;
            }
            if (FailTerminateAfterRootWait && RootWaitFailureObserved)
            {
                error = 6;
                LastTerminateError = error;
                LastTerminateResult = false;
                return false;
            }
            RealTerminateCalls++;
            LastTerminateResult = NativeWin32Api.Instance.TerminateJobObject(
                job, exitCode, out error);
            LastTerminateError = error;
            return LastTerminateResult;
        }

        public bool GetExitCodeProcess(IntPtr process, out uint exitCode, out int error)
        {
            if (fault == FaultStep.ExitCode)
            {
                exitCode = 0;
                error = 5;
                return false;
            }
            return NativeWin32Api.Instance.GetExitCodeProcess(process, out exitCode, out error);
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
            if (fault == FaultStep.RootWait && milliseconds == NativeMethods.Infinite)
            {
                RootWaitFailureObserved = true;
                error = 5;
                return NativeMethods.WaitFailed;
            }
            return NativeWin32Api.Instance.WaitForSingleObject(handle, milliseconds, out error);
        }
    }
}
