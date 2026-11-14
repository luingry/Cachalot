using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using SwissTechKnife.Sdk;
using Cachalot.Module.Downloads;
using Cachalot.Module.Native;

namespace Cachalot.Module.Views
{
    public partial class SettingsView
    {
        private static readonly int[] PlaylistLimits = { 25, 50, 100, 200, 500, 5000 };
        private static readonly int[] Intervals = { 30, 60, 180, 360, 720, 1440 };

        private readonly CachalotModule _module;
        private readonly Preferences _prefs;
        private readonly Dictionary<CheckBox, Action<bool>> _switches;
        private bool _loading = true;

        internal SettingsView(CachalotModule module)
        {
            _module = module;
            _prefs = module.Prefs;
            InitializeComponent();

            _switches = new Dictionary<CheckBox, Action<bool>>
            {
                [OrganizeSwitch] = v => _prefs.OrganizeByPlatform = v,
                [SkipSwitch] = v => _prefs.SkipExisting = v,
                [PlaylistSwitch] = v => _prefs.WholePlaylist = v,
                [PlaylistFolderSwitch] = v => _prefs.PlaylistFolder = v,
                [MetadataSwitch] = v => _prefs.EmbedMetadata = v,
                [ThumbSwitch] = v => _prefs.EmbedThumbnail = v,
                [NfoSwitch] = v => _prefs.WriteNfo = v,
                [ChaptersSwitch] = v => _prefs.SplitChapters = v,
                [LiveSwitch] = v => _prefs.LiveFromStart = v,
                [AutoSubsSwitch] = v => _prefs.AutoSubtitles = v,
                [SleepSwitch] = v => _prefs.PreventSleep = v,
                [NativeSwitch] = v => _prefs.UseNative = v,
                [GallerySwitch] = v => _prefs.UseGallery = v,
                [HeadlessSwitch] = v => _prefs.UseHeadless = v,
                [UpnpSwitch] = v => _prefs.TorrentUpnp = v,
                [TrackersSwitch] = v => _prefs.TorrentTrackers = v,
                [ClipboardSwitch] = v => _prefs.ClipboardSuggest = v,
                [TlsSwitch] = v => _prefs.IgnoreTls = v,
            };

            BridgeSwitch.IsChecked = _prefs.BridgeEnabled;
            BridgeCode.Text = FormatCode(_prefs.BridgeCode);
            OrganizeSwitch.IsChecked = _prefs.OrganizeByPlatform;
            SkipSwitch.IsChecked = _prefs.SkipExisting;
            PlaylistSwitch.IsChecked = _prefs.WholePlaylist;
            PlaylistFolderSwitch.IsChecked = _prefs.PlaylistFolder;
            MetadataSwitch.IsChecked = _prefs.EmbedMetadata;
            ThumbSwitch.IsChecked = _prefs.EmbedThumbnail;
            NfoSwitch.IsChecked = _prefs.WriteNfo;
            ChaptersSwitch.IsChecked = _prefs.SplitChapters;
            LiveSwitch.IsChecked = _prefs.LiveFromStart;
            AutoSubsSwitch.IsChecked = _prefs.AutoSubtitles;
            SleepSwitch.IsChecked = _prefs.PreventSleep;
            NativeSwitch.IsChecked = _prefs.UseNative;
            GallerySwitch.IsChecked = _prefs.UseGallery;
            HeadlessSwitch.IsChecked = _prefs.UseHeadless;
            UpnpSwitch.IsChecked = _prefs.TorrentUpnp;
            TrackersSwitch.IsChecked = _prefs.TorrentTrackers;
            ClipboardSwitch.IsChecked = _prefs.ClipboardSuggest;
            HotkeySwitch.IsChecked = _prefs.HotkeyEnabled;
            TlsSwitch.IsChecked = _prefs.IgnoreTls;
            CookiesSwitch.IsChecked = _prefs.CookiesEnabled;

            Fill(TemplateBox, new[]
            {
                new Option("titulo", "Título"),
                new Option("titulo_id", "Título [id]"),
                new Option("canal_titulo", "Canal - Título"),
                new Option("data_titulo", "Data - Título"),
            }, _prefs.FilenameTemplate);
            Fill(PlaylistLimitBox, PlaylistLimits.Select(n => new Option(n.ToString(CultureInfo.InvariantCulture), n == 5000 ? "Todos" : "Até " + n)),
                 PlaylistLimits.FirstOrDefault(n => n >= _prefs.PlaylistLimit).ToString(CultureInfo.InvariantCulture));
            Fill(RetriesBox, Enumerable.Range(0, 6).Select(n => new Option(n.ToString(CultureInfo.InvariantCulture), n == 0 ? "Nenhuma" : n + (n == 1 ? " tentativa" : " tentativas"))),
                 _prefs.Retries.ToString(CultureInfo.InvariantCulture));
            Fill(BrowserBox, new[]
            {
                new Option(string.Empty, "Não usar"),
                new Option("firefox", "Firefox"),
                new Option("chrome", "Chrome"),
                new Option("edge", "Edge"),
                new Option("brave", "Brave"),
                new Option("opera", "Opera"),
                new Option("vivaldi", "Vivaldi"),
            }, _prefs.CookiesBrowser ?? string.Empty);
            LoadTransientFormat();
            // the extension's "Lembrar escolha" changes it while this view may be alive: show the current one when it reappears
            IsVisibleChanged += (s, e) =>
            {
                if (IsVisible)
                {
                    LoadTransientFormat();
                    BuildCookies(); // sites the extension sent meanwhile
                }
            };

            SubsOff.IsChecked = _prefs.Subtitles == "nao";
            SubsFile.IsChecked = _prefs.Subtitles == "arquivo";
            SubsEmbed.IsChecked = _prefs.Subtitles == "embutir";
            SponsorOff.IsChecked = _prefs.SponsorBlock == "nao";
            SponsorRemove.IsChecked = _prefs.SponsorBlock == "remover";
            SponsorMark.IsChecked = _prefs.SponsorBlock == "marcar";
            SubtitleLanguages.Text = _prefs.SubtitleLanguages;
            ConcurrentSlider.Value = _prefs.MaxConcurrent;
            FragmentsSlider.Value = _prefs.Fragments;
            SpeedLimit.Text = _prefs.SpeedLimit;
            Proxy.Text = _prefs.Proxy;
            TorrentPort.Text = _prefs.TorrentPort.ToString(CultureInfo.InvariantCulture);
            ExtraFlags.Text = _prefs.ExtraFlags;
            ConcurrentValue.Text = _prefs.MaxConcurrent.ToString(CultureInfo.InvariantCulture);
            FragmentsValue.Text = _prefs.Fragments.ToString(CultureInfo.InvariantCulture);
            VersionText.Text = "Cachalot " + (module.Context.ModuleVersion?.ToString(3) ?? string.Empty);

            UpdateBridge();
            UpdateSubtitlePanel();
            UpdateFfmpeg();
            UpdateEngines();
            UpdateCookiesPanel();
            BuildCookies();
            BuildRules();
            BuildChannels();
            UpdateHotkeyHint();

            module.Service.DependenciesChanged += () => Dispatcher.BeginInvoke(new Action(() =>
            {
                UpdateFfmpeg();
                UpdateEngines();
            }));
            module.Channels.Changed += BuildChannels;
            _loading = false;
        }

