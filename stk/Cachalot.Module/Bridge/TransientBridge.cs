using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Threading.Tasks;
using SwissTechKnife.Sdk;
using Cachalot.Module.Downloads;

namespace Cachalot.Module.Bridge
{
    /// <summary>
    /// The extension's transient mode: the waveform and sections of a song. The backend prepares the audio (a hidden
    /// audio download plus a mono 22 050 Hz PCM copy for the analysis, which runs in the extension) and cuts the chosen
    /// sections into WAV, FLAC or MP3 files in the downloads folder. This class maps the bridge calls to the backend's
    /// <c>transiente</c> action and its answers to HTTP; paths on disk never reach the extension.
    /// </summary>
    internal sealed class TransientBridge
    {
        private static readonly TimeSpan PrepareTimeout = TimeSpan.FromSeconds(90); // the backend may have to start first
        private static readonly TimeSpan StatusTimeout = TimeSpan.FromSeconds(20);
        private static readonly TimeSpan ExportTimeout = TimeSpan.FromMinutes(5);

        private readonly IModuleContext _context;
        private readonly Func<DownloadService> _service;
        private readonly Dictionary<string, string> _exported = new Dictionary<string, string>(); // job id -> last file or folder written

        public TransientBridge(IModuleContext context, Func<DownloadService> service)
        {
            _context = context;
            _service = service;
        }

        public async Task<BridgeReply> HandleAsync(string op, Dictionary<string, object> body)
        {
            DownloadService service = await OnUi(() => _service()).ConfigureAwait(false);
            string id = Str(body, "id");
            switch (op)
            {
                case "prepare":
                    return await PrepareAsync(service, body).ConfigureAwait(false);
                case "status":
                    return Answer(await AskAsync(service, "estado", new Dictionary<string, object> { ["id"] = id }, StatusTimeout).ConfigureAwait(false));
                case "export":
                    return await ExportAsync(service, id, body).ConfigureAwait(false);
                case "format":
                    // the remembered section format ("" = ask); the module's settings change or clear it
                    string format = await OnUi(() => TransientFormats.Normalize(service.Prefs.TransientFormat)).ConfigureAwait(false);
                    return Ok(new Dictionary<string, object> { ["format"] = format });
                case "open":
                    string path;
                    lock (_exported)
                    {
                        _exported.TryGetValue(id, out path);
                    }
                    bool opened = !string.IsNullOrEmpty(path) && await OnUi(() => service.Reveal(path)).ConfigureAwait(false);
                    return opened ? Ok(new Dictionary<string, object>()) : NotFound();
                default:
                    return NotFound();
            }
        }

        /// <summary>The analysis audio of a ready job, read from the module's data folder (and nowhere else).</summary>
        public async Task<byte[]> PcmAsync(string id)
        {
            DownloadService service = await OnUi(() => _service()).ConfigureAwait(false);
            Dictionary<string, object> reply = await AskAsync(service, "estado", new Dictionary<string, object> { ["id"] = id }, StatusTimeout).ConfigureAwait(false);
            if (reply == null || !IsTrue(reply, "ok") || Str(reply, "estado") != "pronto")
            {
                return null;
            }
            string path;
            try
            {
                path = Path.GetFullPath(Str(reply, "pcm"));
            }
            catch (Exception error) when (error is ArgumentException || error is NotSupportedException || error is PathTooLongException)
            {
                return null;
            }
            string root = Path.GetFullPath(_context.DataDirectory).TrimEnd('\\') + "\\";
            if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(path))
            {
                return null;
            }
            return await Task.Run(() => File.ReadAllBytes(path)).ConfigureAwait(false);
        }

