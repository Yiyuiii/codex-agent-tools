using System;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace CodexAgentTools.HostAcceptance
{
    internal sealed class SessionRequestIdentity
    {
        internal SessionRequestIdentity(
            string llm,
            string promptSha256,
            string cwdSha256,
            long? timeoutMs,
            string sessionIdSha256,
            string inputIdentitySha256,
            string completionMarkerId,
            string completionMarkerIdentitySha256)
        {
            Llm = llm;
            PromptSha256 = promptSha256;
            CwdSha256 = cwdSha256;
            TimeoutMs = timeoutMs;
            SessionIdSha256 = sessionIdSha256;
            InputIdentitySha256 = inputIdentitySha256;
            CompletionMarkerId = completionMarkerId;
            CompletionMarkerIdentitySha256 = completionMarkerIdentitySha256;
        }

        internal string Llm { get; private set; }
        internal string PromptSha256 { get; private set; }
        internal string CwdSha256 { get; private set; }
        internal long? TimeoutMs { get; private set; }
        internal string SessionIdSha256 { get; private set; }
        internal string InputIdentitySha256 { get; private set; }
        internal string CompletionMarkerId { get; private set; }
        internal string CompletionMarkerIdentitySha256 { get; private set; }
    }

    internal sealed class SessionDescriptor
    {
        internal SessionDescriptor(
            string nonce,
            string pipeName,
            string descriptorSha256,
            PublicBetaIdentity publicBeta,
            SessionRequestIdentity request)
        {
            Nonce = nonce;
            PipeName = pipeName;
            DescriptorSha256 = descriptorSha256;
            PublicBeta = publicBeta;
            Request = request;
        }

        internal string Nonce { get; private set; }
        internal string PipeName { get; private set; }
        internal string DescriptorSha256 { get; private set; }
        internal PublicBetaIdentity PublicBeta { get; private set; }
        internal SessionRequestIdentity Request { get; private set; }
    }

    internal static class SessionDescriptorParser
    {
        private const long MaximumJavaScriptSafeInteger = 9007199254740991L;
        private static readonly Regex PipeNamePattern = new Regex(ProtocolV1.PipeNamePattern, RegexOptions.CultureInvariant);
        private static readonly Regex LlmPattern = new Regex(ProtocolV1.LlmPattern, RegexOptions.CultureInvariant);

        internal static SessionDescriptor Parse(byte[] bytes)
        {
            if (bytes == null || bytes.Length == 0 || bytes.Length > ProtocolV1.DescriptorMaximumBytes)
            {
                throw new ProtocolException();
            }
            var root = StrictJson.ParseUtf8(bytes, false).RequireObject();
            root.RequireExactKeys(ProtocolV1.DescriptorTopLevelKeys);
            if (root.RequireInt32("schemaVersion") != ProtocolV1.SchemaVersion ||
                root.RequireInt32("protocolVersion") != ProtocolV1.ProtocolVersion ||
                root.RequireString("packageName") != ProtocolV1.PackageName)
            {
                throw new ProtocolException();
            }

            var nonce = ProtocolValues.Nonce(root.RequireString("nonce"));
            var pipeName = RequireMatch(root.RequireString("pipeName"), PipeNamePattern, 128);
            var publicBeta = ObserverFrameParser.ParsePublicBeta(root.RequireObject("publicBeta"));
            var request = ParseRequest(root.RequireObject("request"), nonce);
            return new SessionDescriptor(nonce, pipeName, Sha256(bytes), publicBeta, request);
        }

        internal static string ComputeInputIdentitySha256(
            string llm,
            string promptSha256,
            string cwdSha256,
            long? timeoutMs,
            string sessionIdSha256)
        {
            var builder = new StringBuilder();
            builder.Append('[');
            AppendString(builder, ProtocolV1.RequestInputHashDomain, true);
            AppendString(builder, "delegate", false);
            AppendString(builder, RequireMatch(llm, LlmPattern, 128), false);
            AppendString(builder, ProtocolValues.Digest(promptSha256), false);
            AppendString(builder, ProtocolValues.Digest(cwdSha256), false);
            builder.Append(',');
            if (timeoutMs.HasValue)
            {
                if (timeoutMs.Value < ProtocolV1.MinimumTimeoutMs ||
                    timeoutMs.Value > MaximumJavaScriptSafeInteger)
                {
                    throw new ProtocolException();
                }
                builder.Append(timeoutMs.Value.ToString(CultureInfo.InvariantCulture));
            }
            else
            {
                builder.Append("null");
            }
            builder.Append(',');
            if (sessionIdSha256 == null) builder.Append("null");
            else JsonEncoding.AppendQuoted(builder, ProtocolValues.Digest(sessionIdSha256));
            builder.Append(']');
            return HostAcceptanceHash.Sha256Utf8(builder.ToString());
        }

        internal static string ComputeCompletionMarkerIdentitySha256(string nonce, string markerId, string inputIdentitySha256)
        {
            var builder = new StringBuilder();
            builder.Append('[');
            AppendString(builder, ProtocolV1.CompletionMarkerHashDomain, true);
            AppendString(builder, ProtocolValues.Nonce(nonce), false);
            AppendString(builder, ProtocolValues.MarkerId(markerId), false);
            AppendString(builder, ProtocolValues.Digest(inputIdentitySha256), false);
            builder.Append(']');
            return HostAcceptanceHash.Sha256Utf8(builder.ToString());
        }

        internal static string Sha256(byte[] bytes)
        {
            using (var sha256 = SHA256.Create())
            {
                return Hex(sha256.ComputeHash(bytes));
            }
        }

        internal static string Hex(byte[] bytes)
        {
            var builder = new StringBuilder(bytes.Length * 2);
            foreach (var item in bytes) builder.Append(item.ToString("x2", CultureInfo.InvariantCulture));
            return builder.ToString();
        }

        private static SessionRequestIdentity ParseRequest(StrictJsonObject request, string nonce)
        {
            request.RequireExactKeys(ProtocolV1.RequestKeys);
            if (request.RequireString("task") != "delegate") throw new ProtocolException();
            var llm = RequireMatch(request.RequireString("llm"), LlmPattern, 128);
            var promptSha256 = ProtocolValues.Digest(request.RequireString("promptSha256"));
            var cwdSha256 = ProtocolValues.Digest(request.RequireString("cwdSha256"));
            var timeoutMs = NullableSafeInteger(request, "timeoutMs");
            if (timeoutMs.HasValue && timeoutMs.Value < ProtocolV1.MinimumTimeoutMs) throw new ProtocolException();
            var sessionIdSha256 = NullableDigest(request, "sessionIdSha256");
            var inputIdentitySha256 = ProtocolValues.Digest(request.RequireString("inputIdentitySha256"));
            if (inputIdentitySha256 != ComputeInputIdentitySha256(llm, promptSha256, cwdSha256, timeoutMs, sessionIdSha256))
            {
                throw new ProtocolException();
            }
            var markerId = ProtocolValues.MarkerId(request.RequireString("completionMarkerId"));
            var markerIdentity = ProtocolValues.Digest(request.RequireString("completionMarkerIdentitySha256"));
            if (markerIdentity != ComputeCompletionMarkerIdentitySha256(nonce, markerId, inputIdentitySha256))
            {
                throw new ProtocolException();
            }
            return new SessionRequestIdentity(
                llm, promptSha256, cwdSha256, timeoutMs, sessionIdSha256,
                inputIdentitySha256, markerId, markerIdentity);
        }

        private static long? NullableSafeInteger(StrictJsonObject value, string key)
        {
            if (value.Require(key) is StrictJsonNull) return null;
            long parsed;
            if (!long.TryParse(
                value.RequireNumber(key).Raw,
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out parsed) || parsed > MaximumJavaScriptSafeInteger)
            {
                throw new ProtocolException();
            }
            return parsed;
        }

        private static string NullableDigest(StrictJsonObject value, string key)
        {
            if (value.Require(key) is StrictJsonNull) return null;
            return ProtocolValues.Digest(value.RequireString(key));
        }

        private static string RequireMatch(string value, Regex pattern, int maximumLength)
        {
            return ProtocolValues.ExactMatch(value, pattern, maximumLength);
        }

        private static void AppendString(StringBuilder builder, string value, bool first)
        {
            if (!first) builder.Append(',');
            JsonEncoding.AppendQuoted(builder, value);
        }
    }

    internal sealed class VerifiedSessionMaterials
    {
        internal VerifiedSessionMaterials(
            SessionDescriptor descriptor,
            HostAcceptanceBinding binding,
            string completionMarkerPath,
            string receiptPath)
        {
            Descriptor = descriptor;
            Binding = binding;
            CompletionMarkerPath = completionMarkerPath;
            ReceiptPath = receiptPath;
        }

        internal SessionDescriptor Descriptor { get; private set; }
        internal HostAcceptanceBinding Binding { get; private set; }
        internal string CompletionMarkerPath { get; private set; }
        internal string ReceiptPath { get; private set; }
    }

    internal static class SessionMaterials
    {
        private const int MaximumMarkerBytes = 1024 * 1024;
        private static readonly string[] BetaMarkerKeys = {
            "schemaVersion", "kind", "package", "core", "pluginArtifactTree", "observerArtifact"
        };

        internal static VerifiedSessionMaterials Load(string repositoryRoot, string localAppData, byte[] descriptorBytes)
        {
            var descriptor = SessionDescriptorParser.Parse(descriptorBytes);
            var repository = RequireDirectory(repositoryRoot);
            var markerPath = ResolveRepositoryFile(repository, descriptor.PublicBeta.MarkerPath);
            var markerBytes = ReadBoundedFile(markerPath, MaximumMarkerBytes);
            if (SessionDescriptorParser.Sha256(markerBytes) != descriptor.PublicBeta.MarkerSha256)
            {
                throw new ProtocolException();
            }
            var core = ParseAndValidateBetaMarker(markerBytes, descriptor.PublicBeta);

            RequireFileHash(repository, descriptor.PublicBeta.ObserverArtifact.Protocol);
            RequireFileHash(repository, core.WindowsJobHelper);
            RequireFileHash(repository, core.CapabilityIndex);
            RequireFileHash(repository, core.CurrentHostFreeze);

            var sessionRoot = RequireSessionRoot(localAppData, descriptor.Nonce);
            var markerDirectory = RequireDirectory(Path.Combine(sessionRoot, "completion-markers"));
            var completionMarkerPath = Path.Combine(markerDirectory, descriptor.Request.CompletionMarkerId + ".marker");
            var receiptPath = Path.Combine(sessionRoot, "host-acceptance-receipt.v1.json");
            RequireOutputAbsent(completionMarkerPath);
            RequireOutputAbsent(receiptPath);

            var binding = new HostAcceptanceBinding(
                descriptor.Nonce,
                descriptor.DescriptorSha256,
                descriptor.PublicBeta,
                core,
                descriptor.Request.InputIdentitySha256,
                descriptor.Request.CompletionMarkerId,
                descriptor.Request.CompletionMarkerIdentitySha256);
            return new VerifiedSessionMaterials(descriptor, binding, completionMarkerPath, receiptPath);
        }

        private static ReleaseCoreIdentity ParseAndValidateBetaMarker(byte[] markerBytes, PublicBetaIdentity expected)
        {
            var marker = StrictJson.ParseUtf8(markerBytes, false).RequireObject();
            marker.RequireExactKeys(BetaMarkerKeys);
            if (marker.RequireInt32("schemaVersion") != 1 || marker.RequireString("kind") != "beta")
            {
                throw new ProtocolException();
            }

            var package = marker.RequireObject("package");
            package.RequireExactKeys(new[] { "name", "version", "tag", "npmChannel" });
            if (package.RequireString("name") != ProtocolV1.PackageName ||
                package.RequireString("version") != expected.Version ||
                package.RequireString("tag") != expected.Tag ||
                package.RequireString("npmChannel") != "next")
            {
                throw new ProtocolException();
            }

            var plugin = marker.RequireObject("pluginArtifactTree");
            plugin.RequireExactKeys(new[] { "schemaVersion", "digestSha256" });
            if (plugin.RequireInt32("schemaVersion") != 1 ||
                ProtocolValues.Digest(plugin.RequireString("digestSha256")) != expected.PluginArtifactTreeDigestSha256)
            {
                throw new ProtocolException();
            }

            var observer = ObserverFrameParser.ParseObserverArtifact(marker.RequireObject("observerArtifact"));
            if (!observer.SameAs(expected.ObserverArtifact)) throw new ProtocolException();
            return ParseCore(marker.RequireObject("core"));
        }

        private static ReleaseCoreIdentity ParseCore(StrictJsonObject core)
        {
            core.RequireExactKeys(new[] {
                "runtimeFrozenCommit", "canonicalRuntime", "windowsJobHelper", "capabilityIndex", "currentHostFreeze"
            });
            var canonical = core.RequireObject("canonicalRuntime");
            canonical.RequireExactKeys(new[] { "schemaVersion", "digestSha256" });
            var helper = core.RequireObject("windowsJobHelper");
            helper.RequireExactKeys(ProtocolV1.ArtifactIdentityKeys);
            var capability = core.RequireObject("capabilityIndex");
            capability.RequireExactKeys(new[] { "path", "sha256", "entryCount" });
            var freeze = core.RequireObject("currentHostFreeze");
            freeze.RequireExactKeys(ProtocolV1.ArtifactIdentityKeys);
            return new ReleaseCoreIdentity(
                core.RequireString("runtimeFrozenCommit"),
                new VersionedArtifactIdentity(canonical.RequireInt32("schemaVersion"), canonical.RequireString("digestSha256")),
                ObserverFrameParser.ParseArtifact(helper),
                new CountedArtifactIdentity(capability.RequireString("path"), capability.RequireString("sha256"), capability.RequireInt32("entryCount")),
                ObserverFrameParser.ParseArtifact(freeze));
        }

        private static void RequireFileHash(string repositoryRoot, ArtifactIdentity expected)
        {
            var path = ResolveRepositoryFile(repositoryRoot, expected.Path);
            if (HashFile(path) != expected.Sha256) throw new ProtocolException();
        }

        private static void RequireFileHash(string repositoryRoot, CountedArtifactIdentity expected)
        {
            var path = ResolveRepositoryFile(repositoryRoot, expected.Path);
            if (HashFile(path) != expected.Sha256) throw new ProtocolException();
        }

        private static string HashFile(string path)
        {
            try
            {
                using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (var sha256 = SHA256.Create())
                {
                    return SessionDescriptorParser.Hex(sha256.ComputeHash(stream));
                }
            }
            catch (ProtocolException)
            {
                throw;
            }
            catch
            {
                throw new ProtocolException();
            }
        }

        private static byte[] ReadBoundedFile(string path, int maximumBytes)
        {
            try
            {
                using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    if (stream.Length <= 0 || stream.Length > maximumBytes) throw new ProtocolException();
                    var bytes = new byte[checked((int)stream.Length)];
                    var offset = 0;
                    while (offset < bytes.Length)
                    {
                        var read = stream.Read(bytes, offset, bytes.Length - offset);
                        if (read == 0) throw new ProtocolException();
                        offset += read;
                    }
                    if (stream.ReadByte() != -1) throw new ProtocolException();
                    return bytes;
                }
            }
            catch (ProtocolException)
            {
                throw;
            }
            catch
            {
                throw new ProtocolException();
            }
        }

        private static string ResolveRepositoryFile(string repositoryRoot, string relativePath)
        {
            if (string.IsNullOrEmpty(relativePath) || Path.IsPathRooted(relativePath) ||
                relativePath.IndexOf('\\') >= 0 || relativePath.IndexOf('\0') >= 0)
            {
                throw new ProtocolException();
            }
            var segments = relativePath.Split('/');
            foreach (var segment in segments)
            {
                if (segment.Length == 0 || segment == "." || segment == "..") throw new ProtocolException();
            }
            var candidate = Path.GetFullPath(Path.Combine(repositoryRoot, relativePath.Replace('/', Path.DirectorySeparatorChar)));
            var prefix = repositoryRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(candidate))
            {
                throw new ProtocolException();
            }
            EnsureNoReparse(candidate);
            return candidate;
        }

        private static string RequireSessionRoot(string localAppData, string nonce)
        {
            var localRoot = RequireDirectory(localAppData);
            return RequireDirectory(Path.Combine(
                localRoot, "codex-agent-tools", "host-acceptance", "sessions", ProtocolValues.Nonce(nonce)));
        }

        private static string RequireDirectory(string path)
        {
            try
            {
                if (string.IsNullOrEmpty(path) || path.IndexOf('\0') >= 0 || !Path.IsPathRooted(path))
                {
                    throw new ProtocolException();
                }
                var full = Path.GetFullPath(path);
                if (!Directory.Exists(full)) throw new ProtocolException();
                EnsureNoReparse(full);
                return full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            }
            catch (ProtocolException)
            {
                throw;
            }
            catch
            {
                throw new ProtocolException();
            }
        }

        private static void EnsureNoReparse(string path)
        {
            var full = Path.GetFullPath(path);
            var root = Path.GetPathRoot(full);
            var current = root;
            var relative = full.Substring(root.Length);
            foreach (var segment in relative.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries))
            {
                current = Path.Combine(current, segment);
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                {
                    throw new ProtocolException();
                }
            }
        }

        internal static void RequireOutputAbsent(string path)
        {
            try
            {
                if (string.IsNullOrEmpty(path) || path.IndexOf('\0') >= 0 || !Path.IsPathRooted(path))
                {
                    throw new ProtocolException();
                }
                var full = Path.GetFullPath(path);
                var parent = Path.GetDirectoryName(full);
                if (string.IsNullOrEmpty(parent)) throw new ProtocolException();
                RequireDirectory(parent);
                try
                {
                    File.GetAttributes(full);
                }
                catch (FileNotFoundException)
                {
                    RequireDirectory(parent);
                    return;
                }
                catch (DirectoryNotFoundException)
                {
                    throw new ProtocolException();
                }
                throw new ProtocolException();
            }
            catch (ProtocolException)
            {
                throw;
            }
            catch
            {
                throw new ProtocolException();
            }
        }
    }
}
