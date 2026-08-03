using System;

namespace CodexAgentTools.WindowsJobHelper
{
    internal static class Program
    {
        private const int ControlFailureExitCode = 68;

        private static int Main(string[] args)
        {
            if (args.Length == 1 &&
                String.Equals(args[0], ProtocolV1.ProbeMode, StringComparison.Ordinal))
            {
                try
                {
                    NativeMethods.ValidateCurrentHostLayouts();
                    return 0;
                }
                catch
                {
                    return 65;
                }
            }

            if (args.Length == 1 &&
                String.Equals(args[0], ProtocolV1.ControlMode, StringComparison.Ordinal))
            {
                try
                {
                    using (ControlChannel channel = ControlChannel.OpenFd3(
                        ControlNativeApi.Instance))
                    {
                        int status = new SessionCoordinator(
                            new JobSession(NativeWin32Api.Instance),
                            channel).Run();
                        return status == 0 ? 0 : ControlFailureExitCode;
                    }
                }
                catch
                {
                    // No control channel means there is no safe terminal owner.
                    // Fail silently with the fixed helper-control exit code.
                    return ControlFailureExitCode;
                }
            }

            return 64;
        }
    }
}
