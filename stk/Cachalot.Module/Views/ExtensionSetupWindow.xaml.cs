using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using SwissTechKnife.Sdk;
using Cachalot.Module.Setup;

namespace Cachalot.Module.Views
{
    /// <summary>
    /// Guided install of the Chrome extension. Chrome does not let other programs enable developer mode or load an
    /// unpacked extension (both settings are signed), so this copies the folder, opens chrome://extensions and the
    /// folder, puts the path on the clipboard and then follows Chrome's profile files and the bridge, ticking each
    /// step as soon as it happens.
    /// </summary>
    public partial class ExtensionSetupWindow
    {
        private enum Phase { Offer, Waiting, Done }

        private enum Step { Pending, Active, Done }

        private readonly ExtensionSetup _setup;
        private readonly DispatcherTimer _timer;
        private ChromeState _state;
        private Phase _phase = Phase.Offer;
        private DateTime _installedAt = DateTime.MaxValue;
        private string _error;
        private bool _busy;
        private bool _polling;
        private bool _preview;
        private bool _openFailed;

        internal ExtensionSetupWindow(ExtensionSetup setup)
        {
            _setup = setup;
            InitializeComponent();
            LoadLogo();
            _timer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromSeconds(1.5) };
            _timer.Tick += async (s, e) => await PollAsync();
            Loaded += async (s, e) =>
            {
                Render();
                await PollAsync();
                if (!_preview)
                {
                    _timer.Start();
                }
            };
            Closed += (s, e) => _timer.Stop();
            PreviewKeyDown += (s, e) =>
            {
                if (e.Key == Key.Escape)
                {
                    Close();
                }
            };
        }

        private async System.Threading.Tasks.Task PollAsync()
        {
            if (_polling || _preview)
            {
                return;
            }
            _polling = true;
            ChromeState state;
            try
            {
                state = await _setup.ProbeAsync();
            }
            catch (Exception)
            {
                // Unreadable this time; the next tick tries again.
                return;
            }
            finally
            {
                _polling = false;
            }
            if (_preview || !IsVisible)
            {
                return;
            }
            _state = state;
            bool wasDone = _phase == Phase.Done;
            if (_phase != Phase.Done && ExtensionLoaded && Paired)
            {
                _phase = Phase.Done;
            }
            else if (_phase == Phase.Offer && _state.Installed)
            {
                // Opened from the settings with the extension already there.
                _phase = Phase.Done;
                wasDone = true;
            }
            Render();
            if (!wasDone && _phase == Phase.Done)
            {
                _setup.Notify("Extensão do Chrome instalada e pareada.", NotificationKind.Success);
                Activate();
            }
        }

        private bool ContactSinceInstall => _setup.LastPairedContact >= _installedAt;

        /// <summary>Chrome lists it, or it already called the bridge with the code it carries.</summary>
        private bool ExtensionLoaded => (_state?.Installed ?? false) || ContactSinceInstall;

        private bool Paired => ContactSinceInstall || (ExtensionLoaded && (_setup.LastPairedContact != DateTime.MinValue || !_setup.BridgeEnabled));

        private void Render()
        {
            ChromeState state = _state ?? new ChromeState { Found = true };
            bool copied = _phase != Phase.Offer || ExtensionLoaded;
            bool developer = state.DeveloperMode || ExtensionLoaded;

            SetStep(CopyBadge, CopyBadgeText, "1", copied ? Step.Done : _phase == Phase.Offer ? Step.Active : Step.Pending);
            CopyHint.Text = copied ? "Pronto." : "Para uma pasta que não muda nas atualizações do Cachalot.";
            PathText.Text = _setup.Folder;
            PathBox.Visibility = ExtensionLoaded ? Visibility.Collapsed : Visibility.Visible;

            SetStep(DevBadge, DevBadgeText, "2", developer ? Step.Done : copied ? Step.Active : Step.Pending);
            DevHint.Text = developer
                ? "Já está ligado neste perfil do Chrome."
                : "Na página de extensões do Chrome, ligue a chave “Modo do desenvolvedor”, no canto superior direito."
                  + (_phase == Phase.Waiting ? " Esta janela percebe sozinha quando ligar." : string.Empty);

            SetStep(LoadBadge, LoadBadgeText, "3", ExtensionLoaded ? Step.Done : copied && developer ? Step.Active : Step.Pending);
            LoadHint.Text = ExtensionLoaded
                ? (state.InstalledButDisabled ? "Carregada, mas desativada: ligue o Cachalot na página de extensões." : "Carregada no Chrome.")
                : _phase == Phase.Offer
                    ? "O Cachalot abre a página de extensões no Chrome que já está aberto. Lá, “Carregar sem compactação” e esta pasta:"
                    : _openFailed
                        ? "Abra chrome://extensions no Chrome, clique em “Carregar sem compactação”, cole este caminho (Ctrl+V) e clique em “Selecionar pasta”:"
                        : "Na página de extensões, clique em “Carregar sem compactação”, cole este caminho (Ctrl+V) e clique em “Selecionar pasta”:";

            SetStep(PairBadge, PairBadgeText, "4", Paired ? Step.Done : ExtensionLoaded ? Step.Active : Step.Pending);
            PairHint.Text = Paired
                ? "Pareada com este PC."
                : !_setup.BridgeEnabled
                    ? "Automático depois de instalar (a opção “Receber links da extensão” é ligada junto)."
                    : ExtensionLoaded
                        ? "Abra qualquer página no Chrome: a extensão se pareia sozinha."
                        : "Automático: a extensão já leva o código deste PC.";

            TitleText.Text = _phase == Phase.Done ? "Extensão do Chrome pronta" : _phase == Phase.Waiting ? "Instalando a extensão do Chrome" : "Instalar a extensão do Chrome?";
            // While the user works in Chrome, the steps and the path stay in sight (the card can be dragged aside).
            Topmost = _phase == Phase.Waiting && !_preview;
            RenderStatus(state);
            RenderButtons(state);
        }

