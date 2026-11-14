using System;
using System.Collections.Generic;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Cachalot.Module;
using Cachalot.Module.Downloads;
using Cachalot.Module.Setup;
using Cachalot.Module.Views;

namespace Cachalot.DevHost
{
    /// <summary>Renders the page and the settings tab with representative items (2x PNGs) — no backend, no network.</summary>
    internal static class Snapshots
    {
        public static int Run(CachalotModule module, DevContext context, string output)
        {
            Directory.CreateDirectory(output);
            DownloadService service = module.Service;
            Seed(service, module.Prefs);

            var window = new DevWindow(module, context, showViewLifecycle: false) { Left = -20000, Top = 0, ShowActivated = false, ShowInTaskbar = false };
            window.Show();
            Pump(TimeSpan.FromMilliseconds(1500));
            Render((FrameworkElement)window.Page, Path.Combine(output, "page.png"));

            // Copied-link suggestion + audio mode.
            if (window.Page.FindName("ClipboardBar") is Border bar && window.Page.FindName("ClipboardText") is TextBlock text)
            {
                text.Text = "Link copiado: youtube.com/watch?v=jNQXAC9IVRw";
                bar.Visibility = Visibility.Visible;
            }
            if (window.Page.FindName("AudioOption") is RadioButton audio)
            {
                audio.IsChecked = true;
            }
            Pump(TimeSpan.FromMilliseconds(700));
            Render((FrameworkElement)window.Page, Path.Combine(output, "page-audio-clipboard.png"));
            if (window.Page.FindName("QualityBox") is ComboBox quality)
            {
                quality.IsDropDownOpen = true;
                Pump(TimeSpan.FromMilliseconds(500));
                if (quality.Template.FindName("PART_Popup", quality) is Popup popup && popup.Child is FrameworkElement list)
                {
                    Render(list, Path.Combine(output, "quality-dropdown.png"));
                }
                quality.IsDropDownOpen = false;
            }
            window.Close();

            // Settings tab at full height, framed like the host's details dialog.
            var card = new Border
            {
                Style = (Style)Application.Current.FindResource("Card"),
                Background = (Brush)Application.Current.FindResource("Brush.Surface2"),
                Width = 548,
                Padding = new Thickness(24),
                Child = module.CreateSettingsView(),
            };
            // Laid out off-window so the full height renders (a window would be capped at the screen height).
            card.Measure(new Size(548, double.PositiveInfinity));
            card.Arrange(new Rect(card.DesiredSize));
            card.UpdateLayout();
            Pump(TimeSpan.FromMilliseconds(800));
            card.UpdateLayout();
            double part = 1100;
            for (int i = 0; i * part < card.ActualHeight; i++)
            {
                Render(card, Path.Combine(output, $"settings-{i + 1}.png"), new Rect(0, i * part, card.ActualWidth, Math.Min(part, card.ActualHeight - i * part)));
            }

            // Chrome extension setup popup: offer (developer mode off), waiting (developer mode on), done.
            var states = new[]
            {
                ("extension-offer.png", new ChromeState { Found = true, LastProfile = "Default" }, false, false),
                ("extension-waiting.png", new ChromeState { Found = true, LastProfile = "Default", DeveloperMode = true }, true, false),
                ("extension-done.png", new ChromeState { Found = true, LastProfile = "Default", DeveloperMode = true, InstalledProfiles = { "Default" } }, true, true),
            };
            foreach (var (name, state, waiting, done) in states)
            {
                var setup = new ExtensionSetupWindow(module.Extension) { Left = -20000, Top = 0, ShowActivated = false, ShowInTaskbar = false };
                setup.Show();
                setup.Preview(state, waiting, done);
                Pump(TimeSpan.FromMilliseconds(500));
                var frame = (Border)setup.Content;
                frame.Effect = null; // the shadow widens the visual's bounds and shifts the capture
                frame.Margin = new Thickness(0);
                Pump(TimeSpan.FromMilliseconds(200));
                Render(frame, Path.Combine(output, name));
                setup.Close();
            }

            Console.WriteLine("Snapshots written to " + output);
            return 0;
        }

