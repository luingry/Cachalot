using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using SwissTechKnife.Sdk;
using Cachalot.Module.Backend;
using Cachalot.Module.Downloads;
using Cachalot.Module.Native;

namespace Cachalot.Module.Views
{
    /// <summary>Value + label for the combo boxes (ToString is what the closed box shows).</summary>
    internal sealed class Option
    {
        public Option(string value, string label)
        {
            Value = value;
            Label = label;
        }

        public string Value { get; }
        public string Label { get; }

        public override string ToString() => Label;
    }

    public partial class DownloadsPage : IModuleViewLifecycle
    {
        private static readonly char[] LineBreaks = { '\r', '\n' };

        private readonly DownloadService _service;
        private readonly IModuleContext _context;
        private readonly CachalotModule _module;
        private readonly DispatcherTimer _clearConfirm;
        private bool _loading = true;
        private bool _visible;
        private BackendState? _shownState;
        private string _clipboardLink;
        private string _lastOffered;
        private Window _window;

        internal DownloadsPage(DownloadService service, IModuleContext context, CachalotModule module)
        {
            _service = service;
            _context = context;
            _module = module;
            InitializeComponent();

            UrlInput.Text = service.State.Draft;
            if (service.Prefs.Mode == Modes.Audio)
            {
                AudioOption.IsChecked = true;
            }
            else
            {
                VideoOption.IsChecked = true;
            }
            FillQualities();
            RefreshFolders();

            ActiveList.ItemsSource = service.Active;
            CompletedList.ItemsSource = service.Completed;
            service.Active.CollectionChanged += OnListsChanged;
            service.Completed.CollectionChanged += OnListsChanged;
            service.BackendStateChanged += ApplyBackendState;
            foreach (DownloadItem item in service.Active)
            {
                item.PropertyChanged += OnItemChanged;
            }

            _clearConfirm = new DispatcherTimer(TimeSpan.FromSeconds(3), DispatcherPriority.Normal, (s, e) => ResetClear(), Dispatcher);
            _clearConfirm.Stop();

            Loaded += (s, e) => AttachWindow();
            Unloaded += (s, e) => DetachWindow();

            UpdateLists();
            UpdateSortButton();
            ApplyBackendState();
            _loading = false;
        }

        public void OnViewShown()
        {
            _visible = true;
            _service.Backend.EnsureStarted(); // warm up: Python and yt-dlp take a moment to load
            OfferClipboard();
        }

        public void OnViewHidden() => _visible = false;

        private void AttachWindow()
        {
            DetachWindow();
            _window = Window.GetWindow(this);
            if (_window != null)
            {
                _window.Activated += OnWindowActivated;
            }
        }

        private void DetachWindow()
        {
            if (_window != null)
            {
                _window.Activated -= OnWindowActivated;
                _window = null;
            }
        }

        /// <summary>Coming back from the browser with a link copied: offer it (no clipboard polling).</summary>
        private void OnWindowActivated(object sender, EventArgs e)
        {
            if (_visible)
            {
                OfferClipboard();
            }
        }

        private void OfferClipboard()
        {
            if (!_service.Prefs.ClipboardSuggest)
            {
                SetShown(ClipboardBar, false);
                return;
            }
            string link = ClipboardLinks.Read();
            if (link == null || link == _lastOffered || UrlInput.Text.Contains(link) ||
                _service.Active.Any(i => i.Url == link) || _service.Completed.Take(20).Any(i => i.Url == link))
            {
                return;
            }
            _clipboardLink = link;
            _lastOffered = link;
            ClipboardText.Text = "Link copiado: " + ClipboardLinks.Short(link);
            SetShown(ClipboardBar, true);
        }

        private void OnUseClipboard(object sender, RoutedEventArgs e)
        {
            if (_clipboardLink != null)
            {
                AppendLinks(_clipboardLink);
            }
            SetShown(ClipboardBar, false);
        }

        private void OnDismissClipboard(object sender, RoutedEventArgs e) => SetShown(ClipboardBar, false);

        private async void OnAdd(object sender, RoutedEventArgs e)
        {
            string[] urls = UrlInput.Text.Split(LineBreaks, StringSplitOptions.RemoveEmptyEntries);
            if (urls.All(string.IsNullOrWhiteSpace))
            {
                UrlInput.Focus();
                return;
            }

            AddButton.IsEnabled = false;
            try
            {
                string folder = FolderBox.SelectedItem as string ?? _service.DefaultFolder;
                bool sent = await _service.AddAsync(urls, folder);
                if (sent)
                {
                    UrlInput.Clear();
                    SetShown(ClipboardBar, false);
                }
                else if (_service.Backend.State != BackendState.NoPython && _service.Backend.State != BackendState.Failed)
                {
                    _context.Notify("O Cachalot não respondeu. Tente de novo.", NotificationKind.Warning);
                }
                RefreshFolders();
            }
            finally
            {
                AddButton.IsEnabled = true;
            }
        }

