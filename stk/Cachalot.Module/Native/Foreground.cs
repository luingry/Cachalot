using System;
using System.Runtime.InteropServices;

namespace Cachalot.Module.Native
{
    /// <summary>
    /// Puts a window in front of the app that has the focus. Windows hands the foreground only to the process that got
    /// the last input, so windows shown on the extension's request (the browser has the focus) would stay behind it.
    /// Call on a thread with a message queue (the UI thread).
    /// </summary>
    internal static class Foreground
    {
        /// <summary>Same trick as Kiwindow: borrow the foreground thread's input state, then a null mouse move as fallback.</summary>
        public static void Activate(IntPtr window)
        {
            if (!IsWindow(window))
            {
                return;
            }
            if (IsIconic(window))
            {
                ShowWindow(window, SwRestore);
            }
            uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), out _);
            uint self = GetCurrentThreadId();
            bool attached = foreground != 0 && foreground != self && AttachThreadInput(self, foreground, true);
            BringWindowToTop(window);
            bool ok = SetForegroundWindow(window);
            if (attached)
            {
                AttachThreadInput(self, foreground, false);
            }
            if (!ok || GetForegroundWindow() != window)
            {
                mouse_event(MouseEventMove, 0, 0, 0, UIntPtr.Zero);
                SetForegroundWindow(window);
            }
        }

        private const int SwRestore = 9;
        private const uint MouseEventMove = 0x1;

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr window);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr window);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr window, int command);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr window);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr window);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);

        [DllImport("user32.dll")]
        private static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
    }
}
