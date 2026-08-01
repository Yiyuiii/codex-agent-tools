using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Text;

namespace CodexAgentTools.WindowsJobHelper
{
    internal enum ControlDirection
    {
        NodeToHelper,
        HelperToNode
    }

    internal enum ControlMessageType
    {
        LaunchConfig = ProtocolV1.MessageLaunchConfig,
        Ready = ProtocolV1.MessageReady,
        Terminate = ProtocolV1.MessageTerminate,
        Error = ProtocolV1.MessageError,
        Exit = ProtocolV1.MessageExit
    }

    internal enum ControlReason
    {
        NoneOrRootExit = ProtocolV1.ReasonNoneOrRootExit,
        Cancelled = ProtocolV1.ReasonCancelled,
        TimedOut = ProtocolV1.ReasonTimedOut,
        SessionShutdown = ProtocolV1.ReasonSessionShutdown,
        ProtocolError = ProtocolV1.ReasonProtocolError
    }

    internal enum ControlStage
    {
        None = 0,
        ProtocolInvalid = ProtocolV1.StageProtocolInvalid,
        CancelledBeforeReady = ProtocolV1.StageCancelledBeforeReady,
        JobCreateFailed = ProtocolV1.StageJobCreateFailed,
        JobConfigFailed = ProtocolV1.StageJobConfigFailed,
        StdioDuplicateFailed = ProtocolV1.StageStdioDuplicateFailed,
        AttributeListInitFailed = ProtocolV1.StageAttributeListInitFailed,
        HandleListAttributeFailed = ProtocolV1.StageHandleListAttributeFailed,
        JobListAttributeFailed = ProtocolV1.StageJobListAttributeFailed,
        CommandLineInvalid = ProtocolV1.StageCommandLineInvalid,
        CreateFailed = ProtocolV1.StageCreateFailed,
        ResumeFailed = ProtocolV1.StageResumeFailed,
        TerminateJobFailed = ProtocolV1.StageTerminateJobFailed,
        QueryJobFailed = ProtocolV1.StageQueryJobFailed,
        ControlChannelFailed = ProtocolV1.StageControlChannelFailed,
        HelperInternal = ProtocolV1.StageHelperInternal,
        WaitFailed = ProtocolV1.StageWaitFailed
    }

    internal sealed class ProtocolViolationException : Exception
    {
        internal ProtocolViolationException()
            : base("windows_native_protocol_invalid")
        {
        }
    }

    internal sealed class ControlFrame
    {
        internal ControlMessageType Type { get; private set; }
        internal string Executable { get; private set; }
        internal string CurrentDirectory { get; private set; }
        internal IList<string> Arguments { get; private set; }
        internal ControlReason Reason { get; private set; }
        internal ControlStage Stage { get; private set; }
        internal uint? Win32Code { get; private set; }
        internal uint RootExitCode { get; private set; }
        internal bool JobActiveProcessesZero { get; private set; }

        private ControlFrame(ControlMessageType type)
        {
            Type = type;
            Arguments = new ReadOnlyCollection<string>(new string[0]);
            Reason = ControlReason.NoneOrRootExit;
            Stage = ControlStage.None;
        }

        internal static ControlFrame LaunchConfig(string executable, string cwd, IList<string> arguments)
        {
            var frame = new ControlFrame(ControlMessageType.LaunchConfig);
            frame.Executable = executable;
            frame.CurrentDirectory = cwd;
            frame.Arguments = new ReadOnlyCollection<string>(new List<string>(arguments));
            return frame;
        }

        internal static ControlFrame Ready()
        {
            return new ControlFrame(ControlMessageType.Ready);
        }

        internal static ControlFrame Terminate(ControlReason reason)
        {
            var frame = new ControlFrame(ControlMessageType.Terminate);
            frame.Reason = reason;
            return frame;
        }

        internal static ControlFrame Error(ControlStage stage, ControlReason reason, uint? win32Code)
        {
            var frame = new ControlFrame(ControlMessageType.Error);
            frame.Stage = stage;
            frame.Reason = reason;
            frame.Win32Code = win32Code;
            return frame;
        }

        internal static ControlFrame Exit(uint rootExitCode, ControlReason reason)
        {
            var frame = new ControlFrame(ControlMessageType.Exit);
            frame.RootExitCode = rootExitCode;
            frame.Reason = reason;
            frame.JobActiveProcessesZero = true;
            return frame;
        }
    }