        // ── generic ──

        private void Save(bool integration = false)
        {
            if (!_loading)
            {
                _module.PreferencesChanged(integration);
            }
        }

        private static void Fill(ComboBox box, IEnumerable<Option> options, string selected)
        {
            List<Option> list = options.ToList();
            box.ItemsSource = list;
            box.SelectedItem = list.FirstOrDefault(o => o.Value == selected) ?? list[0];
        }

        private static string Selected(ComboBox box) => (box.SelectedItem as Option)?.Value ?? string.Empty;

        private void OnSwitch(object sender, RoutedEventArgs e)
        {
            if (_loading || !(sender is CheckBox box) || !_switches.TryGetValue(box, out Action<bool> apply))
            {
                return;
            }
            apply(box.IsChecked == true);
            Save();
        }

        private void OnTextCommitted(object sender, KeyboardFocusChangedEventArgs e)
        {
            if (_loading)
            {
                return;
            }
            _prefs.SubtitleLanguages = SubtitleLanguages.Text.Trim();
            _prefs.SpeedLimit = SpeedLimit.Text.Trim();
            _prefs.Proxy = Proxy.Text.Trim();
            _prefs.ExtraFlags = ExtraFlags.Text.Trim();
            if (int.TryParse(TorrentPort.Text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int port) && port >= 1024 && port <= 65535)
            {
                _prefs.TorrentPort = port;
            }
            else
            {
                TorrentPort.Text = _prefs.TorrentPort.ToString(CultureInfo.InvariantCulture);
            }
            Save();
        }

