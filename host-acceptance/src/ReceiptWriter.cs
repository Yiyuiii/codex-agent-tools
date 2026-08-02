using System;
using System.IO;

namespace CodexAgentTools.HostAcceptance
{
    internal static class AtomicReceiptWriter
    {
        internal static void WriteNew(string destinationPath, byte[] receiptUtf8)
        {
            if (string.IsNullOrEmpty(destinationPath)) throw new ArgumentException("A receipt path is required.", "destinationPath");
            if (receiptUtf8 == null || receiptUtf8.Length == 0) throw new ArgumentException("Receipt bytes are required.", "receiptUtf8");

            var absolute = Path.GetFullPath(destinationPath);
            var directory = Path.GetDirectoryName(absolute);
            if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory))
            {
                throw new DirectoryNotFoundException();
            }

            var temporary = Path.Combine(directory, "." + Path.GetFileName(absolute) + "." + Guid.NewGuid().ToString("N") + ".tmp");
            var published = false;
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
                {
                    stream.Write(receiptUtf8, 0, receiptUtf8.Length);
                    stream.Flush(true);
                }
                File.Move(temporary, absolute);
                published = true;
            }
            finally
            {
                if (!published && File.Exists(temporary))
                {
                    File.Delete(temporary);
                }
            }
        }
    }
}
