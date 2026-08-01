using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CodexAgentTools.WindowsJobHelper.Fixtures
{
    internal static class KernelFixture
    {
        private const int JobObjectExtendedLimitInformation = 9;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
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
        private struct JobBasicLimitInformation
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
        private struct IoCounters
        {
            internal ulong ReadOperationCount;
            internal ulong WriteOperationCount;
            internal ulong OtherOperationCount;
            internal ulong ReadTransferCount;
            internal ulong WriteTransferCount;
            internal ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobExtendedLimitInformation
        {
            internal JobBasicLimitInformation BasicLimitInformation;
            internal IoCounters IoInfo;
            internal UIntPtr ProcessMemoryLimit;
            internal UIntPtr JobMemoryLimit;
            internal UIntPtr PeakProcessMemoryUsed;
            internal UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsProcessInJob(
            IntPtr process,
            IntPtr job,
            [MarshalAs(UnmanagedType.Bool)] out bool result);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll")]
        private static extern void GetStartupInfoW(ref StartupInfo startupInfo);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength,
            IntPtr returnLength);

        [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern IntPtr _get_osfhandle(int descriptor);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetEvent(IntPtr handle);

        private static int Main(string[] args)
        {
            if (args.Length == 2 && args[0] == "--block" && Path.IsPathRooted(args[1]))
            {
                File.WriteAllText(args[1], "started\n", new UTF8Encoding(false, true));
                Thread.Sleep(Timeout.Infinite);
                return 0;
            }

            if (args.Length != 4 || args[0] != "--inspect" || !Path.IsPathRooted(args[1]))
            {
                return 64;
            }

            long excludedHandleValue;
            if (!Int64.TryParse(
                args[2],
                System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture,
                out excludedHandleValue) ||
                excludedHandleValue == 0 ||
                args[3].Length != 32)
            {
                return 64;
            }

            bool membership;
            if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out membership) || !membership)
            {
                return 65;
            }

            var startup = new StartupInfo();
            startup.cb = Marshal.SizeOf(typeof(StartupInfo));
            GetStartupInfoW(ref startup);
            bool reservedEmpty = startup.cbReserved2 == 0 && startup.lpReserved2 == IntPtr.Zero;
            bool stdioOnly =
                _get_osfhandle(0) != new IntPtr(-1) &&
                _get_osfhandle(1) != new IntPtr(-1) &&
                _get_osfhandle(2) != new IntPtr(-1) &&
                _get_osfhandle(3) == new IntPtr(-1);

            int size = Marshal.SizeOf(typeof(JobExtendedLimitInformation));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            uint flags;
            try
            {
                for (int offset = 0; offset < size; offset++)
                {
                    Marshal.WriteByte(buffer, offset, 0);
                }
                if (!QueryInformationJobObject(
                    IntPtr.Zero,
                    JobObjectExtendedLimitInformation,
                    buffer,
                    checked((uint)size),
                    IntPtr.Zero))
                {
                    return 66;
                }
                flags = ((JobExtendedLimitInformation)Marshal.PtrToStructure(
                    buffer,
                    typeof(JobExtendedLimitInformation))).BasicLimitInformation.LimitFlags;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }

            string evidence = String.Format(
                "membership={0}\nlimitFlags={1}\nstdioOnly={2}\nreservedDataEmpty={3}\nnonce={4}\n",
                membership ? 1 : 0,
                flags,
                stdioOnly ? 1 : 0,
                reservedEmpty ? 1 : 0,
                args[3]);
            SetEvent(new IntPtr(excludedHandleValue));
            File.WriteAllText(args[1], evidence, new UTF8Encoding(false, true));
            return membership && flags == 0x00002000 && stdioOnly && reservedEmpty ? 0 : 67;
        }
    }
}
