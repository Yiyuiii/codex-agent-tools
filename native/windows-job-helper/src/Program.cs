using System;

namespace CodexAgentTools.WindowsJobHelper
{
    internal static class Program
    {
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

            // The first Task 4 atomic batch establishes the real kernel launch
            // primitive. The fd3 production session is wired in the following
            // Task 4 batch; until then the public control entry fails closed.
            return 64;
        }
    }
}