        private async Task<BridgeReply> PrepareAsync(DownloadService service, Dictionary<string, object> body)
        {
            string url = Str(body, "url").Trim();
            if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                return new BridgeReply(400, new Dictionary<string, object> { ["error"] = "url is required" });
            }
            Dictionary<string, object> headers = body.TryGetValue("headers", out object h) ? h as Dictionary<string, object> : null;
            List<Dictionary<string, object>> cookies = LocalBridge.CookiesOf(body);
            string page = Str(body, "pageUrl");
            Dictionary<string, object> options = await OnUi(() =>
            {
                // same as POST /download: the site's cookies go to the store yt-dlp reads
                if (cookies.Count > 0 && Uri.TryCreate(page.Length > 0 ? page : url, UriKind.Absolute, out Uri origin))
                {
                    try
                    {
                        service.Cookies.SaveFromBrowser(origin.Host, cookies);
                    }
                    catch (Exception error) when (error is IOException || error is UnauthorizedAccessException)
                    {
                        _context.Log.Warn("Could not save the browser cookies: " + error.Message);
                    }
                }
                return service.TransientOptions(headers);
            }).ConfigureAwait(false);
            var fields = new Dictionary<string, object>
            {
                ["url"] = url,
                ["titulo"] = Str(body, "title"),
                ["opcoes"] = options,
            };
            return Answer(await AskAsync(service, "preparar", fields, PrepareTimeout).ConfigureAwait(false));
        }

        private async Task<BridgeReply> ExportAsync(DownloadService service, string id, Dictionary<string, object> body)
        {
            var segments = new List<object>();
            if (body.TryGetValue("segments", out object raw) && raw is object[] list)
            {
                foreach (object item in list)
                {
                    if (item is Dictionary<string, object> s)
                    {
                        segments.Add(new Dictionary<string, object>
                        {
                            ["inicio"] = Num(s, "start"),
                            ["fim"] = Num(s, "end"),
                            ["numero"] = (int)Num(s, "number"),
                            ["fade_entrada"] = Num(s, "fadeIn"),
                            ["curva_entrada"] = Num(s, "fadeInCurve"),
                            ["fade_saida"] = Num(s, "fadeOut"),
                            ["curva_saida"] = Num(s, "fadeOutCurve"),
                        });
                    }
                }
            }
            if (segments.Count == 0)
            {
                return new BridgeReply(400, new Dictionary<string, object> { ["error"] = "no sections" });
            }
            string format = TransientFormats.Normalize(Str(body, "format"));
            bool remember = IsTrue(body, "remember") && format.Length > 0;
            string folder = await OnUi(() =>
            {
                if (remember && service.Prefs.TransientFormat != format)
                {
                    service.Prefs.TransientFormat = format;
                    service.PreferencesChanged();
                }
                return service.State.Folder ?? service.DefaultFolder;
            }).ConfigureAwait(false);
            var fields = new Dictionary<string, object>
            {
                ["id"] = id,
                ["segmentos"] = segments,
                ["titulo"] = Str(body, "title"),
                ["pasta"] = IsTrue(body, "folder"),
                ["destino"] = folder,
                ["formato"] = format.Length > 0 ? format : "wav",
            };
            Dictionary<string, object> reply = await AskAsync(service, "exportar", fields, ExportTimeout).ConfigureAwait(false);
            if (reply != null && IsTrue(reply, "ok"))
            {
                lock (_exported)
                {
                    _exported[id] = Str(reply, "caminho");
                }
            }
            return Answer(reply);
        }

        private Task<Dictionary<string, object>> AskAsync(DownloadService service, string op, Dictionary<string, object> fields, TimeSpan timeout) =>
            _context.Dispatcher.InvokeAsync(() => service.TransientAsync(op, fields, timeout)).Task.Unwrap();

        private Task<T> OnUi<T>(Func<T> action) => _context.Dispatcher.InvokeAsync(action).Task;

        /// <summary>The backend's answer in the extension's words (English keys, no paths).</summary>
        private static BridgeReply Answer(Dictionary<string, object> reply)
        {
            if (reply == null)
            {
                return new BridgeReply(503, new Dictionary<string, object> { ["error"] = "O Cachalot não respondeu a tempo." });
            }
            if (!IsTrue(reply, "ok"))
            {
                string error = Str(reply, "erro");
                return error == "não encontrado" ? NotFound() : new BridgeReply(422, new Dictionary<string, object> { ["error"] = error });
            }
            var body = new Dictionary<string, object>();
            Copy(reply, body, "id", "id");
            Copy(reply, body, "estado", "state");
            Copy(reply, body, "progresso", "progress");
            Copy(reply, body, "fase", "phase");
            Copy(reply, body, "erro", "error");
            Copy(reply, body, "titulo", "title");
            Copy(reply, body, "duracao", "duration");
            Copy(reply, body, "taxa", "rate");
            Copy(reply, body, "bytes", "bytes");
            Copy(reply, body, "arquivos", "files");
            string written = Str(reply, "caminho");
            if (written.Length > 0)
            {
                body["saved"] = Path.GetFileName(written.TrimEnd('\\', '/'));
            }
            return Ok(body);
        }

        private static void Copy(Dictionary<string, object> from, Dictionary<string, object> to, string key, string name)
        {
            if (from.TryGetValue(key, out object value) && value != null)
            {
                to[name] = value;
            }
        }

        private static BridgeReply Ok(Dictionary<string, object> body)
        {
            body["ok"] = true;
            return new BridgeReply(200, body);
        }

        private static BridgeReply NotFound() => new BridgeReply(404, new Dictionary<string, object> { ["error"] = "not found" });

        private static bool IsTrue(Dictionary<string, object> d, string key) => d.TryGetValue(key, out object v) && v is bool b && b;

        private static string Str(Dictionary<string, object> d, string key) =>
            d != null && d.TryGetValue(key, out object v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : string.Empty;

        private static double Num(Dictionary<string, object> d, string key)
        {
            if (!d.TryGetValue(key, out object v) || v == null)
            {
                return 0;
            }
            try
            {
                return Convert.ToDouble(v, CultureInfo.InvariantCulture);
            }
            catch (Exception error) when (error is FormatException || error is InvalidCastException || error is OverflowException)
            {
                return 0;
            }
        }
    }
}
