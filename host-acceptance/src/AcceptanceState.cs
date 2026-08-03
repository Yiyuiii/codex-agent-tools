using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace CodexAgentTools.HostAcceptance
{
    internal enum AcceptanceStage
    {
        AwaitOldHello,
        AwaitOldExit,
        AwaitNewHello,
        AwaitRequestStarted,
        AwaitRequestAborted,
        AwaitOwnedExit,
        AwaitHandlerCancelled,
        AwaitInflightRemoved,
        AwaitCompletionMarker,
        Completed,
        Failed
    }

    internal sealed class ProcessIdentity
    {
        internal ProcessIdentity(string identitySha256, DateTime createdAt)
        {
            IdentitySha256 = ProtocolValues.Digest(identitySha256);
            CreatedAt = NormalizeTimestamp(createdAt);
        }

        internal string IdentitySha256 { get; private set; }
        internal DateTime CreatedAt { get; private set; }

        internal static DateTime NormalizeTimestamp(DateTime value)
        {
            if (value.Kind != DateTimeKind.Utc)
            {
                throw new ProtocolException();
            }
            return new DateTime(value.Ticks - (value.Ticks % TimeSpan.TicksPerMillisecond), DateTimeKind.Utc);
        }
    }

    internal sealed class ExitedProcessIdentity
    {
        internal ExitedProcessIdentity(ProcessIdentity process, DateTime exitedAt)
        {
            if (process == null) throw new ProtocolException();
            Process = process;
            ExitedAt = ProcessIdentity.NormalizeTimestamp(exitedAt);
            if (Process.CreatedAt >= ExitedAt) throw new ProtocolException();
        }

        internal ProcessIdentity Process { get; private set; }
        internal DateTime ExitedAt { get; private set; }
    }

    internal sealed class HostChain
    {
        internal HostChain(ProcessIdentity chatGpt, ProcessIdentity appServer, ProcessIdentity kernelPeerMcp)
        {
            if (chatGpt == null || appServer == null || kernelPeerMcp == null) throw new ProtocolException();
            ChatGpt = chatGpt;
            AppServer = appServer;
            KernelPeerMcp = kernelPeerMcp;
        }

        internal ProcessIdentity ChatGpt { get; private set; }
        internal ProcessIdentity AppServer { get; private set; }
        internal ProcessIdentity KernelPeerMcp { get; private set; }
    }

    internal sealed class ExitedHostChain
    {
        internal ExitedHostChain(ExitedProcessIdentity chatGpt, ExitedProcessIdentity appServer, ExitedProcessIdentity kernelPeerMcp)
        {
            ChatGpt = chatGpt;
            AppServer = appServer;
            KernelPeerMcp = kernelPeerMcp;
        }

        internal ExitedProcessIdentity ChatGpt { get; private set; }
        internal ExitedProcessIdentity AppServer { get; private set; }
        internal ExitedProcessIdentity KernelPeerMcp { get; private set; }
    }

    internal sealed class HostAcceptanceBinding
    {
        internal HostAcceptanceBinding(string nonce, string descriptorSha256, PublicBetaIdentity publicBeta, ReleaseCoreIdentity core, string inputIdentitySha256, string completionMarkerId, string completionMarkerIdentitySha256)
        {
            if (publicBeta == null || core == null) throw new ProtocolException();
            Nonce = ProtocolValues.Nonce(nonce);
            DescriptorSha256 = ProtocolValues.Digest(descriptorSha256);
            PublicBeta = publicBeta;
            Core = core;
            InputIdentitySha256 = ProtocolValues.Digest(inputIdentitySha256);
            CompletionMarkerId = ProtocolValues.MarkerId(completionMarkerId);
            CompletionMarkerIdentitySha256 = ProtocolValues.Digest(completionMarkerIdentitySha256);
        }

        internal string Nonce { get; private set; }
        internal string DescriptorSha256 { get; private set; }
        internal PublicBetaIdentity PublicBeta { get; private set; }
        internal ReleaseCoreIdentity Core { get; private set; }
        internal string InputIdentitySha256 { get; private set; }
        internal string CompletionMarkerId { get; private set; }
        internal string CompletionMarkerIdentitySha256 { get; private set; }
    }

    internal sealed class AcceptanceEventRecord
    {
        internal AcceptanceEventRecord(string name, DateTime at, string previousSha256, string outcome)
        {
            Name = name;
            At = HostAcceptanceStateMachine.FormatTimestamp(at);
            PreviousSha256 = ProtocolValues.Digest(previousSha256);
            EventSha256 = HostAcceptanceHash.ComputeEventSha256(name, At, PreviousSha256, outcome);
        }

        internal string Name { get; private set; }
        internal string At { get; private set; }
        internal string PreviousSha256 { get; private set; }
        internal string EventSha256 { get; private set; }
    }

    internal sealed class HostAcceptanceStateMachine
    {
        private readonly HostAcceptanceBinding binding;
        private HostChain oldHost;
        private ExitedHostChain oldExited;
        private HostChain newHost;
        private string requestIdType;
        private string correlationSha256;
        private string bindingSha256;
        private DateTime lastObservedAt;
        private AcceptanceEventRecord started;
        private AcceptanceEventRecord sdkAbort;
        private AcceptanceEventRecord ownedProcessExit;
        private AcceptanceEventRecord ownershipDrained;
        private AcceptanceEventRecord handlerCancelled;
        private AcceptanceEventRecord inFlightRemoved;
        private AcceptanceEventRecord completionMarkerChecked;

        internal HostAcceptanceStateMachine(HostAcceptanceBinding binding)
        {
            if (binding == null) throw new ArgumentNullException("binding");
            this.binding = binding;
            Stage = AcceptanceStage.AwaitOldHello;
        }

        internal AcceptanceStage Stage { get; private set; }

        internal void ObserveOldHello(HelloFrame hello, HostChain chain)
        {
            TryTransition(delegate
            {
                RequireStage(AcceptanceStage.AwaitOldHello);
                ValidateHello(hello);
                ValidateCreationOrder(chain);
                oldHost = chain;
                Stage = AcceptanceStage.AwaitOldExit;
            });
        }

        internal void ObserveOldExited(DateTime chatGptExitedAt, DateTime appServerExitedAt, DateTime kernelPeerMcpExitedAt)
        {
            TryTransition(delegate
            {
                RequireStage(AcceptanceStage.AwaitOldExit);
                oldExited = new ExitedHostChain(
                    new ExitedProcessIdentity(oldHost.ChatGpt, chatGptExitedAt),
                    new ExitedProcessIdentity(oldHost.AppServer, appServerExitedAt),
                    new ExitedProcessIdentity(oldHost.KernelPeerMcp, kernelPeerMcpExitedAt));
                Stage = AcceptanceStage.AwaitNewHello;
            });
        }

        internal void ObserveNewHello(HelloFrame hello, HostChain chain)
        {
            TryTransition(delegate
            {
                RequireStage(AcceptanceStage.AwaitNewHello);
                ValidateHello(hello);
                ValidateCreationOrder(chain);
                var oldLatestExit = Max(oldExited.ChatGpt.ExitedAt, oldExited.AppServer.ExitedAt, oldExited.KernelPeerMcp.ExitedAt);
                if (oldLatestExit >= chain.ChatGpt.CreatedAt) throw new ProtocolException();
                RequireUniqueIdentities(oldHost, chain);
                newHost = chain;
                Stage = AcceptanceStage.AwaitRequestStarted;
            });
        }

        internal void Observe(ObserverFrame frame, DateTime observedAt)
        {
            TryTransition(delegate
            {
                if (frame == null || frame.Nonce != binding.Nonce) throw new ProtocolException();
                var at = ProcessIdentity.NormalizeTimestamp(observedAt);
                if (Stage != AcceptanceStage.AwaitRequestStarted && at < lastObservedAt) throw new ProtocolException();

                switch (Stage)
                {
                    case AcceptanceStage.AwaitRequestStarted:
                        ObserveStarted(frame as RequestStartedFrame, at);
                        break;
                    case AcceptanceStage.AwaitRequestAborted:
                        RequireRequestFrame(frame as RequestAbortedFrame, 2);
                        sdkAbort = NewEvent("sdk-abort", at, started.EventSha256, "true");
                        Stage = AcceptanceStage.AwaitOwnedExit;
                        break;
                    case AcceptanceStage.AwaitOwnedExit:
                        RequireRequestFrame(frame as OwnedExitFrame, 3);
                        ownedProcessExit = NewEvent("owned-process-exit", at, sdkAbort.EventSha256, "cancelled");
                        ownershipDrained = NewEvent("ownership-drained", at, ownedProcessExit.EventSha256, "true");
                        Stage = AcceptanceStage.AwaitHandlerCancelled;
                        break;
                    case AcceptanceStage.AwaitHandlerCancelled:
                        RequireRequestFrame(frame as HandlerCancelledFrame, 4);
                        handlerCancelled = NewEvent("handler-cancelled", at, ownershipDrained.EventSha256, "cancelled");
                        Stage = AcceptanceStage.AwaitInflightRemoved;
                        break;
                    case AcceptanceStage.AwaitInflightRemoved:
                        RequireRequestFrame(frame as InflightRemovedFrame, 5);
                        inFlightRemoved = NewEvent("in-flight-removed", at, handlerCancelled.EventSha256, "true");
                        Stage = AcceptanceStage.AwaitCompletionMarker;
                        break;
                    default:
                        throw new ProtocolException();
                }
                lastObservedAt = at;
            });
        }

        internal void ObserveCompletionMarker(bool exists, DateTime observedAt)
        {
            TryTransition(delegate
            {
                RequireStage(AcceptanceStage.AwaitCompletionMarker);
                var at = ProcessIdentity.NormalizeTimestamp(observedAt);
                if (exists || at < lastObservedAt) throw new ProtocolException();
                completionMarkerChecked = NewEvent(
                    "completion-marker-checked", at, inFlightRemoved.EventSha256,
                    "absent:" + binding.CompletionMarkerIdentitySha256);
                lastObservedAt = at;
                Stage = AcceptanceStage.Completed;
            });
        }

        internal byte[] BuildReceiptUtf8()
        {
            if (Stage != AcceptanceStage.Completed)
            {
                throw new InvalidOperationException("Host acceptance is incomplete.");
            }
            return new UTF8Encoding(false, true).GetBytes(BuildReceiptJson());
        }

        private void ObserveStarted(RequestStartedFrame frame, DateTime at)
        {
            if (frame == null || frame.Sequence != 1 || frame.InputIdentitySha256 != binding.InputIdentitySha256 ||
                frame.CompletionMarkerId != binding.CompletionMarkerId || frame.CompletionMarkerIdentitySha256 != binding.CompletionMarkerIdentitySha256 ||
                frame.DescriptorSha256 != binding.DescriptorSha256 || at < newHost.KernelPeerMcp.CreatedAt)
            {
                throw new ProtocolException();
            }
            requestIdType = frame.RequestIdType;
            correlationSha256 = frame.RequestCorrelationSha256;
            var nonceSha256 = HostAcceptanceHash.Sha256Utf8(binding.Nonce);
            bindingSha256 = HostAcceptanceHash.ComputeRequestBindingSha256(
                nonceSha256, newHost.ChatGpt.IdentitySha256, newHost.AppServer.IdentitySha256,
                newHost.KernelPeerMcp.IdentitySha256, correlationSha256,
                binding.CompletionMarkerIdentitySha256, binding.DescriptorSha256);
            started = NewEvent(
                "request-started", at, bindingSha256,
                "bound:" + binding.CompletionMarkerIdentitySha256 + ":" + binding.DescriptorSha256);
            Stage = AcceptanceStage.AwaitRequestAborted;
        }

        private void RequireRequestFrame(RequestFrame frame, int sequence)
        {
            if (frame == null || frame.Sequence != sequence || frame.RequestIdType != requestIdType || frame.RequestCorrelationSha256 != correlationSha256)
            {
                throw new ProtocolException();
            }
        }

        private AcceptanceEventRecord NewEvent(string name, DateTime at, string previous, string outcome)
        {
            return new AcceptanceEventRecord(name, at, previous, outcome);
        }

        private void ValidateHello(HelloFrame hello)
        {
            if (hello == null || hello.Nonce != binding.Nonce || hello.Sequence != 0 || hello.DescriptorSha256 != binding.DescriptorSha256 || !hello.PublicBeta.SameAs(binding.PublicBeta))
            {
                throw new ProtocolException();
            }
        }

        private static void ValidateCreationOrder(HostChain chain)
        {
            if (chain == null || chain.ChatGpt.CreatedAt > chain.AppServer.CreatedAt || chain.AppServer.CreatedAt > chain.KernelPeerMcp.CreatedAt)
            {
                throw new ProtocolException();
            }
        }

        private static void RequireUniqueIdentities(HostChain oldChain, HostChain newChain)
        {
            var identities = new HashSet<string>(StringComparer.Ordinal) {
                oldChain.ChatGpt.IdentitySha256, oldChain.AppServer.IdentitySha256, oldChain.KernelPeerMcp.IdentitySha256,
                newChain.ChatGpt.IdentitySha256, newChain.AppServer.IdentitySha256, newChain.KernelPeerMcp.IdentitySha256
            };
            if (identities.Count != 6) throw new ProtocolException();
        }

        private void RequireStage(AcceptanceStage expected)
        {
            if (Stage != expected) throw new ProtocolException();
        }

        private void TryTransition(Action action)
        {
            if (Stage == AcceptanceStage.Failed) throw new ProtocolException();
            try
            {
                action();
            }
            catch (ProtocolException)
            {
                Stage = AcceptanceStage.Failed;
                throw;
            }
        }

        private string BuildReceiptJson()
        {
            var builder = new StringBuilder(4096);
            builder.Append('{');
            PropertyNumber(builder, "schemaVersion", 1, true);
            PropertyString(builder, "kind", "host-acceptance", false);
            builder.Append(",\"beta\":"); AppendReceiptBeta(builder, binding.PublicBeta);
            PropertyString(builder, "pluginArtifactTreeDigestSha256", binding.PublicBeta.PluginArtifactTreeDigestSha256, false);
            builder.Append(",\"core\":"); AppendCore(builder, binding.Core);
            builder.Append(",\"observerArtifact\":"); AppendObserverArtifact(builder, binding.PublicBeta.ObserverArtifact);
            builder.Append(",\"session\":{");
            PropertyString(builder, "nonce", binding.Nonce, true);
            PropertyString(builder, "nonceSha256", HostAcceptanceHash.Sha256Utf8(binding.Nonce), false);
            PropertyString(builder, "descriptorSha256", binding.DescriptorSha256, false);
            builder.Append('}');
            builder.Append(",\"oldHost\":"); AppendExitedHost(builder, oldExited);
            builder.Append(",\"newHost\":"); AppendHost(builder, newHost);
            builder.Append(",\"request\":{");
            PropertyString(builder, "correlationSha256", correlationSha256, true);
            PropertyString(builder, "completionMarkerIdentitySha256", binding.CompletionMarkerIdentitySha256, false);
            PropertyString(builder, "bindingSha256", bindingSha256, false);
            builder.Append(",\"started\":"); AppendEvent(builder, started, new[] {
                new KeyValuePair<string, object>("completionMarkerIdentitySha256", binding.CompletionMarkerIdentitySha256),
                new KeyValuePair<string, object>("sessionDescriptorSha256", binding.DescriptorSha256)
            });
            builder.Append(",\"sdkAbort\":"); AppendEvent(builder, sdkAbort, null);
            builder.Append(",\"ownedProcessExit\":"); AppendEvent(builder, ownedProcessExit, new[] { new KeyValuePair<string, object>("completion", "cancelled") });
            builder.Append(",\"ownershipDrained\":"); AppendEvent(builder, ownershipDrained, null);
            builder.Append(",\"handlerCancelled\":"); AppendEvent(builder, handlerCancelled, new[] { new KeyValuePair<string, object>("outcome", "cancelled") });
            builder.Append(",\"inFlightRemoved\":"); AppendEvent(builder, inFlightRemoved, null);
            builder.Append(",\"completionMarkerChecked\":"); AppendEvent(builder, completionMarkerChecked, new[] {
                new KeyValuePair<string, object>("absent", true),
                new KeyValuePair<string, object>("completionMarkerIdentitySha256", binding.CompletionMarkerIdentitySha256)
            });
            builder.Append('}');
            PropertyString(builder, "result", "passed", false);
            builder.Append('}');
            return builder.ToString();
        }

        private static void AppendReceiptBeta(StringBuilder builder, PublicBetaIdentity beta)
        {
            builder.Append('{');
            PropertyString(builder, "version", beta.Version, true);
            PropertyString(builder, "tag", beta.Tag, false);
            PropertyString(builder, "taggedCommit", beta.TaggedCommit, false);
            builder.Append(",\"npm\":{");
            PropertyString(builder, "integrity", beta.Npm.Integrity, true);
            PropertyString(builder, "shasum", beta.Npm.Shasum, false);
            builder.Append("}}");
        }

        private static void AppendCore(StringBuilder builder, ReleaseCoreIdentity core)
        {
            builder.Append('{');
            PropertyString(builder, "runtimeFrozenCommit", core.RuntimeFrozenCommit, true);
            builder.Append(",\"canonicalRuntime\":{");
            PropertyNumber(builder, "schemaVersion", core.CanonicalRuntime.SchemaVersion, true);
            PropertyString(builder, "digestSha256", core.CanonicalRuntime.DigestSha256, false);
            builder.Append('}');
            builder.Append(",\"windowsJobHelper\":"); AppendArtifact(builder, core.WindowsJobHelper);
            builder.Append(",\"capabilityIndex\":{");
            PropertyString(builder, "path", core.CapabilityIndex.Path, true);
            PropertyString(builder, "sha256", core.CapabilityIndex.Sha256, false);
            PropertyNumber(builder, "entryCount", core.CapabilityIndex.EntryCount, false);
            builder.Append('}');
            builder.Append(",\"currentHostFreeze\":"); AppendArtifact(builder, core.CurrentHostFreeze);
            builder.Append('}');
        }

        private static void AppendObserverArtifact(StringBuilder builder, ObserverArtifactIdentity observer)
        {
            builder.Append('{');
            PropertyString(builder, "path", observer.Path, true);
            PropertyString(builder, "sha256", observer.Sha256, false);
            PropertyNumber(builder, "protocolVersion", observer.ProtocolVersion, false);
            builder.Append(",\"buildManifest\":"); AppendArtifact(builder, observer.BuildManifest);
            builder.Append(",\"protocol\":"); AppendArtifact(builder, observer.Protocol);
            PropertyString(builder, "inputsDigestSha256", observer.InputsDigestSha256, false);
            builder.Append('}');
        }

        private static void AppendArtifact(StringBuilder builder, ArtifactIdentity artifact)
        {
            builder.Append('{');
            PropertyString(builder, "path", artifact.Path, true);
            PropertyString(builder, "sha256", artifact.Sha256, false);
            builder.Append('}');
        }

        private static void AppendExitedHost(StringBuilder builder, ExitedHostChain chain)
        {
            builder.Append('{');
            builder.Append("\"chatGpt\":"); AppendExitedProcess(builder, chain.ChatGpt);
            builder.Append(",\"appServer\":"); AppendExitedProcess(builder, chain.AppServer);
            builder.Append(",\"kernelPeerMcp\":"); AppendExitedProcess(builder, chain.KernelPeerMcp);
            builder.Append('}');
        }

        private static void AppendHost(StringBuilder builder, HostChain chain)
        {
            builder.Append('{');
            builder.Append("\"chatGpt\":"); AppendProcess(builder, chain.ChatGpt);
            builder.Append(",\"appServer\":"); AppendProcess(builder, chain.AppServer);
            builder.Append(",\"kernelPeerMcp\":"); AppendProcess(builder, chain.KernelPeerMcp);
            builder.Append('}');
        }

        private static void AppendProcess(StringBuilder builder, ProcessIdentity process)
        {
            builder.Append('{');
            PropertyString(builder, "identitySha256", process.IdentitySha256, true);
            PropertyString(builder, "createdAt", FormatTimestamp(process.CreatedAt), false);
            builder.Append('}');
        }

        private static void AppendExitedProcess(StringBuilder builder, ExitedProcessIdentity process)
        {
            builder.Append('{');
            PropertyString(builder, "identitySha256", process.Process.IdentitySha256, true);
            PropertyString(builder, "createdAt", FormatTimestamp(process.Process.CreatedAt), false);
            PropertyString(builder, "exitedAt", FormatTimestamp(process.ExitedAt), false);
            builder.Append('}');
        }

        private static void AppendEvent(StringBuilder builder, AcceptanceEventRecord record, IEnumerable<KeyValuePair<string, object>> extras)
        {
            builder.Append('{');
            PropertyBoolean(builder, "observed", true, true);
            PropertyString(builder, "at", record.At, false);
            PropertyString(builder, "previousSha256", record.PreviousSha256, false);
            PropertyString(builder, "eventSha256", record.EventSha256, false);
            if (extras != null)
            {
                foreach (var extra in extras)
                {
                    var boolean = extra.Value as bool?;
                    if (boolean.HasValue) PropertyBoolean(builder, extra.Key, boolean.Value, false);
                    else PropertyString(builder, extra.Key, (string)extra.Value, false);
                }
            }
            builder.Append('}');
        }

        private static void PropertyString(StringBuilder builder, string name, string value, bool first)
        {
            if (!first) builder.Append(',');
            JsonEncoding.AppendQuoted(builder, name);
            builder.Append(':');
            JsonEncoding.AppendQuoted(builder, value);
        }

        private static void PropertyNumber(StringBuilder builder, string name, int value, bool first)
        {
            if (!first) builder.Append(',');
            JsonEncoding.AppendQuoted(builder, name);
            builder.Append(':');
            builder.Append(value.ToString(CultureInfo.InvariantCulture));
        }

        private static void PropertyBoolean(StringBuilder builder, string name, bool value, bool first)
        {
            if (!first) builder.Append(',');
            JsonEncoding.AppendQuoted(builder, name);
            builder.Append(value ? ":true" : ":false");
        }

        internal static string FormatTimestamp(DateTime value)
        {
            return ProcessIdentity.NormalizeTimestamp(value).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
        }

        private static DateTime Max(DateTime first, DateTime second, DateTime third)
        {
            var result = first > second ? first : second;
            return result > third ? result : third;
        }
    }
}
