using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
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
                if (args.Length == 2 && IsPipeName(args[1]))
                {
                    if (args[0] == "--ancestor") return RunChild("--parent", args[1]);
                    if (args[0] == "--parent") return RunChild("--client", args[1]);
                    if (args[0] == "--client") return RunClient(args[1]);
                    return 64;
                }
                if (args.Length == 4 && IsPipeName(args[1]) && IsPayload(args[2]) && IsBarrier(args[3]))
                {
                    if (args[0] == "--ancestor-json") return RunJsonChild("--parent-json", args[1], args[2], args[3]);
                    if (args[0] == "--parent-json") return RunJsonChild("--client-json", args[1], args[2], args[3]);
                    if (args[0] == "--client-json") return RunJsonClient(args[1], args[2], args[3]);
                    return 64;
                }
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

        private static int RunJsonChild(string mode, string pipeName, string payload, string barrier)
        {
            var start = new ProcessStartInfo {
                FileName = Environment.GetCommandLineArgs()[0],
                Arguments = mode + " " + pipeName + " " + payload + " " + Quote(barrier),
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

        private static int RunJsonClient(string pipeName, string payloadBase64, string barrier)
        {
            string payload;
            try
            {
                payload = new UTF8Encoding(false, true).GetString(Convert.FromBase64String(payloadBase64));
            }
            catch
            {
                return 71;
            }
            const string pidToken = "__MCP_PID__";
            const string mismatchToken = "__MCP_PID_MISMATCH__";
            var token = payload.IndexOf(mismatchToken, StringComparison.Ordinal) >= 0 ? mismatchToken : pidToken;
            var tokenIndex = payload.IndexOf(token, StringComparison.Ordinal);
            if (tokenIndex < 0 || payload.IndexOf(token, tokenIndex + token.Length, StringComparison.Ordinal) >= 0 ||
                (token == pidToken && payload.IndexOf(mismatchToken, StringComparison.Ordinal) >= 0)) return 72;
            var actualPid = Process.GetCurrentProcess().Id;
            var reportedPid = token == pidToken ? actualPid : (actualPid == Int32.MaxValue ? actualPid - 1 : actualPid + 1);
            payload = payload.Substring(0, tokenIndex) + reportedPid.ToString(System.Globalization.CultureInfo.InvariantCulture) + payload.Substring(tokenIndex + token.Length);
            var bytes = new UTF8Encoding(false, true).GetBytes(payload);
            if (bytes.Length == 0 || bytes.Length > 32768 || bytes[bytes.Length - 1] != (byte)'\n') return 73;

            var handle = CreateFileW("\\\\.\\pipe\\" + pipeName, GenericRead | GenericWrite, 0, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
            if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return 66;
            try
            {
                uint transferred;
                if (!WriteFile(handle, bytes, checked((uint)bytes.Length), out transferred, IntPtr.Zero) || transferred != bytes.Length) return 67;
                if (barrier != "-")
                {
                    while (!File.Exists(barrier)) Thread.Sleep(10);
                }
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

        private static bool IsPayload(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 65536) return false;
            try
            {
                return Convert.FromBase64String(value).Length > 0;
            }
            catch
            {
                return false;
            }
        }

        private static bool IsBarrier(string value)
        {
            if (value == "-") return true;
            if (string.IsNullOrEmpty(value) || !Path.IsPathRooted(value) || Path.GetFileName(value) != "release.barrier") return false;
            var session = Path.GetDirectoryName(Path.GetFullPath(value));
            var basePath = session == null ? null : Path.GetDirectoryName(session);
            Guid parsed;
            return session != null && basePath != null &&
                Guid.TryParseExact(Path.GetFileName(session), "N", out parsed) &&
                string.Equals(Path.GetFileName(basePath), "cat-ha-kernel", StringComparison.Ordinal);
        }

        private static string Quote(string value)
        {
            if (string.IsNullOrEmpty(value) || value.IndexOf('"') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0) return value;
            return "\"" + value + "\"";
        }
    }
}
