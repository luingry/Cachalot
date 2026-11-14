using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Cachalot.Module.Native
{
    /// <summary>
    /// Opens chrome://extensions in a new tab of the Chrome window the user already has open. Chrome drops chrome://
    /// URLs given on its command line (only web, file and about:blank pass), so <c>chrome.exe chrome://extensions</c>
    /// just opens an empty window. Instead: bring the most recent Chrome window forward, then Ctrl+T, the address and
    /// Enter — each key only after checking Chrome is still the foreground window. Without a Chrome window, starts
    /// Chrome first (it restores its own session) and waits for the window.
    /// </summary>
    internal static class ChromeTab
    {
        public const string ExtensionsPage = "chrome://extensions/";

        /// <summary>Blocks for up to ~15 s: call off the UI thread. False when Chrome could not be reached; nothing typed then.</summary>
        public static bool OpenExtensionsPage(string executable)
        {
            IntPtr window = FindChromeWindow();
            if (window == IntPtr.Zero)
            {
                try
                {
                    Process.Start(new ProcessStartInfo(executable ?? "chrome.exe") { UseShellExecute = true });
                }
                catch (Exception error) when (error is System.ComponentModel.Win32Exception || error is InvalidOperationException || error is FileNotFoundException)
                {
                    return false;
                }
                for (int i = 0; i < 60 && window == IntPtr.Zero; i++)
                {
                    Thread.Sleep(250);
                    window = FindChromeWindow();
                }
                if (window == IntPtr.Zero)
                {
                    return false;
                }
                Thread.Sleep(800); // let the restored session settle before typing
            }

            if (!BringForward(window))
            {
                return false;
            }
            ReleaseModifiers();
            if (!IsChromeForeground())
            {
                return false;
            }
            Chord(VkControl, (ushort)'T');
            Thread.Sleep(350);
            if (!IsChromeForeground())
            {
                return false;
            }
            TypeText(ExtensionsPage);
            Thread.Sleep(60);
            if (!IsChromeForeground())
            {
                return false;
            }
            Key(VkReturn);
            return true;
        }

        /// <summary>Topmost (most recently used) visible Chrome browser window; EnumWindows walks the z-order from the top.</summary>
        internal static IntPtr FindChromeWindow()
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows((hwnd, _) =>
            {
                if (IsChromeBrowserWindow(hwnd))
                {
                    found = hwnd;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        private static bool IsChromeBrowserWindow(IntPtr hwnd)
        {
            if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GwOwner) != IntPtr.Zero || GetWindowTextLength(hwnd) == 0)
            {
                return false;
            }
            var name = new StringBuilder(64);
            GetClassName(hwnd, name, name.Capacity);
            if (name.ToString() != "Chrome_WidgetWin_1")
            {
                return false;
            }
            // Electron apps share the class name: only chrome.exe counts.
            return IsChromeProcess(hwnd);
        }

        private static bool IsChromeProcess(IntPtr hwnd)
        {
            GetWindowThreadProcessId(hwnd, out uint pid);
            IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, pid);
            if (process == IntPtr.Zero)
            {
                return false;
            }
            try
            {
                var path = new StringBuilder(1024);
                int size = path.Capacity;
                return QueryFullProcessImageName(process, 0, path, ref size)
                       && string.Equals(Path.GetFileName(path.ToString()), "chrome.exe", StringComparison.OrdinalIgnoreCase);
            }
            finally
            {
                CloseHandle(process);
            }
        }

        private static bool IsChromeForeground()
        {
            IntPtr foreground = GetForegroundWindow();
            return foreground != IntPtr.Zero && IsChromeProcess(foreground);
        }

        private static bool BringForward(IntPtr window)
        {
            for (int attempt = 0; attempt < 3; attempt++)
            {
                Foreground.Activate(window);
                for (int i = 0; i < 10; i++)
                {
                    if (IsChromeForeground())
                    {
                        return true;
                    }
                    Thread.Sleep(50);
                }
            }
            return false;
        }

        private static void ReleaseModifiers()
        {
            foreach (ushort key in new[] { VkShift, VkControl, VkMenu, VkLWin, VkRWin })
            {
                if ((GetAsyncKeyState(key) & 0x8000) != 0)
                {
                    Send(KeyInput(key, KeyUp));
                }
            }
        }

        private static void Chord(ushort modifier, ushort key) =>
            Send(KeyInput(modifier, 0), KeyInput(key, 0), KeyInput(key, KeyUp), KeyInput(modifier, KeyUp));

        private static void Key(ushort key) => Send(KeyInput(key, 0), KeyInput(key, KeyUp));

        private static void TypeText(string text)
        {
            var inputs = new Input[text.Length * 2];
            for (int i = 0; i < text.Length; i++)
            {
                inputs[i * 2] = UnicodeInput(text[i], 0);
                inputs[i * 2 + 1] = UnicodeInput(text[i], KeyUp);
            }
            Send(inputs);
        }

        private static Input KeyInput(ushort key, uint flags) =>
            new Input { Type = InputKeyboard, Keyboard = new KeyboardInput { VirtualKey = key, Flags = flags } };

        private static Input UnicodeInput(char c, uint flags) =>
            new Input { Type = InputKeyboard, Keyboard = new KeyboardInput { Scan = c, Flags = KeyUnicode | flags } };

        private static void Send(params Input[] inputs) => SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));

        private const uint GwOwner = 4;
        private const uint ProcessQueryLimitedInformation = 0x1000;
        private const uint InputKeyboard = 1;
        private const uint KeyUp = 0x2;
        private const uint KeyUnicode = 0x4;
        private const ushort VkShift = 0x10, VkControl = 0x11, VkMenu = 0x12, VkLWin = 0x5B, VkRWin = 0x5C, VkReturn = 0x0D;

        [StructLayout(LayoutKind.Sequential)]
        private struct KeyboardInput
        {
            public ushort VirtualKey;
            public ushort Scan;
            public uint Flags;
            public uint Time;
            public IntPtr ExtraInfo;
        }

        /// <summary>INPUT: the union is sized by MOUSEINPUT (its largest member), so Marshal.SizeOf matches on x86 and x64.</summary>
        [StructLayout(LayoutKind.Sequential)]
        private struct Input
        {
            public uint Type;
            public InputUnion Union;

            public KeyboardInput Keyboard
            {
                set => Union.Keyboard = value;
            }
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion
        {
            [FieldOffset(0)] public KeyboardInput Keyboard;
            [FieldOffset(0)] public MouseInputPadding Mouse;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MouseInputPadding
        {
            public int X, Y;
            public uint Data, Flags, Time;
            public IntPtr ExtraInfo;
        }

        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetWindow(IntPtr hwnd, uint command);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextLength(IntPtr hwnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int capacity);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int key);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint count, Input[] inputs, int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
