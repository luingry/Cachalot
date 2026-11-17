using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using SwissTechKnife.Sdk;
using Cachalot.Module.Bridge;
using Cachalot.Module.Channels;
using Cachalot.Module.Downloads;
using Cachalot.Module.Native;
using Cachalot.Module.Setup;
using Cachalot.Module.Views;

namespace Cachalot.Module
{
    /// <summary>
    /// SwissTechKnife entry point. Starts with the host only for what must listen without the page open — the
    /// browser-extension bridge, followed channels and the optional global shortcut; none of them polls. The
    /// download service (and the hidden Python backend) is created on first use.
    /// </summary>
    public sealed class CachalotModule : IBackgroundModule, IModuleSettings, IModuleTrayMenu
    {
        private const uint VirtualKeyD = 0x44;

        private IModuleContext _context;
        private PreferencesStore _prefsStore;
        private Preferences _prefs;
        private DownloadService _service;
        private LocalBridge _bridge;
        private ChannelWatcher _channels;
        private GlobalHotKey _hotKey;
        private ExtensionSetup _extension;
        private bool _started;

        public void Initialize(IModuleContext context)
        {
            _context = context;
            Directory.CreateDirectory(context.DataDirectory);
            _prefsStore = new PreferencesStore(context.DataDirectory);
            _prefs = _prefsStore.Load();
            if (_prefs.NeedsSave)
            {
                _prefs.NeedsSave = false;
                _prefsStore.Save(_prefs);
            }
        }

        public void Start()
        {
            _started = true;
            _channels = new ChannelWatcher(_context, _prefs, () => Service);
            _channels.Start();
            ApplyIntegration();
            // Idle priority: after the host finished starting; reads Chrome's files off the UI thread.
            _context.Dispatcher.BeginInvoke(new Action(() => Extension.OnStartup()), System.Windows.Threading.DispatcherPriority.ApplicationIdle);
        }

        public void Stop()
        {
            _started = false;
            _channels?.Dispose();
            _channels = null;
            _bridge?.Dispose();
            _bridge = null;
            _hotKey?.Dispose();
            _hotKey = null;
        }

        public FrameworkElement CreateView() => new DownloadsPage(Service, _context, this);

        public FrameworkElement CreateSettingsView() => new SettingsView(this);

        public IEnumerable<Control> CreateTrayMenuItems()
        {
            var items = new List<Control>();
            var clipboard = new MenuItem { Header = "Baixar o link copiado" };
            clipboard.Click += async (s, e) => await DownloadClipboardAsync();
            items.Add(clipboard);
            if (_service != null && _service.HasPausable)
            {
                var pause = new MenuItem { Header = "Pausar todos" };
                pause.Click += (s, e) => _service.PauseAll();
                items.Add(pause);
            }
            if (_service != null && _service.HasPaused)
            {
                var resume = new MenuItem { Header = "Retomar todos" };
                resume.Click += async (s, e) => await _service.ResumeAllAsync();
                items.Add(resume);
            }
            var folder = new MenuItem { Header = "Abrir a pasta de downloads" };
            folder.Click += (s, e) => OpenFolder(_service?.State.Folder ?? KnownFolders.Downloads());
            items.Add(folder);
            return items;
        }

        public void Dispose()
        {
            Stop();
            _service?.Dispose();
            _service = null;
        }

        internal IModuleContext Context => _context;

        internal Preferences Prefs => _prefs;

        internal DownloadService Service => _service ?? (_service = new DownloadService(_context, _prefs, _prefsStore));

        internal ChannelWatcher Channels => _channels ?? (_channels = new ChannelWatcher(_context, _prefs, () => Service));

        internal LocalBridge Bridge => _bridge;

        internal bool HotKeyActive => _hotKey?.IsRegistered == true;

        /// <summary>Folder that Chrome loads the unpacked extension from (stable across module updates).</summary>
        internal string ExtensionFolder => Path.Combine(_context.DataDirectory, "extensao-chrome");

        /// <summary>Guided install, update and pairing of the Chrome extension.</summary>
        internal ExtensionSetup Extension => _extension ?? (_extension = new ExtensionSetup(this, Path.Combine(_context.InstallDirectory, "extension", "chrome"), ExtensionFolder));

        /// <summary>Settings changed: save, update a running backend and turn the listeners on or off.</summary>
        internal void PreferencesChanged(bool integration = false)
        {
            if (_service != null)
            {
                _service.PreferencesChanged();
            }
            else
            {
                _prefsStore.Save(_prefs);
            }
            if (integration)
            {
                ApplyIntegration();
            }
        }