    internal static class ControlProtocol
    {
        private static readonly byte[] Magic = Encoding.ASCII.GetBytes("CAJ1");
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        internal static byte[] EncodeLaunchConfig(string executable, string cwd, IEnumerable<string> arguments)
        {
            try
            {
                RequireAbsolutePath(executable);
                RequireAbsolutePath(cwd);
                if (arguments == null)
                {
                    throw new ProtocolViolationException();
                }

                var encodedArguments = new List<byte[]>();
                foreach (string argument in arguments)
                {
                    if (encodedArguments.Count == ProtocolV1.MaxArgCount)
                    {
                        throw new ProtocolViolationException();
                    }
                    encodedArguments.Add(EncodeString(argument));
                }

                byte[] encodedExecutable = EncodeString(executable);
                byte[] encodedCwd = EncodeString(cwd);
                long payloadLength = encodedExecutable.Length + encodedCwd.Length + 4L;
                foreach (byte[] argument in encodedArguments)
                {
                    payloadLength += argument.Length;
                }
                RequirePayloadLength(payloadLength);

                byte[] payload = new byte[(int)payloadLength];
                int offset = 0;
                Copy(encodedExecutable, payload, ref offset);
                Copy(encodedCwd, payload, ref offset);
                WriteUInt32(payload, offset, (uint)encodedArguments.Count);
                offset += 4;
                foreach (byte[] argument in encodedArguments)
                {
                    Copy(argument, payload, ref offset);
                }
                return EncodeFrame(ControlMessageType.LaunchConfig, payload);
            }
            catch (ProtocolViolationException)
            {
                throw;
            }
            catch
            {
                throw new ProtocolViolationException();
            }
        }

        internal static byte[] EncodeReady()
        {
            return EncodeFrame(ControlMessageType.Ready, new byte[0]);
        }

        internal static byte[] EncodeTerminate(ControlReason reason)
        {
            if (!IsReason(reason) || reason == ControlReason.NoneOrRootExit)
            {
                throw new ProtocolViolationException();
            }
            return EncodeFrame(ControlMessageType.Terminate, new[] { (byte)reason });
        }

        internal static byte[] EncodeError(ControlStage stage, ControlReason reason, uint? win32Code)
        {
            if (!IsStage(stage) || stage == ControlStage.None || !IsReason(reason))
            {
                throw new ProtocolViolationException();
            }
            byte[] payload = new byte[8];
            WriteUInt16(payload, 0, (ushort)stage);
            payload[2] = (byte)reason;
            if (win32Code.HasValue)
            {
                payload[3] = 1;
                WriteUInt32(payload, 4, win32Code.Value);
            }
            return EncodeFrame(ControlMessageType.Error, payload);
        }

        internal static byte[] EncodeExit(uint rootExitCode, ControlReason reason)
        {
            if (!IsReason(reason) || reason == ControlReason.ProtocolError)
            {
                throw new ProtocolViolationException();
            }
            byte[] payload = new byte[8];
            WriteUInt32(payload, 0, rootExitCode);
            payload[4] = (byte)reason;
            payload[5] = 1;
            return EncodeFrame(ControlMessageType.Exit, payload);
        }

        internal static ControlFrame DecodeSingle(byte[] frame, ControlDirection direction)
        {
            try
            {
                if (frame == null)
                {
                    throw new ProtocolViolationException();
                }
                var decoder = new Decoder(direction);
                IList<ControlFrame> frames = decoder.Push(frame, 0, frame.Length);
                decoder.Finish();
                if (frames.Count != 1)
                {
                    throw new ProtocolViolationException();
                }
                return frames[0];
            }
            catch (ProtocolViolationException)
            {
                throw;
            }
            catch
            {
                throw new ProtocolViolationException();
            }
        }

        internal sealed class Decoder
        {
            private const int InitialBufferBytes = 4096;
            private const int MaximumFrameBytes =
                ProtocolV1.HeaderBytes + ProtocolV1.MaxPayloadBytes;
            private readonly ControlDirection direction;
            private byte[] storage = new byte[0];
            private int start;
            private int end;
            private bool configSeen;
            private bool readySeen;
            private bool sealedDirection;
            private bool finished;
            private bool failed;

            internal int BufferCapacity { get { return storage.Length; } }
            internal long CopiedByteCount { get; private set; }

            internal Decoder(ControlDirection direction)
            {
                this.direction = direction;
            }

