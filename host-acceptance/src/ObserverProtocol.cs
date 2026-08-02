using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace CodexAgentTools.HostAcceptance
{
    internal static class ProtocolValues
    {
        private static readonly Regex DigestPattern = new Regex(ProtocolV1.Sha256Pattern, RegexOptions.CultureInvariant);
        private static readonly Regex Sha1Pattern = new Regex(ProtocolV1.Sha1Pattern, RegexOptions.CultureInvariant);
        private static readonly Regex CommitPattern = new Regex(ProtocolV1.CommitPattern, RegexOptions.CultureInvariant);
        private static readonly Regex NoncePattern = new Regex(ProtocolV1.NoncePattern, RegexOptions.CultureInvariant);
        private static readonly Regex MarkerPattern = new Regex(ProtocolV1.CompletionMarkerIdPattern, RegexOptions.CultureInvariant);
        private static readonly Regex VersionPattern = new Regex(ProtocolV1.PublicBetaVersionPattern, RegexOptions.CultureInvariant);
        private static readonly Regex IntegrityPattern = new Regex(ProtocolV1.NpmIntegrityPattern, RegexOptions.CultureInvariant);

        internal static string Digest(string value)
        {
            return Match(value, DigestPattern, 64);
        }

        internal static string Commit(string value)
        {
            return Match(value, CommitPattern, 40);
        }

        internal static string Sha1(string value)
        {
            return Match(value, Sha1Pattern, 40);
        }

        internal static string Nonce(string value)
        {
            return Match(value, NoncePattern, 128);
        }

        internal static string MarkerId(string value)
        {
            return Match(value, MarkerPattern, 64);
        }

        internal static string Version(string value)
        {
            return Match(value, VersionPattern, 128);
        }

        internal static string Integrity(string value)
        {
            return Match(value, IntegrityPattern, 256);
        }

        internal static string NonEmpty(string value, int maximumLength)
        {
            if (string.IsNullOrEmpty(value) || value.Length > maximumLength || value.IndexOf('\0') >= 0)
            {
                throw new ProtocolException();
            }
            return value;
        }

        internal static string RequestIdType(string value)
        {
            if (!string.Equals(value, "string", StringComparison.Ordinal) && !string.Equals(value, "number", StringComparison.Ordinal))
            {
                throw new ProtocolException();
            }
            return value;
        }

        private static string Match(string value, Regex pattern, int maximumLength)
        {
            NonEmpty(value, maximumLength);
            if (!pattern.IsMatch(value))
            {
                throw new ProtocolException();
            }
            return value;
        }
    }

    internal sealed class ArtifactIdentity
    {
        internal ArtifactIdentity(string path, string sha256)
        {
            Path = ProtocolValues.NonEmpty(path, 256);
            Sha256 = ProtocolValues.Digest(sha256);
        }

        internal string Path { get; private set; }
        internal string Sha256 { get; private set; }
    }

    internal sealed class VersionedArtifactIdentity
    {
        internal VersionedArtifactIdentity(int schemaVersion, string digestSha256)
        {
            if (schemaVersion != 1) throw new ProtocolException();
            SchemaVersion = schemaVersion;
            DigestSha256 = ProtocolValues.Digest(digestSha256);
        }

        internal int SchemaVersion { get; private set; }
        internal string DigestSha256 { get; private set; }
    }

    internal sealed class CountedArtifactIdentity
    {
        internal CountedArtifactIdentity(string path, string sha256, int entryCount)
        {
            if (entryCount != 8) throw new ProtocolException();
            Path = ProtocolValues.NonEmpty(path, 256);
            Sha256 = ProtocolValues.Digest(sha256);
            EntryCount = entryCount;
        }

        internal string Path { get; private set; }
        internal string Sha256 { get; private set; }
        internal int EntryCount { get; private set; }
    }

    internal sealed class ObserverArtifactIdentity
    {
        internal ObserverArtifactIdentity(
            string path,
            string sha256,
            int protocolVersion,
            ArtifactIdentity buildManifest,
            ArtifactIdentity protocol,
            string inputsDigestSha256)
        {
            if (!string.Equals(path, ProtocolV1.ObserverPath, StringComparison.Ordinal) ||
                protocolVersion != ProtocolV1.ProtocolVersion || buildManifest == null || protocol == null ||
                !string.Equals(buildManifest.Path, ProtocolV1.BuildManifestPath, StringComparison.Ordinal) ||
                !string.Equals(protocol.Path, ProtocolV1.ProtocolPath, StringComparison.Ordinal))
            {
                throw new ProtocolException();
            }
            Path = path;
            Sha256 = ProtocolValues.Digest(sha256);
            ProtocolVersion = protocolVersion;
            BuildManifest = buildManifest;
            Protocol = protocol;
            InputsDigestSha256 = ProtocolValues.Digest(inputsDigestSha256);
        }

        internal string Path { get; private set; }
        internal string Sha256 { get; private set; }
        internal int ProtocolVersion { get; private set; }
        internal ArtifactIdentity BuildManifest { get; private set; }
        internal ArtifactIdentity Protocol { get; private set; }
        internal string InputsDigestSha256 { get; private set; }

        internal bool SameAs(ObserverArtifactIdentity other)
        {
            return other != null && Path == other.Path && Sha256 == other.Sha256 && ProtocolVersion == other.ProtocolVersion &&
                BuildManifest.Path == other.BuildManifest.Path && BuildManifest.Sha256 == other.BuildManifest.Sha256 &&
                Protocol.Path == other.Protocol.Path && Protocol.Sha256 == other.Protocol.Sha256 &&
                InputsDigestSha256 == other.InputsDigestSha256;
        }
    }

    internal sealed class NpmIdentity
    {
        internal NpmIdentity(string integrity, string shasum)
        {
            Integrity = ProtocolValues.Integrity(integrity);
            Shasum = ProtocolValues.Sha1(shasum);
        }

        internal string Integrity { get; private set; }
        internal string Shasum { get; private set; }

        internal bool SameAs(NpmIdentity other)
        {
            return other != null && Integrity == other.Integrity && Shasum == other.Shasum;
        }
    }

    internal sealed class PublicBetaIdentity
    {
        internal PublicBetaIdentity(
            string version,
            string tag,
            string taggedCommit,
            string markerPath,
            string markerSha256,
            string pluginArtifactTreeDigestSha256,
            ObserverArtifactIdentity observerArtifact,
            NpmIdentity npm)
        {
            Version = ProtocolValues.Version(version);
            if (!string.Equals(tag, "v" + Version, StringComparison.Ordinal) ||
                !string.Equals(markerPath, ProtocolV1.MarkerPrefix + Version + ProtocolV1.MarkerSuffix, StringComparison.Ordinal) ||
                observerArtifact == null || npm == null)
            {
                throw new ProtocolException();
            }
            Tag = tag;
            TaggedCommit = ProtocolValues.Commit(taggedCommit);
            MarkerPath = markerPath;
            MarkerSha256 = ProtocolValues.Digest(markerSha256);
            PluginArtifactTreeDigestSha256 = ProtocolValues.Digest(pluginArtifactTreeDigestSha256);
            ObserverArtifact = observerArtifact;
            Npm = npm;
        }

        internal string Version { get; private set; }
        internal string Tag { get; private set; }
        internal string TaggedCommit { get; private set; }
        internal string MarkerPath { get; private set; }
        internal string MarkerSha256 { get; private set; }
        internal string PluginArtifactTreeDigestSha256 { get; private set; }
        internal ObserverArtifactIdentity ObserverArtifact { get; private set; }
        internal NpmIdentity Npm { get; private set; }

        internal bool SameAs(PublicBetaIdentity other)
        {
            return other != null && Version == other.Version && Tag == other.Tag && TaggedCommit == other.TaggedCommit &&
                MarkerPath == other.MarkerPath && MarkerSha256 == other.MarkerSha256 &&
                PluginArtifactTreeDigestSha256 == other.PluginArtifactTreeDigestSha256 &&
                ObserverArtifact.SameAs(other.ObserverArtifact) && Npm.SameAs(other.Npm);
        }
    }

    internal sealed class ReleaseCoreIdentity
    {
        internal ReleaseCoreIdentity(
            string runtimeFrozenCommit,
            VersionedArtifactIdentity canonicalRuntime,
            ArtifactIdentity windowsJobHelper,
            CountedArtifactIdentity capabilityIndex,
            ArtifactIdentity currentHostFreeze)
        {
            RuntimeFrozenCommit = ProtocolValues.Commit(runtimeFrozenCommit);
            if (canonicalRuntime == null || windowsJobHelper == null || capabilityIndex == null || currentHostFreeze == null ||
                windowsJobHelper.Path != ProtocolV1.WindowsJobHelperPath || capabilityIndex.Path != ProtocolV1.CapabilityIndexPath ||
                currentHostFreeze.Path != ProtocolV1.CurrentHostFreezePrefix + RuntimeFrozenCommit + ProtocolV1.CurrentHostFreezeSuffix)
            {
                throw new ProtocolException();
            }
            CanonicalRuntime = canonicalRuntime;
            WindowsJobHelper = windowsJobHelper;
            CapabilityIndex = capabilityIndex;
            CurrentHostFreeze = currentHostFreeze;
        }

        internal string RuntimeFrozenCommit { get; private set; }
        internal VersionedArtifactIdentity CanonicalRuntime { get; private set; }
        internal ArtifactIdentity WindowsJobHelper { get; private set; }
        internal CountedArtifactIdentity CapabilityIndex { get; private set; }
        internal ArtifactIdentity CurrentHostFreeze { get; private set; }
    }

    internal abstract class ObserverFrame
    {
        protected ObserverFrame(string type, string nonce, int sequence)
        {
            if (sequence < 0) throw new ProtocolException();
            Type = type;
            Nonce = ProtocolValues.Nonce(nonce);
            Sequence = sequence;
        }

        internal string Type { get; private set; }
        internal string Nonce { get; private set; }
        internal int Sequence { get; private set; }
    }

    internal sealed class HelloFrame : ObserverFrame
    {
        internal HelloFrame(string nonce, int sequence, string descriptorSha256, PublicBetaIdentity publicBeta, int mcpPid, string packageName, string version)
            : base(ProtocolV1.HelloType, nonce, sequence)
        {
            if (sequence != 0 || publicBeta == null || mcpPid <= 0 || packageName != ProtocolV1.PackageName || version != publicBeta.Version)
            {
                throw new ProtocolException();
            }
            DescriptorSha256 = ProtocolValues.Digest(descriptorSha256);
            PublicBeta = publicBeta;
            McpPid = mcpPid;
            PackageName = packageName;
            Version = version;
        }

        internal string DescriptorSha256 { get; private set; }
        internal PublicBetaIdentity PublicBeta { get; private set; }
        internal int McpPid { get; private set; }
        internal string PackageName { get; private set; }
        internal string Version { get; private set; }
    }

    internal abstract class RequestFrame : ObserverFrame
    {
        protected RequestFrame(string type, string nonce, int sequence, string requestIdType, string requestCorrelationSha256)
            : base(type, nonce, sequence)
        {
            RequestIdType = ProtocolValues.RequestIdType(requestIdType);
            RequestCorrelationSha256 = ProtocolValues.Digest(requestCorrelationSha256);
        }

        internal string RequestIdType { get; private set; }
        internal string RequestCorrelationSha256 { get; private set; }
    }

    internal sealed class RequestStartedFrame : RequestFrame
    {
        internal RequestStartedFrame(string nonce, int sequence, string requestIdType, string requestCorrelationSha256, string inputIdentitySha256, string completionMarkerId, string completionMarkerIdentitySha256, string descriptorSha256)
            : base(ProtocolV1.RequestStartedType, nonce, sequence, requestIdType, requestCorrelationSha256)
        {
            InputIdentitySha256 = ProtocolValues.Digest(inputIdentitySha256);
            CompletionMarkerId = ProtocolValues.MarkerId(completionMarkerId);
            CompletionMarkerIdentitySha256 = ProtocolValues.Digest(completionMarkerIdentitySha256);
            DescriptorSha256 = ProtocolValues.Digest(descriptorSha256);
        }

        internal string InputIdentitySha256 { get; private set; }
        internal string CompletionMarkerId { get; private set; }
        internal string CompletionMarkerIdentitySha256 { get; private set; }
        internal string DescriptorSha256 { get; private set; }
    }

    internal sealed class RequestAbortedFrame : RequestFrame
    {
        internal RequestAbortedFrame(string nonce, int sequence, string requestIdType, string requestCorrelationSha256)
            : base(ProtocolV1.RequestAbortedType, nonce, sequence, requestIdType, requestCorrelationSha256) { }
    }

    internal sealed class OwnedExitFrame : RequestFrame
    {
        internal OwnedExitFrame(string nonce, int sequence, string requestIdType, string requestCorrelationSha256, string completion, bool ownershipDrained)
            : base(ProtocolV1.OwnedExitType, nonce, sequence, requestIdType, requestCorrelationSha256)
        {
            if (completion != "cancelled" || !ownershipDrained) throw new ProtocolException();
            Completion = completion;
            OwnershipDrained = ownershipDrained;
        }
        internal string Completion { get; private set; }
        internal bool OwnershipDrained { get; private set; }
    }

    internal sealed class HandlerCancelledFrame : RequestFrame
    {
        internal HandlerCancelledFrame(string nonce, int sequence, string requestIdType, string requestCorrelationSha256)
            : base(ProtocolV1.HandlerCancelledType, nonce, sequence, requestIdType, requestCorrelationSha256) { }
    }

    internal sealed class InflightRemovedFrame : RequestFrame
    {
        internal InflightRemovedFrame(string nonce, int sequence, string requestIdType, string requestCorrelationSha256)
            : base(ProtocolV1.InflightRemovedType, nonce, sequence, requestIdType, requestCorrelationSha256) { }
    }

    internal static class ObserverFrameParser
    {
        internal static ObserverFrame Parse(StrictJsonObject frame)
        {
            if (frame == null) throw new ProtocolException();
            if (frame.RequireInt32("schemaVersion") != ProtocolV1.SchemaVersion || frame.RequireInt32("protocolVersion") != ProtocolV1.ProtocolVersion)
            {
                throw new ProtocolException();
            }
            var type = frame.RequireString("type");
            switch (type)
            {
                case ProtocolV1.HelloType: return ParseHello(frame);
                case ProtocolV1.RequestStartedType: return ParseStarted(frame);
                case ProtocolV1.RequestAbortedType: return ParseAborted(frame);
                case ProtocolV1.OwnedExitType: return ParseOwnedExit(frame);
                case ProtocolV1.HandlerCancelledType: return ParseHandlerCancelled(frame);
                case ProtocolV1.InflightRemovedType: return ParseInflightRemoved(frame);
                default: throw new ProtocolException();
            }
        }

        private static HelloFrame ParseHello(StrictJsonObject frame)
        {
            frame.RequireExactKeys(ProtocolV1.HelloKeys);
            var mcp = frame.RequireObject("mcp");
            mcp.RequireExactKeys(ProtocolV1.McpKeys);
            return new HelloFrame(frame.RequireString("nonce"), frame.RequireInt32("sequence"), frame.RequireString("descriptorSha256"), ParsePublicBeta(frame.RequireObject("publicBeta")), mcp.RequireInt32("pid"), mcp.RequireString("packageName"), mcp.RequireString("version"));
        }

        private static RequestStartedFrame ParseStarted(StrictJsonObject frame)
        {
            frame.RequireExactKeys(ProtocolV1.RequestStartedKeys);
            return new RequestStartedFrame(frame.RequireString("nonce"), frame.RequireInt32("sequence"), frame.RequireString("requestIdType"), frame.RequireString("requestCorrelationSha256"), frame.RequireString("inputIdentitySha256"), frame.RequireString("completionMarkerId"), frame.RequireString("completionMarkerIdentitySha256"), frame.RequireString("descriptorSha256"));
        }

        private static RequestAbortedFrame ParseAborted(StrictJsonObject frame)
        {
            frame.RequireExactKeys(ProtocolV1.RequestAbortedKeys);
            return new RequestAbortedFrame(frame.RequireString("nonce"), frame.RequireInt32("sequence"), frame.RequireString("requestIdType"), frame.RequireString("requestCorrelationSha256"));
        }

        private static OwnedExitFrame ParseOwnedExit(StrictJsonObject frame)
        {
            frame.RequireExactKeys(ProtocolV1.OwnedExitKeys);
            return new OwnedExitFrame(frame.RequireString("nonce"), frame.RequireInt32("sequence"), frame.RequireString("requestIdType"), frame.RequireString("requestCorrelationSha256"), frame.RequireString("completion"), frame.RequireBoolean("ownershipDrained"));
        }

        private static HandlerCancelledFrame ParseHandlerCancelled(StrictJsonObject frame)
        {
            frame.RequireExactKeys(ProtocolV1.HandlerCancelledKeys);
            return new HandlerCancelledFrame(frame.RequireString("nonce"), frame.RequireInt32("sequence"), frame.RequireString("requestIdType"), frame.RequireString("requestCorrelationSha256"));
        }

        private static InflightRemovedFrame ParseInflightRemoved(StrictJsonObject frame)
        {
            frame.RequireExactKeys(ProtocolV1.InflightRemovedKeys);
            return new InflightRemovedFrame(frame.RequireString("nonce"), frame.RequireInt32("sequence"), frame.RequireString("requestIdType"), frame.RequireString("requestCorrelationSha256"));
        }

        private static PublicBetaIdentity ParsePublicBeta(StrictJsonObject beta)
        {
            beta.RequireExactKeys(ProtocolV1.PublicBetaKeys);
            var observer = beta.RequireObject("observerArtifact");
            observer.RequireExactKeys(ProtocolV1.ObserverArtifactKeys);
            var npm = beta.RequireObject("npm");
            npm.RequireExactKeys(ProtocolV1.NpmKeys);
            return new PublicBetaIdentity(
                beta.RequireString("version"), beta.RequireString("tag"), beta.RequireString("taggedCommit"), beta.RequireString("markerPath"), beta.RequireString("markerSha256"), beta.RequireString("pluginArtifactTreeDigestSha256"),
                new ObserverArtifactIdentity(observer.RequireString("path"), observer.RequireString("sha256"), observer.RequireInt32("protocolVersion"), ParseArtifact(observer.RequireObject("buildManifest")), ParseArtifact(observer.RequireObject("protocol")), observer.RequireString("inputsDigestSha256")),
                new NpmIdentity(npm.RequireString("integrity"), npm.RequireString("shasum")));
        }

        private static ArtifactIdentity ParseArtifact(StrictJsonObject artifact)
        {
            artifact.RequireExactKeys(ProtocolV1.ArtifactIdentityKeys);
            return new ArtifactIdentity(artifact.RequireString("path"), artifact.RequireString("sha256"));
        }
    }

    internal static class HostAcceptanceHash
    {
        internal static string ComputeRequestBindingSha256(string sessionNonceSha256, string newChatGptIdentitySha256, string newAppServerIdentitySha256, string newKernelPeerMcpIdentitySha256, string requestCorrelationSha256, string completionMarkerIdentitySha256, string sessionDescriptorSha256)
        {
            return Sha256Utf8(JsonStringArray(new[] {
                "host-acceptance-request-binding-v1",
                ProtocolValues.Digest(sessionNonceSha256), ProtocolValues.Digest(newChatGptIdentitySha256),
                ProtocolValues.Digest(newAppServerIdentitySha256), ProtocolValues.Digest(newKernelPeerMcpIdentitySha256),
                ProtocolValues.Digest(requestCorrelationSha256), ProtocolValues.Digest(completionMarkerIdentitySha256),
                ProtocolValues.Digest(sessionDescriptorSha256)
            }));
        }

        internal static string ComputeEventSha256(string name, string at, string previousSha256, string outcome)
        {
            ProtocolValues.NonEmpty(name, 64);
            ProtocolValues.NonEmpty(at, 64);
            ProtocolValues.Digest(previousSha256);
            ProtocolValues.NonEmpty(outcome, 256);
            return Sha256Utf8(JsonStringArray(new[] { "host-acceptance-event-v1", name, at, previousSha256, outcome }));
        }

        internal static string Sha256Utf8(string value)
        {
            using (var sha256 = SHA256.Create())
            {
                var hash = sha256.ComputeHash(new UTF8Encoding(false, true).GetBytes(value));
                var builder = new StringBuilder(hash.Length * 2);
                foreach (var item in hash)
                {
                    builder.Append(item.ToString("x2", CultureInfo.InvariantCulture));
                }
                return builder.ToString();
            }
        }

        private static string JsonStringArray(IEnumerable<string> values)
        {
            var builder = new StringBuilder();
            builder.Append('[');
            var first = true;
            foreach (var value in values)
            {
                if (!first) builder.Append(',');
                first = false;
                JsonEncoding.AppendQuoted(builder, value);
            }
            builder.Append(']');
            return builder.ToString();
        }
    }

    internal static class JsonEncoding
    {
        internal static void AppendQuoted(StringBuilder builder, string value)
        {
            builder.Append('"');
            foreach (var character in value)
            {
                switch (character)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\b': builder.Append("\\b"); break;
                    case '\f': builder.Append("\\f"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (character < 0x20)
                        {
                            builder.Append("\\u");
                            builder.Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            builder.Append(character);
                        }
                        break;
                }
            }
            builder.Append('"');
        }
    }
}