        internal void ApplyIntegration()
        {
            if (!_started)
            {
                return;
            }
            if (_prefs.BridgeEnabled && _bridge == null)
            {
                var transient = new TransientBridge(_context, () => Service);
                _bridge = new LocalBridge(() => _prefs.BridgeCode, _context.ModuleVersion?.ToString(3) ?? "0.0.0", _context.Log)
                {
                    TransientRequested = transient.HandleAsync,
                    TransientPcmRequested = transient.PcmAsync,
                    DownloadRequested = OnBridgeDownloadAsync,
                    CookiesReceived = OnBridgeCookies,
                    DownloadsRequested = OnBridgeDownloads,
                    OpenFolderRequested = OnBridgeOpenFolder,
                    ShowRequested = OnBridgeShow,
                    CancelRequested = OnBridgeCancel,
                    AudioFormatRequested = OnBridgeAudioFormat,
                };
                _bridge.Start();
            }
            else if (!_prefs.BridgeEnabled && _bridge != null)
            {
                _bridge.Dispose();
                _bridge = null;
            }

            if (_prefs.HotkeyEnabled && _hotKey == null)
            {
                _hotKey = new GlobalHotKey(GlobalHotKey.ModControl | GlobalHotKey.ModAlt, VirtualKeyD, () => _ = DownloadClipboardAsync());
                if (!_hotKey.IsRegistered)
                {
                    _context.Log.Warn("Ctrl+Alt+D is already taken by another app.");
                }
            }
            else if (!_prefs.HotkeyEnabled && _hotKey != null)
            {
                _hotKey.Dispose();
                _hotKey = null;
            }
            _channels?.Reschedule();
        }

        /// <summary>Global shortcut and tray: queues the copied link with the page's current choices.</summary>
        internal async Task DownloadClipboardAsync()
        {
            string link = ClipboardLinks.Read();
            if (link == null)
            {
                _context.Notify("Copie um link antes de usar o atalho.", NotificationKind.Warning);
                return;
            }
            DownloadService service = Service;
            bool sent = await service.AddAsync(new[] { link }, service.State.Folder ?? service.DefaultFolder);
            _context.Notify(sent ? "Na fila: " + ClipboardLinks.Short(link) : "O Cachalot não respondeu. Tente de novo.",
                sent ? NotificationKind.Info : NotificationKind.Warning);
        }

        /// <summary>
        /// Answers the extension at once (the backend may take seconds to start) and queues in the background;
        /// the toast tells whether it worked.
        /// </summary>
        private async Task<int> OnBridgeDownloadAsync(BridgeDownload request)
        {
            await _context.Dispatcher.BeginInvoke(new Action(() =>
            {
                DownloadService service = Service;
                string origin = request.PageUrl.Length > 0 ? request.PageUrl : request.Urls[0];
                if (request.Cookies.Count > 0 && Uri.TryCreate(origin, UriKind.Absolute, out Uri page))
                {
                    try
                    {
                        service.SaveBrowserCookies(page.Host, request.Cookies);
                    }
                    catch (Exception error) when (error is IOException || error is UnauthorizedAccessException)
                    {
                        _context.Log.Warn("Could not save the browser cookies: " + error.Message);
                    }
                }
                _ = QueueFromBrowserAsync(service, request);
            }));
            return request.Urls.Count;
        }

        private async Task QueueFromBrowserAsync(DownloadService service, BridgeDownload request)
        {
            string origin = request.PageUrl.Length > 0 ? request.PageUrl : request.Urls[0];
            string format = AudioFormats.All.Contains(request.AudioFormat) ? request.AudioFormat : null;
            if (format != null && request.RememberFormat && service.Prefs.SetSiteAudioFormat(origin, format))
            {
                service.PreferencesChanged();
            }
            string remembered = service.Prefs.AudioFormatFor(origin);
            bool sent = await service.AddAsync(request.Urls, service.State.Folder ?? service.DefaultFolder, new AddRequest
            {
                Mode = string.IsNullOrEmpty(request.Mode) ? null : Modes.Normalize(request.Mode),
                AudioFormat = format ?? (remembered.Length > 0 ? remembered : null),
                Title = request.Title,
                Headers = request.Headers,
            });
            string what = request.Urls.Count == 1
                ? (string.IsNullOrEmpty(request.Title) ? ClipboardLinks.Short(request.Urls[0]) : request.Title)
                : request.Urls.Count + " links";
            _context.Notify(sent ? "Recebido do navegador: " + what : "O Cachalot não conseguiu iniciar o download de " + what + ".",
                sent ? NotificationKind.Info : NotificationKind.Warning);
        }

        /// <summary>Sites whose downloads always come out as audio (the extension's MUSIC_PLATFORMS).</summary>
        private static readonly string[] MusicSites = { "soundcloud.com", "bandcamp.com", "mixcloud.com", "audiomack.com" };

        /// <summary>
        /// POST /audio-format: whether a download sent by the extension comes out as audio (asked mode, a matching rule,
        /// the page's mode, or a music site) and the format remembered for its site (empty: the extension asks).
        /// </summary>
        private Dictionary<string, object> OnBridgeAudioFormat(BridgeDownload request)
        {
            string url = request.Urls.FirstOrDefault() ?? string.Empty;
            string origin = request.PageUrl.Length > 0 ? request.PageUrl : url;
            var reply = new Dictionary<string, object>();
            _context.Dispatcher.Invoke(new Action(() =>
            {
                reply["audio"] = WillBeAudio(_prefs, url.Length > 0 ? url : origin, origin, request.Mode);
                reply["format"] = _prefs.AudioFormatFor(origin);
                reply["site"] = Preferences.NormalizeSite(origin);
            }));
            return reply;
        }

