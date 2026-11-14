using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Cachalot.Module.Backend;

namespace Cachalot.Module.Downloads
{
    /// <summary>
    /// Everything the settings tab changes, persisted in <c>settings.json</c> (small, read at host startup for
    /// the background parts). Download history and the page draft live in <c>state.json</c>.
    /// Property names map 1:1 to the backend keys in <see cref="ToBackendConfig"/>.
    /// </summary>
    internal sealed class Preferences
    {
        // Page choices (remembered between sessions; the page is the only place they change).
        public string Mode { get; set; } = Modes.Video;
        public string VideoQuality { get; set; } = VideoQualities.Best;
        public string AudioFormat { get; set; } = AudioFormats.Original;

        /// <summary>Format of the sections the extension's transient mode saves; empty: ask on every download.</summary>
        public string TransientFormat { get; set; } = TransientFormats.Ask;

        // Saída
        public string FilenameTemplate { get; set; } = "titulo";
        public bool OrganizeByPlatform { get; set; }
        public bool SkipExisting { get; set; } = true;
        public bool WholePlaylist { get; set; }
        public int PlaylistLimit { get; set; } = 200;
        public bool PlaylistFolder { get; set; } = true;

        // Extras
        public bool EmbedMetadata { get; set; } = true;
        public bool EmbedThumbnail { get; set; } = true;
        public bool WriteNfo { get; set; }
        public bool SplitChapters { get; set; }
        public bool LiveFromStart { get; set; }
        public string Subtitles { get; set; } = "nao";
        public bool AutoSubtitles { get; set; }
        public string SubtitleLanguages { get; set; } = "pt,en";
        public bool KeepVtt { get; set; }
        public string SponsorBlock { get; set; } = "nao";

        // Rede
        public int MaxConcurrent { get; set; } = 3;
        public int Retries { get; set; } = 3;
        public int Fragments { get; set; } = 4;
        public string SpeedLimit { get; set; } = string.Empty;
        public string Proxy { get; set; } = string.Empty;
        public string UserAgent { get; set; } = string.Empty;
        public bool IgnoreTls { get; set; }

        // Cookies (per-site files imported into the data folder are listed from disk, not stored here)
        public string CookiesFile { get; set; } = string.Empty;
        public string CookiesBrowser { get; set; } = string.Empty;

        /// <summary>Off: no download uses cookies (stored, imported file or browser) and the extension's are not saved.</summary>
        public bool CookiesEnabled { get; set; } = true;

        /// <summary>Sites (registrable domains, see <see cref="NormalizeSite"/>) whose cookies are never saved nor used.</summary>
        public List<string> CookiesDisabledSites { get; set; } = new List<string>();

        // Motores
        public bool UseNative { get; set; } = true;
        public bool UseGallery { get; set; } = true;
        public bool UseHeadless { get; set; } = true;
        public int TorrentPort { get; set; } = 6881;
        public bool TorrentUpnp { get; set; } = true;
        public bool TorrentTrackers { get; set; } = true;

        // Avançado
        public string ExtraFlags { get; set; } = string.Empty;
        public string FfmpegPath { get; set; } = string.Empty;

        // Integração
        public bool BridgeEnabled { get; set; } = true;
        public string BridgeCode { get; set; } = string.Empty;
        public bool ClipboardSuggest { get; set; } = true;
        public bool HotkeyEnabled { get; set; }
        public bool PreventSleep { get; set; } = true;

        /// <summary>The "install the Chrome extension?" popup was shown: never offered on its own again (the settings button stays).</summary>
        public bool ExtensionPromptShown { get; set; }

        /// <summary>
        /// Install folder (path + creation time) already checked and skipped because Chrome is missing or already has the
        /// extension. Uninstalling keeps the data folder, so a reinstall gets a new key and is checked again.
        /// </summary>
        public string ExtensionCheckedInstall { get; set; } = string.Empty;

        /// <summary>Hash of the bundled extension last copied to the Chrome folder (empty: never copied by this version).</summary>
        public string ExtensionBuild { get; set; } = string.Empty;

        public List<Rule> Rules { get; set; } = new List<Rule>();
        public List<Channel> Channels { get; set; } = new List<Channel>();

