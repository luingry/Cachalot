using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Threading;

namespace Cachalot.Module.Native
{
    /// <summary>
    /// Brings forward the Explorer window Cachalot just opened. Windows hands the foreground only to the process that
    /// got the last input, so a folder opened on the extension's request (the browser has the focus) would stay behind
    /// the browser and only flash in the taskbar.
    /// </summary>
    internal static class ExplorerWindow
    {
        private const string ExplorerClass = "CabinetWClass";
        private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);
        private static readonly TimeSpan ReusedAfter = TimeSpan.FromSeconds(1.5);

        /// <summary>The visible Explorer windows right now, top of the z-order first.</summary>
        public static List<IntPtr> Snapshot()
        {
            var list = new List<IntPtr>();
            EnumWindows((h, _) =>
            {
                if (IsWindowVisible(h) && ClassOf(h) == ExplorerClass)
                {
                    list.Add(h);
                }
                return true;
            }, IntPtr.Zero);
            return list;
        }

        /// <summary>
        /// Waits, off the UI thread, for the Explorer window that was not in <paramref name="before"/> (or, when Explorer
        /// reused a window, the one titled <paramref name="folderName"/>) and activates it on the UI thread.
        /// </summary>
        public static void BringForward(ICollection<IntPtr> before, string folderName, Dispatcher ui)
        {
            Task.Run(async () =>
            {
                var clock = Stopwatch.StartNew();
                while (clock.Elapsed < Timeout)
                {
                    List<IntPtr> now = Snapshot();
                    IntPtr target = now.FirstOrDefault(h => !before.Contains(h));
                    if (target == IntPtr.Zero && clock.Elapsed >= ReusedAfter && !string.IsNullOrEmpty(folderName))
                    {
                        target = now.FirstOrDefault(h => string.Equals(TitleOf(h), folderName, StringComparison.OrdinalIgnoreCase));
                    }
                    if (target != IntPtr.Zero)
                    {
                        await ui.InvokeAsync(() => Foreground.Activate(target));
                        return;
                    }
                    await Task.Delay(100).ConfigureAwait(false);
                }
            });
        }

        private static string ClassOf(IntPtr window)
        {
            var name = new StringBuilder(64);
            return GetClassName(window, name, name.Capacity) > 0 ? name.ToString() : string.Empty;
        }

        private static string TitleOf(IntPtr window)
        {
            var title = new StringBuilder(260);
            return GetWindowText(window, title, title.Capacity) > 0 ? title.ToString() : string.Empty;
        }

        private delegate bool EnumWindowsProc(IntPtr window, IntPtr param);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr window);
    }
}
