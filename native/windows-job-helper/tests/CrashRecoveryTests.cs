using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace CodexAgentTools.WindowsJobHelper.Tests
{
    internal static class CrashRecoveryTests
    {
        private const uint GenericRead = 0x80000000;
        private const uint OpenExisting = 3;
        private const int ErrorSharingViolation = 32;
        private const uint ParentDeathExitCode = 211;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        internal static int Run(
            string nodePath,
            string harnessPath,
            string helperPath,
            string fixturePath)
        {
            uint helperKillPreAction = RunCase(
                "helper-kill", nodePath, harnessPath, helperPath, fixturePath);
            uint parentDeathPreAction = RunCase(
                "parent-death", nodePath, harnessPath, helperPath, fixturePath);
            Console.WriteLine(
                "windows-native-helper: crash recovery passed cases=2 preAction={0},{1}",
                helperKillPreAction,
                parentDeathPreAction);
            return 2;
        }

        private static uint RunCase(
            string mode,
            string nodePath,
            string harnessPath,
            string helperPath,
            string fixturePath)
        {
            string caseRoot = CreateCaseRoot(mode);
            string readyMarker = Path.Combine(caseRoot, "ready.marker");
            string goMarker = Path.Combine(caseRoot, "go.marker");
            string doneMarker = Path.Combine(caseRoot, "done.marker");
            string rootLock = Path.Combine(caseRoot, "root.lock");
            string childLock = Path.Combine(caseRoot, "child.lock");
            string nonce = Guid.NewGuid().ToString("N");
            string[] paths = {
                readyMarker, goMarker, doneMarker, rootLock, childLock
            };
            var api = new FaultingWin32Api(FaultStep.None, null);
            api.CaptureProcessWitness = true;
            JobSession outer = null;
            Exception firstFailure = null;
            string stage = "create";
            uint observedPreCount = UInt32.MaxValue;

            try
            {
                outer = JobSession.CreateSuspended(
                    api,
                    nodePath,
                    caseRoot,
                    new[] {
                        harnessPath,
                        "__crash-carrier-v1",
                        mode,
                        helperPath,
                        fixturePath,
                        caseRoot,
                        readyMarker,
                        goMarker,
                        doneMarker,
                        rootLock,
                        childLock,
                        nonce
                    });
                TestAssert.True(api.ProcessWitness != null);
                TestAssert.True(!api.ProcessWitness.IsInheritable);
                TestAssert.True(!outer.IsJobHandleInheritable());
                TestAssert.Equal(
                    NativeMethods.JobObjectLimitKillOnJobClose,
                    outer.QueryLimitFlags());
                TestAssert.Equal((uint)1, outer.QueryActiveProcesses());
                outer.ResumeAndPublishReady(delegate { });

                stage = "ready";
                WaitForMarker(readyMarker, nonce, 10000);
                stage = "held";
                WaitForWitnessHeld(rootLock, 5000);
                WaitForWitnessHeld(childLock, 5000);
                stage = "pre_count";
                observedPreCount = outer.QueryActiveProcesses();
                TestAssert.True(observedPreCount >= 4);
                TestAssert.True(!api.ProcessWitness.WaitForExit(0));

                if (mode == "helper-kill")
                {
                    stage = "go";
                    WriteMarkerCreateNew(goMarker, nonce);
                }
                else
                {
                    stage = "terminate_parent";
                    int terminateError;
                    TestAssert.True(
                        api.ProcessWitness.TerminateForTest(
                            ParentDeathExitCode,
                            out terminateError));
                    TestAssert.Equal(0, terminateError);
                }

                uint expectedNodeExitCode =
                    mode == "helper-kill" ? (uint)0 : ParentDeathExitCode;
                stage = "root_exit";
                TestAssert.True(outer.WaitForRootExit(10000));
                TestAssert.Equal(expectedNodeExitCode, outer.ReadRootExitCode());
                TestAssert.True(api.ProcessWitness.WaitForExit(0));
                TestAssert.Equal(expectedNodeExitCode, api.ProcessWitness.ReadExitCode());
                if (mode == "helper-kill")
                {
                    stage = "done";
                    WaitForMarker(doneMarker, nonce, 1000);
                }
                else
                {
                    TestAssert.True(!File.Exists(goMarker));
                    TestAssert.True(!File.Exists(doneMarker));
                }

                stage = "release";
                WaitForWitnessReleased(rootLock, nonce, 10000);
                WaitForWitnessReleased(childLock, nonce, 10000);
                stage = "job_zero";
                WaitForJobZero(outer, 10000);
                outer.RecordJobZero();
            }
            catch (Exception failure)
            {
                firstFailure = failure;
            }
            finally
            {
                try
                {
                    if (outer != null)
                    {
                        outer.Dispose();
                    }
                }
                catch (Exception cleanupFailure)
                {
                    if (firstFailure == null)
                    {
                        firstFailure = cleanupFailure;
                    }
                }

                if (api.ProcessWitness != null)
                {
                    api.ProcessWitness.Dispose();
                }

                try
                {
                    WaitForCleanupRelease(rootLock, 5000);
                    WaitForCleanupRelease(childLock, 5000);
                    DeleteCaseRoot(caseRoot, paths);
                }
                catch (Exception cleanupFailure)
                {
                    if (firstFailure == null)
                    {
                        firstFailure = cleanupFailure;
                    }
                }
            }

            if (firstFailure != null)
            {
                Console.Error.WriteLine(
                    "windows-native-helper: crash recovery failed mode={0} stage={1} pre={2}",
                    mode,
                    stage,
                    observedPreCount == UInt32.MaxValue
                        ? "unset"
                        : observedPreCount.ToString());
                throw new InvalidOperationException(
                    "crash_recovery_case_failed_" + mode,
                    firstFailure);
            }
            return observedPreCount;
        }

        private static string CreateCaseRoot(string mode)
        {
            string root = Path.Combine(
                Path.GetTempPath(),
                "codex-agent-tools",
                "windows-job-helper",
                "crash-v1",
                mode + "-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            return Path.GetFullPath(root);
        }

        private static void WriteMarkerCreateNew(string path, string nonce)
        {
            byte[] bytes = new UTF8Encoding(false, true).GetBytes(nonce);
            using (var stream = new FileStream(
                path,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None))
            {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
        }

        private static void WaitForMarker(string path, string nonce, int milliseconds)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
            for (;;)
            {
                if (File.Exists(path))
                {
                    try
                    {
                        string contents = File.ReadAllText(
                            path,
                            new UTF8Encoding(false, true));
                        if (contents == nonce)
                        {
                            return;
                        }
                        if (contents.Length > nonce.Length ||
                            !nonce.StartsWith(contents, StringComparison.Ordinal))
                        {
                            throw new InvalidOperationException("crash_marker_invalid");
                        }
                    }
                    catch (IOException)
                    {
                    }
                }
                if (DateTime.UtcNow >= deadline)
                {
                    throw new InvalidOperationException("crash_marker_missing");
                }
                Thread.Sleep(10);
            }
        }

        private static void WaitForWitnessHeld(string path, int milliseconds)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
            for (;;)
            {
                int error;
                FileStream stream = TryOpenExclusive(path, out error);
                if (stream == null)
                {
                    if (error == ErrorSharingViolation)
                    {
                        return;
                    }
                    if (error != 2)
                    {
                        throw new InvalidOperationException("crash_witness_open_failed");
                    }
                }
                else
                {
                    stream.Dispose();
                }
                if (DateTime.UtcNow >= deadline)
                {
                    throw new InvalidOperationException("crash_witness_not_held");
                }
                Thread.Sleep(10);
            }
        }

        private static void WaitForWitnessReleased(
            string path,
            string nonce,
            int milliseconds)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
            for (;;)
            {
                int error;
                FileStream stream = TryOpenExclusive(path, out error);
                if (stream != null)
                {
                    using (stream)
                    {
                        byte[] expected = new UTF8Encoding(false, true).GetBytes(nonce);
                        byte[] actual = new byte[expected.Length + 1];
                        int read = 0;
                        while (read < actual.Length)
                        {
                            int current = stream.Read(actual, read, actual.Length - read);
                            if (current == 0)
                            {
                                break;
                            }
                            read += current;
                        }
                        TestAssert.Equal(expected.Length, read);
                        for (int index = 0; index < expected.Length; index++)
                        {
                            TestAssert.Equal(expected[index], actual[index]);
                        }
                    }
                    return;
                }
                if (error != ErrorSharingViolation)
                {
                    throw new InvalidOperationException("crash_witness_open_failed");
                }
                if (DateTime.UtcNow >= deadline)
                {
                    throw new InvalidOperationException("crash_witness_not_released");
                }
                Thread.Sleep(10);
            }
        }

        private static FileStream TryOpenExclusive(string path, out int error)
        {
            IntPtr raw = CreateFileW(
                path,
                GenericRead,
                0,
                IntPtr.Zero,
                OpenExisting,
                0,
                IntPtr.Zero);
            if (raw == new IntPtr(-1))
            {
                error = Marshal.GetLastWin32Error();
                return null;
            }
            error = 0;
            return new FileStream(new SafeFileHandle(raw, true), FileAccess.Read);
        }

        private static void WaitForJobZero(JobSession outer, int milliseconds)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
            for (;;)
            {
                if (outer.QueryActiveProcesses() == 0)
                {
                    return;
                }
                if (DateTime.UtcNow >= deadline)
                {
                    throw new InvalidOperationException("crash_outer_job_not_zero");
                }
                Thread.Sleep(10);
            }
        }

        private static void WaitForCleanupRelease(string path, int milliseconds)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
            for (;;)
            {
                if (!File.Exists(path))
                {
                    return;
                }
                int error;
                FileStream stream = TryOpenExclusive(path, out error);
                if (stream != null)
                {
                    stream.Dispose();
                    return;
                }
                if (error != ErrorSharingViolation)
                {
                    throw new InvalidOperationException("crash_cleanup_witness_open_failed");
                }
                if (DateTime.UtcNow >= deadline)
                {
                    throw new InvalidOperationException("crash_cleanup_witness_held");
                }
                Thread.Sleep(10);
            }
        }

        private static void DeleteCaseRoot(string root, string[] paths)
        {
            foreach (string path in paths)
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            if (Directory.Exists(root))
            {
                Directory.Delete(root, false);
            }
        }
    }
}