        private void OnTemplateChanged(object sender, SelectionChangedEventArgs e)
        {
            if (!_loading)
            {
                _prefs.FilenameTemplate = Selected(TemplateBox);
                Save();
            }
        }

        private void OnPlaylistLimitChanged(object sender, SelectionChangedEventArgs e)
        {
            if (!_loading && int.TryParse(Selected(PlaylistLimitBox), out int limit))
            {
                _prefs.PlaylistLimit = limit;
                Save();
            }
        }

        private void OnRetriesChanged(object sender, SelectionChangedEventArgs e)
        {
            if (!_loading && int.TryParse(Selected(RetriesBox), out int retries))
            {
                _prefs.Retries = retries;
                Save();
            }
        }

        private void LoadTransientFormat()
        {
            bool loading = _loading;
            _loading = true;
            Fill(TransientFormatBox, new[] { new Option(TransientFormats.Ask, "Perguntar sempre") }
                .Concat(TransientFormats.All.Select(f => new Option(f, f.ToUpperInvariant()))), TransientFormats.Normalize(_prefs.TransientFormat));
            _loading = loading;
            UpdateTransientFormatHint();
        }

        private void UpdateTransientFormatHint() =>
            TransientFormatHint.Text = TransientFormats.Normalize(_prefs.TransientFormat).Length == 0
                ? "A extensão pergunta MP3, WAV ou FLAC a cada download."
                : "Escolha lembrada pela extensão. “Perguntar sempre” volta a perguntar.";

        private void OnTransientFormatChanged(object sender, SelectionChangedEventArgs e)
        {
            if (!_loading)
            {
                _prefs.TransientFormat = TransientFormats.Normalize(Selected(TransientFormatBox));
                UpdateTransientFormatHint();
                Save();
            }
        }

        private void OnBrowserChanged(object sender, SelectionChangedEventArgs e)
        {
            if (!_loading)
            {
                _prefs.CookiesBrowser = Selected(BrowserBox);
                Save();
            }
        }

        private void OnConcurrentChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        {
            if (ConcurrentValue == null)
            {
                return;
            }
            ConcurrentValue.Text = ((int)ConcurrentSlider.Value).ToString(CultureInfo.InvariantCulture);
            if (!_loading)
            {
                _prefs.MaxConcurrent = (int)ConcurrentSlider.Value;
                Save();
            }
        }

        private void OnFragmentsChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        {
            if (FragmentsValue == null)
            {
                return;
            }
            FragmentsValue.Text = ((int)FragmentsSlider.Value).ToString(CultureInfo.InvariantCulture);
            if (!_loading)
            {
                _prefs.Fragments = (int)FragmentsSlider.Value;
                Save();
            }
        }

        private void OnSubtitlesChanged(object sender, RoutedEventArgs e)
        {
            if (_loading)
            {
                return;
            }
            _prefs.Subtitles = SubsEmbed.IsChecked == true ? "embutir" : SubsFile.IsChecked == true ? "arquivo" : "nao";
            UpdateSubtitlePanel();
            Save();
        }

        private void UpdateSubtitlePanel() => SubtitlePanel.Visibility = _prefs.Subtitles == "nao" ? Visibility.Collapsed : Visibility.Visible;

        private void OnSponsorChanged(object sender, RoutedEventArgs e)
        {
            if (_loading)
            {
                return;
            }
            _prefs.SponsorBlock = SponsorRemove.IsChecked == true ? "remover" : SponsorMark.IsChecked == true ? "marcar" : "nao";
            Save();
        }

        // ── browser extension ──

        private void OnBridgeSwitch(object sender, RoutedEventArgs e)
        {
            if (_loading)
            {
                return;
            }
            _prefs.BridgeEnabled = BridgeSwitch.IsChecked == true;
            Save(integration: true);
            UpdateBridge();
        }

