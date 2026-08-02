using System;
using System.Diagnostics;

namespace CodexAgentTools.HostAcceptance.Tests
{
    internal static class KernelTests
    {
        internal static int Run(string fixturePath)
        {
            ValidatesCurrentHostAbi();
            HashesOnlyThePidAndFullCreationFileTime();
            ObservesTheRealPeerAndTwoHeldAncestors(fixturePath);
            return 3;
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
                chain.WaitForExit();
                TestAssert.True(chain.Peer.IsExited && chain.Parent.IsExited && chain.Grandparent.IsExited, "Every held process handle must become signalled.");
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
    }
}