        private void OnUrlsKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.Enter && (Keyboard.Modifiers & ModifierKeys.Control) != 0)
            {
                e.Handled = true;
                OnAdd(sender, e);
            }
        }

        private void OnUrlsChanged(object sender, TextChangedEventArgs e)
        {
            if (!_loading)
            {
                _service.SetDraft(UrlInput.Text);
            }
        }

        private void OnModeChanged(object sender, RoutedEventArgs e)
        {
            if (_loading)
            {
                return;
            }
            _service.Prefs.Mode = AudioOption.IsChecked == true ? Modes.Audio : Modes.Video;
            FillQualities();
            _module.PreferencesChanged();
        }

        private void OnQualityChanged(object sender, SelectionChangedEventArgs e)
        {
            if (_loading || !(QualityBox.SelectedItem is Option option))
            {
                return;
            }
            if (_service.Prefs.Mode == Modes.Audio)
            {
                _service.Prefs.AudioFormat = option.Value;
            }
            else
            {
                _service.Prefs.VideoQuality = option.Value;
            }
            _module.PreferencesChanged();
        }

        private void FillQualities()
        {
            bool loading = _loading;
            _loading = true;
            bool audio = _service.Prefs.Mode == Modes.Audio;
            List<Option> options = audio
                ? AudioFormats.All.Select(v => new Option(v, AudioFormats.Label(v))).ToList()
                : VideoQualities.All.Select(v => new Option(v, VideoQualities.Label(v))).ToList();
            string current = audio ? _service.Prefs.AudioFormat : _service.Prefs.VideoQuality;
            QualityBox.ItemsSource = options;
            QualityBox.SelectedItem = options.FirstOrDefault(o => o.Value == current) ?? options[0];
            QualityBox.ToolTip = audio ? "Formato do áudio (converter usa o FFmpeg)" : "Qualidade máxima do vídeo";
            _loading = loading;
        }

        private void OnFolderChanged(object sender, SelectionChangedEventArgs e)
        {
            if (!_loading && FolderBox.SelectedItem is string folder)
            {
                _service.State.Folder = folder;
            }
        }

        private void OnPickFolder(object sender, RoutedEventArgs e)
        {
            string folder;
            try
            {
                folder = FolderPicker.Pick(Window.GetWindow(this), "Pasta de destino dos downloads", FolderBox.SelectedItem as string);
            }
            catch (Exception error) when (error is System.Runtime.InteropServices.COMException || error is InvalidCastException)
            {
                _context.Log.Error("Folder picker failed.", error);
                return;
            }
            if (folder != null)
            {
                _service.RememberFolder(folder);
                RefreshFolders();
            }
        }

        private void OnImportFile(object sender, RoutedEventArgs e)
        {
            var dialog = new Microsoft.Win32.OpenFileDialog
            {
                Title = "Abrir lista de links ou torrent",
                Filter = "Listas e torrents (*.txt;*.torrent)|*.txt;*.torrent|Todos os arquivos (*.*)|*.*",
                Multiselect = true,
            };
            if (dialog.ShowDialog(Window.GetWindow(this)) == true)
            {
                ImportFiles(dialog.FileNames);
            }
        }

        /// <summary>.txt: one link per line (# comments and "link | note" allowed). .torrent: queued as is.</summary>
        private void ImportFiles(IEnumerable<string> files)
        {
            var links = new List<string>();
            foreach (string file in files)
            {
                if (file.EndsWith(".torrent", StringComparison.OrdinalIgnoreCase))
                {
                    links.Add(file);
                    continue;
                }
                try
                {
                    foreach (string line in File.ReadAllLines(file, Encoding.UTF8))
                    {
                        string text = line.Split('|')[0].Trim();
                        if (text.Length > 0 && !text.StartsWith("#", StringComparison.Ordinal))
                        {
                            links.Add(text);
                        }
                    }
                }
                catch (Exception error) when (error is IOException || error is UnauthorizedAccessException)
                {
                    _context.Notify("Não deu para ler " + Path.GetFileName(file) + ".", NotificationKind.Warning);
                }
            }
            if (links.Count > 0)
            {
                AppendLinks(string.Join(Environment.NewLine, links));
            }
        }

        private void OnDragOver(object sender, DragEventArgs e)
        {
            bool files = e.Data.GetDataPresent(DataFormats.FileDrop);
            e.Effects = files || e.Data.GetDataPresent(DataFormats.UnicodeText) || e.Data.GetDataPresent(DataFormats.Text)
                ? DragDropEffects.Copy
                : DragDropEffects.None;
            e.Handled = true;
        }

        /// <summary>Links dragged from a browser are appended; dropped .txt/.torrent files are read.</summary>
        private void OnDrop(object sender, DragEventArgs e)
        {
            if (e.Data.GetData(DataFormats.FileDrop) is string[] files && files.Length > 0)
            {
                ImportFiles(files.Where(f => f.EndsWith(".txt", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".torrent", StringComparison.OrdinalIgnoreCase)));
                e.Handled = true;
                return;
            }
            string text = e.Data.GetData(DataFormats.UnicodeText) as string ?? e.Data.GetData(DataFormats.Text) as string;
            if (!string.IsNullOrWhiteSpace(text))
            {
                AppendLinks(text.Trim());
                e.Handled = true;
            }
        }

        private void AppendLinks(string text)
        {
            string current = UrlInput.Text.TrimEnd();
            UrlInput.Text = current.Length == 0 ? text : current + Environment.NewLine + text;
            UrlInput.CaretIndex = UrlInput.Text.Length;
            UrlInput.Focus();
        }

        private void OnPause(object sender, RoutedEventArgs e)
        {
            if (Item(sender) is DownloadItem item)
            {
                _service.Pause(item);
                UpdateBulkButtons();
            }
        }

        private async void OnResume(object sender, RoutedEventArgs e)
        {
            if (Item(sender) is DownloadItem item)
            {
                await _service.ResumeAsync(item);
                UpdateBulkButtons();
            }
        }

        private void OnPauseAll(object sender, RoutedEventArgs e)
        {
            _service.PauseAll();
            UpdateBulkButtons();
        }

        private async void OnResumeAll(object sender, RoutedEventArgs e)
        {
            await _service.ResumeAllAsync();
            UpdateBulkButtons();
        }

        private void OnRemove(object sender, RoutedEventArgs e)
        {
            if (Item(sender) is DownloadItem item)
            {
                _service.Remove(item);
            }
        }

        private async void OnRetry(object sender, RoutedEventArgs e)
        {
            if (Item(sender) is DownloadItem item)
            {
                await _service.RetryAsync(item);
            }
        }

        private void OnOpenFile(object sender, RoutedEventArgs e)
        {
            if (Item(sender) is DownloadItem item && !_service.OpenFile(item))
            {
                _context.Notify("O arquivo não está mais nesse local.", NotificationKind.Warning);
            }
        }

        private void OnOpenFolder(object sender, RoutedEventArgs e)
        {
            if (Item(sender) is DownloadItem item && !_service.OpenFolder(item))
            {
                _context.Notify("A pasta não existe mais.", NotificationKind.Warning);
            }
        }

        private void OnToggleSort(object sender, RoutedEventArgs e)
        {
            _service.ToggleSort();
            UpdateSortButton();
        }

        /// <summary>Clearing the history takes a second click.</summary>
        private void OnClear(object sender, RoutedEventArgs e)
        {
            if (!_clearConfirm.IsEnabled)
            {
                ClearButton.Content = "Confirmar limpeza";
                ClearButton.SetResourceReference(StyleProperty, "Button.Danger");
                _clearConfirm.Start();
                return;
            }
            ResetClear();
            _service.ClearCompleted();
        }

        private void ResetClear()
        {
            _clearConfirm.Stop();
            ClearButton.Content = "Limpar tudo";
            ClearButton.SetResourceReference(StyleProperty, "Button.Ghost");
        }

        private void OnOpenLog(object sender, RoutedEventArgs e) => _service.OpenLog();

        private void OnRetryBackend(object sender, RoutedEventArgs e) => _service.Backend.EnsureStarted();

        private void OnListsChanged(object sender, NotifyCollectionChangedEventArgs e)
        {
            if (sender == _service.Active)
            {
                foreach (DownloadItem item in e.NewItems?.OfType<DownloadItem>() ?? Enumerable.Empty<DownloadItem>())
                {
                    item.PropertyChanged += OnItemChanged;
                }
                foreach (DownloadItem item in e.OldItems?.OfType<DownloadItem>() ?? Enumerable.Empty<DownloadItem>())
                {
                    item.PropertyChanged -= OnItemChanged;
                }
            }
            UpdateLists();
        }

        private void OnItemChanged(object sender, PropertyChangedEventArgs e)
        {
            if (e.PropertyName == nameof(DownloadItem.Status) || e.PropertyName == nameof(DownloadItem.Pausing))
            {
                UpdateBulkButtons();
            }
        }

        private void UpdateLists()
        {
            ActiveCount.Text = _service.Active.Count.ToString();
            CompletedCount.Text = _service.Completed.Count.ToString();
            SetShown(ActiveEmpty, _service.Active.Count == 0);
            SetShown(CompletedEmpty, _service.Completed.Count == 0);
            CompletedTools.Visibility = _service.Completed.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
            UpdateBulkButtons();
        }

        /// <summary>"Pausar todos" only with two or more pausable; "Retomar todos" with two or more paused.</summary>
        private void UpdateBulkButtons()
        {
            SetShown(PauseAllButton, _service.Active.Count(i => i.CanPause) >= 2);
            SetShown(ResumeAllButton, _service.Active.Count(i => i.IsPaused) >= 2);
        }

        private void UpdateSortButton()
        {
            bool oldest = _service.State.OldestFirst;
            Ui.SetIcon(SortButton, oldest ? "" : "");
            SortButton.ToolTip = oldest ? "Mais antigos primeiro (clique para inverter)" : "Mais recentes primeiro (clique para inverter)";
        }

        private void RefreshFolders()
        {
            bool loading = _loading;
            _loading = true;
            FolderBox.ItemsSource = _service.State.Folders.ToList();
            FolderBox.SelectedItem = _service.State.Folders.FirstOrDefault(f => string.Equals(f, _service.State.Folder, StringComparison.OrdinalIgnoreCase))
                                     ?? _service.State.Folders.FirstOrDefault();
            _loading = loading;
        }

        private void ApplyBackendState()
        {
            BackendState state = _service.Backend.State;
            if (_shownState == state)
            {
                return;
            }
            bool first = _shownState == null;
            _shownState = state;

            string label, soft, strong;
            switch (state)
            {
                case BackendState.Ready:
                    label = "Pronto"; soft = "Brush.Success.Soft"; strong = "Brush.Success";
                    break;
                case BackendState.Starting:
                    label = "Iniciando"; soft = "Brush.Info.Soft"; strong = "Brush.Info";
                    break;
                case BackendState.NoPython:
                    label = "Python ausente"; soft = "Brush.Danger.Soft"; strong = "Brush.Danger";
                    break;
                case BackendState.Failed:
                    label = "Com erro"; soft = "Brush.Danger.Soft"; strong = "Brush.Danger";
                    break;
                default:
                    label = "Em espera"; soft = "Brush.Surface4"; strong = "Brush.Text.Secondary";
                    break;
            }
            StatusText.Text = label;
            StatusChip.SetResourceReference(BackgroundProperty, soft);
            StatusText.SetResourceReference(ForegroundProperty, strong);
            StatusChip.ToolTip = state == BackendState.Stopped
                ? "O Cachalot inicia sozinho no próximo download e se fecha após alguns minutos sem uso."
                : null;

            if (state == BackendState.NoPython)
            {
                ProblemTitle.Text = "O Cachalot precisa do Python 3";
                ProblemText.Text = "Instale o Python 3 em python.org (marque \"Add python.exe to PATH\") e tente de novo. As dependências (yt-dlp) são instaladas sozinhas no primeiro uso.";
                LogButton.Visibility = Visibility.Collapsed;
                SetShown(Problem, true);
            }
            else if (state == BackendState.Failed)
            {
                ProblemTitle.Text = "O Cachalot parou com um erro";
                ProblemText.Text = LastLine(_service.Backend.LastError);
                LogButton.Visibility = Visibility.Visible;
                SetShown(Problem, true);
            }
            else
            {
                SetShown(Problem, false);
            }

            if (!first)
            {
                Fade(StatusChip);
            }
        }

        private static string LastLine(string text)
        {
            if (string.IsNullOrWhiteSpace(text))
            {
                return "Veja o log para detalhes.";
            }
            string[] lines = text.Split(LineBreaks, StringSplitOptions.RemoveEmptyEntries);
            return lines.Length == 0 ? text : lines[lines.Length - 1].Trim();
        }

        private static DownloadItem Item(object sender) => (sender as FrameworkElement)?.DataContext as DownloadItem;

        /// <summary>Shows or hides with a fade instead of a jump.</summary>
        private void SetShown(UIElement element, bool shown)
        {
            bool visible = element.Visibility == Visibility.Visible;
            if (visible == shown)
            {
                return;
            }
            element.Visibility = shown ? Visibility.Visible : Visibility.Collapsed;
            if (shown && !_loading)
            {
                Fade(element);
            }
        }

        private void Fade(UIElement element)
        {
            var duration = TryFindResource("Motion.Normal") is Duration d ? d : new Duration(TimeSpan.FromMilliseconds(200));
            var fade = new DoubleAnimation(0, 1, duration) { EasingFunction = TryFindResource("Ease.Out") as IEasingFunction };
            fade.Freeze();
            element.BeginAnimation(OpacityProperty, fade);
        }
    }
}