        private void UpdateBridge()
        {
            BridgePanel.Visibility = _prefs.BridgeEnabled ? Visibility.Visible : Visibility.Collapsed;
            var bridge = _module.Bridge;
            BridgeStatus.Text = !_prefs.BridgeEnabled
                ? "Desligado: a extensão não consegue mandar links."
                : bridge != null && bridge.IsRunning
                    ? "Ativo neste PC (127.0.0.1:" + bridge.Port + "). Nada é aceito de sites, só da extensão pareada."
                    : bridge != null ? "Sem porta livre entre 47821 e 47830; feche o que estiver usando." : "Liga junto com o SwissTechKnife.";
        }

        private void OnCopyCode(object sender, RoutedEventArgs e)
        {
            try
            {
                Clipboard.SetText(_prefs.BridgeCode);
                _module.Context.Notify("Código copiado. Cole na extensão do Cachalot.", NotificationKind.Success);
            }
            catch (System.Runtime.InteropServices.COMException)
            {
            }
        }

        private void OnNewCode(object sender, RoutedEventArgs e)
        {
            _prefs.BridgeCode = Preferences.NewBridgeCode();
            BridgeCode.Text = FormatCode(_prefs.BridgeCode);
            Save();
            _module.Extension.PairingChanged();
        }

        private static string FormatCode(string code) => string.IsNullOrEmpty(code) || code.Length != 8 ? code : code.Substring(0, 4) + " " + code.Substring(4);

        private void OnInstallExtension(object sender, RoutedEventArgs e) => _module.Extension.Show();

        // ── shortcuts ──

        private void OnHotkeySwitch(object sender, RoutedEventArgs e)
        {
            if (_loading)
            {
                return;
            }
            _prefs.HotkeyEnabled = HotkeySwitch.IsChecked == true;
            Save(integration: true);
            UpdateHotkeyHint();
        }

        private void UpdateHotkeyHint()
        {
            if (_prefs.HotkeyEnabled && !_module.HotKeyActive)
            {
                HotkeyHint.Text = "Outro programa já usa Ctrl + Alt + D. Feche-o e ligue de novo.";
                HotkeyHint.SetResourceReference(TextBlock.ForegroundProperty, "Brush.Warning");
            }
            else
            {
                HotkeyHint.Text = "Funciona em qualquer app, com a qualidade escolhida na página.";
                HotkeyHint.SetResourceReference(TextBlock.ForegroundProperty, "Brush.Text.Tertiary");
            }
        }

        // ── engines ──

        private void UpdateFfmpeg()
        {
            string configured = _prefs.FfmpegPath;
            string detected = Dep("ffmpeg");
            if (!string.IsNullOrEmpty(configured))
            {
                FfmpegText.Text = (File.Exists(configured) || Directory.Exists(configured) ? "Usando " : "Não encontrado: ") + configured;
            }
            else if (_module.Service.Dependencies == null)
            {
                FfmpegText.Text = "Automático (procura no PATH). Clique em Verificar para ver qual.";
            }
            else
            {
                FfmpegText.Text = string.IsNullOrEmpty(detected)
                    ? "Não encontrado: vídeos ficam no formato que o site entrega, sem juntar, converter ou embutir. Instale com winget install Gyan.FFmpeg."
                    : "Automático: " + detected;
            }
            FfmpegAuto.Visibility = string.IsNullOrEmpty(configured) ? Visibility.Collapsed : Visibility.Visible;
        }

        private void UpdateEngines()
        {
            if (_module.Service.Dependencies == null)
            {
                EngineText.Text = "yt-dlp e Python: clique em Verificar (inicia o motor por alguns minutos).";
                return;
            }
            string js = Dep("js");
            EngineText.Text = string.Join(" · ", new[]
            {
                "yt-dlp " + Dep("yt_dlp"),
                "Python " + Dep("python"),
                string.IsNullOrEmpty(js) ? "sem runtime JavaScript (YouTube pode vir em qualidade menor)" : "JavaScript: " + js,
                Dep("gallery_dl") == "True" ? "galerias prontas" : "galerias no 1º uso",
                Dep("libtorrent") == "True" ? "torrent pronto" : "torrent no 1º uso",
            });
        }

