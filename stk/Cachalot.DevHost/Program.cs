using System;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using SwissTechKnife.Sdk;
using Cachalot.Module;

namespace Cachalot.DevHost
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            // Exactly what the host does: its theme in the application resources, inherited by module pages.
            app.Resources.MergedDictionaries.Add(new ResourceDictionary { Source = new Uri("pack://application:,,,/SwissTechKnife.Sdk;component/Theme/Theme.xaml") });

            int dataArg = Array.IndexOf(args, "--data");
            string data = dataArg >= 0 && dataArg + 1 < args.Length
                ? args[dataArg + 1]
                : Path.Combine(Path.GetTempPath(), "Cachalot.DevHost");
            int snapshot = Array.IndexOf(args, "--snapshot");
            if (snapshot >= 0)
            {
                // Snapshots never touch real data: a fresh folder each run.
                data = Path.Combine(Path.GetTempPath(), "Cachalot.Snapshot." + Guid.NewGuid().ToString("N").Substring(0, 6));
            }

            var context = new DevContext(data, Dispatcher.CurrentDispatcher);
            var module = new CachalotModule();
            module.Initialize(context);

            if (snapshot >= 0)
            {
                string output = snapshot + 1 < args.Length ? args[snapshot + 1] : Path.Combine(Environment.CurrentDirectory, "snapshots");
                int code = Snapshots.Run(module, context, output);
                module.Dispose();
                return code;
            }

            module.Start();
            var window = new DevWindow(module, context);
            window.Closed += (s, e) => app.Shutdown();
            window.Show();
            app.Run();
            module.Stop();
            module.Dispose();
            return 0;
        }
    }

    /// <summary>Host stand-in: the module page, and the settings tab framed like the host's details dialog.</summary>
    internal sealed class DevWindow : Window
    {
        public DevWindow(CachalotModule module, DevContext context, bool showViewLifecycle = true)
        {
            Title = "Cachalot · DevHost";
            Width = 1500;
            Height = 900;
            Background = (Brush)FindResource("Brush.Canvas");
            WindowStartupLocation = WindowStartupLocation.CenterScreen;

            var toast = new TextBlock { Style = (Style)FindResource("Text.Caption"), Margin = new Thickness(28, 0, 28, 14) };
            context.Notified += (message, kind) => toast.Text = kind + ": " + message;

            SettingsCard = new Border
            {
                Style = (Style)FindResource("Card"),
                Background = (Brush)FindResource("Brush.Surface2"),
                Width = 548,
                Padding = new Thickness(24),
                Margin = new Thickness(0, 8, 28, 28),
                VerticalAlignment = VerticalAlignment.Top,
                Child = module.CreateSettingsView(),
            };

            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            grid.Children.Add(new TextBlock { Text = "Cachalot", Style = (Style)FindResource("Text.Display"), Margin = new Thickness(28, 24, 28, 12) });
            Page = module.CreateView();
            Grid.SetRow(Page, 1);
            grid.Children.Add(Page);
            SettingsScroll = new ScrollViewer { Content = SettingsCard };
            Grid.SetRow(SettingsScroll, 1);
            Grid.SetColumn(SettingsScroll, 1);
            grid.Children.Add(SettingsScroll);
            Grid.SetRow(toast, 2);
            Grid.SetColumnSpan(toast, 2);
            grid.Children.Add(toast);
            Content = grid;

            if (showViewLifecycle)
            {
                Loaded += (s, e) => (Page as IModuleViewLifecycle)?.OnViewShown();
            }
        }

        public FrameworkElement Page { get; }

        public Border SettingsCard { get; }

        public ScrollViewer SettingsScroll { get; }
    }

    /// <summary>Minimal stand-in for the host's IModuleContext.</summary>
    internal sealed class DevContext : IModuleContext, IModuleLog
    {
        private readonly string _logPath;

        public DevContext(string dataDirectory, Dispatcher dispatcher)
        {
            DataDirectory = dataDirectory;
            Directory.CreateDirectory(dataDirectory);
            Dispatcher = dispatcher;
            _logPath = Path.Combine(dataDirectory, "devhost.log");
        }

        public event Action<string, NotificationKind> Notified;

        public string ModuleId => "vd-get";

        public Version ModuleVersion => typeof(CachalotModule).Assembly.GetName().Version;

        public Version HostVersion => new Version(0, 5, 3);

        public string InstallDirectory => AppDomain.CurrentDomain.BaseDirectory;

        public string DataDirectory { get; }

        public Dispatcher Dispatcher { get; }

        public IModuleLog Log => this;

        public void Notify(string message, NotificationKind kind = NotificationKind.Info)
        {
            Write("NOTIFY", kind + ": " + message);
            Notified?.Invoke(message, kind);
        }

        public void ShowModulePage()
        {
        }

        public void Info(string message) => Write("INFO", message);

        public void Warn(string message) => Write("WARN", message);

        public void Error(string message, Exception exception = null) => Write("ERROR", message + (exception == null ? string.Empty : Environment.NewLine + exception));

        private void Write(string level, string message)
        {
            try
            {
                File.AppendAllText(_logPath, $"{DateTime.Now:HH:mm:ss.fff} {level} {message}{Environment.NewLine}");
            }
            catch (IOException)
            {
            }
        }
    }
}