        internal static bool WillBeAudio(Preferences prefs, string url, string pageUrl, string mode)
        {
            if (!string.IsNullOrEmpty(mode))
            {
                return Modes.Normalize(mode) == Modes.Audio;
            }
            string link = (url ?? string.Empty).ToLowerInvariant();
            string host = Uri.TryCreate(url ?? string.Empty, UriKind.Absolute, out Uri u) ? u.Host.ToLowerInvariant() : string.Empty;
            string pageHost = Uri.TryCreate(pageUrl ?? string.Empty, UriKind.Absolute, out Uri p) ? p.Host.ToLowerInvariant() : host;
            foreach (Rule rule in prefs.Rules.Where(r => r.Active && !string.IsNullOrWhiteSpace(r.Value)))
            {
                string value = rule.Value.Trim().ToLowerInvariant();
                string site = value.StartsWith("www.", StringComparison.Ordinal) ? value.Substring(4) : value;
                bool matches = rule.When == "contem" ? link.Contains(value)
                    : rule.When == "plataforma" ? host.Contains(site)
                    : host == site || host.EndsWith("." + site, StringComparison.Ordinal);
                if (matches)
                {
                    // the backend's first matching rule wins (servidor.aplicar_regras); without a mode it keeps the page's
                    return string.IsNullOrEmpty(rule.Mode) ? IsMusicHost(host) || IsMusicHost(pageHost) || prefs.Mode == Modes.Audio : rule.Mode == Modes.Audio;
                }
            }
            return prefs.Mode == Modes.Audio || IsMusicHost(host) || IsMusicHost(pageHost);
        }

        private static bool IsMusicHost(string host) =>
            MusicSites.Any(s => host == s || host.EndsWith("." + s, StringComparison.Ordinal));

        private int OnBridgeCookies(string domain, List<Dictionary<string, object>> cookies)
        {
            int count = 0;
            _context.Dispatcher.Invoke(new Action(() => count = Service.SaveBrowserCookies(domain, cookies)));
            return count;
        }

        /// <summary>
        /// Active downloads and the latest finished ones. Creating the service only reads state.json (the
        /// backend starts with the first download), so a fresh host still knows what was downloaded.
        /// </summary>
        private List<Dictionary<string, object>> OnBridgeDownloads()
        {
            var items = new List<Dictionary<string, object>>();
            _context.Dispatcher.Invoke(new Action(() =>
            {
                DownloadService service = Service;
                foreach (DownloadItem item in service.Active.Concat(service.Completed.Take(100)))
                {
                    items.Add(new Dictionary<string, object>
                    {
                        ["id"] = item.Id ?? string.Empty,
                        ["url"] = item.Url ?? string.Empty,
                        ["status"] = item.Status,
                        ["progress"] = Math.Round(item.Progress, 1),
                        ["title"] = item.Title ?? string.Empty,
                        ["speed"] = item.Speed ?? string.Empty,
                        ["eta"] = item.Eta ?? string.Empty,
                        ["phase"] = item.Phase ?? string.Empty,
                        ["error"] = item.Error ?? string.Empty,
                        ["created"] = item.CreatedTs,
                    });
                }
            }));
            return items;
        }

        /// <summary>The extension's button hovered as "Cancelar": same as removing the item on the page.</summary>
        private bool OnBridgeCancel(string id)
        {
            bool cancelled = false;
            _context.Dispatcher.Invoke(new Action(() =>
            {
                DownloadService service = Service;
                DownloadItem item = service.Active.FirstOrDefault(i => i.Id == id);
                if (item != null)
                {
                    service.Remove(item);
                    cancelled = true;
                }
            }));
            return cancelled;
        }

        /// <summary>The extension's Cachalot button: the host window on this page, in front of the browser.</summary>
        private void OnBridgeShow()
        {
            _context.Dispatcher.Invoke(new Action(() =>
            {
                _context.ShowModulePage();
                System.Windows.Window main = System.Windows.Application.Current?.MainWindow;
                if (main != null)
                {
                    Foreground.Activate(new System.Windows.Interop.WindowInteropHelper(main).Handle);
                }
            }));
        }

        /// <summary>The extension's folder button next to "✓ Baixado": Explorer with the file selected.</summary>
        private bool OnBridgeOpenFolder(string id)
        {
            bool opened = false;
            _context.Dispatcher.Invoke(new Action(() =>
            {
                DownloadService service = Service;
                DownloadItem item = service.Completed.Concat(service.Active).FirstOrDefault(i => i.Id == id);
                opened = item != null && item.CanOpenFolder && service.OpenFolder(item, bringForward: true);
            }));
            return opened;
        }

        private static void OpenFolder(string folder)
        {
            try
            {
                if (Directory.Exists(folder))
                {
                    Process.Start(new ProcessStartInfo(folder) { UseShellExecute = true });
                }
            }
            catch (System.ComponentModel.Win32Exception)
            {
            }
        }
    }
}