        private void RenderStatus(ChromeState state)
        {
            if (_error != null)
            {
                SetStatus("Não deu para copiar a extensão: " + _error, "", "Brush.Danger", "Brush.Danger.Soft");
            }
            else if (_phase == Phase.Done && state.InstalledButDisabled)
            {
                SetStatus("A extensão está instalada, mas desativada. Ligue o Cachalot em chrome://extensions.", "", "Brush.Warning", "Brush.Warning.Soft");
            }
            else if (_phase == Phase.Done)
            {
                SetStatus("Pronto! Dica: fixe o Cachalot na barra do Chrome pelo ícone de quebra-cabeça, ao lado do endereço.", "", "Brush.Success", "Brush.Success.Soft");
            }
            else if (!state.Found)
            {
                SetStatus("Não encontramos o Google Chrome neste PC. Dá para instalar mesmo assim em outro navegador baseado no Chromium (Edge, Brave): "
                          + "abra a página de extensões dele e carregue a pasta.", "", "Brush.Warning", "Brush.Warning.Soft");
            }
            else if (_phase == Phase.Waiting)
            {
                SetStatus(state.DeveloperMode || ExtensionLoaded
                    ? "Falta só carregar a pasta no Chrome. Esta janela acompanha e avisa quando terminar."
                    : "Siga os passos no Chrome. Esta janela acompanha e marca cada um sozinha.", "", "Brush.Info", "Brush.Info.Soft");
            }
            else if (state.DeveloperMode)
            {
                SetStatus("O Modo do desenvolvedor do Chrome já está ligado: depois de clicar em Instalar, é só carregar a pasta.", "", "Brush.Info", "Brush.Info.Soft");
            }
            else
            {
                SetStatus("Extensões de fora da Chrome Web Store precisam do Modo do desenvolvedor do Chrome. O Cachalot abre tudo e acompanha cada passo.",
                    "", "Brush.Info", "Brush.Info.Soft");
            }
        }

        private void RenderButtons(ChromeState state)
        {
            PrimaryButton.IsEnabled = !_busy;
            switch (_phase)
            {
                case Phase.Offer:
                    SecondaryButton.Content = "Agora não";
                    SecondaryButton.Visibility = Visibility.Visible;
                    PrimaryButton.Content = _busy ? "Copiando…" : "Instalar";
                    Ui.SetIcon(PrimaryButton, "");
                    break;
                case Phase.Waiting:
                    SecondaryButton.Content = "Fechar";
                    SecondaryButton.Visibility = Visibility.Visible;
                    PrimaryButton.Content = "Abrir a página de extensões";
                    Ui.SetIcon(PrimaryButton, "");
                    break;
                default:
                    SecondaryButton.Visibility = state.InstalledButDisabled ? Visibility.Visible : Visibility.Collapsed;
                    SecondaryButton.Content = "Fechar";
                    PrimaryButton.Content = state.InstalledButDisabled ? "Abrir o Chrome" : "Concluir";
                    Ui.SetIcon(PrimaryButton, state.InstalledButDisabled ? "" : "");
                    break;
            }
        }

