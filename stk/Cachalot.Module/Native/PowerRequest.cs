using System;
using System.Runtime.InteropServices;

namespace Cachalot.Module.Native
{
    /// <summary>
    /// Keeps the PC from sleeping while downloads run (a power request, so it does not depend on the shared UI
    /// thread's execution state). Shows in <c>powercfg /requests</c> with its reason.
    /// </summary>
    internal sealed class PowerRequest : IDisposable
    {
        private const int PowerRequestSystemRequired = 1;
        private const uint PowerRequestContextVersion = 0;
        private const uint PowerRequestContextSimpleString = 0x1;

        private IntPtr _handle;
        private bool _active;

        public void Set(bool active)
        {
            if (active == _active)
            {
                return;
            }
            try
            {
                if (_handle == IntPtr.Zero)
                {
                    var context = new ReasonContext
                    {
                        Version = PowerRequestContextVersion,
                        Flags = PowerRequestContextSimpleString,
                        SimpleReasonString = "Cachalot: downloads em andamento",
                    };
                    _handle = PowerCreateRequest(ref context);
                    if (_handle == IntPtr.Zero || _handle == new IntPtr(-1))
                    {
                        _handle = IntPtr.Zero;
                        return;
                    }
                }
                if (active ? PowerSetRequest(_handle, PowerRequestSystemRequired) : PowerClearRequest(_handle, PowerRequestSystemRequired))
                {
                    _active = active;
                }
            }
            catch (EntryPointNotFoundException)
            {
            }
        }

        public void Dispose()
        {
            Set(false);
            if (_handle != IntPtr.Zero)
            {
                CloseHandle(_handle);
                _handle = IntPtr.Zero;
            }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct ReasonContext
        {
            public uint Version;
            public uint Flags;
            [MarshalAs(UnmanagedType.LPWStr)] public string SimpleReasonString;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr PowerCreateRequest(ref ReasonContext context);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PowerSetRequest(IntPtr handle, int requestType);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PowerClearRequest(IntPtr handle, int requestType);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
