using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace CodexAgentTools.WindowsJobHelper
{
    internal static class Fd3Preflight
    {
        private const uint DuplicateSameAccess = 0x00000002;
        private const int ErrorIoPending = 997;
        private const uint WaitTimeout = 258;
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private static SafeFileHandle AutonomousControl;
        private static PendingIo AutonomousRead;

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeOverlapped
        {
            internal IntPtr Internal;
            internal IntPtr InternalHigh;
            internal uint Offset;
            internal uint OffsetHigh;
            internal IntPtr EventHandle;
        }

        private sealed class PendingIo
        {
            internal IntPtr Handle;
            internal IntPtr Buffer;
            internal IntPtr Overlapped;
            internal IntPtr EventHandle;
            internal bool WasPending;

            internal void Release()
            {
                if (Overlapped != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(Overlapped);
                    Overlapped = IntPtr.Zero;
                }
                if (Buffer != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(Buffer);
                    Buffer = IntPtr.Zero;
                }
                if (EventHandle != IntPtr.Zero)
                {
                    CloseHandle(EventHandle);
                    EventHandle = IntPtr.Zero;
                }
            }
        }

        [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern IntPtr _get_osfhandle(int fd);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DuplicateHandle(
            IntPtr sourceProcess,
            IntPtr sourceHandle,
            IntPtr targetProcess,
            out IntPtr targetHandle,
            uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
            uint options);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateEventW(
            IntPtr eventAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool manualReset,
            [MarshalAs(UnmanagedType.Bool)] bool initialState,
            string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ReadFile(
            IntPtr file,
            IntPtr buffer,
            uint bytesToRead,
            IntPtr bytesRead,
            IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WriteFile(
            IntPtr file,
            IntPtr buffer,
            uint bytesToWrite,
            IntPtr bytesWritten,
            IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetOverlappedResult(
            IntPtr file,
            IntPtr overlapped,
            out uint bytesTransferred,
            [MarshalAs(UnmanagedType.Bool)] bool wait);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FlushFileBuffers(IntPtr file);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        private sealed class ProbeConfig
        {
            internal readonly string Mode;
            internal readonly uint Nonce;

            internal ProbeConfig(string mode, uint nonce)
            {
                Mode = mode;
                Nonce = nonce;
            }
        }

        private static int Main(string[] args)
        {
            if (args.Length != 1 || !String.Equals(args[0], ProtocolV1.ControlMode, StringComparison.Ordinal))
            {
                return 64;
            }

            IntPtr fd3 = _get_osfhandle(3);
            if (fd3 == new IntPtr(-1) || fd3 == IntPtr.Zero)
            {
                return 65;
            }

            IntPtr process = GetCurrentProcess();
            IntPtr controlHandle;
            if (!DuplicateHandle(process, fd3, process, out controlHandle, 0, false, DuplicateSameAccess))
            {
                return 66;
            }

            SafeFileHandle safeControl = new SafeFileHandle(controlHandle, true);
            bool controlOwnedByPendingRead = false;
            try
            {
                ProbeConfig config;
                try
                {
                    config = ReadConfig(controlHandle);
                }
                catch
                {
                    return 67;
                }

                try
                {
                    int terminalReason = ProtocolV1.ReasonNoneOrRootExit;
                    WriteFrame(controlHandle, ProtocolV1.MessageReady, new byte[0]);

                    if (String.Equals(config.Mode, "explicit", StringComparison.Ordinal))
                    {
                        try
                        {
                            terminalReason = ReadTerminate(controlHandle);
                        }
                        catch
                        {
                            return 68;
                        }
                    }
                    else if (String.Equals(config.Mode, "autonomous", StringComparison.Ordinal))
                    {
                        PendingIo pendingRead;
                        try
                        {
                            pendingRead = StartRead(controlHandle, 1);
                        }
                        catch
                        {
                            return 68;
                        }

                        // Retain the operation before inspecting completion. Even
                        // an unexpected wait failure must not free an OVERLAPPED or
                        // buffer that the kernel may still own.
                        AutonomousRead = pendingRead;
                        AutonomousControl = safeControl;
                        controlOwnedByPendingRead = true;
                        uint waitResult = WaitForSingleObject(pendingRead.EventHandle, 0);
                        if (!pendingRead.WasPending || waitResult != WaitTimeout)
                        {
                            return 68;
                        }

                        // A zero-time wait that times out is the barrier: the native
                        // overlapped fd3 read is pending before EXIT is written.
                        // These static roots retain the handle and unmanaged I/O
                        // state until process exit; the terminal path never joins it.
                    }
                    else
                    {
                        return 69;
                    }

                    byte[] terminal = new byte[8];
                    WriteUInt32(terminal, 0, config.Nonce);
                    terminal[4] = (byte)terminalReason;
                    terminal[5] = 1;
                    WriteFrame(controlHandle, ProtocolV1.MessageExit, terminal);
                    if (!FlushFileBuffers(controlHandle))
                    {
                        return 70;
                    }
                    return 0;
                }
                catch
                {
                    return 70;
                }
            }
            finally
            {
                if (!controlOwnedByPendingRead)
                {
                    safeControl.Dispose();
                }
            }
        }

        private static PendingIo CreateOperation(IntPtr handle, int bufferLength)
        {
            PendingIo operation = new PendingIo();
            operation.Handle = handle;
            try
            {
                operation.EventHandle = CreateEventW(IntPtr.Zero, true, false, null);
                if (operation.EventHandle == IntPtr.Zero)
                {
                    throw new IOException();
                }
                operation.Buffer = Marshal.AllocHGlobal(bufferLength);
                operation.Overlapped = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(NativeOverlapped)));
                NativeOverlapped value = new NativeOverlapped();
                value.EventHandle = operation.EventHandle;
                Marshal.StructureToPtr(value, operation.Overlapped, false);
                return operation;
            }
            catch
            {
                operation.Release();
                throw;
            }
        }

        private static PendingIo StartRead(IntPtr handle, int length)
        {
            PendingIo operation = CreateOperation(handle, length);
            bool completed = ReadFile(
                handle,
                operation.Buffer,
                checked((uint)length),
                IntPtr.Zero,
                operation.Overlapped);
            if (!completed)
            {
                if (Marshal.GetLastWin32Error() != ErrorIoPending)
                {
                    operation.Release();
                    throw new IOException();
                }
                operation.WasPending = true;
            }
            return operation;
        }

        private static PendingIo StartWrite(IntPtr handle, byte[] bytes)
        {
            PendingIo operation = CreateOperation(handle, bytes.Length);
            Marshal.Copy(bytes, 0, operation.Buffer, bytes.Length);
            bool completed = WriteFile(
                handle,
                operation.Buffer,
                checked((uint)bytes.Length),
                IntPtr.Zero,
                operation.Overlapped);
            if (!completed)
            {
                if (Marshal.GetLastWin32Error() != ErrorIoPending)
                {
                    operation.Release();
                    throw new IOException();
                }
                operation.WasPending = true;
            }
            return operation;
        }

        private static uint CompleteIo(PendingIo operation, bool wait)
        {
            uint transferred;
            if (!GetOverlappedResult(operation.Handle, operation.Overlapped, out transferred, wait))
            {
                throw new IOException();
            }
            return transferred;
        }

        private static byte[] ReadExactly(IntPtr handle, int length)
        {
            byte[] result = new byte[length];
            int offset = 0;
            while (offset < length)
            {
                PendingIo operation = StartRead(handle, length - offset);
                try
                {
                    uint transferred = CompleteIo(operation, true);
                    if (transferred == 0)
                    {
                        throw new EndOfStreamException();
                    }
                    if (transferred > (uint)(length - offset))
                    {
                        throw new InvalidDataException();
                    }
                    Marshal.Copy(operation.Buffer, result, offset, checked((int)transferred));
                    offset += checked((int)transferred);
                }
                finally
                {
                    operation.Release();
                }
            }
            return result;
        }

        private static void WriteAll(IntPtr handle, byte[] bytes)
        {
            PendingIo operation = StartWrite(handle, bytes);
            try
            {
                if (CompleteIo(operation, true) != (uint)bytes.Length)
                {
                    throw new IOException();
                }
            }
            finally
            {
                operation.Release();
            }
        }

        private static ProbeConfig ReadConfig(IntPtr handle)
        {
            byte[] payload = ReadFrame(handle, ProtocolV1.MessageLaunchConfig);
            int offset = 0;
            ReadString(payload, ref offset);
            ReadString(payload, ref offset);
            uint count = ReadUInt32(payload, ref offset);
            if (count != 2)
            {
                throw new InvalidDataException();
            }
            string mode = ReadString(payload, ref offset);
            string nonce = ReadString(payload, ref offset);
            if (offset != payload.Length || nonce.Length != 8)
            {
                throw new InvalidDataException();
            }
            uint parsed;
            if (!UInt32.TryParse(nonce, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out parsed))
            {
                throw new InvalidDataException();
            }
            return new ProbeConfig(mode, parsed);
        }

        private static int ReadTerminate(IntPtr handle)
        {
            byte[] payload = ReadFrame(handle, ProtocolV1.MessageTerminate);
            if (payload.Length != 1 || payload[0] != ProtocolV1.ReasonCancelled)
            {
                throw new InvalidDataException();
            }
            return ProtocolV1.ReasonCancelled;
        }

        private static byte[] ReadFrame(IntPtr handle, int expectedType)
        {
            byte[] header = ReadExactly(handle, ProtocolV1.HeaderBytes);
            if (header[0] != (byte)'C' || header[1] != (byte)'A' || header[2] != (byte)'J' || header[3] != (byte)'1' ||
                ReadUInt16(header, 4) != ProtocolV1.Version || ReadUInt16(header, 6) != expectedType)
            {
                throw new InvalidDataException();
            }
            uint length = ReadUInt32(header, 8);
            if (length > ProtocolV1.MaxPayloadBytes)
            {
                throw new InvalidDataException();
            }
            return ReadExactly(handle, checked((int)length));
        }

        private static string ReadString(byte[] payload, ref int offset)
        {
            uint byteLength = ReadUInt32(payload, ref offset);
            if (byteLength > ProtocolV1.MaxStringBytes || byteLength > Int32.MaxValue || offset + (int)byteLength > payload.Length)
            {
                throw new InvalidDataException();
            }
            string value = StrictUtf8.GetString(payload, offset, (int)byteLength);
            if (value.IndexOf('\0') >= 0)
            {
                throw new InvalidDataException();
            }
            offset += (int)byteLength;
            return value;
        }

        private static void WriteFrame(IntPtr handle, int type, byte[] payload)
        {
            byte[] frame = new byte[ProtocolV1.HeaderBytes + payload.Length];
            frame[0] = (byte)'C';
            frame[1] = (byte)'A';
            frame[2] = (byte)'J';
            frame[3] = (byte)'1';
            WriteUInt16(frame, 4, (ushort)ProtocolV1.Version);
            WriteUInt16(frame, 6, (ushort)type);
            WriteUInt32(frame, 8, (uint)payload.Length);
            Buffer.BlockCopy(payload, 0, frame, ProtocolV1.HeaderBytes, payload.Length);
            WriteAll(handle, frame);
        }

        private static ushort ReadUInt16(byte[] bytes, int offset)
        {
            return (ushort)(bytes[offset] | (bytes[offset + 1] << 8));
        }

        private static uint ReadUInt32(byte[] bytes, int offset)
        {
            return (uint)bytes[offset] |
                ((uint)bytes[offset + 1] << 8) |
                ((uint)bytes[offset + 2] << 16) |
                ((uint)bytes[offset + 3] << 24);
        }

        private static uint ReadUInt32(byte[] bytes, ref int offset)
        {
            if (offset + 4 > bytes.Length)
            {
                throw new InvalidDataException();
            }
            uint value = ReadUInt32(bytes, offset);
            offset += 4;
            return value;
        }

        private static void WriteUInt16(byte[] bytes, int offset, ushort value)
        {
            bytes[offset] = (byte)(value & 0xff);
            bytes[offset + 1] = (byte)((value >> 8) & 0xff);
        }

        private static void WriteUInt32(byte[] bytes, int offset, uint value)
        {
            bytes[offset] = (byte)(value & 0xff);
            bytes[offset + 1] = (byte)((value >> 8) & 0xff);
            bytes[offset + 2] = (byte)((value >> 16) & 0xff);
            bytes[offset + 3] = (byte)((value >> 24) & 0xff);
        }
    }
}
