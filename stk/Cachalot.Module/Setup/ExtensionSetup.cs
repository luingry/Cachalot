using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using SwissTechKnife.Sdk;
using Cachalot.Module.Views;

namespace Cachalot.Module.Setup
{
    /// <summary>
    /// Chrome extension lifecycle on the module side: offers it once after the module is installed (when the host
    /// window is on screen), keeps an already copied extension up to date with the module, and runs the guided
    /// install from the popup or from the settings.
    /// </summary>
    internal sealed class ExtensionSetup
    {
        private readonly CachalotModule _module;
        private readonly ChromeProbe _probe = new ChromeProbe();
        private ExtensionSetupWindow _window;
        private Task<string> _executable;
        private string _bundleHash;

        public ExtensionSetup(CachalotModule module, string bundledFolder, string targetFolder)
        {
            _module = module;
            BundledFolder = bundledFolder;
            Installer = new ExtensionInstaller(bundledFolder, targetFolder);
        }

        /// <summary>The extension shipped inside the module package (read-only).</summary>
        public string BundledFolder { get; }

        public ExtensionInstaller Installer { get; }

        public string Folder => Installer.Folder;

        private IModuleContext Context => _module.Context;

        /// <summary>When the extension last talked to the bridge with the right code (MinValue: not since the host started, or the bridge is off).</summary>
        public DateTime LastPairedContact => _module.Bridge?.LastPairedContact ?? DateTime.MinValue;

        public bool BridgeEnabled => _module.Prefs.BridgeEnabled;

        /// <summary>Chrome's state on a pool thread (files are parsed only when they changed).</summary>
        public async Task<ChromeState> ProbeAsync()
        {
            string executable = await (_executable ?? (_executable = Task.Run(() => ChromeProbe.FindExecutable()))).ConfigureAwait(false);
            return await Task.Run(() => _probe.Read(Folder, executable)).ConfigureAwait(false);
        }

        /// <summary>Host startup (UI thread, idle): update a copied extension, then offer it once.</summary>
        public async void OnStartup()
        {
            try
            {
                if (!Installer.HasBundle)
                {
                    return;
                }
                if (Installer.IsCopied)
                {
                    await UpdateCopyAsync();
                }
                string install = InstallKey();
                if (_module.Prefs.ExtensionPromptShown || _module.Prefs.ExtensionCheckedInstall == install)
                {
                    return;
                }
                ChromeState state = await ProbeAsync();
                if (!state.Found || state.Installed)
                {
                    // No Chrome to install into, or it is already there: nothing to ask for this install.
                    _module.Prefs.ExtensionCheckedInstall = install;
                    _module.PreferencesChanged();
                    Context.Log.Info(state.Found ? "Chrome already has the extension; not offering it." : "Chrome not found; not offering the extension.");
                    return;
                }
                Context.Log.Info("Offering the Chrome extension (developer mode " + (state.DeveloperMode ? "on" : "off") + ").");
                ShowWhenHostVisible();
            }
            catch (Exception error)
            {
                // async void on the host's dispatcher: never let it escape.
                Context.Log.Warn("Chrome extension check failed: " + error.Message);
            }
        }

        /// <summary>Opens the guided install (or brings it forward).</summary>
        public void Show()
        {
            if (_window != null)
            {
                _window.Activate();
                return;
            }
            MarkOffered();
            _window = new ExtensionSetupWindow(this);
            Window main = Application.Current?.MainWindow;
            if (main != null && main != _window && main.IsVisible && main.WindowState != WindowState.Minimized)
            {
                _window.Owner = main;
                _window.WindowStartupLocation = WindowStartupLocation.CenterOwner;
                _window.ShowInTaskbar = false;
            }
            else
            {
                _window.WindowStartupLocation = WindowStartupLocation.CenterScreen;
            }
            _window.Closed += (s, e) => _window = null;
            _window.Show();
            _window.Activate();
        }

        /// <summary>Copies the extension (with the pairing code), turning the bridge on if it was off. UI thread.</summary>
        public async Task InstallAsync()
        {
            if (!_module.Prefs.BridgeEnabled)
            {
                _module.Prefs.BridgeEnabled = true;
                _module.PreferencesChanged(integration: true);
            }
            string code = _module.Prefs.BridgeCode;
            string hash = await Task.Run(() =>
            {
                string bundle = BundleHash();
                Installer.Install(code, bundle);
                return bundle;
            });
            _module.Prefs.ExtensionBuild = hash;
            _module.PreferencesChanged();
        }

