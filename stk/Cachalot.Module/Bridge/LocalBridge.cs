using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using SwissTechKnife.Sdk;
using Cachalot.Module.Backend;

namespace Cachalot.Module.Bridge
{
    /// <summary>A request from the browser extension, already authenticated.</summary>
    internal sealed class BridgeDownload
    {
        public List<string> Urls { get; } = new List<string>();
        public string Mode { get; set; }
        public string Title { get; set; }
        public string PageUrl { get; set; }
        public Dictionary<string, object> Headers { get; set; }
        public List<Dictionary<string, object>> Cookies { get; } = new List<Dictionary<string, object>>();
    }

    /// <summary>
    /// Tiny HTTP server on 127.0.0.1 (47821–47830) for the Chrome extension: <c>GET /ping</c>, <c>GET /downloads</c>,
    /// <c>POST /download</c>, <c>POST /cookies</c>, <c>POST /open-folder</c>, <c>POST /show</c>, <c>POST /cancel</c>. A raw socket instead of HttpListener so no URL reservation or admin rights are needed.
    /// Every POST needs the pairing code shown in the settings; requests from web pages (http/https origins) are refused.
    /// Idle cost: one pending accept, no polling.
    /// </summary>
    internal sealed class LocalBridge : IDisposable
    {
        public const int FirstPort = 47821;
        public const int LastPort = 47830;
        private const int MaxBody = 4 * 1024 * 1024;

        private readonly Func<string> _code;
        private readonly string _version;
        private readonly IModuleLog _log;
        private TcpListener _listener;
        private CancellationTokenSource _stop;

        public LocalBridge(Func<string> code, string version, IModuleLog log)
        {
            _code = code;
            _version = version;
            _log = log;
        }

        /// <summary>Raised on a pool thread; the handler returns how many links were queued (or throws).</summary>
        public Func<BridgeDownload, Task<int>> DownloadRequested { get; set; }

        public Func<string, List<Dictionary<string, object>>, int> CookiesReceived { get; set; }

        /// <summary>GET /downloads: snapshot of the queue and recent history (url, status, progress…).</summary>
        public Func<List<Dictionary<string, object>>> DownloadsRequested { get; set; }

        /// <summary>POST /open-folder {"id"}: shows a finished download in Explorer; false when it is unknown or gone.</summary>
        public Func<string, bool> OpenFolderRequested { get; set; }

        /// <summary>POST /show: brings the SwissTechKnife window forward on Cachalot's page.</summary>
        public Action ShowRequested { get; set; }

        /// <summary>POST /cancel {"id"}: cancels a queued or running download; false when it is unknown or finished.</summary>
        public Func<string, bool> CancelRequested { get; set; }

        public int Port { get; private set; }

        public bool IsRunning => _listener != null;

        public void Start()
        {
            if (_listener != null)
            {
                return;
            }
            for (int port = FirstPort; port <= LastPort; port++)
            {
                var listener = new TcpListener(IPAddress.Loopback, port);
                try
                {
                    listener.Start();
                }
                catch (SocketException)
                {
                    continue;
                }
                _listener = listener;
                Port = port;
                _stop = new CancellationTokenSource();
                Task.Run(() => AcceptLoopAsync(listener, _stop.Token));
                _log.Info($"Cachalot bridge listening on 127.0.0.1:{port}.");
                return;
            }
            _log.Warn("Cachalot bridge: no free port between 47821 and 47830.");
        }

        public void Stop()
        {
            _stop?.Cancel();
            try
            {
                _listener?.Stop();
            }
            catch (SocketException)
            {
            }
            _listener = null;
            _stop = null;
            Port = 0;
        }

        public void Dispose() => Stop();

