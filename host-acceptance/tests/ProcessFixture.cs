using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace CodexAgentTools.HostAcceptance.Tests
{
    internal static class ProcessFixture
    {
        private const uint GenericRead = 0x80000000;
        private const uint GenericWrite = 0x40000000;
        private const uint OpenExisting = 3;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ReadFile(IntPtr handle, byte[] bytes, uint count, out uint read, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WriteFile(IntPtr handle, byte[] bytes, uint count, out uint written, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        private static int Main(string[] args)
        {
            using (var watchdog = new Timer(delegate { Environment.Exit(70); }, null, TimeSpan.FromSeconds(10), Timeout.InfiniteTimeSpan))
            {
                if (args.Length != 2 || !IsPipeName(args[1])) return 64;
                if (args[0] == "--ancestor") return RunChild("--parent", args[1]);
                if (args[0] == "--parent") return RunChild("--client", args[1]);
                if (args[0] == "--client") return RunClient(args[1]);
                return 64;
            }
        }

        private static int RunChild(string mode, string pipeName)
        {
            var start = new ProcessStartInfo {
                FileName = Environment.GetCommandLineArgs()[0],
                Arguments = mode + " " + pipeName,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using (var child = Process.Start(start))
            {
                if (child == null) return 65;
                child.WaitForExit();
                return child.ExitCode;
            }
        }

        private static int RunClient(string pipeName)
        {
            var handle = CreateFileW("\\\\.\\pipe\\" + pipeName, GenericRead | GenericWrite, 0, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
            if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return 66;
            try
            {
                uint transferred;
                if (!WriteFile(handle, new byte[] { 0x51 }, 1, out transferred, IntPtr.Zero) || transferred != 1) return 67;
                var response = new byte[1];
                if (!ReadFile(handle, response, 1, out transferred, IntPtr.Zero) || transferred != 1 || response[0] != 0x52) return 68;
                return 0;
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        private static bool IsPipeName(string value)
        {
            Guid parsed;
            const string prefix = "codex-agent-tools-host-acceptance-";
            return value.StartsWith(prefix, StringComparison.Ordinal) &&
                value.Length == prefix.Length + 32 &&
                Guid.TryParseExact(value.Substring(prefix.Length), "N", out parsed);
        }
    }
}
