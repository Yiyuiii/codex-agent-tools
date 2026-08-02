using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace CodexAgentTools.HostAcceptance
{
    internal sealed class SafeKernelObjectHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        private SafeKernelObjectHandle() : base(true) { }

        internal SafeKernelObjectHandle(IntPtr value) : base(true)
        {
            SetHandle(value);
        }

        protected override bool ReleaseHandle()
        {
            return WindowsNative.CloseKernelHandle(handle);
        }
    }

    internal sealed class SafeLocalMemoryHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        internal SafeLocalMemoryHandle(IntPtr value) : base(true)
        {
            SetHandle(value);
        }

        protected override bool ReleaseHandle()
        {
            return WindowsNative.FreeLocalMemory(handle) == IntPtr.Zero;
        }
    }

    internal static class WindowsNative
    {
        internal const int ProcessBasicInformationSize = 48;
        internal const int UniqueProcessIdOffset = 32;
        internal const int InheritedProcessIdOffset = 40;
        internal const uint Infinite = 0xffffffff;
        internal const uint WaitObject0 = 0;
        internal const uint WaitTimeout = 258;
        internal const uint WaitFailed = 0xffffffff;

        private const uint PipeAccessDuplex = 0x00000003;
        private const uint FileFlagFirstPipeInstance = 0x00080000;
        private const uint PipeRejectRemoteClients = 0x00000008;
        private const uint ProcessQueryLimitedInformation = 0x00001000;
        private const uint Synchronize = 0x00100000;
        private const int ErrorPipeConnected = 535;
        private const uint DaclSecurityInformation = 0x00000004;
        private const int SeKernelObject = 6;
        private const ushort SeDaclProtected = 0x1000;
        private const byte AccessAllowedAceType = 0;
        private const uint GenericAll = 0x10000000;
        private const uint FileAllAccess = 0x001f01ff;

        [StructLayout(LayoutKind.Sequential)]
        internal struct SecurityAttributes
        {
            internal int Length;
            internal IntPtr SecurityDescriptor;
            internal int InheritHandle;
        }

        [StructLayout(LayoutKind.Explicit, Size = ProcessBasicInformationSize)]
        internal struct ProcessBasicInformation64
        {
            [FieldOffset(0)] internal int ExitStatus;
            [FieldOffset(8)] internal IntPtr PebBaseAddress;
            [FieldOffset(16)] internal UIntPtr AffinityMask;
            [FieldOffset(24)] internal int BasePriority;
            [FieldOffset(UniqueProcessIdOffset)] internal ulong UniqueProcessId;
            [FieldOffset(InheritedProcessIdOffset)] internal ulong InheritedFromUniqueProcessId;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct NativeFileTime
        {
            internal uint Low;
            internal uint High;

            internal ulong Value
            {
                get { return ((ulong)High << 32) | Low; }
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeKernelObjectHandle CreateNamedPipeW(
            string name,
            uint openMode,
            uint pipeMode,
            uint maximumInstances,
            uint outputBufferSize,
            uint inputBufferSize,
            uint defaultTimeout,
            ref SecurityAttributes securityAttributes);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConnectNamedPipe(SafeKernelObjectHandle pipe, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DisconnectNamedPipe(SafeKernelObjectHandle pipe);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetNamedPipeClientProcessId(SafeKernelObjectHandle pipe, out uint clientProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern SafeKernelObjectHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetProcessId(SafeKernelObjectHandle process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetProcessTimes(
            SafeKernelObjectHandle process,
            out NativeFileTime creation,
            out NativeFileTime exit,
            out NativeFileTime kernel,
            out NativeFileTime user);

        [DllImport("ntdll.dll")]
        private static extern int NtQueryInformationProcess(
            SafeKernelObjectHandle process,
            int informationClass,
            ref ProcessBasicInformation64 information,
            uint informationLength,
            out uint returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(SafeKernelObjectHandle handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ReadFile(SafeKernelObjectHandle handle, byte[] bytes, uint count, out uint read, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WriteFile(SafeKernelObjectHandle handle, byte[] bytes, uint count, out uint written, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FlushFileBuffers(SafeKernelObjectHandle handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr LocalFree(IntPtr memory);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string descriptor,
            uint revision,
            out IntPtr securityDescriptor,
            out uint securityDescriptorSize);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern uint GetSecurityInfo(
            SafeKernelObjectHandle handle,
            int objectType,
            uint securityInformation,
            out IntPtr owner,
            out IntPtr group,
            out IntPtr dacl,
            out IntPtr sacl,
            out IntPtr securityDescriptor);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetSecurityDescriptorControl(IntPtr securityDescriptor, out ushort control, out uint revision);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetAce(IntPtr acl, uint index, out IntPtr ace);

        internal static void ValidateCurrentHostLayouts()
        {
            if (
                IntPtr.Size != 8 ||
                Marshal.SizeOf(typeof(SecurityAttributes)) != 24 ||
                Marshal.SizeOf(typeof(ProcessBasicInformation64)) != ProcessBasicInformationSize ||
                Marshal.OffsetOf(typeof(ProcessBasicInformation64), "UniqueProcessId") != new IntPtr(UniqueProcessIdOffset) ||
                Marshal.OffsetOf(typeof(ProcessBasicInformation64), "InheritedFromUniqueProcessId") != new IntPtr(InheritedProcessIdOffset) ||
                Marshal.SizeOf(typeof(NativeFileTime)) != 8)
            {
                throw new InvalidOperationException("host_acceptance_native_layout_invalid");
            }
        }

        internal static SafeKernelObjectHandle CreateCurrentUserPipe(string pipePath)
        {
            ValidateCurrentHostLayouts();
            SecurityIdentifier currentSid;
            using (var identity = WindowsIdentity.GetCurrent())
            {
                currentSid = identity.User;
            }
            if (currentSid == null) throw new InvalidOperationException("host_acceptance_current_sid_unavailable");

            IntPtr descriptorPointer;
            uint descriptorSize;
            var sddl = "D:P(A;;GA;;;" + currentSid.Value + ")";
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptorPointer, out descriptorSize) || descriptorPointer == IntPtr.Zero)
            {
                throw new InvalidOperationException("host_acceptance_pipe_security_failed");
            }
            using (var descriptor = new SafeLocalMemoryHandle(descriptorPointer))
            {
                var attributes = new SecurityAttributes {
                    Length = Marshal.SizeOf(typeof(SecurityAttributes)),
                    SecurityDescriptor = descriptor.DangerousGetHandle(),
                    InheritHandle = 0
                };
                var pipe = CreateNamedPipeW(
                    pipePath,
                    PipeAccessDuplex | FileFlagFirstPipeInstance,
                    PipeRejectRemoteClients,
                    1,
                    checked((uint)ProtocolV1.MaximumFrameBytes),
                    checked((uint)ProtocolV1.MaximumFrameBytes),
                    0,
                    ref attributes);
                GC.KeepAlive(descriptor);
                if (pipe == null || pipe.IsInvalid)
                {
                    if (pipe != null) pipe.Dispose();
                    throw new InvalidOperationException("host_acceptance_pipe_create_failed");
                }
                return pipe;
            }
        }

        internal static void ConnectPipe(SafeKernelObjectHandle pipe)
        {
            if (!ConnectNamedPipe(pipe, IntPtr.Zero) && Marshal.GetLastWin32Error() != ErrorPipeConnected)
            {
                throw new InvalidOperationException("host_acceptance_pipe_connect_failed");
            }
        }

        internal static void DisconnectPipe(SafeKernelObjectHandle pipe)
        {
            DisconnectNamedPipe(pipe);
        }

        internal static uint GetPipeClientProcessId(SafeKernelObjectHandle pipe)
        {
            uint processId;
            if (!GetNamedPipeClientProcessId(pipe, out processId) || processId == 0)
            {
                throw new InvalidOperationException("host_acceptance_pipe_peer_failed");
            }
            return processId;
        }

        internal static SafeKernelObjectHandle OpenProcessForObservation(uint processId)
        {
            var process = OpenProcess(Synchronize | ProcessQueryLimitedInformation, false, processId);
            if (process == null || process.IsInvalid)
            {
                if (process != null) process.Dispose();
                throw new InvalidOperationException("host_acceptance_process_open_failed");
            }
            if (GetProcessId(process) != processId)
            {
                process.Dispose();
                throw new InvalidOperationException("host_acceptance_process_identity_failed");
            }
            return process;
        }

        internal static ulong GetProcessCreationFileTime(SafeKernelObjectHandle process)
        {
            NativeFileTime creation;
            NativeFileTime exit;
            NativeFileTime kernel;
            NativeFileTime user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user) || creation.Value == 0)
            {
                throw new InvalidOperationException("host_acceptance_process_times_failed");
            }
            return creation.Value;
        }

        internal static uint GetDirectParentProcessId(SafeKernelObjectHandle child)
        {
            var information = new ProcessBasicInformation64();
            uint returned;
            var status = NtQueryInformationProcess(child, 0, ref information, ProcessBasicInformationSize, out returned);
            if (status != 0 || returned != ProcessBasicInformationSize || information.UniqueProcessId == 0 || information.InheritedFromUniqueProcessId == 0 || information.InheritedFromUniqueProcessId > UInt32.MaxValue)
            {
                throw new InvalidOperationException("host_acceptance_process_parent_failed");
            }
            var actual = GetProcessId(child);
            if (information.UniqueProcessId != actual)
            {
                throw new InvalidOperationException("host_acceptance_process_parent_failed");
            }
            return checked((uint)information.InheritedFromUniqueProcessId);
        }

        internal static bool IsProcessExited(SafeKernelObjectHandle process)
        {
            var result = WaitForSingleObject(process, 0);
            if (result == WaitObject0) return true;
            if (result == WaitTimeout) return false;
            throw new InvalidOperationException("host_acceptance_process_wait_failed");
        }

        internal static void WaitForProcessExit(SafeKernelObjectHandle process)
        {
            if (WaitForSingleObject(process, Infinite) != WaitObject0)
            {
                throw new InvalidOperationException("host_acceptance_process_wait_failed");
            }
        }

        internal static byte ReadPipeByte(SafeKernelObjectHandle pipe)
        {
            var bytes = new byte[1];
            uint read;
            if (!ReadFile(pipe, bytes, 1, out read, IntPtr.Zero) || read != 1)
            {
                throw new InvalidOperationException("host_acceptance_pipe_read_failed");
            }
            return bytes[0];
        }

        internal static void WritePipeByte(SafeKernelObjectHandle pipe, byte value)
        {
            uint written;
            if (!WriteFile(pipe, new[] { value }, 1, out written, IntPtr.Zero) || written != 1 || !FlushFileBuffers(pipe))
            {
                throw new InvalidOperationException("host_acceptance_pipe_write_failed");
            }
        }

        internal static bool HasProtectedCurrentUserOnlyDacl(SafeKernelObjectHandle handle)
        {
            IntPtr owner;
            IntPtr group;
            IntPtr dacl;
            IntPtr sacl;
            IntPtr descriptorPointer;
            if (GetSecurityInfo(handle, SeKernelObject, DaclSecurityInformation, out owner, out group, out dacl, out sacl, out descriptorPointer) != 0 || descriptorPointer == IntPtr.Zero)
            {
                throw new InvalidOperationException("host_acceptance_pipe_acl_query_failed");
            }
            using (var descriptor = new SafeLocalMemoryHandle(descriptorPointer))
            {
                ushort control;
                uint revision;
                if (!GetSecurityDescriptorControl(descriptor.DangerousGetHandle(), out control, out revision) || (control & SeDaclProtected) == 0 || dacl == IntPtr.Zero)
                {
                    return false;
                }
                var aceCount = unchecked((ushort)Marshal.ReadInt16(dacl, 4));
                IntPtr ace;
                if (aceCount != 1 || !GetAce(dacl, 0, out ace) || ace == IntPtr.Zero)
                {
                    return false;
                }
                var accessMask = unchecked((uint)Marshal.ReadInt32(ace, 4));
                if (Marshal.ReadByte(ace, 0) != AccessAllowedAceType || (accessMask != GenericAll && accessMask != FileAllAccess))
                {
                    return false;
                }
                var aceSid = new SecurityIdentifier(new IntPtr(ace.ToInt64() + 8));
                using (var identity = WindowsIdentity.GetCurrent())
                {
                    return identity.User != null && identity.User.Equals(aceSid);
                }
            }
        }

        internal static bool CloseKernelHandle(IntPtr handle)
        {
            return CloseHandle(handle);
        }

        internal static IntPtr FreeLocalMemory(IntPtr memory)
        {
            return LocalFree(memory);
        }
    }
}
