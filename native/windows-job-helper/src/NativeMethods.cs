using System;
using System.Runtime.InteropServices;
using System.Text;

namespace CodexAgentTools.WindowsJobHelper
{
    internal static class NativeMethods
    {
        internal const uint CreateSuspended = 0x00000004;
        internal const uint ExtendedStartupInfoPresent = 0x00080000;
        internal const uint CreateNoWindow = 0x08000000;
        internal const uint StartfUseStdHandles = 0x00000100;
        internal const uint JobObjectLimitKillOnJobClose = 0x00002000;
        internal const int JobObjectBasicAccountingInformation = 1;
        internal const int JobObjectExtendedLimitInformation = 9;
        internal const int StandardInputHandle = -10;
        internal const int StandardOutputHandle = -11;
        internal const int StandardErrorHandle = -12;
        internal const uint WaitObject0 = 0;
        internal const uint WaitTimeout = 258;
        internal const uint WaitFailed = 0xffffffff;
        internal const uint Infinite = 0xffffffff;
        internal const uint ResumeThreadFailed = 0xffffffff;
        internal const int ErrorInsufficientBuffer = 122;
        internal const uint HandleFlagInherit = 0x00000001;
        internal static readonly IntPtr ProcThreadAttributeHandleList = new IntPtr(0x00020002);
        internal static readonly IntPtr ProcThreadAttributeJobList = new IntPtr(0x0002000D);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct StartupInfo
        {
            internal int cb;
            internal IntPtr lpReserved;
            internal IntPtr lpDesktop;
            internal IntPtr lpTitle;
            internal uint dwX;
            internal uint dwY;
            internal uint dwXSize;
            internal uint dwYSize;
            internal uint dwXCountChars;
            internal uint dwYCountChars;
            internal uint dwFillAttribute;
            internal uint dwFlags;
            internal ushort wShowWindow;
            internal ushort cbReserved2;
            internal IntPtr lpReserved2;
            internal IntPtr hStdInput;
            internal IntPtr hStdOutput;
            internal IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct StartupInfoEx
        {
            internal StartupInfo StartupInfo;
            internal IntPtr AttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct ProcessInformation
        {
            internal IntPtr Process;
            internal IntPtr Thread;
            internal uint ProcessId;
            internal uint ThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct JobBasicAccountingInformation
        {
            internal long TotalUserTime;
            internal long TotalKernelTime;
            internal long ThisPeriodTotalUserTime;
            internal long ThisPeriodTotalKernelTime;
            internal uint TotalPageFaultCount;
            internal uint TotalProcesses;
            internal uint ActiveProcesses;
            internal uint TotalTerminatedProcesses;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct JobBasicLimitInformation
        {
            internal long PerProcessUserTimeLimit;
            internal long PerJobUserTimeLimit;
            internal uint LimitFlags;
            internal UIntPtr MinimumWorkingSetSize;
            internal UIntPtr MaximumWorkingSetSize;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint PriorityClass;
            internal uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct IoCounters
        {
            internal ulong ReadOperationCount;
            internal ulong WriteOperationCount;
            internal ulong OtherOperationCount;
            internal ulong ReadTransferCount;
            internal ulong WriteTransferCount;
            internal ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct JobExtendedLimitInformation
        {
            internal JobBasicLimitInformation BasicLimitInformation;
            internal IoCounters IoInfo;
            internal UIntPtr ProcessMemoryLimit;
            internal UIntPtr JobMemoryLimit;
            internal UIntPtr PeakProcessMemoryUsed;
            internal UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct NativeOverlapped
        {
            internal IntPtr Internal;
            internal IntPtr InternalHigh;
            internal uint Offset;
            internal uint OffsetHigh;
            internal IntPtr EventHandle;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetStdHandle(int standardHandle);

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

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList,
            int attributeCount,
            uint flags,
            ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList,
            uint flags,
            IntPtr attribute,
            IntPtr value,
            IntPtr size,
            IntPtr previousValue,
            IntPtr returnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessW(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref StartupInfoEx startupInfo,
            out ProcessInformation processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength,
            out uint returnLength);

        [DllImport("kernel32.dll", EntryPoint = "TerminateJobObject", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObjectNative(
            IntPtr job,
            uint exitCode);

        [DllImport("kernel32.dll", EntryPoint = "GetExitCodeProcess", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcessNative(
            IntPtr process,
            out uint exitCode);

        [DllImport("kernel32.dll", EntryPoint = "IsProcessInJob", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsProcessInJobNative(
            IntPtr process,
            IntPtr job,
            [MarshalAs(UnmanagedType.Bool)] out bool result);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetProcessHandleCount(IntPtr process, out uint handleCount);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetHandleInformation(IntPtr handle, out uint flags);

        internal static void ValidateCurrentHostLayouts()
        {
            if (IntPtr.Size != 8 ||
                Marshal.SizeOf(typeof(StartupInfo)) != 104 ||
                Marshal.SizeOf(typeof(StartupInfoEx)) != 112 ||
                Marshal.OffsetOf(typeof(StartupInfoEx), "AttributeList") != new IntPtr(104) ||
                Marshal.SizeOf(typeof(ProcessInformation)) != 24 ||
                Marshal.SizeOf(typeof(JobBasicAccountingInformation)) != 48 ||
                Marshal.SizeOf(typeof(JobBasicLimitInformation)) != 64 ||
                Marshal.SizeOf(typeof(JobExtendedLimitInformation)) != 144 ||
                Marshal.SizeOf(typeof(NativeOverlapped)) != 32)
            {
                throw new InvalidOperationException("windows_native_layout_invalid");
            }
        }

        internal static int GetCurrentProcessHandleCountChecked()
        {
            uint count;
            if (!GetProcessHandleCount(GetCurrentProcess(), out count) || count > Int32.MaxValue)
            {
                throw new InvalidOperationException("windows_native_handle_count_failed");
            }
            return (int)count;
        }

        internal static bool IsHandleInheritable(IntPtr handle)
        {
            uint flags;
            if (!GetHandleInformation(handle, out flags))
            {
                throw new InvalidOperationException("windows_native_handle_query_failed");
            }
            return (flags & HandleFlagInherit) != 0;
        }

        internal static IntPtr CurrentProcess { get { return GetCurrentProcess(); } }
        internal static IntPtr StandardHandle(int handle) { return GetStdHandle(handle); }

        internal static IntPtr CreateJob(out int error)
        {
            IntPtr result = CreateJobObjectW(IntPtr.Zero, null);
            error = result == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            return result;
        }

        internal static bool SetJobInformation(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint length,
            out int error)
        {
            bool result = SetInformationJobObject(job, informationClass, information, length);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        internal static bool DuplicateInheritable(
            IntPtr source,
            out IntPtr duplicate,
            out int error)
        {
            bool result = DuplicateHandle(
                GetCurrentProcess(),
                source,
                GetCurrentProcess(),
                out duplicate,
                0,
                true,
                0x00000002);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        internal static bool InitializeAttributeList(
            IntPtr list,
            int count,
            ref IntPtr size,
            out int error)
        {
            bool result = InitializeProcThreadAttributeList(list, count, 0, ref size);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        internal static bool UpdateAttribute(
            IntPtr list,
            IntPtr attribute,
            IntPtr value,
            IntPtr size,
            out int error)
        {
            bool result = UpdateProcThreadAttribute(
                list, 0, attribute, value, size, IntPtr.Zero, IntPtr.Zero);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        internal static void DeleteAttributeList(IntPtr list)
        {
            DeleteProcThreadAttributeList(list);
        }

        internal static bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            bool inheritHandles,
            uint creationFlags,
            string currentDirectory,
            ref StartupInfoEx startup,
            out ProcessInformation information,
            out int error)
        {
            bool result = CreateProcessW(
                applicationName,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                inheritHandles,
                creationFlags,
                IntPtr.Zero,
                currentDirectory,
                ref startup,
                out information);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        internal static uint Resume(IntPtr thread, out int error)
        {
            uint result = ResumeThread(thread);
            error = result == ResumeThreadFailed ? Marshal.GetLastWin32Error() : 0;
            return result;
        }

        internal static bool QueryJob(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint length,
            out uint returnLength,
            out int error)
        {
            bool result = QueryInformationJobObject(
                job, informationClass, information, length, out returnLength);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        internal static bool TerminateJob(IntPtr job, uint exitCode, out int error)
        {
            bool result = TerminateJobObjectNative(job, exitCode);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        internal static bool GetProcessExitCode(
            IntPtr process,
            out uint exitCode,
            out int error)
        {
            bool result = GetExitCodeProcessNative(process, out exitCode);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        internal static bool QueryProcessInJob(
            IntPtr process,
            IntPtr job,
            out bool isMember,
            out int error)
        {
            bool result = IsProcessInJobNative(process, job, out isMember);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        internal static uint Wait(IntPtr handle, uint milliseconds, out int error)
        {
            uint result = WaitForSingleObject(handle, milliseconds);
            error = result == WaitFailed ? Marshal.GetLastWin32Error() : 0;
            return result;
        }
    }

    internal interface IWin32Api
    {
        IntPtr CreateJobObject(out int error);
        bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint length,
            out int error);
        bool DuplicateHandle(IntPtr source, out IntPtr duplicate, out int error);
        bool InitializeProcThreadAttributeList(
            IntPtr list,
            int count,
            ref IntPtr size,
            out int error);
        bool UpdateProcThreadAttribute(
            IntPtr list,
            IntPtr attribute,
            IntPtr value,
            IntPtr size,
            out int error);
        void DeleteProcThreadAttributeList(IntPtr list);
        bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            bool inheritHandles,
            uint creationFlags,
            string currentDirectory,
            ref NativeMethods.StartupInfoEx startup,
            out NativeMethods.ProcessInformation information,
            out int error);
        uint ResumeThread(IntPtr thread, out int error);
        bool QueryInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint length,
            out uint returnLength,
            out int error);
        bool TerminateJobObject(IntPtr job, uint exitCode, out int error);
        bool GetExitCodeProcess(IntPtr process, out uint exitCode, out int error);
        bool IsProcessInJob(
            IntPtr process,
            IntPtr job,
            out bool isMember,
            out int error);
        uint WaitForSingleObject(IntPtr handle, uint milliseconds, out int error);
    }

    internal sealed class NativeWin32Api : IWin32Api
    {
        internal static readonly NativeWin32Api Instance = new NativeWin32Api();

        private NativeWin32Api()
        {
        }

        public IntPtr CreateJobObject(out int error)
        {
            return NativeMethods.CreateJob(out error);
        }

        public bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint length,
            out int error)
        {
            return NativeMethods.SetJobInformation(
                job, informationClass, information, length, out error);
        }

        public bool DuplicateHandle(IntPtr source, out IntPtr duplicate, out int error)
        {
            return NativeMethods.DuplicateInheritable(source, out duplicate, out error);
        }

        public bool InitializeProcThreadAttributeList(
            IntPtr list,
            int count,
            ref IntPtr size,
            out int error)
        {
            return NativeMethods.InitializeAttributeList(list, count, ref size, out error);
        }

        public bool UpdateProcThreadAttribute(
            IntPtr list,
            IntPtr attribute,
            IntPtr value,
            IntPtr size,
            out int error)
        {
            return NativeMethods.UpdateAttribute(list, attribute, value, size, out error);
        }

        public void DeleteProcThreadAttributeList(IntPtr list)
        {
            NativeMethods.DeleteAttributeList(list);
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
            return NativeMethods.CreateProcess(
                applicationName,
                commandLine,
                inheritHandles,
                creationFlags,
                currentDirectory,
                ref startup,
                out information,
                out error);
        }

        public uint ResumeThread(IntPtr thread, out int error)
        {
            return NativeMethods.Resume(thread, out error);
        }

        public bool QueryInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint length,
            out uint returnLength,
            out int error)
        {
            return NativeMethods.QueryJob(
                job, informationClass, information, length, out returnLength, out error);
        }

        public bool TerminateJobObject(IntPtr job, uint exitCode, out int error)
        {
            return NativeMethods.TerminateJob(job, exitCode, out error);
        }

        public bool GetExitCodeProcess(IntPtr process, out uint exitCode, out int error)
        {
            return NativeMethods.GetProcessExitCode(process, out exitCode, out error);
        }

        public bool IsProcessInJob(
            IntPtr process,
            IntPtr job,
            out bool isMember,
            out int error)
        {
            return NativeMethods.QueryProcessInJob(
                process, job, out isMember, out error);
        }

        public uint WaitForSingleObject(IntPtr handle, uint milliseconds, out int error)
        {
            return NativeMethods.Wait(handle, milliseconds, out error);
        }
    }
}