        /// <summary>Settings generated a new pairing code: the copied extension adopts it on its next start.</summary>
        public void PairingChanged()
        {
            try
            {
                Installer.WritePairing(_module.Prefs.BridgeCode);
            }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException)
            {
                Context.Log.Warn("Could not update the extension's pairing file: " + error.Message);
            }
        }

        /// <summary>Chrome on its extensions page (in the profile it opens by default) and Explorer with the folder selected.</summary>
        public bool OpenChromeAndFolder(ChromeState state)
        {
            bool opened = OpenChrome(state);
            // After Chrome, so Explorer ends up in front with the folder ready to drag.
            Start("explorer.exe", "/select,\"" + Folder + "\"");
            return opened;
        }

        public bool OpenChrome(ChromeState state)
        {
            string profile = state?.LastProfile;
            string arguments = (string.IsNullOrEmpty(profile) ? string.Empty : "--profile-directory=\"" + profile + "\" ") + "chrome://extensions";
            return Start(state?.Executable ?? "chrome.exe", arguments);
        }

        public void Notify(string message, NotificationKind kind) => Context.Notify(message, kind);

        private async Task UpdateCopyAsync()
        {
            string previous = _module.Prefs.ExtensionBuild ?? string.Empty;
            string hash = await Task.Run(() => BundleHash());
            if (hash == previous)
            {
                // Same files; only make sure the pairing file follows the current code.
                PairingChanged();
                return;
            }
            string code = _module.Prefs.BridgeCode;
            await Task.Run(() => Installer.Install(code, hash));
            _module.Prefs.ExtensionBuild = hash;
            _module.PreferencesChanged();
            Context.Log.Info("Chrome extension updated in " + Folder);
            if (previous.Length == 0)
            {
                // Copied by a module version without auto-reload: the running extension cannot notice by itself.
                ChromeState state = await ProbeAsync();
                if (state.Installed)
                {
                    Context.Notify("Extensão do Chrome atualizada. Clique em recarregar nela em chrome://extensions (só desta vez; depois ela se atualiza sozinha).", NotificationKind.Info);
                }
            }
        }

        private string BundleHash() => _bundleHash ?? (_bundleHash = Installer.BundleHash());

        private void MarkOffered()
        {
            if (!_module.Prefs.ExtensionPromptShown)
            {
                _module.Prefs.ExtensionPromptShown = true;
                _module.PreferencesChanged();
            }
        }

        /// <summary>Identifies this install of the module: the host extracts every install (and update) into a new folder.</summary>
        private string InstallKey()
        {
            string folder = Context.InstallDirectory ?? string.Empty;
            try
            {
                return folder + "|" + Directory.GetCreationTimeUtc(folder).Ticks;
            }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException || error is ArgumentException)
            {
                return folder;
            }
        }

        /// <summary>Right after an install from the catalog the window is up; at boot the host starts in the tray, so wait for it.</summary>
        private void ShowWhenHostVisible()
        {
            Window main = Application.Current?.MainWindow;
            if (main == null || (main.IsVisible && main.WindowState != WindowState.Minimized))
            {
                ShowSoon();
                return;
            }
            DependencyPropertyChangedEventHandler handler = null;
            handler = (s, e) =>
            {
                if (main.IsVisible)
                {
                    main.IsVisibleChanged -= handler;
                    ShowSoon();
                }
            };
            main.IsVisibleChanged += handler;
        }

        private void ShowSoon()
        {
            var timer = new DispatcherTimer(DispatcherPriority.Background, Context.Dispatcher) { Interval = TimeSpan.FromSeconds(1.2) };
            timer.Tick += (s, e) =>
            {
                timer.Stop();
                if (!_module.Prefs.ExtensionPromptShown)
                {
                    Show();
                }
            };
            timer.Start();
        }

        private static bool Start(string file, string arguments)
        {
            try
            {
                Process.Start(new ProcessStartInfo(file, arguments) { UseShellExecute = true });
                return true;
            }
            catch (Exception error) when (error is Win32Exception || error is InvalidOperationException || error is FileNotFoundException)
            {
                return false;
            }
        }
    }
}
