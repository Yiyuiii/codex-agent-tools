using System;
using System.IO;
using System.Threading;

namespace CodexAgentTools.HostAcceptance.Tests
{
    internal static class KernelTestRunner
    {
        private static int Main(string[] args)
        {
            if (args.Length != 3 || !Path.IsPathRooted(args[0]) || !Path.IsPathRooted(args[1]) || !Path.IsPathRooted(args[2]))
            {
                Console.Error.WriteLine("host-acceptance: invalid kernel fixture");
                return 64;
            }

            using (var watchdog = new Timer(
                delegate { Environment.FailFast("host-acceptance kernel watchdog expired"); },
                null,
                TimeSpan.FromSeconds(10),
                Timeout.InfiniteTimeSpan))
            {
                try
                {
                    var cases = KernelTests.Run(
                        Path.GetFullPath(args[0]),
                        Path.GetFullPath(args[1]),
                        Path.GetFullPath(args[2]));
                    Console.WriteLine("host-acceptance kernel tests: " + cases + " passed");
                    return 0;
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine("host-acceptance: kernel tests failed");
                    Console.Error.WriteLine(error.ToString());
                    return 1;
                }
            }
        }
    }
}
