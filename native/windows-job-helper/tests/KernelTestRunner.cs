using System;
using System.IO;

namespace CodexAgentTools.WindowsJobHelper.Tests
{
    internal static class KernelTestRunner
    {
        private static int Main(string[] args)
        {
            if (args.Length != 4)
            {
                Console.Error.WriteLine("windows-native-helper: invalid kernel fixture");
                return 64;
            }
            foreach (string argument in args)
            {
                if (!Path.IsPathRooted(argument))
                {
                    Console.Error.WriteLine("windows-native-helper: invalid kernel fixture");
                    return 64;
                }
            }

            try
            {
                int cases = KernelTests.Run(Path.GetFullPath(args[0]));
                cases += CrashRecoveryTests.Run(
                    Path.GetFullPath(args[1]),
                    Path.GetFullPath(args[2]),
                    Path.GetFullPath(args[3]),
                    Path.GetFullPath(args[0]));
                Console.WriteLine(
                    "windows-native-helper: kernel tests passed suites=2 cases={0}",
                    cases);
                return 0;
            }
            catch (Exception)
            {
                Console.Error.WriteLine("windows-native-helper: kernel tests failed");
                return 1;
            }
        }
    }
}
