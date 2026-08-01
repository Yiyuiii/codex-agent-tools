using System;
using System.Collections.Generic;

namespace CodexAgentTools.WindowsJobHelper.Tests
{
    internal static class TestRunner
    {
        private static readonly IDictionary<string, Func<int>> Suites =
            new Dictionary<string, Func<int>>(StringComparer.Ordinal)
            {
                { "Protocol", ProtocolTests.Run },
                { "CommandLine", CommandLineTests.Run },
                { "ControlChannel", ControlChannelTests.Run },
                { "LifecycleMachine", LifecycleMachineTests.Run },
                { "SessionCoordinator", SessionCoordinatorTests.Run }
            };

        private static int Main(string[] args)
        {
            string filter = null;
            if (args.Length == 2 && args[0] == "--filter" && Suites.ContainsKey(args[1]))
            {
                filter = args[1];
            }
            else if (args.Length != 0)
            {
                Console.Error.WriteLine("windows-native-helper: unsupported managed test filter");
                return 64;
            }

            var suites = 0;
            var cases = 0;
            try
            {
                foreach (var suite in Suites)
                {
                    if (filter != null && suite.Key != filter)
                    {
                        continue;
                    }

                    cases += suite.Value();
                    suites++;
                }
            }
            catch (Exception)
            {
                Console.Error.WriteLine("windows-native-helper: managed tests failed");
                return 1;
            }

            Console.WriteLine(
                "windows-native-helper: managed tests passed suites={0} cases={1}",
                suites,
                cases);
            return 0;
        }
    }
}
