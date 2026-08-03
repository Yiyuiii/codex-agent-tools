using System;
using System.Collections.Generic;

namespace CodexAgentTools.HostAcceptance.Tests
{
    internal static class StateMachineTests
    {
        internal static IEnumerable<Action> All()
        {
            yield return CompletesOnlyTheExactPerRequestSequence;
            yield return RejectsSequenceGapsAndMismatchedCorrelation;
            yield return RejectsInvalidHostTimelineAndReusedIdentity;
            yield return RejectsPresentCompletionMarker;
            yield return CannotEmitBeforeCompletion;
        }

        internal static HostAcceptanceStateMachine CompletedMachine()
        {
            var machine = NewMachine();
            ApplyHostTransition(machine);
            ApplyRequest(machine);
            machine.ObserveCompletionMarker(false, At(17));
            return machine;
        }

        private static HostAcceptanceStateMachine NewMachine()
        {
            return new HostAcceptanceStateMachine(FixtureBinding());
        }

        private static void CompletesOnlyTheExactPerRequestSequence()
        {
            var machine = CompletedMachine();
            TestAssert.Equal(AcceptanceStage.Completed, machine.Stage, "The exact sequence must complete.");
            TestAssert.True(machine.BuildReceiptUtf8().Length > 0, "A completed sequence must emit a receipt.");
        }

        private static void RejectsSequenceGapsAndMismatchedCorrelation()
        {
            var sequenceGap = NewMachine();
            ApplyHostTransition(sequenceGap);
            TestAssert.Throws<ProtocolException>(
                () => sequenceGap.Observe(new RequestStartedFrame(Nonce, 2, "string", HashReceiptTests.Digest('d'), HashReceiptTests.Digest('8'), MarkerId, HashReceiptTests.Digest('9'), HashReceiptTests.Digest('7')), At(10)),
                "The event sequence must begin at one."
            );

            var mismatch = NewMachine();
            ApplyHostTransition(mismatch);
            mismatch.Observe(RequestStarted(), At(10));
            TestAssert.Throws<ProtocolException>(
                () => mismatch.Observe(new RequestAbortedFrame(Nonce, 2, "string", HashReceiptTests.Digest('e')), At(11)),
                "All events must remain bound to one request."
            );
        }

        private static void RejectsInvalidHostTimelineAndReusedIdentity()
        {
            var invalid = NewMachine();
            TestAssert.Throws<ProtocolException>(
                () => invalid.ObserveOldHello(Hello(), new HostChain(
                    Process('1', 1), Process('2', 3), Process('3', 2))),
                "Host creation order must be validated."
            );

            var reused = NewMachine();
            reused.ObserveOldHello(Hello(), new HostChain(Process('1', 1), Process('2', 2), Process('3', 3)));
            reused.ObserveOldExited(At(4), At(5), At(6));
            TestAssert.Throws<ProtocolException>(
                () => reused.ObserveNewHello(Hello(), new HostChain(Process('1', 7), Process('5', 8), Process('6', 9))),
                "Every old and new process identity must be unique."
            );
        }

        private static void RejectsPresentCompletionMarker()
        {
            var machine = NewMachine();
            ApplyHostTransition(machine);
            ApplyRequest(machine);
            TestAssert.Throws<ProtocolException>(
                () => machine.ObserveCompletionMarker(true, At(17)),
                "A present completion marker must fail closed."
            );
        }

        private static void CannotEmitBeforeCompletion()
        {
            var machine = NewMachine();
            TestAssert.Throws<InvalidOperationException>(
                () => machine.BuildReceiptUtf8(),
                "An incomplete machine must never emit a receipt."
            );
        }

        private static void ApplyHostTransition(HostAcceptanceStateMachine machine)
        {
            machine.ObserveOldHello(Hello(), new HostChain(Process('1', 1), Process('2', 2), Process('3', 3)));
            machine.ObserveOldExited(At(4), At(5), At(6));
            machine.ObserveNewHello(Hello(), new HostChain(Process('4', 7), Process('5', 8), Process('6', 9)));
        }

        private static void ApplyRequest(HostAcceptanceStateMachine machine)
        {
            machine.Observe(RequestStarted(), At(10));
            machine.Observe(new RequestAbortedFrame(Nonce, 2, "string", HashReceiptTests.Digest('d')), At(11));
            machine.Observe(new OwnedExitFrame(Nonce, 3, "string", HashReceiptTests.Digest('d'), "cancelled", true), At(12));
            machine.Observe(new HandlerCancelledFrame(Nonce, 4, "string", HashReceiptTests.Digest('d')), At(14));
            machine.Observe(new InflightRemovedFrame(Nonce, 5, "string", HashReceiptTests.Digest('d')), At(16));
        }

        internal static RequestStartedFrame RequestStarted()
        {
            return new RequestStartedFrame(
                Nonce, 1, "string", HashReceiptTests.Digest('d'), HashReceiptTests.Digest('8'),
                MarkerId, HashReceiptTests.Digest('9'), HashReceiptTests.Digest('7'));
        }

        private static HelloFrame Hello()
        {
            return new HelloFrame(Nonce, 0, HashReceiptTests.Digest('7'), FixtureBinding().PublicBeta, 42, "codex-agent-tools", "0.2.0-beta.1");
        }

        internal static HostAcceptanceBinding FixtureBinding()
        {
            var observer = new ObserverArtifactIdentity(
                ProtocolV1.ObserverPath,
                HashReceiptTests.Digest('a'), ProtocolV1.ProtocolVersion,
                new ArtifactIdentity(ProtocolV1.BuildManifestPath, HashReceiptTests.Digest('b')),
                new ArtifactIdentity(ProtocolV1.ProtocolPath, HashReceiptTests.Digest('c')),
                HashReceiptTests.Digest('e'));
            var beta = new PublicBetaIdentity(
                "0.2.0-beta.1", "v0.2.0-beta.1", HashReceiptTests.Commit('f'),
                ".release-validation/v0.2.0-beta.1.json", HashReceiptTests.Digest('a'), HashReceiptTests.Digest('b'),
                observer, new NpmIdentity("sha512-" + new string('A', 86) + "==", HashReceiptTests.Commit('c')));
            var runtimeCommit = HashReceiptTests.Commit('d');
            var core = new ReleaseCoreIdentity(
                runtimeCommit,
                new VersionedArtifactIdentity(1, HashReceiptTests.Digest('e')),
                new ArtifactIdentity(ProtocolV1.WindowsJobHelperPath, HashReceiptTests.Digest('f')),
                new CountedArtifactIdentity(ProtocolV1.CapabilityIndexPath, HashReceiptTests.Digest('1'), 8),
                new ArtifactIdentity(ProtocolV1.CurrentHostFreezePrefix + runtimeCommit + ProtocolV1.CurrentHostFreezeSuffix, HashReceiptTests.Digest('2')));
            return new HostAcceptanceBinding(
                Nonce, HashReceiptTests.Digest('7'), beta, core,
                HashReceiptTests.Digest('8'), MarkerId, HashReceiptTests.Digest('9'));
        }

        internal static ProcessIdentity Process(char digest, int millisecond)
        {
            return new ProcessIdentity(HashReceiptTests.Digest(digest), At(millisecond));
        }

        internal static DateTime At(int millisecond)
        {
            return new DateTime(2026, 8, 2, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(millisecond);
        }

        internal const string Nonce = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
        internal const string MarkerId = "completion_marker_01";
    }
}
