using System;
using System.IO;

namespace CodexAgentTools.WindowsJobHelper.Tests
{
    internal static class KernelTestRunner
    {
        private static int Main(string[] args)
        {
            if (args.Length != 1 || !Path.IsPathRooted(args[0]))
            {
                Console.Error.WriteLine("windows-native-helper: invalid kernel fixture");
                return 64;
            }

            try
            {
                int cases = KernelTests.Run(Path.GetFullPath(args[0]));
                Console.WriteLine(
                    "windows-native-helper: kernel tests passed suites=1 cases={0}",
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
