using System;
using System.Collections.Generic;
using System.Text;

namespace CodexAgentTools.WindowsJobHelper.Tests
{
    internal static class CommandLineTests
    {
        internal static int Run()
        {
            var count = 0;
            var arguments = new[]
            {
                "",
                "plain",
                "space value",
                "quote\"value",
                "slashes" + new string('\\', 2) + "\"quote",
                "trail space\\",
                "雪🙂"
            };
            var spec = WindowsCommandLine.Build(
                @"C:\Program Files\nodejs\node.exe",
                @"C:\work",
                arguments);
            TestAssert.Equal(@"C:\Program Files\nodejs\node.exe", spec.ApplicationName);
            TestAssert.Equal(@"C:\work", spec.CurrentDirectory);
            var expected = string.Concat(
                "\"C:\\Program Files\\nodejs\\node.exe\"",
                " \"\" plain \"space value\" \"quote\\\"value\" \"slashes",
                new string('\\', 5),
                "\"quote\" \"trail space",
                new string('\\', 2),
                "\" 雪🙂");
            TestAssert.Equal(expected, spec.CommandLine);
            var parsed = ParseCrtCommandLine(spec.CommandLine);
            TestAssert.Equal(arguments.Length + 1, parsed.Count);
            TestAssert.Equal(spec.ApplicationName, parsed[0]);
            for (var index = 0; index < arguments.Length; index++)
            {
                TestAssert.Equal(arguments[index], parsed[index + 1]);
            }
            count++;

            TestAssert.Throws<CommandLineContractException>(() =>
                WindowsCommandLine.Build(@"C:\tool.cmd", @"C:\work", new string[0]));
            TestAssert.Throws<CommandLineContractException>(() =>
                WindowsCommandLine.Build(@"C:\tool.bat", @"C:\work", new string[0]));
            TestAssert.Throws<CommandLineContractException>(() =>
                WindowsCommandLine.Build(@"C:\tool.CMD", @"C:\work", new string[0]));
            TestAssert.Throws<CommandLineContractException>(() =>
                WindowsCommandLine.Build(@"C:\tool.com", @"C:\work", new string[0]));
            TestAssert.Throws<CommandLineContractException>(() =>
                WindowsCommandLine.Build("relative.exe", @"C:\work", new string[0]));
            TestAssert.Throws<CommandLineContractException>(() =>
                WindowsCommandLine.Build(@"Å:\tool.exe", @"C:\work", new string[0]));
            TestAssert.Throws<CommandLineContractException>(() =>
                WindowsCommandLine.Build(@"C:\tool.exe", "relative", new string[0]));
            TestAssert.Throws<CommandLineContractException>(() =>
                WindowsCommandLine.Build(@"C:\tool.exe", @"C:\work", new[] { "bad\0arg" }));
            TestAssert.Throws<CommandLineContractException>(() =>
                WindowsCommandLine.Build("C:\\bad\0tool.exe", @"C:\work", new string[0]));
            TestAssert.Throws<CommandLineContractException>(() =>
                WindowsCommandLine.Build(@"C:\tool.exe", "C:\\bad\0work", new string[0]));
            count += 10;

            var unicode = WindowsCommandLine.Build(@"C:\工具.exe", @"C:\工作", new[] { "雪🙂" });
            TestAssert.True(unicode.CommandLine.Contains("雪🙂"));
            count++;

            const string shortExecutable = @"C:\x.exe";
            var acceptedArgumentLength =
                ProtocolV1.MaxNativeCommandLineUtf16UnitsIncludingNul -
                shortExecutable.Length -
                2;
            var accepted = WindowsCommandLine.Build(
                shortExecutable,
                @"C:\w",
                new[] { new string('x', acceptedArgumentLength) });
            TestAssert.Equal(
                ProtocolV1.MaxNativeCommandLineUtf16UnitsIncludingNul,
                accepted.CommandLine.Length + 1);
            TestAssert.Throws<CommandLineContractException>(() =>
                WindowsCommandLine.Build(
                    shortExecutable,
                    @"C:\w",
                    new[] { new string('x', acceptedArgumentLength + 1) }));
            count += 2;

            return count;
        }

        // Independent test-only inverse of the Microsoft CRT quoting rules. It is
        // deliberately not shared with the production builder.
        private static IList<string> ParseCrtCommandLine(string commandLine)
        {
            var result = new List<string>();
            var index = 0;
            while (index < commandLine.Length)
            {
                while (index < commandLine.Length && char.IsWhiteSpace(commandLine[index]))
                {
                    index++;
                }
                if (index == commandLine.Length)
                {
                    break;
                }

                var value = new StringBuilder();
                var quoted = false;
                while (index < commandLine.Length)
                {
                    var slashes = 0;
                    while (index < commandLine.Length && commandLine[index] == '\\')
                    {
                        slashes++;
                        index++;
                    }

                    if (index < commandLine.Length && commandLine[index] == '"')
                    {
                        value.Append('\\', slashes / 2);
                        if ((slashes & 1) != 0)
                        {
                            value.Append('"');
                            index++;
                        }
                        else
                        {
                            quoted = !quoted;
                            index++;
                        }
                        continue;
                    }

                    value.Append('\\', slashes);
                    if (index == commandLine.Length || (!quoted && char.IsWhiteSpace(commandLine[index])))
                    {
                        break;
                    }
                    value.Append(commandLine[index]);
                    index++;
                }
                result.Add(value.ToString());
            }
            return result;
        }
    }
}