        private string Dep(string key)
        {
            Dictionary<string, object> deps = _module.Service.Dependencies;
            return deps != null && deps.TryGetValue(key, out object v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : string.Empty;
        }

        private void OnCheckEngines(object sender, RoutedEventArgs e)
        {
            EngineText.Text = "Verificando…";
            _module.Service.RequestDependencies();
        }

        private void OnFfmpegAuto(object sender, RoutedEventArgs e)
        {
            _prefs.FfmpegPath = string.Empty;
            Save();
            UpdateFfmpeg();
        }

        private void OnFfmpegBrowse(object sender, RoutedEventArgs e)
        {
            var dialog = new Microsoft.Win32.OpenFileDialog { Title = "Localizar o ffmpeg.exe", Filter = "ffmpeg.exe|ffmpeg.exe|Programas (*.exe)|*.exe" };
            if (dialog.ShowDialog(Window.GetWindow(this)) == true)
            {
                _prefs.FfmpegPath = dialog.FileName;
                Save();
                UpdateFfmpeg();
            }
        }

        private void OnOpenLog(object sender, RoutedEventArgs e) => _module.Service.OpenLog();

        // ── cookies ──

        private void OnCookiesSwitch(object sender, RoutedEventArgs e)
        {
            if (_loading)
            {
                return;
            }
            _prefs.CookiesEnabled = CookiesSwitch.IsChecked == true;
            UpdateCookiesPanel();
            Save();
        }

        /// <summary>With cookies off nothing below applies (no site gets any), so the per-site controls are hidden.</summary>
        private void UpdateCookiesPanel()
        {
            CookiesPanel.Visibility = _prefs.CookiesEnabled ? Visibility.Visible : Visibility.Collapsed;
            CookiesStatus.Text = _prefs.CookiesEnabled
                ? "A extensão manda os cookies da página junto com o link. Desligue abaixo os sites em que eles não devem ser usados."
                : "Desligado: nenhum download usa cookies, nem os salvos, nem os do navegador. O que a extensão mandar é descartado.";
        }

        /// <summary>Sites with stored cookies plus the disabled ones without any, each with its own switch.</summary>
        private void BuildCookies()
        {
            CookieList.Children.Clear();
            IReadOnlyList<CookieSite> stored = _module.Service.Cookies.List();
            CookieEmpty.Visibility = stored.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            var rows = stored.Select(s => (Domain: s.Domain, Site: s))
                .Concat(_prefs.CookiesDisabledSites
                    .Where(d => !stored.Any(s => string.Equals(s.Domain, d, StringComparison.OrdinalIgnoreCase)))
                    .Select(d => (Domain: d, Site: (CookieSite)null)))
                .OrderBy(r => r.Domain, StringComparer.OrdinalIgnoreCase)
                .ToList();
            foreach (var row in rows)
            {
                CookieList.Children.Add(CookieRow(row.Domain, row.Site));
            }
        }

        private FrameworkElement CookieRow(string domain, CookieSite site)
        {
            var row = new Grid { Margin = new Thickness(0, 10, 0, 0) };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var text = new StackPanel();
            text.Children.Add(Label(domain, "Text.BodyStrong"));
            TextBlock caption = Label(string.Empty, "Text.Caption");
            caption.TextWrapping = TextWrapping.Wrap;
            text.Children.Add(caption);
            var use = new CheckBox { Content = text, IsChecked = _prefs.CookiesAllowedFor(domain), VerticalAlignment = VerticalAlignment.Center, ToolTip = "Usar os cookies de " + domain };
            use.SetResourceReference(StyleProperty, "Switch");
            System.Windows.Automation.AutomationProperties.SetName(use, "Usar os cookies de " + domain);
            void Describe() => caption.Text = use.IsChecked == true
                ? (site == null ? "Nenhum cookie salvo ainda" : site.Count + " cookies · " + Age(site.Modified))
                : (site == null ? "Desligado · nenhum cookie salvo" : "Desligado · " + site.Count + " cookies guardados, sem uso");
            Describe();
            RoutedEventHandler toggled = (s, e) =>
            {
                _prefs.SetSiteCookies(domain, use.IsChecked == true);
                Describe();
                Save();
            };
            use.Checked += toggled;
            use.Unchecked += toggled;
            row.Children.Add(use);
            var remove = IconButton("", "Apagar os cookies de " + domain);
            remove.Margin = new Thickness(8, 0, 0, 0);
            if (site == null)
            {
                remove.Visibility = Visibility.Hidden; // nothing to delete; keeps the switches aligned
            }
            remove.Click += (s, e) =>
            {
                _module.Service.Cookies.Delete(domain);
                BuildCookies();
            };
            Grid.SetColumn(remove, 1);
            row.Children.Add(remove);
            return row;
        }

        private void OnCookieSiteKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.Enter)
            {
                e.Handled = true;
                OnAddCookieSite(sender, e);
            }
        }