        /// <summary>Keys and values the backend understands (opcoes_ytdlp.PADROES + servidor.CONFIG_PADRAO).</summary>
        public Dictionary<string, object> ToBackendConfig() => new Dictionary<string, object>
        {
            ["modo"] = Modes.Normalize(Mode),
            ["qualidade"] = VideoQualities.Normalize(VideoQuality),
            ["formato_audio"] = AudioFormats.Normalize(AudioFormat),
            ["modelo_nome"] = FilenameTemplate ?? "titulo",
            ["organizar_por_plataforma"] = OrganizeByPlatform,
            ["pular_existentes"] = SkipExisting,
            ["playlist_inteira"] = WholePlaylist,
            ["limite_playlist"] = Clamp(PlaylistLimit, 1, 5000),
            ["playlist_em_pasta"] = PlaylistFolder,
            ["embutir_metadados"] = EmbedMetadata,
            ["embutir_miniatura"] = EmbedThumbnail,
            ["nfo"] = WriteNfo,
            ["dividir_capitulos"] = SplitChapters,
            ["ao_vivo_do_inicio"] = LiveFromStart,
            ["legendas"] = Subtitles ?? "nao",
            ["legendas_auto"] = AutoSubtitles,
            ["idiomas_legenda"] = SubtitleLanguages ?? string.Empty,
            ["manter_vtt"] = KeepVtt,
            ["sponsorblock"] = SponsorBlock ?? "nao",
            ["simultaneos"] = Clamp(MaxConcurrent, 1, 10),
            ["tentativas"] = Clamp(Retries, 0, 10),
            ["fragmentos"] = Clamp(Fragments, 1, 16),
            ["limite_velocidade"] = SpeedLimit ?? string.Empty,
            ["proxy"] = Proxy ?? string.Empty,
            ["user_agent"] = UserAgent ?? string.Empty,
            ["ignorar_tls"] = IgnoreTls,
            ["cookies_arquivo"] = CookiesFile ?? string.Empty,
            ["cookies_navegador"] = CookiesBrowser ?? string.Empty,
            ["cookies_ativos"] = CookiesEnabled,
            ["cookies_sites_off"] = (CookiesDisabledSites ?? new List<string>()).Select(s => (object)s).ToList(),
            ["usar_nativos"] = UseNative,
            ["usar_galeria"] = UseGallery,
            ["usar_navegador"] = UseHeadless,
            ["torrent_porta"] = Clamp(TorrentPort, 1024, 65535),
            ["torrent_upnp"] = TorrentUpnp,
            ["torrent_trackers"] = TorrentTrackers,
            ["flags_extras"] = ExtraFlags ?? string.Empty,
            ["ffmpeg"] = FfmpegPath ?? string.Empty,
            ["regras"] = Rules.Where(r => r.Active && !string.IsNullOrWhiteSpace(r.Value)).Select(r => (object)r.ToBackend()).ToList(),
        };

        internal static int Clamp(int value, int min, int max) => value < min ? min : value > max ? max : value;

        /// <summary>
        /// Whether cookies may be saved or used for a page on <paramref name="host"/>: the global switch is on and neither
        /// the host, a parent domain nor an alias of its site (youtu.be ↔ youtube.com, x.com ↔ twitter.com) is disabled.
        /// Same rule as servidor.cookies_permitidos.
        /// </summary>
        internal bool CookiesAllowedFor(string host)
        {
            if (!CookiesEnabled)
            {
                return false;
            }
            List<string> off = CookiesDisabledSites;
            return off == null || off.Count == 0 || !SiteKeys(host).Any(off.Contains);
        }

        /// <summary>Turns one site's cookies on or off. Returns false when <paramref name="site"/> is not a site.</summary>
        internal bool SetSiteCookies(string site, bool enabled)
        {
            string key = NormalizeSite(site);
            if (key.Length == 0)
            {
                return false;
            }
            CookiesDisabledSites = CookiesDisabledSites ?? new List<string>();
            CookiesDisabledSites.Remove(key);
            if (!enabled)
            {
                CookiesDisabledSites.Add(key);
                CookiesDisabledSites.Sort(StringComparer.Ordinal);
            }
            return true;
        }

        /// <summary>The host, each parent domain and the aliases of its site, in lower case.</summary>
        internal static IEnumerable<string> SiteKeys(string host)
        {
            string h = (host ?? string.Empty).Trim().Trim('.').ToLowerInvariant();
            var keys = new List<string>();
            string[] parts = h.Split(new[] { '.' }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < parts.Length; i++)
            {
                keys.Add(string.Join(".", parts.Skip(i)));
            }
            string site = CookieStore.RegistrableDomain(h);
            if (SiteAliases.TryGetValue(site, out string[] aliases))
            {
                keys.AddRange(aliases);
            }
            return keys.Distinct();
        }