        private async void OnPrimary(object sender, RoutedEventArgs e)
        {
            if (_phase == Phase.Done)
            {
                if (_state?.InstalledButDisabled == true)
                {
                    await OpenChromeAsync();
                }
                else
                {
                    Close();
                }
                return;
            }
            if (_phase == Phase.Waiting)
            {
                CopyPath();
                await OpenChromeAsync();
                return;
            }

            _busy = true;
            _error = null;
            Render();
            try
            {
                _installedAt = DateTime.UtcNow;
                await _setup.InstallAsync();
            }
            catch (Exception error)
            {
                _error = error.Message;
                _installedAt = DateTime.MaxValue;
            }
            finally
            {
                _busy = false;
            }
            if (_error == null)
            {
                _phase = Phase.Waiting;
                CopyPath();
                Render();
                await OpenChromeAsync();
                return;
            }
            Render();
        }

        /// <summary>DevHost snapshots: a fixed state, no polling.</summary>
        internal void Preview(ChromeState state, bool waiting, bool done)
        {
            _preview = true;
            _timer.Stop();
            _state = state;
            _phase = done ? Phase.Done : waiting ? Phase.Waiting : Phase.Offer;
            if (done)
            {
                _installedAt = DateTime.MinValue;
            }
            Render();
        }

        private void OnCopyPath(object sender, RoutedEventArgs e)
        {
            CopyPath();
            _setup.Notify("Caminho da extensão copiado.", NotificationKind.Success);
        }

        /// <summary>The extensions page in the Chrome already open; this window stays where the user can see the steps.</summary>
        private async System.Threading.Tasks.Task OpenChromeAsync()
        {
            PrimaryButton.IsEnabled = false;
            try
            {
                _openFailed = !await _setup.OpenExtensionsPageAsync(_state);
            }
            catch (Exception error)
            {
                _openFailed = true;
                _setup.Notify("Não deu para abrir o Chrome: " + error.Message, NotificationKind.Warning);
            }
            Render();
        }

        private void CopyPath()
        {
            try
            {
                Clipboard.SetText(_setup.Folder);
            }
            catch (System.Runtime.InteropServices.COMException)
            {
                // Clipboard held by another app: the path is on screen anyway.
            }
        }

        private void OnClose(object sender, RoutedEventArgs e) => Close();

        private void OnDrag(object sender, MouseButtonEventArgs e)
        {
            if (e.ButtonState == MouseButtonState.Pressed && !(e.OriginalSource is DependencyObject source && FindButton(source)))
            {
                try
                {
                    DragMove();
                }
                catch (InvalidOperationException)
                {
                }
            }
        }

        private static bool FindButton(DependencyObject element)
        {
            for (DependencyObject current = element; current != null; current = current is Visual || current is System.Windows.Media.Media3D.Visual3D ? VisualTreeHelper.GetParent(current) : LogicalTreeHelper.GetParent(current))
            {
                if (current is System.Windows.Controls.Primitives.ButtonBase)
                {
                    return true;
                }
            }
            return false;
        }

        private void SetStatus(string text, string glyph, string foreground, string background)
        {
            StatusText.Text = text;
            StatusIcon.Text = glyph;
            StatusIcon.Foreground = (Brush)FindResource(foreground);
            StatusBox.Background = (Brush)FindResource(background);
        }

        private void SetStep(Border badge, TextBlock text, string number, Step step)
        {
            switch (step)
            {
                case Step.Done:
                    badge.Background = (Brush)FindResource("Brush.Success.Soft");
                    text.Text = "";
                    text.FontFamily = (FontFamily)FindResource("Font.Icon");
                    text.Foreground = (Brush)FindResource("Brush.Success");
                    break;
                case Step.Active:
                    badge.Background = (Brush)FindResource("Brush.Accent.Soft");
                    text.Text = number;
                    text.FontFamily = (FontFamily)FindResource("Font.Text");
                    text.Foreground = (Brush)FindResource("Brush.Accent");
                    break;
                default:
                    badge.Background = (Brush)FindResource("Brush.Surface4");
                    text.Text = number;
                    text.FontFamily = (FontFamily)FindResource("Font.Text");
                    text.Foreground = (Brush)FindResource("Brush.Text.Tertiary");
                    break;
            }
        }

        private void LoadLogo()
        {
            string icon = Path.Combine(_setup.BundledFolder, "icons", "active-128.png");
            try
            {
                if (File.Exists(icon))
                {
                    var bitmap = new BitmapImage();
                    bitmap.BeginInit();
                    bitmap.CacheOption = BitmapCacheOption.OnLoad;
                    bitmap.UriSource = new Uri(icon);
                    bitmap.EndInit();
                    bitmap.Freeze();
                    Logo.Source = bitmap;
                    return;
                }
            }
            catch (Exception error) when (error is IOException || error is NotSupportedException || error is UriFormatException)
            {
            }
            LogoGlyph.Visibility = Visibility.Visible;
        }
    }
}
