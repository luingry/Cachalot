using System;
using System.Runtime.InteropServices;
using System.Windows.Interop;

namespace Cachalot.Module.Native
{
    /// <summary>
    /// A system-wide shortcut (RegisterHotKey) on a message-only window: no hook, no polling — Windows posts
    /// WM_HOTKEY only when the keys are pressed. Fails quietly when another app already owns the combination.
    /// </summary>
    internal sealed class GlobalHotKey : IDisposable
    {
        public const uint ModAlt = 0x1;
        public const uint ModControl = 0x2;
        public const uint ModShift = 0x4;
        private const uint ModNoRepeat = 0x4000;
        private const int WmHotKey = 0x0312;
        private const int Id = 0xCA70;

        private readonly HwndSource _window;
        private readonly Action _pressed;
        private bool _registered;

        public GlobalHotKey(uint modifiers, uint virtualKey, Action pressed)
        {
            _pressed = pressed;
            _window = new HwndSource(new HwndSourceParameters("CachalotHotKey") { ParentWindow = new IntPtr(-3), WindowStyle = 0 });
            _window.AddHook(WndProc);
            _registered = RegisterHotKey(_window.Handle, Id, modifiers | ModNoRepeat, virtualKey);
        }

        public bool IsRegistered => _registered;

        public void Dispose()
        {
            if (_registered)
            {
                UnregisterHotKey(_window.Handle, Id);
                _registered = false;
            }
            _window.RemoveHook(WndProc);
            _window.Dispose();
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == WmHotKey && wParam.ToInt32() == Id)
            {
                handled = true;
                _pressed();
            }
            return IntPtr.Zero;
        }

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint virtualKey);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnregisterHotKey(IntPtr hwnd, int id);
    }
}
