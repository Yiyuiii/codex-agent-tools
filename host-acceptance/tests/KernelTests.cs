using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;

namespace CodexAgentTools.HostAcceptance.Tests
{
    internal static class KernelTests
    {
        internal static int Run(string fixturePath, string nodePath, string nodePipeCloseFixturePath)
        {
            ValidatesCurrentHostAbi();
            HashesOnlyThePidAndFullCreationFileTime();
            RecreatesTheSameFirstInstanceOnlyAfterFullDispose();
            ObservesTheRealPeerAndTwoHeldAncestors(fixturePath);
            ObservesTheCurrentNodeTerminalPipeEof(nodePath, nodePipeCloseFixturePath);
            return 5 + KernelObserverSessionTests.Run(fixturePath);
        }

        private static void HashesOnlyThePidAndFullCreationFileTime()
        {
            TestAssert.Equal(
                "fa73f9b8b7c0763b6dd7b659e3dbb7be238320103c8121dc74271449af0ac166",
                HeldProcessIdentity.ComputeIdentitySha256(0x78563412, 0x1122334455667788),
                "The identity hash input must be exactly uint PID plus the full ulong creation FILETIME in little-endian order.");
        }

        private static void ValidatesCurrentHostAbi()
        {
            WindowsNative.ValidateCurrentHostLayouts();
            TestAssert.Equal(48, WindowsNative.ProcessBasicInformationSize, "x64 PBI must remain exactly 48 bytes.");
            TestAssert.Equal(32, WindowsNative.UniqueProcessIdOffset, "The x64 PBI PID offset must remain exact.");
            TestAssert.Equal(40, WindowsNative.InheritedProcessIdOffset, "The x64 PBI parent PID offset must remain exact.");
        }

        private static void RecreatesTheSameFirstInstanceOnlyAfterFullDispose()
        {
            var pipeName = "codex-agent-tools-host-acceptance-" + Guid.NewGuid().ToString("N");
            using (var first = CurrentUserNamedPipeServer.Create(pipeName))
            {
                TestAssert.True(first.HasProtectedCurrentUserOnlyDacl(), "The first pipe instance must use the protected current-user ACL.");
            }
            using (var second = CurrentUserNamedPipeServer.Create(pipeName))
            {
                TestAssert.True(second.HasProtectedCurrentUserOnlyDacl(), "The same random name must be reusable only after the first instance is fully disposed.");
            }
        }

        private static void ObservesTheRealPeerAndTwoHeldAncestors(string fixturePath)
        {
            var pipeName = "codex-agent-tools-host-acceptance-" + Guid.NewGuid().ToString("N");
            using (var server = CurrentUserNamedPipeServer.Create(pipeName))
            using (var fixture = StartFixture(fixturePath, "--ancestor " + pipeName))
            using (var chain = server.AcceptProcessChain())
            {
                TestAssert.True(server.HasProtectedCurrentUserOnlyDacl(), "The pipe DACL must be protected and grant only the current SID.");
                TestAssert.Equal((uint)fixture.Id, chain.Grandparent.ProcessId, "The held grandparent must be the fixture launched by the runner.");
                TestAssert.True(chain.Peer.ProcessId != chain.Parent.ProcessId && chain.Parent.ProcessId != chain.Grandparent.ProcessId, "All held process identities must be distinct.");
                TestAssert.True(!chain.Peer.IsExited && !chain.Parent.IsExited && !chain.Grandparent.IsExited, "All three kernel handles must remain live before release.");
                TestAssert.Equal((byte)0x51, server.ReadClientByte(), "The real pipe client must complete its readiness write.");
                server.WriteClientByte(0x52);
                var exits = chain.WaitForActualExits();
                TestAssert.True(chain.Peer.IsExited && chain.Parent.IsExited && chain.Grandparent.IsExited, "Every held process handle must become signalled.");
                TestAssert.Equal(
                    ProcessIdentity.NormalizeTimestamp(DateTime.FromFileTimeUtc(checked((long)WindowsNative.GetProcessExitFileTime(chain.Grandparent.Handle)))),
                    exits.ChatGpt.ExitedAt,
                    "The reported ChatGPT exit must be the exact FILETIME from its already-held handle.");
                TestAssert.Equal(
                    ProcessIdentity.NormalizeTimestamp(DateTime.FromFileTimeUtc(checked((long)WindowsNative.GetProcessExitFileTime(chain.Parent.Handle)))),
                    exits.AppServer.ExitedAt,
                    "The reported app-server exit must be the exact FILETIME from its already-held handle.");
                TestAssert.Equal(
                    ProcessIdentity.NormalizeTimestamp(DateTime.FromFileTimeUtc(checked((long)WindowsNative.GetProcessExitFileTime(chain.Peer.Handle)))),
                    exits.KernelPeerMcp.ExitedAt,
                    "The reported MCP exit must be the exact FILETIME from its already-held handle.");
                TestAssert.True(
                    exits.ChatGpt.ExitedAt > exits.ChatGpt.Process.CreatedAt &&
                    exits.AppServer.ExitedAt > exits.AppServer.Process.CreatedAt &&
                    exits.KernelPeerMcp.ExitedAt > exits.KernelPeerMcp.Process.CreatedAt,
                    "Exit timestamps must come from the three already-held kernel handles after they signal.");
                byte unexpected;
                TestAssert.True(!server.TryReadClientByte(out unexpected), "The real client exit must produce a clean named-pipe EOF.");
                fixture.WaitForExit();
                TestAssert.Equal(0, fixture.ExitCode, "The known fixture chain must exit cleanly.");
            }
        }

        private static Process StartFixture(string fixturePath, string arguments)
        {
            var start = new ProcessStartInfo {
                FileName = fixturePath,
                Arguments = arguments,
                WorkingDirectory = System.IO.Path.GetDirectoryName(fixturePath),
                UseShellExecute = false,
                CreateNoWindow = true
            };
            var process = Process.Start(start);
            if (process == null) throw new InvalidOperationException("host_acceptance_fixture_start_failed");
            return process;
        }

        private static void ObservesTheCurrentNodeTerminalPipeEof(string nodePath, string scriptPath)
        {
            var pipeName = "codex-agent-tools-host-acceptance-" + Guid.NewGuid().ToString("N");
            using (var server = CurrentUserNamedPipeServer.Create(pipeName))
            using (var node = StartFixture(nodePath, Quote(scriptPath) + " " + Quote("\\\\.\\pipe\\" + pipeName)))
            {
                using (var chain = server.AcceptProcessChain())
                {
                    var bytes = new List<byte>();
                    byte value;
                    while (server.TryReadClientByte(out value)) bytes.Add(value);
                    TestAssert.Equal(
                        "terminal\n",
                        Encoding.UTF8.GetString(bytes.ToArray()),
                        "The current Node named-pipe client must flush its terminal frame before producing server-observed EOF.");
                    TestAssert.Equal((uint)node.Id, chain.Peer.ProcessId, "The current Node process must remain the kernel-observed pipe peer.");
                }
                server.Dispose();
                node.WaitForExit();
                TestAssert.Equal(0, node.ExitCode, "The current Node named-pipe close fixture must exit cleanly after the server closes.");
            }
        }

        private static string Quote(string value)
        {
            if (value == null || value.IndexOf('"') >= 0) throw new InvalidOperationException("host_acceptance_fixture_argument_invalid");
            return "\"" + value + "\"";
        }

    }
}
