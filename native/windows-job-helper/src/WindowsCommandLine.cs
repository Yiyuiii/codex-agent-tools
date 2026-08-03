using System;
using System.Collections.Generic;
using System.Text;

namespace CodexAgentTools.WindowsJobHelper
{
    internal sealed class CommandLineContractException : Exception
    {
        internal CommandLineContractException()
            : base("windows_native_command_line_invalid")
        {
        }
    }

    internal sealed class WindowsCommandLineSpec
    {
        internal string ApplicationName { get; private set; }
        internal string CurrentDirectory { get; private set; }
        internal string CommandLine { get; private set; }

        internal WindowsCommandLineSpec(string applicationName, string currentDirectory, string commandLine)
        {
            ApplicationName = applicationName;
            CurrentDirectory = currentDirectory;
            CommandLine = commandLine;
        }
    }

    internal static class WindowsCommandLine
    {
        internal static WindowsCommandLineSpec Build(
            string executable,
            string currentDirectory,
            IEnumerable<string> arguments)
        {
            try
            {
                RequireAbsolutePath(executable);
                RequireAbsolutePath(currentDirectory);
                if (!executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || arguments == null)
                {
                    throw new CommandLineContractException();
                }

                var values = new List<string>();
                foreach (string argument in arguments)
                {
                    if (argument == null || argument.IndexOf('\0') >= 0 || values.Count == ProtocolV1.MaxArgCount)
                    {
                        throw new CommandLineContractException();
                    }
                    values.Add(argument);
                }

                var commandLine = new StringBuilder();
                AppendToken(commandLine, executable, false);
                foreach (string argument in values)
                {
                    if (commandLine.Length >= ProtocolV1.MaxNativeCommandLineUtf16UnitsIncludingNul - 1)
                    {
                        throw new CommandLineContractException();
                    }
                    commandLine.Append(' ');
                    AppendToken(commandLine, argument, true);
                }
                if (commandLine.Length + 1 > ProtocolV1.MaxNativeCommandLineUtf16UnitsIncludingNul)
                {
                    throw new CommandLineContractException();
                }

                return new WindowsCommandLineSpec(executable, currentDirectory, commandLine.ToString());
            }
            catch (CommandLineContractException)
            {
                throw;
            }
            catch
            {
                throw new CommandLineContractException();
            }
        }

        private static void AppendToken(StringBuilder result, string value, bool allowEmpty)
        {
            if ((!allowEmpty && value.Length == 0) || value.IndexOf('\0') >= 0)
            {
                throw new CommandLineContractException();
            }

            bool quote = value.Length == 0 || value.IndexOf('"') >= 0 || ContainsWhitespace(value);
            if (!quote)
            {
                AppendBounded(result, value);
                return;
            }

            AppendBounded(result, '"');
            int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\')
                {
                    slashes++;
                    continue;
                }
                if (character == '"')
                {
                    AppendRepeated(result, '\\', checked(slashes * 2 + 1));
                    AppendBounded(result, '"');
                    slashes = 0;
                    continue;
                }
                AppendRepeated(result, '\\', slashes);
                slashes = 0;
                AppendBounded(result, character);
            }
            AppendRepeated(result, '\\', checked(slashes * 2));
            AppendBounded(result, '"');
        }

        private static bool ContainsWhitespace(string value)
        {
            foreach (char character in value)
            {
                if (Char.IsWhiteSpace(character))
                {
                    return true;
                }
            }
            return false;
        }

        private static void RequireAbsolutePath(string value)
        {
            if (value == null || value.Length < 3 || value.IndexOf('\0') >= 0 ||
                value.IndexOf('"') >= 0 || value[0] == '\uFEFF')
            {
                throw new CommandLineContractException();
            }
            if (!WindowsPath.IsFullyQualified(value))
            {
                throw new CommandLineContractException();
            }
        }

        private static void AppendRepeated(StringBuilder result, char value, int count)
        {
            for (int index = 0; index < count; index++)
            {
                AppendBounded(result, value);
            }
        }

        private static void AppendBounded(StringBuilder result, string value)
        {
            if ((long)result.Length + value.Length + 1 > ProtocolV1.MaxNativeCommandLineUtf16UnitsIncludingNul)
            {
                throw new CommandLineContractException();
            }
            result.Append(value);
        }

        private static void AppendBounded(StringBuilder result, char value)
        {
            if (result.Length + 2 > ProtocolV1.MaxNativeCommandLineUtf16UnitsIncludingNul)
            {
                throw new CommandLineContractException();
            }
            result.Append(value);
        }
    }

    internal static class WindowsPath
    {
        internal static bool IsFullyQualified(string value)
        {
            if (String.IsNullOrEmpty(value))
            {
                return false;
            }
            if (value.Length >= 3 &&
                IsAsciiLetter(value[0]) &&
                value[1] == ':' &&
                IsSeparator(value[2]))
            {
                return true;
            }
            if (value.Length < 5 ||
                !IsSeparator(value[0]) ||
                !IsSeparator(value[1]) ||
                IsSeparator(value[2]))
            {
                return false;
            }

            int serverEnd = 2;
            while (serverEnd < value.Length && !IsSeparator(value[serverEnd]))
            {
                serverEnd++;
            }
            if (serverEnd == 2 || serverEnd >= value.Length - 1)
            {
                return false;
            }
            int shareStart = serverEnd + 1;
            return !IsSeparator(value[shareStart]);
        }

        private static bool IsAsciiLetter(char value)
        {
            return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z';
        }

        private static bool IsSeparator(char value)
        {
            return value == '\\' || value == '/';
        }
    }
}