            internal IList<ControlFrame> Push(byte[] bytes, int offset, int count)
            {
                if (failed || finished)
                {
                    throw new ProtocolViolationException();
                }
                try
                {
                    if (bytes == null || offset < 0 || count < 0 || offset > bytes.Length - count)
                    {
                        throw new ProtocolViolationException();
                    }
                    if (sealedDirection && count != 0)
                    {
                        throw new ProtocolViolationException();
                    }

                    var result = new List<ControlFrame>();
                    int incomingOffset = offset;
                    int incomingRemaining = count;
                    while (incomingRemaining > 0)
                    {
                        EnsureWritableCapacity();
                        int copyLength = Math.Min(storage.Length - end, incomingRemaining);
                        CopyBytes(bytes, incomingOffset, storage, end, copyLength);
                        end += copyLength;
                        incomingOffset += copyLength;
                        incomingRemaining -= copyLength;
                        DecodeAvailable(result);
                    }
                    if (sealedDirection && end != start)
                    {
                        throw new ProtocolViolationException();
                    }
                    return new ReadOnlyCollection<ControlFrame>(result);
                }
                catch (ProtocolViolationException)
                {
                    failed = true;
                    ClearStorage();
                    throw;
                }
                catch
                {
                    failed = true;
                    ClearStorage();
                    throw new ProtocolViolationException();
                }
            }

            internal void Finish()
            {
                if (failed || finished || end != start)
                {
                    failed = true;
                    ClearStorage();
                    throw new ProtocolViolationException();
                }
                finished = true;
            }

            private void DecodeAvailable(List<ControlFrame> result)
            {
                while (end - start >= ProtocolV1.HeaderBytes)
                {
                    ValidateHeader(storage, start);
                    uint payloadLength = ReadUInt32(storage, start + 8);
                    if (payloadLength > ProtocolV1.MaxPayloadBytes)
                    {
                        throw new ProtocolViolationException();
                    }
                    int frameLength = checked(ProtocolV1.HeaderBytes + (int)payloadLength);
                    if (end - start < frameLength)
                    {
                        EnsureFrameCapacity(frameLength);
                        return;
                    }

                    var type = (ControlMessageType)ReadUInt16(storage, start + 6);
                    byte[] payload = new byte[payloadLength];
                    CopyBytes(
                        storage,
                        start + ProtocolV1.HeaderBytes,
                        payload,
                        0,
                        payload.Length);
                    ControlFrame frame = DecodePayload(type, payload);
                    ValidateSequence(frame);
                    result.Add(frame);
                    start += frameLength;
                }
                if (start == end)
                {
                    start = 0;
                    end = 0;
                }
            }

            private void EnsureWritableCapacity()
            {
                if (end < storage.Length)
                {
                    return;
                }
                int unreadLength = end - start;
                if (start > 0)
                {
                    CopyBytes(storage, start, storage, 0, unreadLength);
                    start = 0;
                    end = unreadLength;
                    if (end < storage.Length)
                    {
                        return;
                    }
                }
                if (storage.Length >= MaximumFrameBytes)
                {
                    throw new ProtocolViolationException();
                }
                int nextCapacity = storage.Length == 0
                    ? InitialBufferBytes
                    : Math.Min(MaximumFrameBytes, checked(storage.Length * 2));
                ReplaceStorage(nextCapacity);
            }

            private void EnsureFrameCapacity(int frameLength)
            {
                if (frameLength < ProtocolV1.HeaderBytes || frameLength > MaximumFrameBytes)
                {
                    throw new ProtocolViolationException();
                }
                if (storage.Length >= frameLength)
                {
                    return;
                }
                int nextCapacity = Math.Max(storage.Length, InitialBufferBytes);
                while (nextCapacity < frameLength)
                {
                    nextCapacity = Math.Min(MaximumFrameBytes, checked(nextCapacity * 2));
                }
                ReplaceStorage(nextCapacity);
            }

            private void ReplaceStorage(int capacity)
            {
                byte[] replacement = new byte[capacity];
                int unreadLength = end - start;
                CopyBytes(storage, start, replacement, 0, unreadLength);
                storage = replacement;
                start = 0;
                end = unreadLength;
            }

            private void CopyBytes(
                byte[] source,
                int sourceOffset,
                byte[] destination,
                int destinationOffset,
                int count)
            {
                if (count == 0)
                {
                    return;
                }
                Buffer.BlockCopy(source, sourceOffset, destination, destinationOffset, count);
                CopiedByteCount = checked(CopiedByteCount + count);
            }

            private void ClearStorage()
            {
                storage = new byte[0];
                start = 0;
                end = 0;
            }