        private async Task AcceptLoopAsync(TcpListener listener, CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await listener.AcceptTcpClientAsync().ConfigureAwait(false);
                }
                catch (Exception error) when (error is ObjectDisposedException || error is SocketException || error is InvalidOperationException)
                {
                    return;
                }
                _ = Task.Run(() => HandleAsync(client));
            }
        }

        private async Task HandleAsync(TcpClient client)
        {
            using (client)
            {
                client.ReceiveTimeout = 10000;
                client.SendTimeout = 10000;
                NetworkStream stream = client.GetStream();
                Request request;
                try
                {
                    request = await ReadRequestAsync(stream).ConfigureAwait(false);
                }
                catch (Exception error) when (error is IOException || error is InvalidDataException || error is SocketException || error is ObjectDisposedException)
                {
                    return;
                }
                if (request == null)
                {
                    return;
                }
                Response response;
                try
                {
                    response = await RouteAsync(request).ConfigureAwait(false);
                }
                catch (Exception error)
                {
                    _log.Error("Cachalot bridge request failed.", error);
                    response = Json(500, new Dictionary<string, object> { ["error"] = error.Message });
                }
                try
                {
                    await WriteResponseAsync(stream, request, response).ConfigureAwait(false);
                }
                catch (Exception error) when (error is IOException || error is SocketException || error is ObjectDisposedException)
                {
                }
            }
        }

        private async Task<Response> RouteAsync(Request request)
        {
            if (request.Method == "OPTIONS")
            {
                return new Response(204, null);
            }
            if (IsWebPage(request.Origin))
            {
                return Json(403, new Dictionary<string, object> { ["error"] = "forbidden" });
            }
            bool paired = Authorized(request);
            if (request.Path == "/ping" && request.Method == "GET")
            {
                return Json(200, new Dictionary<string, object> { ["app"] = "cachalot", ["version"] = _version, ["paired"] = paired });
            }
            if (request.Path == "/downloads" && request.Method == "GET")
            {
                // The queue and recent history, so the extension shows the progress of what it sent.
                if (!paired)
                {
                    return Json(401, new Dictionary<string, object> { ["error"] = "unauthorized" });
                }
                List<Dictionary<string, object>> items = DownloadsRequested?.Invoke() ?? new List<Dictionary<string, object>>();
                return Json(200, new Dictionary<string, object> { ["items"] = items });
            }
            if (request.Method != "POST" || (request.Path != "/download" && request.Path != "/cookies" && request.Path != "/open-folder" && request.Path != "/show" && request.Path != "/cancel"))
            {
                return Json(404, new Dictionary<string, object> { ["error"] = "not found" });
            }
            if (!paired)
            {
                return Json(401, new Dictionary<string, object> { ["error"] = "unauthorized" });
            }
            Dictionary<string, object> body;
            try
            {
                body = BackendHost.NewSerializer().DeserializeObject(Encoding.UTF8.GetString(request.Body)) as Dictionary<string, object>;
            }
            catch (ArgumentException)
            {
                body = null;
            }
            if (body == null)
            {
                return Json(400, new Dictionary<string, object> { ["error"] = "invalid json" });
            }

            if (request.Path == "/show")
            {
                if (ShowRequested == null)
                {
                    return Json(503, new Dictionary<string, object> { ["error"] = "not ready" });
                }
                ShowRequested();
                return Json(200, new Dictionary<string, object> { ["ok"] = true });
            }

            if (request.Path == "/open-folder" || request.Path == "/cancel")
            {
                // Only an id from GET /downloads: the extension never names a path on disk.
                string id = Str(body, "id");
                if (id.Length == 0)
                {
                    return Json(400, new Dictionary<string, object> { ["error"] = "id is required" });
                }
                Func<string, bool> handler = request.Path == "/cancel" ? CancelRequested : OpenFolderRequested;
                bool opened = handler != null && handler(id);
                return opened
                    ? Json(200, new Dictionary<string, object> { ["ok"] = true })
                    : Json(404, new Dictionary<string, object> { ["error"] = "not found" });
            }

            if (request.Path == "/cookies")
            {
                string domain = Str(body, "domain");
                List<Dictionary<string, object>> cookies = Cookies(body);
                int count = domain.Length == 0 || CookiesReceived == null ? 0 : CookiesReceived(domain, cookies);
                return Json(200, new Dictionary<string, object> { ["ok"] = true, ["count"] = count });
            }

            var download = new BridgeDownload
            {
                Mode = Str(body, "mode"),
                Title = Str(body, "title"),
                PageUrl = Str(body, "pageUrl"),
                Headers = body.TryGetValue("headers", out object h) ? h as Dictionary<string, object> : null,
            };
            if (body.TryGetValue("urls", out object rawUrls) && rawUrls is object[] urls)
            {
                foreach (object u in urls)
                {
                    string url = Convert.ToString(u, CultureInfo.InvariantCulture)?.Trim();
                    if (!string.IsNullOrEmpty(url) && (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                                                       url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
                                                       url.StartsWith("magnet:", StringComparison.OrdinalIgnoreCase)))
                    {
                        download.Urls.Add(url);
                    }
                }
            }
            download.Cookies.AddRange(Cookies(body));
            if (download.Urls.Count == 0)
            {
                return Json(400, new Dictionary<string, object> { ["error"] = "no urls" });
            }
            if (DownloadRequested == null)
            {
                return Json(503, new Dictionary<string, object> { ["error"] = "not ready" });
            }
            int queued = await DownloadRequested(download).ConfigureAwait(false);
            return Json(202, new Dictionary<string, object> { ["ok"] = true, ["queued"] = queued });
        }

        private bool Authorized(Request request)
        {
            string header = request.Authorization ?? string.Empty;
            const string prefix = "Bearer ";
            if (!header.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
            string given = header.Substring(prefix.Length).Trim().ToUpperInvariant().Replace("-", string.Empty).Replace(" ", string.Empty);
            string expected = _code() ?? string.Empty;
            if (given.Length != expected.Length || expected.Length == 0)
            {
                return false;
            }
            int diff = 0;
            for (int i = 0; i < expected.Length; i++)
            {
                diff |= given[i] ^ expected[i];
            }
            return diff == 0;
        }

        /// <summary>Extensions call from chrome-extension:// (or no Origin from the service worker); websites never may.</summary>
        internal static bool IsWebPage(string origin) =>
            !string.IsNullOrEmpty(origin) && (origin.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                                              origin.StartsWith("https://", StringComparison.OrdinalIgnoreCase));

        private static List<Dictionary<string, object>> Cookies(Dictionary<string, object> body)
        {
            var list = new List<Dictionary<string, object>>();
            if (body.TryGetValue("cookies", out object raw) && raw is object[] array)
            {
                foreach (object c in array)
                {
                    if (c is Dictionary<string, object> cookie)
                    {
                        list.Add(cookie);
                    }
                }
            }
            return list;
        }

        private static string Str(Dictionary<string, object> d, string key) =>
            d.TryGetValue(key, out object v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : string.Empty;

        // ── HTTP plumbing ────────────────────────────────────────────────────

        internal sealed class Request
        {
            public string Method;
            public string Path;
            public string Origin;
            public string Authorization;
            public byte[] Body = new byte[0];
        }

        private sealed class Response
        {
            public Response(int status, string json)
            {
                Status = status;
                Json = json;
            }

            public int Status { get; }
            public string Json { get; }
        }

        private static Response Json(int status, Dictionary<string, object> data) => new Response(status, BackendHost.NewSerializer().Serialize(data));

        internal static async Task<Request> ReadRequestAsync(Stream stream)
        {
            var head = new MemoryStream();
            var buffer = new byte[4096];
            int headerEnd = -1;
            while (headerEnd < 0)
            {
                int read = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                if (read == 0)
                {
                    return null;
                }
                head.Write(buffer, 0, read);
                if (head.Length > 64 * 1024)
                {
                    throw new InvalidDataException("Headers too large.");
                }
                headerEnd = IndexOf(head.GetBuffer(), (int)head.Length, new byte[] { 13, 10, 13, 10 });
            }
            byte[] all = head.ToArray();
            string[] lines = Encoding.ASCII.GetString(all, 0, headerEnd).Split(new[] { "\r\n" }, StringSplitOptions.None);
            string[] first = lines[0].Split(' ');
            if (first.Length < 2)
            {
                throw new InvalidDataException("Bad request line.");
            }
            var request = new Request { Method = first[0].ToUpperInvariant(), Path = first[1].Split('?')[0] };
            int length = 0;
            for (int i = 1; i < lines.Length; i++)
            {
                int colon = lines[i].IndexOf(':');
                if (colon <= 0)
                {
                    continue;
                }
                string name = lines[i].Substring(0, colon).Trim().ToLowerInvariant();
                string value = lines[i].Substring(colon + 1).Trim();
                if (name == "content-length")
                {
                    int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out length);
                }
                else if (name == "origin")
                {
                    request.Origin = value;
                }
                else if (name == "authorization")
                {
                    request.Authorization = value;
                }
            }
            if (length < 0 || length > MaxBody)
            {
                throw new InvalidDataException("Body too large.");
            }
            var body = new MemoryStream();
            int already = all.Length - (headerEnd + 4);
            if (already > 0)
            {
                body.Write(all, headerEnd + 4, Math.Min(already, length));
            }
            while (body.Length < length)
            {
                int read = await stream.ReadAsync(buffer, 0, (int)Math.Min(buffer.Length, length - body.Length)).ConfigureAwait(false);
                if (read == 0)
                {
                    break;
                }
                body.Write(buffer, 0, read);
            }
            request.Body = body.ToArray();
            return request;
        }

        private static async Task WriteResponseAsync(Stream stream, Request request, Response response)
        {
            byte[] payload = response.Json == null ? new byte[0] : Encoding.UTF8.GetBytes(response.Json);
            var head = new StringBuilder();
            head.Append("HTTP/1.1 ").Append(response.Status).Append(' ').Append(Reason(response.Status)).Append("\r\n");
            head.Append("Content-Type: application/json; charset=utf-8\r\n");
            head.Append("Content-Length: ").Append(payload.Length).Append("\r\n");
            head.Append("Cache-Control: no-store\r\nConnection: close\r\n");
            if (!string.IsNullOrEmpty(request.Origin) && !IsWebPage(request.Origin))
            {
                head.Append("Access-Control-Allow-Origin: ").Append(request.Origin).Append("\r\n");
                head.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
                head.Append("Access-Control-Allow-Headers: Authorization, Content-Type\r\n");
                head.Append("Access-Control-Allow-Private-Network: true\r\n");
                head.Append("Vary: Origin\r\n");
            }
            head.Append("\r\n");
            byte[] headBytes = Encoding.ASCII.GetBytes(head.ToString());
            await stream.WriteAsync(headBytes, 0, headBytes.Length).ConfigureAwait(false);
            if (payload.Length > 0)
            {
                await stream.WriteAsync(payload, 0, payload.Length).ConfigureAwait(false);
            }
            await stream.FlushAsync().ConfigureAwait(false);
        }

        private static string Reason(int status)
        {
            switch (status)
            {
                case 200: return "OK";
                case 202: return "Accepted";
                case 204: return "No Content";
                case 400: return "Bad Request";
                case 401: return "Unauthorized";
                case 403: return "Forbidden";
                case 404: return "Not Found";
                case 503: return "Service Unavailable";
                default: return "Error";
            }
        }

        private static int IndexOf(byte[] data, int length, byte[] pattern)
        {
            for (int i = 0; i <= length - pattern.Length; i++)
            {
                int j = 0;
                while (j < pattern.Length && data[i + j] == pattern[j])
                {
                    j++;
                }
                if (j == pattern.Length)
                {
                    return i;
                }
            }
            return -1;
        }
    }
}