        private static void Seed(DownloadService service, Preferences prefs)
        {
            double now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
            service.Active.Add(new DownloadItem
            {
                Id = "a1", Url = "https://www.youtube.com/watch?v=aqz-KE-bpKQ", Title = "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film",
                Platform = "YouTube", Engine = "yt-dlp", Status = Statuses.Downloading, Progress = 46.3, Downloaded = "212.4MiB", Total = "458.9MiB",
                Speed = "8.4MiB/s", Eta = "00:29", Phase = "Vídeo",
            });
            service.Active.Add(new DownloadItem
            {
                Id = "a2", Url = "magnet:?xt=urn:btih:dd8255ec", Title = "Sintel (2010) 1080p", Platform = "Torrent", Engine = "torrent",
                Status = Statuses.Downloading, Progress = 12.8, Downloaded = "88.0MiB", Total = "690.1MiB", Speed = "3.1MiB/s", Eta = "03:14", Phase = "Baixando · 23 pares",
            });
            service.Active.Add(new DownloadItem
            {
                Id = "a3", Url = "https://wallhaven.cc/search?q=nasa", Title = "nasa", Platform = "wallhaven.cc", Engine = "galeria",
                Status = Statuses.Downloading, Phase = "37 arquivos",
            });
            service.Active.Add(new DownloadItem
            {
                Id = "a4", Url = "https://x.com/NASA/status/1", Title = "NASA - Liftoff! Watch the launch from the pad", Platform = "X", Engine = "nativo",
                Status = Statuses.Processing, Progress = 99, Phase = "Juntando vídeo e áudio",
            });
            service.Active.Add(new DownloadItem
            {
                Id = "a5", Url = "https://www.instagram.com/reel/abc", Title = "https://www.instagram.com/reel/abc", Platform = "Instagram",
                Status = Statuses.Pending, Attempt = 2, Hint = "O site limitou os pedidos por agora.",
            });
            service.Active.Add(new DownloadItem
            {
                Id = "a6", Url = "https://soundcloud.com/forss/flickermood", Title = "Forss - Flickermood", Platform = "SoundCloud", Mode = Modes.Audio,
                Status = Statuses.Paused, Progress = 63,
            });
            service.Completed.Add(new DownloadItem
            {
                Id = "c1", Url = "https://www.youtube.com/watch?v=jNQXAC9IVRw", Title = "Me at the zoo", Platform = "YouTube", Engine = "yt-dlp",
                Status = Statuses.Done, FilePath = @"C:\Users\voce\Downloads\Me at the zoo.mp4", FinishedTs = now - 120,
            });
            service.Completed.Add(new DownloadItem
            {
                Id = "c2", Url = "https://www.reddit.com/r/pics/comments/x", Title = "Northern lights over the fjord", Platform = "Reddit", Engine = "nativo",
                Status = Statuses.Done, Files = 6, FinishedTs = now - 3600,
            });
            service.Completed.Add(new DownloadItem
            {
                Id = "c3", Url = "https://www.youtube.com/watch?v=private", Title = "https://www.youtube.com/watch?v=private", Platform = "YouTube",
                Status = Statuses.Error, Error = "Conteúdo privado ou só para membros.", Hint = "Importe cookies de uma conta com acesso.", FinishedTs = now - 7200,
            });
            prefs.Rules.Add(new Rule { When = "site", Value = "soundcloud.com", Folder = @"C:\Users\voce\Music", Mode = Modes.Audio });
            prefs.Channels.Add(new Channel
            {
                Id = "ch1", Url = "https://www.youtube.com/@NASA", Title = "NASA", LastCheckedTs = now - 900, Seeded = true,
                NewItems = new List<ChannelItem> { new ChannelItem { Url = "https://www.youtube.com/watch?v=1" }, new ChannelItem { Url = "https://www.youtube.com/watch?v=2" } },
            });
            prefs.Channels.Add(new Channel { Id = "ch2", Url = "https://www.youtube.com/@blender", Title = "Blender", LastCheckedTs = now - 7200, AutoDownload = true, IntervalMinutes = 360, Seeded = true });

            // Login e cookies: two sites with stored cookies (one turned off) and one turned off before having any.
            foreach (string site in new[] { "youtube.com", "instagram.com" })
            {
                service.Cookies.SaveFromBrowser(site, new[]
                {
                    new Dictionary<string, object> { ["name"] = "SID", ["value"] = "v", ["domain"] = "." + site, ["path"] = "/" },
                    new Dictionary<string, object> { ["name"] = "PREF", ["value"] = "v", ["domain"] = "." + site, ["path"] = "/" },
                });
            }
            prefs.SetSiteCookies("instagram.com", false);
            prefs.SetSiteCookies("tiktok.com", false);
        }

        private static void Render(FrameworkElement element, string path, Rect? region = null)
        {
            const double scale = 2;
            Rect area = region ?? new Rect(0, 0, Math.Max(1, element.ActualWidth), Math.Max(1, element.ActualHeight));
            double width = area.Width, height = area.Height;
            var visual = new DrawingVisual();
            using (DrawingContext dc = visual.RenderOpen())
            {
                dc.PushTransform(new ScaleTransform(scale, scale));
                dc.DrawRectangle((Brush)Application.Current.FindResource("Brush.Canvas"), null, new Rect(0, 0, width, height));
                dc.DrawRectangle(new VisualBrush(element) { Stretch = Stretch.Fill, Viewbox = area, ViewboxUnits = BrushMappingMode.Absolute },
                    null, new Rect(0, 0, width, height));
                dc.Pop();
            }
            var bitmap = new RenderTargetBitmap((int)(width * scale), (int)(height * scale), 96, 96, PixelFormats.Pbgra32);
            bitmap.Render(visual);
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using (FileStream stream = File.Create(path))
            {
                encoder.Save(stream);
            }
        }

        private static void Pump(TimeSpan duration)
        {
            var frame = new DispatcherFrame();
            var timer = new DispatcherTimer { Interval = duration };
            timer.Tick += (s, e) =>
            {
                timer.Stop();
                frame.Continue = false;
            };
            timer.Start();
            Dispatcher.PushFrame(frame);
        }
    }
}