        private void OnAddCookieSite(object sender, RoutedEventArgs e)
        {
            string site = Preferences.NormalizeSite(CookieSiteBox.Text);
            if (site.Length == 0)
            {
                CookieSiteBox.Focus();
                return;
            }
            _prefs.SetSiteCookies(site, false);
            CookieSiteBox.Clear();
            Save();
            BuildCookies();
        }

        private void OnImportCookies(object sender, RoutedEventArgs e)
        {
            var dialog = new Microsoft.Win32.OpenFileDialog { Title = "Importar cookies.txt (formato Netscape)", Filter = "cookies.txt|*.txt|Todos os arquivos (*.*)|*.*" };
            if (dialog.ShowDialog(Window.GetWindow(this)) != true)
            {
                return;
            }
            try
            {
                IReadOnlyList<string> sites = _module.Service.Cookies.Import(dialog.FileName);
                _module.Context.Notify(sites.Count == 0 ? "Nenhum cookie no formato Netscape nesse arquivo." : "Cookies importados: " + string.Join(", ", sites),
                    sites.Count == 0 ? NotificationKind.Warning : NotificationKind.Success);
            }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException)
            {
                _module.Context.Notify("Não deu para ler o arquivo: " + error.Message, NotificationKind.Error);
            }
            BuildCookies();
        }

        // ── rules ──

        private void OnAddRule(object sender, RoutedEventArgs e)
        {
            _prefs.Rules.Add(new Rule());
            BuildRules();
            Save();
        }

        private void BuildRules()
        {
            RuleList.Children.Clear();
            foreach (Rule rule in _prefs.Rules.ToList())
            {
                RuleList.Children.Add(RuleRow(rule));
            }
        }

        private FrameworkElement RuleRow(Rule rule)
        {
            var panel = new StackPanel();
            var top = new Grid();
            top.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(150) });
            top.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var when = new ComboBox { VerticalAlignment = VerticalAlignment.Center };
            Fill(when, new[] { new Option("site", "Site é"), new Option("contem", "Link contém"), new Option("plataforma", "Plataforma é") }, rule.When);
            var value = new TextBox { Text = rule.Value, Margin = new Thickness(8, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            Ui.SetPlaceholder(value, "youtube.com, /shorts/, soundcloud…");
            var remove = IconButton("", "Remover a regra");
            remove.Margin = new Thickness(6, 0, 0, 0);
            Grid.SetColumn(value, 1);
            Grid.SetColumn(remove, 2);
            top.Children.Add(when);
            top.Children.Add(value);
            top.Children.Add(remove);

            var bottom = new Grid { Margin = new Thickness(0, 8, 0, 0) };
            bottom.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            bottom.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(190) });
            var folder = new Button { HorizontalContentAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Center };
            folder.SetResourceReference(StyleProperty, "Button.Secondary");
            Ui.SetIcon(folder, "");
            folder.Content = string.IsNullOrEmpty(rule.Folder) ? "Mesma pasta" : ShortFolder(rule.Folder);
            folder.ToolTip = string.IsNullOrEmpty(rule.Folder) ? "Salvar em outra pasta" : rule.Folder;
            var format = new ComboBox { Margin = new Thickness(8, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            var formats = new List<Option> { new Option("|", "Formato da página") };
            formats.AddRange(VideoQualities.All.Select(q => new Option("video|" + q, "Vídeo · " + VideoQualities.Label(q))));
            formats.Add(new Option("audio|", "Áudio"));
            Fill(format, formats, (rule.Mode ?? string.Empty) + "|" + (rule.Mode == Modes.Audio ? string.Empty : rule.Quality ?? string.Empty));
            Grid.SetColumn(format, 1);
            bottom.Children.Add(folder);
            bottom.Children.Add(format);

            panel.Children.Add(top);
            panel.Children.Add(bottom);
            var box = new Border { Padding = new Thickness(12), Margin = new Thickness(0, 10, 0, 0), Child = panel };
            box.SetResourceReference(Border.BackgroundProperty, "Brush.Surface1");
            box.SetResourceReference(Border.CornerRadiusProperty, "Radius.Md");

            when.SelectionChanged += (s, e) => { rule.When = Selected(when); Save(); };
            value.LostKeyboardFocus += (s, e) => { rule.Value = value.Text.Trim(); Save(); };
            remove.Click += (s, e) =>
            {
                _prefs.Rules.Remove(rule);
                RuleList.Children.Remove(box);
                Save();
            };
            folder.Click += (s, e) =>
            {
                string picked;
                try
                {
                    picked = FolderPicker.Pick(Window.GetWindow(this), "Pasta para esta regra", rule.Folder);
                }
                catch (Exception error) when (error is System.Runtime.InteropServices.COMException || error is InvalidCastException)
                {
                    return;
                }
                if (picked != null)
                {
                    rule.Folder = picked;
                    folder.Content = ShortFolder(picked);
                    folder.ToolTip = picked;
                    Save();
                }
            };
            format.SelectionChanged += (s, e) =>
            {
                string[] parts = Selected(format).Split('|');
                rule.Mode = parts[0];
                rule.Quality = parts.Length > 1 ? parts[1] : string.Empty;
                Save();
            };
            return box;
        }

        private static string ShortFolder(string folder)
        {
            string name = Path.GetFileName(folder.TrimEnd('\\', '/'));
            return string.IsNullOrEmpty(name) ? folder : name;
        }

        // ── channels ──

        private void OnChannelKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.Enter)
            {
                e.Handled = true;
                OnFollow(sender, e);
            }
        }

        private async void OnFollow(object sender, RoutedEventArgs e)
        {
            string url = ClipboardLinks.First(ChannelUrl.Text) ?? string.Empty;
            if (!url.StartsWith("http", StringComparison.OrdinalIgnoreCase))
            {
                ChannelUrl.Focus();
                return;
            }
            if (_prefs.Channels.Any(c => string.Equals(c.Url, url, StringComparison.OrdinalIgnoreCase)))
            {
                _module.Context.Notify("Esse canal já está na lista.", NotificationKind.Info);
                return;
            }
            var channel = new Channel { Id = Guid.NewGuid().ToString("N").Substring(0, 10), Url = url, Title = ClipboardLinks.Short(url) };
            _prefs.Channels.Add(channel);
            ChannelUrl.Clear();
            Save();
            BuildChannels();
            await _module.Channels.CheckNowAsync(channel);
        }

        private void BuildChannels()
        {
            ChannelList.Children.Clear();
            foreach (Channel channel in _prefs.Channels.ToList())
            {
                ChannelList.Children.Add(ChannelRow(channel));
            }
        }

        private FrameworkElement ChannelRow(Channel channel)
        {
            var panel = new StackPanel();
            var head = new Grid();
            head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 12, 0) };
            TextBlock title = Label(string.IsNullOrEmpty(channel.Title) ? channel.Url : channel.Title, "Text.BodyStrong");
            title.TextTrimming = TextTrimming.CharacterEllipsis;
            title.ToolTip = channel.Url;
            text.Children.Add(title);
            TextBlock status = Label(ChannelStatus(channel), "Text.Caption");
            status.TextWrapping = TextWrapping.Wrap;
            if (!string.IsNullOrEmpty(channel.LastError))
            {
                status.SetResourceReference(TextBlock.ForegroundProperty, "Brush.Warning");
            }
            text.Children.Add(status);
            head.Children.Add(text);
            var actions = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Top };
            if (channel.NewItems.Count > 0)
            {
                var get = new Button { Content = "Baixar " + channel.NewItems.Count };
                get.SetResourceReference(StyleProperty, "Button.Secondary");
                Ui.SetIcon(get, "");
                get.Click += async (s, e) => await _module.Channels.DownloadNewAsync(channel);
                actions.Children.Add(get);
            }
            var check = IconButton("", "Verificar agora");
            check.IsEnabled = !_module.Channels.IsChecking;
            check.Margin = new Thickness(6, 0, 0, 0);
            check.Click += async (s, e) => await _module.Channels.CheckNowAsync(channel);
            var remove = IconButton("", "Deixar de seguir");
            remove.Margin = new Thickness(4, 0, 0, 0);
            remove.Click += (s, e) =>
            {
                _prefs.Channels.Remove(channel);
                Save(integration: true);
                BuildChannels();
            };
            actions.Children.Add(check);
            actions.Children.Add(remove);
            Grid.SetColumn(actions, 1);
            head.Children.Add(actions);

            var options = new Grid { Margin = new Thickness(0, 10, 0, 0) };
            options.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            options.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(170) });
            var auto = new CheckBox { IsChecked = channel.AutoDownload, Content = Label("Baixar os novos sozinho", "Text.Body"), VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 16, 0) };
            auto.SetResourceReference(StyleProperty, "Switch");
            var interval = new ComboBox { VerticalAlignment = VerticalAlignment.Center };
            Fill(interval, Intervals.Select(m => new Option(m.ToString(CultureInfo.InvariantCulture), "A cada " + (m < 60 ? m + " min" : m / 60 + (m == 60 ? " hora" : " horas")))),
                 (Intervals.FirstOrDefault(m => m >= channel.IntervalMinutes) == 0 ? 60 : Intervals.First(m => m >= channel.IntervalMinutes)).ToString(CultureInfo.InvariantCulture));
            Grid.SetColumn(interval, 1);
            options.Children.Add(auto);
            options.Children.Add(interval);
            auto.Checked += (s, e) => { channel.AutoDownload = true; Save(); };
            auto.Unchecked += (s, e) => { channel.AutoDownload = false; Save(); };
            interval.SelectionChanged += (s, e) =>
            {
                if (int.TryParse(Selected(interval), out int minutes))
                {
                    channel.IntervalMinutes = minutes;
                    Save(integration: true);
                }
            };

            panel.Children.Add(head);
            panel.Children.Add(options);
            var box = new Border { Padding = new Thickness(12), Margin = new Thickness(0, 10, 0, 0), Child = panel };
            box.SetResourceReference(Border.BackgroundProperty, "Brush.Surface1");
            box.SetResourceReference(Border.CornerRadiusProperty, "Radius.Md");
            return box;
        }

        private string ChannelStatus(Channel channel)
        {
            if (_module.Channels.IsChecking && channel.LastCheckedTs <= 0)
            {
                return "Verificando…";
            }
            if (!string.IsNullOrEmpty(channel.LastError))
            {
                return channel.LastError;
            }
            if (channel.LastCheckedTs <= 0)
            {
                return "Ainda não verificado";
            }
            DateTime when = DateTimeOffset.FromUnixTimeMilliseconds((long)(channel.LastCheckedTs * 1000)).LocalDateTime;
            string news = channel.NewItems.Count == 0 ? "nada novo" : channel.NewItems.Count == 1 ? "1 novo" : channel.NewItems.Count + " novos";
            return "Verificado " + Age(when) + " · " + news;
        }

        // ── helpers ──

        private static string Age(DateTime when)
        {
            TimeSpan age = DateTime.Now - when;
            if (age.TotalMinutes < 1)
            {
                return "agora";
            }
            if (age.TotalHours < 1)
            {
                return "há " + (int)age.TotalMinutes + " min";
            }
            if (age.TotalDays < 1)
            {
                return "há " + (int)age.TotalHours + " h";
            }
            return "em " + when.ToString("dd/MM", CultureInfo.GetCultureInfo("pt-BR"));
        }

        private static TextBlock Label(string text, string style)
        {
            var block = new TextBlock { Text = text };
            block.SetResourceReference(StyleProperty, style);
            return block;
        }

        private static Button IconButton(string glyph, string tip)
        {
            var button = new Button { ToolTip = tip, VerticalAlignment = VerticalAlignment.Center };
            button.SetResourceReference(StyleProperty, "Button.Icon.Sm");
            Ui.SetIcon(button, glyph);
            return button;
        }
    }
}
