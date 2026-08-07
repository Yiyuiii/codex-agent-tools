using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace CodexAgentTools.WindowsJobHelper
{
    internal abstract class SafeKernelHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        protected SafeKernelHandle(IntPtr handleValue)
            : base(true)
        {
            SetHandle(handleValue);
        }

        protected override bool ReleaseHandle()
        {
            return NativeMethods.CloseHandle(handle);
        }
    }

    internal sealed class SafeJobHandle : SafeKernelHandle
    {
        internal SafeJobHandle(IntPtr handleValue)
            : base(handleValue)
        {
        }
    }

    internal sealed class SafeProcessHandle : SafeKernelHandle
    {
        internal SafeProcessHandle(IntPtr handleValue)
            : base(handleValue)
        {
        }
    }

    internal sealed class SafeThreadHandle : SafeKernelHandle
    {
        internal SafeThreadHandle(IntPtr handleValue)
            : base(handleValue)
        {
        }
    }

    internal sealed class SafeInheritedHandle : SafeKernelHandle
    {
        internal SafeInheritedHandle(IntPtr handleValue)
            : base(handleValue)
        {
        }
    }

    internal sealed class SafeNativeBuffer : SafeHandleZeroOrMinusOneIsInvalid
    {
        private SafeNativeBuffer(IntPtr buffer)
            : base(true)
        {
            SetHandle(buffer);
        }

        internal static SafeNativeBuffer Allocate(int bytes)
        {
            if (bytes <= 0)
            {
                throw new ArgumentOutOfRangeException("bytes");
            }
            return new SafeNativeBuffer(Marshal.AllocHGlobal(bytes));
        }

        protected override bool ReleaseHandle()
        {
            Marshal.FreeHGlobal(handle);
            return true;
        }
    }

    internal sealed class ProcThreadAttributeList : IDisposable
    {
        private readonly IWin32Api api;
        private SafeNativeBuffer storage;
        private bool initialized;

        private ProcThreadAttributeList(IWin32Api api, SafeNativeBuffer storage)
        {
            this.api = api;
            this.storage = storage;
        }

        internal IntPtr DangerousGetHandle()
        {
            if (storage == null || storage.IsInvalid || storage.IsClosed || !initialized)
            {
                throw new ObjectDisposedException("ProcThreadAttributeList");
            }
            return storage.DangerousGetHandle();
        }

        internal static ProcThreadAttributeList Create(
            IWin32Api api,
            int count,
            out int error)
        {
            if (api == null || count <= 0)
            {
                throw new ArgumentOutOfRangeException("count");
            }

            IntPtr size = IntPtr.Zero;
            int queryError;
            bool queryResult = api.InitializeProcThreadAttributeList(
                IntPtr.Zero, count, ref size, out queryError);
            if (queryResult || queryError != NativeMethods.ErrorInsufficientBuffer ||
                size.ToInt64() <= 0 || size.ToInt64() > Int32.MaxValue)
            {
                error = queryError;
                return null;
            }

            SafeNativeBuffer buffer = SafeNativeBuffer.Allocate((int)size.ToInt64());
            var result = new ProcThreadAttributeList(api, buffer);
            if (!api.InitializeProcThreadAttributeList(
                buffer.DangerousGetHandle(), count, ref size, out error))
            {
                result.Dispose();
                return null;
            }
            result.initialized = true;
            error = 0;
            return result;
        }

        public void Dispose()
        {
            SafeNativeBuffer current = storage;
            if (current == null)
            {
                return;
            }
            storage = null;
            if (initialized)
            {
                initialized = false;
                api.DeleteProcThreadAttributeList(current.DangerousGetHandle());
            }
            current.Dispose();
        }
    }
}