        private static readonly Dictionary<string, string[]> SiteAliases = new Dictionary<string, string[]>
        {
            ["youtu.be"] = new[] { "youtube.com" },
            ["youtube-nocookie.com"] = new[] { "youtube.com" },
            ["x.com"] = new[] { "twitter.com" },
            ["twitter.com"] = new[] { "x.com" },
        };

        /// <summary>"https://www.Instagram.com/p/x" or " instagram.com " → "instagram.com"; empty when it is not a site.</summary>
        internal static string NormalizeSite(string value)
        {
            string text = (value ?? string.Empty).Trim().ToLowerInvariant();
            int scheme = text.IndexOf("://", StringComparison.Ordinal);
            if (scheme >= 0)
            {
                text = text.Substring(scheme + 3);
            }
            int end = text.IndexOfAny(new[] { '/', '?', '#' });
            if (end >= 0)
            {
                text = text.Substring(0, end);
            }
            int at = text.LastIndexOf('@');
            if (at >= 0)
            {
                text = text.Substring(at + 1);
            }
            int port = text.IndexOf(':');
            if (port >= 0)
            {
                text = text.Substring(0, port);
            }
            text = text.Trim().Trim('.');
            if (text.Length == 0 || text.IndexOf('.') < 0 || text.Any(ch => !(char.IsLetterOrDigit(ch) || ch == '.' || ch == '-')))
            {
                return string.Empty;
            }
            return CookieStore.RegistrableDomain(text);
        }

        internal void Normalize()
        {
            Mode = Modes.Normalize(Mode);
            VideoQuality = VideoQualities.Normalize(VideoQuality);
            AudioFormat = AudioFormats.Normalize(AudioFormat);
            TransientFormat = TransientFormats.Normalize(TransientFormat);
            Rules = Rules ?? new List<Rule>();
            Channels = Channels ?? new List<Channel>();
            CookiesDisabledSites = (CookiesDisabledSites ?? new List<string>())
                .Select(NormalizeSite).Where(s => s.Length > 0).Distinct().OrderBy(s => s, StringComparer.Ordinal).ToList();
            foreach (Channel channel in Channels)
            {
                channel.Seen = channel.Seen ?? new List<string>();
                channel.NewItems = channel.NewItems ?? new List<ChannelItem>();
                if (string.IsNullOrEmpty(channel.Id))
                {
                    channel.Id = Guid.NewGuid().ToString("N").Substring(0, 10);
                }
                channel.IntervalMinutes = Clamp(channel.IntervalMinutes <= 0 ? 60 : channel.IntervalMinutes, 15, 24 * 60);
            }
            if (string.IsNullOrWhiteSpace(BridgeCode) || BridgeCode.Length != 8)
            {
                BridgeCode = NewBridgeCode();
                NeedsSave = true;
            }
        }

        /// <summary>Something was generated while loading (the pairing code): save now, or it changes on every start.</summary>
        [System.Web.Script.Serialization.ScriptIgnore]
        public bool NeedsSave { get; set; }

        /// <summary>8 characters without look-alikes (no 0/O/1/I), easy to read aloud and type.</summary>
        internal static string NewBridgeCode()
        {
            const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
            var bytes = new byte[8];
            using (var rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(bytes);
            }
            var code = new StringBuilder(8);
            foreach (byte b in bytes)
            {
                code.Append(alphabet[b % alphabet.Length]);
            }
            return code.ToString();
        }
    }

    /// <summary>"When the link matches, save here / with this quality."</summary>
    internal sealed class Rule
    {
        public bool Active { get; set; } = true;
        /// <summary>site | contem | plataforma</summary>
        public string When { get; set; } = "site";
        public string Value { get; set; } = string.Empty;
        public string Folder { get; set; } = string.Empty;
        /// <summary>Empty = keep the page choice; otherwise video | audio.</summary>
        public string Mode { get; set; } = string.Empty;
        public string Quality { get; set; } = string.Empty;