            private void ValidateSequence(ControlFrame frame)
            {
                if (direction == ControlDirection.NodeToHelper)
                {
                    if (frame.Type == ControlMessageType.LaunchConfig && !configSeen && !sealedDirection)
                    {
                        configSeen = true;
                        return;
                    }
                    if (frame.Type == ControlMessageType.Terminate && configSeen && !sealedDirection)
                    {
                        sealedDirection = true;
                        return;
                    }
                    throw new ProtocolViolationException();
                }

                if (frame.Type == ControlMessageType.Ready && !readySeen && !sealedDirection)
                {
                    readySeen = true;
                    return;
                }
                if (frame.Type == ControlMessageType.Error && !sealedDirection)
                {
                    sealedDirection = true;
                    return;
                }
                if (frame.Type == ControlMessageType.Exit && readySeen && !sealedDirection)
                {
                    sealedDirection = true;
                    return;
                }
                throw new ProtocolViolationException();
            }
        }

        private static ControlFrame DecodePayload(ControlMessageType type, byte[] payload)
        {
            var reader = new PayloadReader(payload);
            if (type == ControlMessageType.LaunchConfig)
            {
                string executable = reader.ReadString();
                string cwd = reader.ReadString();
                RequireAbsolutePath(executable);
                RequireAbsolutePath(cwd);
                uint count = reader.ReadUInt32();
                if (count > ProtocolV1.MaxArgCount)
                {
                    throw new ProtocolViolationException();
                }
                var arguments = new List<string>();
                for (uint index = 0; index < count; index++)
                {
                    arguments.Add(reader.ReadString());
                }
                reader.RequireComplete();
                return ControlFrame.LaunchConfig(executable, cwd, arguments);
            }
            if (type == ControlMessageType.Ready)
            {
                reader.RequireComplete();
                return ControlFrame.Ready();
            }
            if (type == ControlMessageType.Terminate)
            {
                ControlReason reason = (ControlReason)reader.ReadByte();
                reader.RequireComplete();
                if (!IsReason(reason) || reason == ControlReason.NoneOrRootExit)
                {
                    throw new ProtocolViolationException();
                }
                return ControlFrame.Terminate(reason);
            }
            if (type == ControlMessageType.Error)
            {
                ControlStage stage = (ControlStage)reader.ReadUInt16();
                ControlReason reason = (ControlReason)reader.ReadByte();
                byte hasCode = reader.ReadByte();
                uint code = reader.ReadUInt32();
                reader.RequireComplete();
                if (!IsStage(stage) || stage == ControlStage.None || !IsReason(reason) ||
                    (hasCode != 0 && hasCode != 1) || (hasCode == 0 && code != 0))
                {
                    throw new ProtocolViolationException();
                }
                return ControlFrame.Error(stage, reason, hasCode == 1 ? (uint?)code : null);
            }
            if (type == ControlMessageType.Exit)
            {
                uint rootExitCode = reader.ReadUInt32();
                ControlReason reason = (ControlReason)reader.ReadByte();
                byte zero = reader.ReadByte();
                ushort reserved = reader.ReadUInt16();
                reader.RequireComplete();
                if (!IsReason(reason) || reason == ControlReason.ProtocolError || zero != 1 || reserved != 0)
                {
                    throw new ProtocolViolationException();
                }
                return ControlFrame.Exit(rootExitCode, reason);
            }
            throw new ProtocolViolationException();
        }

        private static byte[] EncodeString(string value)
        {
            if (value == null || value.IndexOf('\0') >= 0)
            {
                throw new ProtocolViolationException();
            }
            byte[] encoded = StrictUtf8.GetBytes(value);
            if (encoded.Length > ProtocolV1.MaxStringBytes || StrictUtf8.GetString(encoded) != value)
            {
                throw new ProtocolViolationException();
            }
            byte[] result = new byte[4 + encoded.Length];
            WriteUInt32(result, 0, (uint)encoded.Length);
            Buffer.BlockCopy(encoded, 0, result, 4, encoded.Length);
            return result;
        }

        private static byte[] EncodeFrame(ControlMessageType type, byte[] payload)
        {
            if (!IsMessageType(type))
            {
                throw new ProtocolViolationException();
            }
            RequirePayloadLength(payload.Length);
            byte[] result = new byte[ProtocolV1.HeaderBytes + payload.Length];
            Buffer.BlockCopy(Magic, 0, result, 0, Magic.Length);
            WriteUInt16(result, 4, ProtocolV1.Version);
            WriteUInt16(result, 6, (ushort)type);
            WriteUInt32(result, 8, (uint)payload.Length);
            Buffer.BlockCopy(payload, 0, result, ProtocolV1.HeaderBytes, payload.Length);
            return result;
        }

