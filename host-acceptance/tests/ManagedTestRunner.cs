using System;
using System.Collections.Generic;

namespace CodexAgentTools.HostAcceptance.Tests
{
    internal static class ManagedTestRunner
    {
        private static int Main()
        {
            var tests = new List<Action>();
            tests.AddRange(BuildContractTests.All());
            tests.AddRange(StrictJsonTests.All());
            tests.AddRange(HashReceiptTests.All());
            tests.AddRange(StateMachineTests.All());
            tests.AddRange(ReceiptWriterTests.All());

            var passed = 0;
            foreach (var test in tests)
            {
                try
                {
                    test();
                    passed += 1;
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine("FAILED " + test.Method.DeclaringType.FullName + "." + test.Method.Name);
                    Console.Error.WriteLine(error.ToString());
                    return 1;
                }
            }

            Console.WriteLine("host-acceptance managed tests: " + passed + " passed");
            return 0;
        }
    }
}
