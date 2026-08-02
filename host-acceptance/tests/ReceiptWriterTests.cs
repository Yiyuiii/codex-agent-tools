using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace CodexAgentTools.HostAcceptance.Tests
{
    internal static class ReceiptWriterTests
    {
        internal static IEnumerable<Action> All()
        {
            yield return CreatesOnceWithoutReplacingExistingReceipt;
            yield return LeavesNoTemporaryFileAfterFailure;
        }

        private static void CreatesOnceWithoutReplacingExistingReceipt()
        {
            var root = NewTemporaryDirectory();
            try
            {
                var path = Path.Combine(root, "receipt.json");
                AtomicReceiptWriter.WriteNew(path, Encoding.UTF8.GetBytes("{\"first\":true}"));
                TestAssert.Equal("{\"first\":true}", File.ReadAllText(path, Encoding.UTF8), "The requested receipt must be durable.");
                TestAssert.Throws<IOException>(
                    () => AtomicReceiptWriter.WriteNew(path, Encoding.UTF8.GetBytes("{\"second\":true}")),
                    "An existing receipt must never be replaced."
                );
                TestAssert.Equal("{\"first\":true}", File.ReadAllText(path, Encoding.UTF8), "The original receipt must survive a collision.");
            }
            finally
            {
                Directory.Delete(root, true);
            }
        }

        private static void LeavesNoTemporaryFileAfterFailure()
        {
            var root = NewTemporaryDirectory();
            try
            {
                var path = Path.Combine(root, "receipt.json");
                File.WriteAllText(path, "existing", Encoding.UTF8);
                TestAssert.Throws<IOException>(
                    () => AtomicReceiptWriter.WriteNew(path, Encoding.UTF8.GetBytes("replacement")),
                    "A collision must fail."
                );
                TestAssert.Equal(1, Directory.GetFiles(root).Length, "A failed publish must clean its same-directory temporary file.");
            }
            finally
            {
                Directory.Delete(root, true);
            }
        }

        private static string NewTemporaryDirectory()
        {
            var path = Path.Combine(Path.GetTempPath(), "codex-agent-tools", "host-acceptance-tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(path);
            return path;
        }
    }
}