        public Dictionary<string, object> ToBackend() => new Dictionary<string, object>
        {
            ["ativo"] = Active,
            ["quando"] = When ?? "site",
            ["valor"] = (Value ?? string.Empty).Trim(),
            ["pasta"] = Folder ?? string.Empty,
            ["modo"] = Mode ?? string.Empty,
            ["qualidade"] = Quality ?? string.Empty,
        };
    }

    /// <summary>A followed channel, profile or playlist, checked for new uploads.</summary>
    internal sealed class Channel
    {
        public string Id { get; set; }
        public string Url { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public bool AutoDownload { get; set; }
        public int IntervalMinutes { get; set; } = 60;
        public double LastCheckedTs { get; set; }
        public string LastError { get; set; } = string.Empty;
        public int NewCount { get; set; }
        /// <summary>Ids already seen (newest kept, max 500).</summary>
        public List<string> Seen { get; set; } = new List<string>();
        /// <summary>False until the first check learned what already existed (that check never reports news).</summary>
        public bool Seeded { get; set; }
        /// <summary>New uploads found but not downloaded yet (channels without automatic download).</summary>
        public List<ChannelItem> NewItems { get; set; } = new List<ChannelItem>();
    }

    internal sealed class ChannelItem
    {
        public string Url { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
    }

    internal static class Modes
    {
        public const string Video = "video";
        public const string Audio = "audio";

        public static string Normalize(string value) => value == Audio ? Audio : Video;
    }

    internal static class VideoQualities
    {
        public const string Best = "melhor";
        public const string Smallest = "menor";
        public static readonly string[] All = { Best, "2160", "1440", "1080", "720", "480", "360", Smallest };

        public static string Normalize(string value) => All.Contains(value) ? value : Best;

        public static string Label(string value)
        {
            switch (value)
            {
                case Best: return "Melhor qualidade";
                case Smallest: return "Menor tamanho";
                case "2160": return "4K (2160p)";
                default: return value + "p";
            }
        }
    }

    internal static class AudioFormats
    {
        public const string Original = "original";
        public static readonly string[] All = { Original, "m4a", "mp3", "opus", "flac", "wav" };

        public static string Normalize(string value) => All.Contains(value) ? value : Original;

        public static string Label(string value) => value == Original ? "Original (sem converter)" : value.ToUpperInvariant();
    }

    /// <summary>Formats the transient mode cuts its sections into (servidor/transientes.py FORMATOS_EXPORTACAO).</summary>
    internal static class TransientFormats
    {
        public const string Ask = "";
        public static readonly string[] All = { "mp3", "wav", "flac" };

        /// <summary>A known format in lower case, or <see cref="Ask"/>.</summary>
        public static string Normalize(string value)
        {
            string v = (value ?? string.Empty).Trim().ToLowerInvariant();
            return All.Contains(v) ? v : Ask;
        }
    }

    /// <summary>Reads and writes settings.json atomically.</summary>
    internal sealed class PreferencesStore
    {
        private readonly string _path;
        private readonly object _gate = new object();

        public PreferencesStore(string dataDirectory)
        {
            _path = Path.Combine(dataDirectory, "settings.json");
        }

        public string FilePath => _path;

        public Preferences Load()
        {
            Preferences prefs = null;
            try
            {
                if (File.Exists(_path))
                {
                    prefs = BackendHost.NewSerializer().Deserialize<Preferences>(File.ReadAllText(_path, Encoding.UTF8));
                }
            }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException || error is ArgumentException || error is InvalidOperationException)
            {
                try
                {
                    File.Copy(_path, Path.ChangeExtension(_path, ".damaged.json"), true);
                }
                catch (Exception copyError) when (copyError is IOException || copyError is UnauthorizedAccessException)
                {
                }
            }
            prefs = prefs ?? new Preferences();
            prefs.Normalize();
            return prefs;
        }

        public void Save(Preferences prefs)
        {
            string json;
            lock (prefs)
            {
                json = BackendHost.NewSerializer().Serialize(prefs);
            }
            lock (_gate)
            {
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(_path));
                    string temp = _path + ".tmp";
                    File.WriteAllText(temp, json, new UTF8Encoding(false));
                    if (File.Exists(_path))
                    {
                        File.Replace(temp, _path, null);
                    }
                    else
                    {
                        File.Move(temp, _path);
                    }
                }
                catch (Exception error) when (error is IOException || error is UnauthorizedAccessException)
                {
                    // Next save retries.
                }
            }
        }
    }
}
