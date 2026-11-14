using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace Cachalot.Module.Setup
{
    /// <summary>What Chrome's profile files say about developer mode and the Cachalot extension.</summary>
    internal sealed class ChromeState
    {
        /// <summary>Chrome is installed (its executable or its user data folder exists).</summary>
        public bool Found { get; set; }

        /// <summary>chrome.exe, when found (null: try "chrome.exe" through the shell).</summary>
        public string Executable { get; set; }

        /// <summary>Profile folder Chrome opens by default (Local State's profile.last_used), e.g. "Default".</summary>
        public string LastProfile { get; set; }

        /// <summary>Developer mode is on in <see cref="LastProfile"/>.</summary>
        public bool DeveloperMode { get; set; }

        /// <summary>Profiles that load the extension unpacked from our folder.</summary>
        public List<string> InstalledProfiles { get; set; } = new List<string>();

        /// <summary>The extension is loaded in some profile but turned off there.</summary>
        public bool InstalledButDisabled { get; set; }

        public bool Installed => InstalledProfiles.Count > 0;
    }

    /// <summary>
    /// Reads Chrome's profile files (read-only). Developer mode lives in <c>extensions.ui.developer_mode</c>, or in
    /// <c>account_values.extensions.ui.developer_mode</c> when the profile syncs with a Google account, in either
    /// Preferences or Secure Preferences. Unpacked extensions are <c>extensions.settings.&lt;id&gt;</c> entries with
    /// <c>location</c> 4 and the folder in <c>path</c>. Both are protected by Chrome's MACs, so they are never written:
    /// the user flips the switch and loads the folder; this only follows along.
    /// </summary>
    internal sealed class ChromeProbe
    {
        private const int UnpackedLocation = 4;
        private static readonly string[] PreferenceFiles = { "Secure Preferences", "Preferences" };

        private readonly string _userData;
        private readonly Dictionary<string, CachedFile> _cache = new Dictionary<string, CachedFile>(StringComparer.OrdinalIgnoreCase);
        private readonly object _gate = new object();

        public ChromeProbe(string userDataDirectory = null)
        {
            _userData = userDataDirectory ?? DefaultUserData();
        }

        public static string DefaultUserData() =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "User Data");

        /// <summary>Safe on any thread; files that did not change since the last call are not parsed again.</summary>
        public ChromeState Read(string extensionFolder, string executable = null)
        {
            lock (_gate)
            {
                var state = new ChromeState { Executable = executable };
                bool hasUserData = Directory.Exists(_userData);
                state.Found = hasUserData || executable != null;
                if (!hasUserData)
                {
                    return state;
                }

                Dictionary<string, object> localState = Load(Path.Combine(_userData, "Local State"));
                var profileInfo = Child(localState, "profile") as Dictionary<string, object>;
                state.LastProfile = (Child(profileInfo, "last_used") as string) is string last && last.Length > 0 ? last : "Default";

                var profiles = new List<string>();
                if (Child(profileInfo, "info_cache") is Dictionary<string, object> known)
                {
                    profiles.AddRange(known.Keys);
                }
                if (!profiles.Contains(state.LastProfile, StringComparer.OrdinalIgnoreCase))
                {
                    profiles.Insert(0, state.LastProfile);
                }

                string target = Normalize(extensionFolder);
                foreach (string profile in profiles)
                {
                    bool developer = false, installed = false, disabled = false;
                    foreach (string name in PreferenceFiles)
                    {
                        Dictionary<string, object> prefs = Load(Path.Combine(_userData, profile, name));
                        if (prefs == null)
                        {
                            continue;
                        }
                        developer |= IsTrue(Dig(prefs, "extensions", "ui", "developer_mode"))
                                     || IsTrue(Dig(prefs, "account_values", "extensions", "ui", "developer_mode"));
                        if (Dig(prefs, "extensions", "settings") is Dictionary<string, object> settings)
                        {
                            foreach (object entry in settings.Values)
                            {
                                if (entry is Dictionary<string, object> extension && IsOurs(extension, target))
                                {
                                    installed = true;
                                    disabled |= IsDisabled(extension);
                                }
                            }
                        }
                    }
                    if (installed)
                    {
                        state.InstalledProfiles.Add(profile);
                        state.InstalledButDisabled |= disabled;
                    }
                    if (string.Equals(profile, state.LastProfile, StringComparison.OrdinalIgnoreCase))
                    {
                        state.DeveloperMode = developer;
                    }
                }
                return state;
            }
        }

        /// <summary>chrome.exe from the App Paths registration (per-user installs first), else the usual folders.</summary>
        public static string FindExecutable()
        {
            foreach (RegistryKey root in new[] { Registry.CurrentUser, Registry.LocalMachine })
            {
                try
                {
                    using (RegistryKey key = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"))
                    {
                        if (key?.GetValue(null) is string path && File.Exists(path.Trim('"')))
                        {
                            return path.Trim('"');
                        }
                    }
                }
                catch (Exception error) when (error is System.Security.SecurityException || error is UnauthorizedAccessException || error is IOException)
                {
                }
            }
            foreach (Environment.SpecialFolder folder in new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.LocalApplicationData })
            {
                string candidate = System.IO.Path.Combine(Environment.GetFolderPath(folder), "Google", "Chrome", "Application", "chrome.exe");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            return null;
        }

        internal static bool IsOurs(Dictionary<string, object> extension, string normalizedFolder)
        {
            if (!(extension.TryGetValue("location", out object location) && Convert.ToInt32(location) == UnpackedLocation))
            {
                return false;
            }
            return extension.TryGetValue("path", out object path) && path is string text && Normalize(text) == normalizedFolder;
        }

        private static bool IsDisabled(Dictionary<string, object> extension)
        {
            // Older Chrome: state 0 = disabled. Current Chrome: a non-empty disable_reasons (list or bit mask).
            if (extension.TryGetValue("state", out object state) && state != null && Convert.ToInt32(state) == 0)
            {
                return true;
            }
            if (extension.TryGetValue("disable_reasons", out object reasons))
            {
                return reasons is System.Collections.ICollection list ? list.Count > 0 : reasons != null && Convert.ToInt64(reasons) != 0;
            }
            return false;
        }

        internal static string Normalize(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return string.Empty;
            }
            try
            {
                path = System.IO.Path.GetFullPath(path);
            }
            catch (Exception error) when (error is ArgumentException || error is NotSupportedException || error is PathTooLongException)
            {
            }
            return path.TrimEnd('\\', '/').ToUpperInvariant();
        }

        private static bool IsTrue(object value) => value is bool flag && flag;

        private static object Child(Dictionary<string, object> node, string key) =>
            node != null && node.TryGetValue(key, out object value) ? value : null;

        private static object Dig(Dictionary<string, object> node, params string[] keys)
        {
            object current = node;
            foreach (string key in keys)
            {
                current = Child(current as Dictionary<string, object>, key);
                if (current == null)
                {
                    return null;
                }
            }
            return current;
        }

        private Dictionary<string, object> Load(string file)
        {
            try
            {
                var info = new FileInfo(file);
                if (!info.Exists)
                {
                    return null;
                }
                if (_cache.TryGetValue(file, out CachedFile cached) && cached.Written == info.LastWriteTimeUtc && cached.Length == info.Length)
                {
                    return cached.Root;
                }
                string text;
                // Chrome keeps these open while running; share everything so reading never gets in its way.
                using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var reader = new StreamReader(stream))
                {
                    text = reader.ReadToEnd();
                }
                var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 512 };
                var root = serializer.DeserializeObject(text) as Dictionary<string, object>;
                _cache[file] = new CachedFile { Written = info.LastWriteTimeUtc, Length = info.Length, Root = root };
                return root;
            }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException || error is ArgumentException || error is InvalidOperationException)
            {
                // Mid-write or unreadable: same answer as a missing file, the next poll tries again.
                return null;
            }
        }

        private sealed class CachedFile
        {
            public DateTime Written;
            public long Length;
            public Dictionary<string, object> Root;
        }
    }
}