        private static void ValidateHeader(byte[] bytes, int offset)
        {
            for (int index = 0; index < Magic.Length; index++)
            {
                if (bytes[offset + index] != Magic[index])
                {
                    throw new ProtocolViolationException();
                }
            }
            if (ReadUInt16(bytes, offset + 4) != ProtocolV1.Version ||
                !IsMessageType((ControlMessageType)ReadUInt16(bytes, offset + 6)))
            {
                throw new ProtocolViolationException();
            }
        }

        private static void RequireAbsolutePath(string value)
        {
            if (value == null || value.Length < 3 || value.IndexOf('\0') >= 0 || value[0] == '\uFEFF')
            {
                throw new ProtocolViolationException();
            }
            if (!WindowsPath.IsFullyQualified(value))
            {
                throw new ProtocolViolationException();
            }
        }

        private static bool IsMessageType(ControlMessageType value)
        {
            return value == ControlMessageType.LaunchConfig || value == ControlMessageType.Ready ||
                value == ControlMessageType.Terminate || value == ControlMessageType.Error ||
                value == ControlMessageType.Exit;
        }

        private static bool IsReason(ControlReason value)
        {
            return value >= ControlReason.NoneOrRootExit && value <= ControlReason.ProtocolError;
        }

        private static bool IsStage(ControlStage value)
        {
            return value >= ControlStage.ProtocolInvalid && value <= ControlStage.WaitFailed;
        }

        private static void RequirePayloadLength(long length)
        {
            if (length < 0 || length > ProtocolV1.MaxPayloadBytes || length > Int32.MaxValue)
            {
                throw new ProtocolViolationException();
            }
        }

        private static void Copy(byte[] source, byte[] destination, ref int offset)
        {
            Buffer.BlockCopy(source, 0, destination, offset, source.Length);
            offset += source.Length;
        }

        private static ushort ReadUInt16(byte[] bytes, int offset)
        {
            return (ushort)(bytes[offset] | bytes[offset + 1] << 8);
        }

        private static uint ReadUInt32(byte[] bytes, int offset)
        {
            return (uint)bytes[offset] |
                (uint)bytes[offset + 1] << 8 |
                (uint)bytes[offset + 2] << 16 |
                (uint)bytes[offset + 3] << 24;
        }

        private static void WriteUInt16(byte[] bytes, int offset, ushort value)
        {
            bytes[offset] = (byte)(value & 0xff);
            bytes[offset + 1] = (byte)(value >> 8 & 0xff);
        }

        private static void WriteUInt32(byte[] bytes, int offset, uint value)
        {
            bytes[offset] = (byte)(value & 0xff);
            bytes[offset + 1] = (byte)(value >> 8 & 0xff);
            bytes[offset + 2] = (byte)(value >> 16 & 0xff);
            bytes[offset + 3] = (byte)(value >> 24 & 0xff);
        }

        private sealed class PayloadReader
        {
            private readonly byte[] payload;
            private int offset;

            internal PayloadReader(byte[] payload)
            {
                this.payload = payload;
            }

            internal byte ReadByte()
            {
                Require(1);
                return payload[offset++];
            }

            internal ushort ReadUInt16()
            {
                Require(2);
                ushort value = ControlProtocol.ReadUInt16(payload, offset);
                offset += 2;
                return value;
            }

            internal uint ReadUInt32()
            {
                Require(4);
                uint value = ControlProtocol.ReadUInt32(payload, offset);
                offset += 4;
                return value;
            }

            internal string ReadString()
            {
                uint length = ReadUInt32();
                if (length > ProtocolV1.MaxStringBytes || length > Int32.MaxValue)
                {
                    throw new ProtocolViolationException();
                }
                Require((int)length);
                string value = StrictUtf8.GetString(payload, offset, (int)length);
                offset += (int)length;
                if (value.IndexOf('\0') >= 0)
                {
                    throw new ProtocolViolationException();
                }
                return value;
            }

            internal void RequireComplete()
            {
                if (offset != payload.Length)
                {
                    throw new ProtocolViolationException();
                }
            }

            private void Require(int count)
            {
                if (count < 0 || offset > payload.Length - count)
                {
                    throw new ProtocolViolationException();
                }
            }
        }
    }
}
