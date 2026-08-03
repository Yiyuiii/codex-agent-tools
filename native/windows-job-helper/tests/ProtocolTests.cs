using System;
using System.Collections.Generic;
using System.Text;

namespace CodexAgentTools.WindowsJobHelper.Tests
{
    internal static class ProtocolTests
    {
        internal static int Run()
        {
            var count = 0;
            var config = ControlProtocol.EncodeLaunchConfig(
                @"C:\native\agent.exe",
                @"C:\work",
                new[] { "", "alpha", "雪" });
            var decoder = new ControlProtocol.Decoder(ControlDirection.NodeToHelper);
            TestAssert.Equal(0, decoder.Push(config, 0, 5).Count);
            var frames = decoder.Push(config, 5, config.Length - 5);
            TestAssert.Equal(1, frames.Count);
            TestAssert.Equal(ControlMessageType.LaunchConfig, frames[0].Type);
            TestAssert.Equal(@"C:\native\agent.exe", frames[0].Executable);
            TestAssert.Equal(@"C:\work", frames[0].CurrentDirectory);
            TestAssert.Equal(3, frames[0].Arguments.Count);
            TestAssert.Equal("", frames[0].Arguments[0]);
            TestAssert.Equal("雪", frames[0].Arguments[2]);
            count++;

            // U+FEFF is ordinary data in argv. Only path fields reject it.
            var bomArgument = ControlProtocol.DecodeSingle(
                ControlProtocol.EncodeLaunchConfig(
                    @"C:\native\agent.exe",
                    @"C:\work",
                    new[] { "\uFEFFargument" }),
                ControlDirection.NodeToHelper);
            TestAssert.Equal("\uFEFFargument", bomArgument.Arguments[0]);
            TestAssert.Throws<ProtocolViolationException>(() =>
                ControlProtocol.EncodeLaunchConfig(
                    "\uFEFFC:\\native\\agent.exe",
                    @"C:\work",
                    new string[0]));
            TestAssert.Throws<ProtocolViolationException>(() =>
                ControlProtocol.EncodeLaunchConfig(
                    @"C:\native\agent.exe",
                    "\uFEFFC:\\work",
                    new string[0]));
            count++;

            // Keep these fully-qualified path vectors byte-for-byte aligned
            // with the TypeScript protocol suite.
            foreach (var acceptedPath in new[] {
                @"C:\root\target.exe",
                "c:/root/target.exe",
                @"\\server\share\target.exe",
                "//server/share/target.exe"
            })
            {
                ControlProtocol.EncodeLaunchConfig(acceptedPath, acceptedPath, new string[0]);
            }
            foreach (var rejectedPath in new[] {
                "target.exe",
                @"Å:\target.exe",
                @"\root\target.exe",
                "/root/target.exe",
                @"\\server",
                @"\\server\",
                @"\\server\\target.exe",
                "///server/share/target.exe"
            })
            {
                TestAssert.Throws<ProtocolViolationException>(() =>
                    ControlProtocol.EncodeLaunchConfig(rejectedPath, @"C:\work", new string[0]));
                TestAssert.Throws<ProtocolViolationException>(() =>
                    ControlProtocol.EncodeLaunchConfig(@"C:\target.exe", rejectedPath, new string[0]));
            }
            count++;

            var bytewise = new ControlProtocol.Decoder(ControlDirection.NodeToHelper);
            IList<ControlFrame> bytewiseFrames = null;
            for (var index = 0; index < config.Length; index++)
            {
                var emitted = bytewise.Push(config, index, 1);
                if (emitted.Count != 0)
                {
                    bytewiseFrames = emitted;
                }
            }
            TestAssert.Equal(1, bytewiseFrames.Count);
            TestAssert.Equal(ControlMessageType.LaunchConfig, bytewiseFrames[0].Type);
            bytewise.Finish();
            count++;

            var merged = Concat(
                ControlProtocol.EncodeLaunchConfig(@"C:\x.exe", @"C:\w", new string[0]),
                ControlProtocol.EncodeTerminate(ControlReason.Cancelled));
            var ordered = new ControlProtocol.Decoder(ControlDirection.NodeToHelper);
            var mergedFrames = ordered.Push(merged, 0, merged.Length);
            TestAssert.Equal(2, mergedFrames.Count);
            TestAssert.Equal(ControlMessageType.LaunchConfig, mergedFrames[0].Type);
            TestAssert.Equal(ControlMessageType.Terminate, mergedFrames[1].Type);
            TestAssert.Equal(ControlReason.Cancelled, mergedFrames[1].Reason);
            count++;

            TestAssert.Throws<ProtocolViolationException>(() =>
                ControlProtocol.DecodeSingle(new byte[] {
                    0x43, 0x41, 0x4a, 0x31, 0x01, 0x00, 0x01, 0x00,
                    0x11, 0x00, 0x00, 0x00,
                    0x01, 0x00, 0x00, 0x00, 0xff,
                    0x04, 0x00, 0x00, 0x00, 0x43, 0x3a, 0x5c, 0x77,
                    0x00, 0x00, 0x00, 0x00
                }, ControlDirection.NodeToHelper));
            count++;

            TestAssert.Throws<ProtocolViolationException>(() =>
                ControlProtocol.EncodeLaunchConfig(@"C:\x.exe", @"C:\w", new[] { "bad\0arg" }));
            count++;

            var secret = "secret-protocol-value";
            try
            {
                ControlProtocol.EncodeLaunchConfig(secret, @"C:\w", new string[0]);
                throw new InvalidOperationException("expected_protocol_failure");
            }
            catch (ProtocolViolationException error)
            {
                TestAssert.Equal("windows_native_protocol_invalid", error.Message);
                TestAssert.True(!error.ToString().Contains(secret));
            }
            count++;

            var duplicate = new ControlProtocol.Decoder(ControlDirection.NodeToHelper);
            var first = ControlProtocol.EncodeLaunchConfig(@"C:\x.exe", @"C:\w", new string[0]);
            duplicate.Push(first, 0, first.Length);
            TestAssert.Throws<ProtocolViolationException>(() => duplicate.Push(first, 0, first.Length));
            count++;

            var terminateBeforeConfig = ControlProtocol.EncodeTerminate(ControlReason.TimedOut);
            TestAssert.Throws<ProtocolViolationException>(() =>
                ControlProtocol.DecodeSingle(terminateBeforeConfig, ControlDirection.NodeToHelper));
            var duplicateTerminate = new ControlProtocol.Decoder(ControlDirection.NodeToHelper);
            duplicateTerminate.Push(first, 0, first.Length);
            duplicateTerminate.Push(terminateBeforeConfig, 0, terminateBeforeConfig.Length);
            IList<ControlFrame> repeatedTerminate =
                duplicateTerminate.Push(
                    terminateBeforeConfig,
                    0,
                    terminateBeforeConfig.Length);
            TestAssert.Equal(1, repeatedTerminate.Count);
            TestAssert.Equal(ControlReason.TimedOut, repeatedTerminate[0].Reason);
            count++;

            var helper = new ControlProtocol.Decoder(ControlDirection.HelperToNode);
            var terminal = ControlProtocol.EncodeError(ControlStage.ProtocolInvalid, ControlReason.ProtocolError, null);
            helper.Push(terminal, 0, terminal.Length);
            TestAssert.Throws<ProtocolViolationException>(() =>
                helper.Push(ControlProtocol.EncodeReady(), 0, ProtocolV1.HeaderBytes));
            count++;

            var duplicateReady = new ControlProtocol.Decoder(ControlDirection.HelperToNode);
            var ready = ControlProtocol.EncodeReady();
            duplicateReady.Push(ready, 0, ready.Length);
            TestAssert.Throws<ProtocolViolationException>(() =>
                duplicateReady.Push(ready, 0, ready.Length));
            count++;

            var exitBeforeReady = new ControlProtocol.Decoder(ControlDirection.HelperToNode);
            var exit = ControlProtocol.EncodeExit(0, ControlReason.NoneOrRootExit);
            TestAssert.Throws<ProtocolViolationException>(() =>
                exitBeforeReady.Push(exit, 0, exit.Length));
            count++;

            var decodedError = ControlProtocol.DecodeSingle(
                ControlProtocol.EncodeError(
                    ControlStage.CreateFailed,
                    ControlReason.Cancelled,
                    5),
                ControlDirection.HelperToNode);
            TestAssert.Equal(ControlMessageType.Error, decodedError.Type);
            TestAssert.Equal(ControlStage.CreateFailed, decodedError.Stage);
            TestAssert.Equal(ControlReason.Cancelled, decodedError.Reason);
            TestAssert.Equal((uint?)5, decodedError.Win32Code);
            count++;

            var reserved = (byte[])exit.Clone();
            reserved[reserved.Length - 1] = 1;
            TestAssert.Throws<ProtocolViolationException>(() =>
                ControlProtocol.DecodeSingle(reserved, ControlDirection.HelperToNode));
            count++;

            var incomplete = new ControlProtocol.Decoder(ControlDirection.NodeToHelper);
            incomplete.Push(first, 0, first.Length - 1);
            TestAssert.Throws<ProtocolViolationException>(() => incomplete.Finish());
            count++;

            var goldenLaunch = Hex(@"
                43 41 4a 31 01 00 01 00 1e 00 00 00
                08 00 00 00 43 3a 5c 78 2e 65 78 65
                04 00 00 00 43 3a 5c 77
                01 00 00 00 02 00 00 00 6f 6b");
            var goldenReady = Hex("43 41 4a 31 01 00 02 00 00 00 00 00");
            var goldenTerminate = Hex("43 41 4a 31 01 00 03 00 01 00 00 00 02");
            var goldenError = Hex(
                "43 41 4a 31 01 00 04 00 08 00 00 00 0a 00 01 01 05 00 00 00");
            var goldenExit = Hex(
                "43 41 4a 31 01 00 05 00 08 00 00 00 07 00 00 00 02 01 00 00");
            AssertBytes(
                goldenLaunch,
                ControlProtocol.EncodeLaunchConfig(@"C:\x.exe", @"C:\w", new[] { "ok" }));
            AssertBytes(goldenReady, ControlProtocol.EncodeReady());
            AssertBytes(goldenTerminate, ControlProtocol.EncodeTerminate(ControlReason.TimedOut));
            AssertBytes(
                goldenError,
                ControlProtocol.EncodeError(ControlStage.CreateFailed, ControlReason.Cancelled, 5));
            AssertBytes(goldenExit, ControlProtocol.EncodeExit(7, ControlReason.TimedOut));
            TestAssert.Equal(
                @"C:\x.exe",
                ControlProtocol.DecodeSingle(goldenLaunch, ControlDirection.NodeToHelper).Executable);
            TestAssert.Equal(
                ControlMessageType.Ready,
                ControlProtocol.DecodeSingle(goldenReady, ControlDirection.HelperToNode).Type);
            var goldenNodeDecoder = new ControlProtocol.Decoder(ControlDirection.NodeToHelper);
            goldenNodeDecoder.Push(goldenLaunch, 0, goldenLaunch.Length);
            TestAssert.Equal(
                ControlReason.TimedOut,
                goldenNodeDecoder.Push(goldenTerminate, 0, goldenTerminate.Length)[0].Reason);
            TestAssert.Equal(
                (uint?)5,
                ControlProtocol.DecodeSingle(goldenError, ControlDirection.HelperToNode).Win32Code);
            var goldenHelperDecoder = new ControlProtocol.Decoder(ControlDirection.HelperToNode);
            goldenHelperDecoder.Push(goldenReady, 0, goldenReady.Length);
            TestAssert.Equal(
                (uint)7,
                goldenHelperDecoder.Push(goldenExit, 0, goldenExit.Length)[0].RootExitCode);
            count++;

            // A maximum incomplete frame arrives in hundreds of deterministic
            // fragments. Diagnostics count only actual buffer copies, proving
            // geometric bounded growth instead of repeated tail recopy.
            var maximumFrameBytes = ProtocolV1.HeaderBytes + ProtocolV1.MaxPayloadBytes;
            var maximumIncomplete = new byte[maximumFrameBytes - 1];
            Buffer.BlockCopy(
                Hex("43 41 4a 31 01 00 01 00 00 00 10 00"),
                0,
                maximumIncomplete,
                0,
                ProtocolV1.HeaderBytes);
            var bounded = new ControlProtocol.Decoder(ControlDirection.NodeToHelper);
            const int chunkBytes = 2048;
            for (var offset = 0; offset < maximumIncomplete.Length; offset += chunkBytes)
            {
                TestAssert.Equal(
                    0,
                    bounded.Push(
                        maximumIncomplete,
                        offset,
                        Math.Min(chunkBytes, maximumIncomplete.Length - offset)).Count);
            }
            TestAssert.True(bounded.BufferCapacity <= maximumFrameBytes);
            TestAssert.True(bounded.CopiedByteCount <= (long)maximumIncomplete.Length * 4);
            TestAssert.Throws<ProtocolViolationException>(() =>
                bounded.Push(new byte[] { 0 }, 0, 1));
            count++;

            return count;
        }

        private static byte[] Concat(byte[] first, byte[] second)
        {
            var result = new byte[first.Length + second.Length];
            Buffer.BlockCopy(first, 0, result, 0, first.Length);
            Buffer.BlockCopy(second, 0, result, first.Length, second.Length);
            return result;
        }

        private static void AssertBytes(byte[] expected, byte[] actual)
        {
            TestAssert.Equal(expected.Length, actual.Length);
            for (var index = 0; index < expected.Length; index++)
            {
                TestAssert.Equal(expected[index], actual[index]);
            }
        }

        private static byte[] Hex(string value)
        {
            var compact = value.Replace(" ", "").Replace("\r", "").Replace("\n", "");
            var result = new byte[compact.Length / 2];
            for (var index = 0; index < result.Length; index++)
            {
                result[index] = Convert.ToByte(compact.Substring(index * 2, 2), 16);
            }
            return result;
        }
    }
}
