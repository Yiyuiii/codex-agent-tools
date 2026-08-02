using System;
using System.Collections.Generic;
using System.IO;

namespace CodexAgentTools.HostAcceptance
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            return Run(
                args,
                Console.OpenStandardInput(),
                Console.Out,
                Console.Error,
                Environment.CurrentDirectory,
                Environment.GetEnvironmentVariable("LOCALAPPDATA"));
        }

        internal static int Run(
            string[] args,
            Stream input,
            TextWriter output,
            TextWriter error,
            string repositoryRoot,
            string localAppData)
        {
            try
            {
                if (args == null || args.Length != 0) throw new ProtocolException();
                var descriptorBytes = ReadBoundedDescriptor(input);
                var materials = SessionMaterials.Load(
                    repositoryRoot,
                    localAppData,
                    descriptorBytes);
                HostAcceptanceObserverSession.Run(materials, new KernelObserverSessionIo(output));
                return 0;
            }
            catch
            {
                try
                {
                    if (error != null)
                    {
                        error.WriteLine("host-acceptance: failed");
                        error.Flush();
                    }
                }
                catch
                {
                    // The fixed failure exit code remains authoritative if stderr is unavailable.
                }
                return 1;
            }
        }

        internal static byte[] ReadBoundedDescriptor(Stream input)
        {
            if (input == null) throw new ArgumentNullException("input");
            var bytes = new List<byte>(ProtocolV1.DescriptorMaximumBytes);
            var buffer = new byte[4096];
            while (bytes.Count < ProtocolV1.DescriptorMaximumBytes)
            {
                var remaining = ProtocolV1.DescriptorMaximumBytes - bytes.Count;
                var read = input.Read(buffer, 0, Math.Min(buffer.Length, remaining));
                if (read == 0) break;
                for (var index = 0; index < read; index += 1) bytes.Add(buffer[index]);
            }
            if (bytes.Count == 0 ||
                (bytes.Count == ProtocolV1.DescriptorMaximumBytes && input.ReadByte() != -1))
            {
                throw new ProtocolException();
            }
            return bytes.ToArray();
        }
    }
}
