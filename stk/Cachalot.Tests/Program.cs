using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Threading;
using SwissTechKnife.Sdk;
using Cachalot.Module;
using Cachalot.Module.Bridge;
using Cachalot.Module.Downloads;
using Cachalot.Module.Native;
using Cachalot.Module.Setup;

namespace Cachalot.Tests
{
    internal static class Program
    {
        private static int _failed;
        private static int _passed;

        [STAThread]
        private static int Main(string[] args)
        {
            int serve = Array.IndexOf(args, "--serve");
            if (serve >= 0 && serve + 3 < args.Length)
            {
                // Real module (bridge + backend) for an external client such as the extension e2e:
                // --serve <data dir> <pairing code> <seconds>. Exits after the first finished download.
                return Serve(args[serve + 1], args[serve + 2], int.Parse(args[serve + 3]));
            }

            Run("registrable domain", RegistrableDomain);
            Run("cookies: import splits by site", CookieImport);
            Run("cookies: browser cookies to Netscape", CookieFromBrowser);
            Run("preferences: round trip and defaults", PreferencesRoundTrip);
            Run("cookies: global and per-site switches", CookieSwitches);
            // Own STA thread: RunOnDispatcher shuts its dispatcher down, and the integration test needs this one.
            var upgrade = new Thread(() => RunOnDispatcher("upgrade: 1.x state.json opens the page", LegacyStateAsync));
            upgrade.SetApartmentState(ApartmentState.STA);
            upgrade.Start();
            upgrade.Join();
            Run("download item: detail line", ItemDetail);
            Run("clipboard: first link", ClipboardLink);
            Run("bridge: auth, origin and CORS", () => BridgeAsync().GetAwaiter().GetResult());
            Run("chrome: developer mode and unpacked extension", ChromeDetection);
            Run("extension: mirror, pairing and build files", ExtensionInstall);

            if (args.Contains("--integration"))
            {
                RunOnDispatcher("integration: module + real backend", IntegrationAsync);
            }

            Console.WriteLine($"{_passed} passed, {_failed} failed");
            return _failed == 0 ? 0 : 1;
        }

        // ── unit ──

        private static void RegistrableDomain()
        {
            Equal("youtube.com", CookieStore.RegistrableDomain("www.youtube.com"));
            Equal("youtube.com", CookieStore.RegistrableDomain(".youtube.com"));
            Equal("globo.com.br", CookieStore.RegistrableDomain("g1.globo.com.br"));
            Equal("x.com", CookieStore.RegistrableDomain("x.com"));
            Equal("bbc.co.uk", CookieStore.RegistrableDomain("www.bbc.co.uk"));
        }

        private static void CookieImport()
        {
            string dir = TempDir();
            string txt = Path.Combine(dir, "cookies.txt");
            File.WriteAllText(txt, "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tabc\n" +
                                   "#HttpOnly_.www.youtube.com\tTRUE\t/\tTRUE\t1999999999\tHSID\tdef\n" +
                                   ".instagram.com\tTRUE\t/\tTRUE\t1999999999\tsessionid\tghi\n# comment\n\n", Encoding.UTF8);
            var store = new CookieStore(dir);
            IReadOnlyList<string> sites = store.Import(txt);
            True(sites.Contains("youtube.com") && sites.Contains("instagram.com") && sites.Count == 2, "sites: " + string.Join(",", sites));
            IReadOnlyList<CookieSite> list = store.List();
            Equal(2, list.First(s => s.Domain == "youtube.com").Count);
            store.Delete("instagram.com");
            Equal(1, store.List().Count);
        }

        private static void CookieFromBrowser()
        {
            string dir = TempDir();
            var store = new CookieStore(dir);
            int count = store.SaveFromBrowser("www.youtube.com", new[]
            {
                new Dictionary<string, object> { ["name"] = "SID", ["value"] = "v1", ["domain"] = ".youtube.com", ["path"] = "/", ["secure"] = true, ["hostOnly"] = false, ["httpOnly"] = false, ["expirationDate"] = 1999999999.5 },
                new Dictionary<string, object> { ["name"] = "PREF", ["value"] = "v2", ["domain"] = "www.youtube.com", ["path"] = "/", ["secure"] = false, ["hostOnly"] = true, ["httpOnly"] = true },
            });
            Equal(2, count);
            string[] lines = File.ReadAllLines(Path.Combine(dir, "cookies", "youtube.com.txt"));
            True(lines.Contains(".youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tv1"), "secure domain cookie line");
            True(lines.Contains("#HttpOnly_www.youtube.com\tFALSE\t/\tFALSE\t0\tPREF\tv2"), "host-only httpOnly line");
        }

        private static void PreferencesRoundTrip()
        {
            string dir = TempDir();
            var store = new PreferencesStore(dir);
            Preferences prefs = store.Load();
            Equal(8, prefs.BridgeCode.Length);
            True(prefs.BridgeCode.All(c => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".IndexOf(c) >= 0), "code alphabet");
            prefs.Mode = Modes.Audio;
            prefs.AudioFormat = "mp3";
            prefs.MaxConcurrent = 99;
            Equal(TransientFormats.Ask, prefs.TransientFormat);
            prefs.TransientFormat = "FLAC";
            prefs.Rules.Add(new Rule { Value = "soundcloud.com", Folder = @"C:\Musica", Mode = Modes.Audio });
            prefs.Channels.Add(new Channel { Url = "https://www.youtube.com/@x", IntervalMinutes = 1 });
            store.Save(prefs);
            Preferences back = new PreferencesStore(dir).Load();
            True(!back.NeedsSave && !File.ReadAllText(store.FilePath).Contains("NeedsSave"), "loaded code is kept and the flag is not persisted");
            var module = new CachalotModule();
            string fresh = TempDir();
            module.Initialize(new TestContext(fresh));
            string code = module.Prefs.BridgeCode;
            module.Dispose();
            var again = new CachalotModule();
            again.Initialize(new TestContext(fresh));
            Equal(code, again.Prefs.BridgeCode);
            again.Dispose();
            Equal(Modes.Audio, back.Mode);
            Equal("mp3", back.AudioFormat);
            Equal("flac", back.TransientFormat);

            // Build from before the per-install check: its "offered" flag (set even when skipped) must not block a reinstall.
            string legacy = TempDir();
            File.WriteAllText(Path.Combine(legacy, "settings.json"), "{\"BridgeCode\":\"ABCD2345\",\"ExtensionOffered\":true}");
            Preferences old = new PreferencesStore(legacy).Load();
            True(!old.ExtensionPromptShown && old.ExtensionCheckedInstall == string.Empty && old.BridgeCode == "ABCD2345", "legacy ExtensionOffered ignored");
            Equal(TransientFormats.Ask, TransientFormats.Normalize("ogg"));
            Equal(prefs.BridgeCode, back.BridgeCode);
            Equal(15, back.Channels[0].IntervalMinutes);
            Dictionary<string, object> config = back.ToBackendConfig();
            Equal(10, (int)config["simultaneos"]);
            Equal("audio", (string)config["modo"]);
            Equal(1, ((List<object>)config["regras"]).Count);
        }

        private static void CookieSwitches()
        {
            // Defaults, and a settings.json from before the switches (missing or null list).
            var fresh = new Preferences();
            fresh.Normalize();
            True(fresh.CookiesEnabled && fresh.CookiesDisabledSites.Count == 0, "defaults: on, no site off");
            string legacy = TempDir();
            File.WriteAllText(Path.Combine(legacy, "settings.json"), "{\"BridgeCode\":\"ABCD2345\",\"CookiesDisabledSites\":null}");
            Preferences old = new PreferencesStore(legacy).Load();
            True(old.CookiesEnabled && old.CookiesDisabledSites != null && old.CookiesDisabledSites.Count == 0, "null list from an old settings.json");

            // Normalize: registrable domain, lower case, trimmed, no duplicates or junk.
            var prefs = new Preferences
            {
                CookiesDisabledSites = new List<string> { " Instagram.com ", "https://www.instagram.com/p/abc", "music.youtube.com", "", "localhost", "a b.com", "www.bbc.co.uk:443" },
            };
            prefs.Normalize();
            Equal("bbc.co.uk,instagram.com,youtube.com", string.Join(",", prefs.CookiesDisabledSites));
            Equal("instagram.com", Preferences.NormalizeSite("user:pw@cdn.instagram.com:8080/x"));
            Equal(string.Empty, Preferences.NormalizeSite("not a site"));

            // Matching: host, parent domains and the site's aliases.
            True(!prefs.CookiesAllowedFor("www.instagram.com"), "host under a disabled site");
            True(!prefs.CookiesAllowedFor("instagram.com"), "the site itself");
            True(!prefs.CookiesAllowedFor("youtu.be"), "alias of a disabled site");
            True(prefs.CookiesAllowedFor("notinstagram.com"), "suffix without a dot does not match");
            True(prefs.CookiesAllowedFor("vimeo.com"), "other sites keep their cookies");
            var x = new Preferences { CookiesDisabledSites = new List<string> { "x.com" } };
            True(!x.CookiesAllowedFor("mobile.twitter.com"), "twitter.com follows x.com");
            True(prefs.SetSiteCookies("www.instagram.com", true) && prefs.CookiesAllowedFor("instagram.com"), "turned back on");
            True(prefs.SetSiteCookies("vimeo.com", false) && !prefs.CookiesAllowedFor("player.vimeo.com"), "turned off");
            True(!prefs.SetSiteCookies("nada", false), "not a site");
            prefs.CookiesEnabled = false;
            True(!prefs.CookiesAllowedFor("example.com"), "global switch off");

            // Backend keys and persistence.
            Dictionary<string, object> config = prefs.ToBackendConfig();
            Equal(false, (bool)config["cookies_ativos"]);
            Equal("bbc.co.uk,vimeo.com,youtube.com", string.Join(",", ((List<object>)config["cookies_sites_off"]).Cast<string>()));
            string dir = TempDir();
            var store = new PreferencesStore(dir);
            store.Save(prefs);
            Preferences back = store.Load();
            True(!back.CookiesEnabled && back.CookiesDisabledSites.SequenceEqual(prefs.CookiesDisabledSites), "round trip");

            // The extension's cookies are not saved for a disabled site (POST /cookies answers 0).
            var module = new CachalotModule();
            string data = TempDir();
            module.Initialize(new TestContext(data));
            try
            {
                DownloadService service = module.Service;
                var cookie = new[] { new Dictionary<string, object> { ["name"] = "sessionid", ["value"] = "v", ["domain"] = ".instagram.com", ["path"] = "/" } };
                service.Prefs.SetSiteCookies("instagram.com", false);
                Equal(0, service.SaveBrowserCookies("www.instagram.com", cookie));
                True(!File.Exists(Path.Combine(data, "cookies", "instagram.com.txt")), "nothing written for a disabled site");
                service.Prefs.SetSiteCookies("instagram.com", true);
                service.Prefs.CookiesEnabled = false;
                Equal(0, service.SaveBrowserCookies("www.instagram.com", cookie));
                service.Prefs.CookiesEnabled = true;
                Equal(1, service.SaveBrowserCookies("www.instagram.com", cookie));
            }
            finally
            {
                module.Dispose();
            }
        }

        /// <summary>The state.json VDGET 1.1.0 left behind (legacy "Quality", no "Unfinished").</summary>
        private static async Task LegacyStateAsync()
        {
            string data = TempDir();
            File.WriteAllText(Path.Combine(data, "state.json"),
                "{\"Folders\":[\"I:\\\\Downloads\"],\"Folder\":\"I:\\\\Downloads\",\"Quality\":\"audio\",\"Draft\":\"\",\"OldestFirst\":false,\"History\":[]}");
            var module = new CachalotModule();
            module.Initialize(new TestContext(data));
            try
            {
                // The page needs the host theme, as in the DevHost.
                var app = System.Windows.Application.Current ?? new System.Windows.Application { ShutdownMode = System.Windows.ShutdownMode.OnExplicitShutdown };
                app.Resources.MergedDictionaries.Add(new System.Windows.ResourceDictionary { Source = new Uri("pack://application:,,,/SwissTechKnife.Sdk;component/Theme/Theme.xaml") });
                True(module.CreateView() != null, "page created");
                DownloadService service = module.Service;
                Equal(Modes.Audio, service.Prefs.Mode);
                Equal("I:\\Downloads", service.State.Folder);
                await Task.Delay(1500);
                string state = File.ReadAllText(Path.Combine(data, "state.json"));
                True(state.Contains("\"Quality\":null") && !state.Contains("\"Quality\":\"audio\""), "legacy quality cleared in state.json");
                True(File.ReadAllText(Path.Combine(data, "settings.json")).Contains("\"Mode\":\"audio\""), "mode migrated to settings.json");
            }
            finally
            {
                module.Dispose();
            }
        }

        private static void ItemDetail()
        {
            var item = new DownloadItem { Platform = "YouTube", Status = Statuses.Downloading, Progress = 46.3, Downloaded = "10MiB", Total = "20MiB", Speed = "1MiB/s", Eta = "00:10" };
            Equal("YouTube · 46,3% · 10MiB de 20MiB · 1MiB/s · faltam 00:10", item.Detail);
            item.Status = Statuses.Pending;
            item.Attempt = 2;
            item.Hint = "O site limitou os pedidos por agora.";
            Equal("YouTube · Nova tentativa em instantes (2ª) · O site limitou os pedidos por agora.", item.Detail);
            item.Status = Statuses.Paused;
            Equal("YouTube · Pausado em 46%", item.Detail);
            True(item.IsActive && !item.CanPause && item.IsPaused, "paused flags");
            item.Status = Statuses.Downloading;
            item.Pausing = true;
            Equal("YouTube · Pausando…", item.Detail);
            item.Status = Statuses.Error;
            item.Error = "Conteúdo privado.";
            Equal("YouTube · Conteúdo privado. · O site limitou os pedidos por agora.", item.Detail);
            var gallery = new DownloadItem { Platform = "wallhaven.cc", Engine = "galeria", Status = Statuses.Done, Files = 3 };
            True(gallery.Detail.EndsWith("3 arquivos"), gallery.Detail);
        }

        private static void ClipboardLink()
        {
            Equal("https://youtu.be/abc", ClipboardLinks.First("veja isso: https://youtu.be/abc."));
            Equal("magnet:?xt=urn:btih:123&dn=Linux+ISO", ClipboardLinks.First("magnet:?xt=urn:btih:123&dn=Linux+ISO"));
            Equal(null, ClipboardLinks.First("só texto"));
            Equal("Torrent: Linux ISO", ClipboardLinks.Short("magnet:?xt=urn:btih:123&dn=Linux+ISO"));
            Equal("youtube.com/watch?v=jNQXAC9IVRw", ClipboardLinks.Short("https://www.youtube.com/watch?v=jNQXAC9IVRw"));
        }

        private static async Task BridgeAsync()
        {
            BridgeDownload received = null;
            int shown = 0;
            var bridge = new LocalBridge(() => "ABCD2345", "9.9.9", new ConsoleLog())
            {
                DownloadRequested = d =>
                {
                    received = d;
                    return Task.FromResult(d.Urls.Count);
                },
                CookiesReceived = (domain, cookies) => cookies.Count,
                OpenFolderRequested = id => id == "done-1",
                ShowRequested = () => shown++,
                CancelRequested = id => id == "run-1",
            };
            bridge.Start();
            try
            {
                True(bridge.IsRunning, "listening");
                string root = "http://127.0.0.1:" + bridge.Port;
                using (var http = new HttpClient())
                {
                    HttpResponseMessage ping = await http.GetAsync(root + "/ping");
                    string pingBody = await ping.Content.ReadAsStringAsync();
                    True(ping.StatusCode == HttpStatusCode.OK && pingBody.Contains("\"paired\":false") && pingBody.Contains("cachalot"), pingBody);

                    string body = "{\"urls\":[\"https://www.youtube.com/watch?v=x\",\"javascript:alert(1)\"],\"mode\":\"audio\",\"pageUrl\":\"https://www.youtube.com/watch?v=x\"," +
                                  "\"headers\":{\"Referer\":\"https://www.youtube.com/\"},\"cookies\":[{\"name\":\"SID\",\"value\":\"1\",\"domain\":\".youtube.com\"}]}";
                    HttpResponseMessage noAuth = await http.PostAsync(root + "/download", new StringContent(body, Encoding.UTF8, "application/json"));
                    Equal(HttpStatusCode.Unauthorized, noAuth.StatusCode);

                    var fromSite = new HttpRequestMessage(HttpMethod.Post, root + "/download") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
                    fromSite.Headers.Add("Authorization", "Bearer ABCD2345");
                    fromSite.Headers.Add("Origin", "https://evil.example");
                    Equal(HttpStatusCode.Forbidden, (await http.SendAsync(fromSite)).StatusCode);

                    var preflight = new HttpRequestMessage(HttpMethod.Options, root + "/download");
                    preflight.Headers.Add("Origin", "chrome-extension://abcdefghijklmnop");
                    HttpResponseMessage options = await http.SendAsync(preflight);
                    Equal(HttpStatusCode.NoContent, options.StatusCode);
                    True(options.Headers.TryGetValues("Access-Control-Allow-Origin", out IEnumerable<string> allow) && allow.First() == "chrome-extension://abcdefghijklmnop", "CORS origin echoed");

                    var good = new HttpRequestMessage(HttpMethod.Post, root + "/download") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
                    good.Headers.Add("Authorization", "Bearer abcd-2345");
                    good.Headers.Add("Origin", "chrome-extension://abcdefghijklmnop");
                    HttpResponseMessage accepted = await http.SendAsync(good);
                    Equal(HttpStatusCode.Accepted, accepted.StatusCode);
                    True(received != null && received.Urls.Count == 1 && received.Mode == "audio" && received.Cookies.Count == 1 &&
                         (string)received.Headers["Referer"] == "https://www.youtube.com/", "parsed request");

                    Func<string, string, Task<HttpStatusCode>> openFolder = async (json, auth) =>
                    {
                        var request = new HttpRequestMessage(HttpMethod.Post, root + "/open-folder") { Content = new StringContent(json, Encoding.UTF8, "application/json") };
                        if (auth != null)
                        {
                            request.Headers.Add("Authorization", auth);
                        }
                        request.Headers.Add("Origin", "chrome-extension://abcdefghijklmnop");
                        return (await http.SendAsync(request)).StatusCode;
                    };
                    Equal(HttpStatusCode.Unauthorized, await openFolder("{\"id\":\"done-1\"}", null));
                    Equal(HttpStatusCode.OK, await openFolder("{\"id\":\"done-1\"}", "Bearer ABCD2345"));
                    Equal(HttpStatusCode.NotFound, await openFolder("{\"id\":\"other\"}", "Bearer ABCD2345"));
                    Equal(HttpStatusCode.BadRequest, await openFolder("{}", "Bearer ABCD2345"));

                    Func<string, Task<HttpStatusCode>> show = async auth =>
                    {
                        var request = new HttpRequestMessage(HttpMethod.Post, root + "/show") { Content = new StringContent("{}", Encoding.UTF8, "application/json") };
                        if (auth != null)
                        {
                            request.Headers.Add("Authorization", auth);
                        }
                        request.Headers.Add("Origin", "chrome-extension://abcdefghijklmnop");
                        return (await http.SendAsync(request)).StatusCode;
                    };
                    Equal(HttpStatusCode.Unauthorized, await show(null));
                    Equal(HttpStatusCode.OK, await show("Bearer ABCD2345"));
                    Equal(1, shown);

                    var cancel = new HttpRequestMessage(HttpMethod.Post, root + "/cancel") { Content = new StringContent("{\"id\":\"run-1\"}", Encoding.UTF8, "application/json") };
                    cancel.Headers.Add("Authorization", "Bearer ABCD2345");
                    cancel.Headers.Add("Origin", "chrome-extension://abcdefghijklmnop");
                    Equal(HttpStatusCode.OK, (await http.SendAsync(cancel)).StatusCode);
                    Equal(HttpStatusCode.NotFound, await openFolder("{\"id\":\"run-1\"}", "Bearer ABCD2345"));

                    // Transient mode: JSON operations go to the module, the PCM comes back as raw bytes.
                    string transientOp = null;
                    Dictionary<string, object> transientBody = null;
                    bridge.TransientRequested = (op, b) =>
                    {
                        transientOp = op;
                        transientBody = b;
                        return Task.FromResult(new BridgeReply(200, new Dictionary<string, object> { ["ok"] = true, ["state"] = "pronto" }));
                    };
                    bridge.TransientPcmRequested = id => Task.FromResult(id == "job-1" ? new byte[] { 1, 2, 3, 4 } : null);
                    Func<string, string, string, Task<HttpResponseMessage>> transient = (path, json, auth) =>
                    {
                        var request = new HttpRequestMessage(HttpMethod.Post, root + "/transient/" + path) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
                        if (auth != null)
                        {
                            request.Headers.Add("Authorization", auth);
                        }
                        request.Headers.Add("Origin", "chrome-extension://abcdefghijklmnop");
                        return http.SendAsync(request);
                    };
                    Equal(HttpStatusCode.Unauthorized, (await transient("prepare", "{\"url\":\"https://a/b\"}", null)).StatusCode);
                    HttpResponseMessage prepared = await transient("prepare", "{\"url\":\"https://a/b\",\"title\":\"T\"}", "Bearer ABCD2345");
                    Equal(HttpStatusCode.OK, prepared.StatusCode);
                    True(transientOp == "prepare" && (string)transientBody["title"] == "T" && (await prepared.Content.ReadAsStringAsync()).Contains("\"state\":\"pronto\""), "transient prepare forwarded");
                    Equal(HttpStatusCode.NotFound, (await transient("delete", "{}", "Bearer ABCD2345")).StatusCode);
                    Equal(HttpStatusCode.OK, (await transient("format", "{}", "Bearer ABCD2345")).StatusCode);
                    Equal("format", transientOp);
                    HttpResponseMessage pcm = await transient("pcm", "{\"id\":\"job-1\"}", "Bearer ABCD2345");
                    Equal(HttpStatusCode.OK, pcm.StatusCode);
                    Equal("application/octet-stream", pcm.Content.Headers.ContentType.MediaType);
                    Equal("1,2,3,4", string.Join(",", await pcm.Content.ReadAsByteArrayAsync()));
                    Equal(HttpStatusCode.NotFound, (await transient("pcm", "{\"id\":\"other\"}", "Bearer ABCD2345")).StatusCode);
                    Equal(HttpStatusCode.BadRequest, (await transient("pcm", "{}", "Bearer ABCD2345")).StatusCode);
                }
            }
            finally
            {
                bridge.Dispose();
            }
        }

        // ── integration (real Python backend, real network) ──

        private static async Task IntegrationAsync()
        {
            string data = TempDir();
            string downloads = Path.Combine(data, "baixados");
            Directory.CreateDirectory(downloads);
            var context = new TestContext(data);
            var module = new CachalotModule();
            module.Initialize(context);
            module.Prefs.BridgeCode = "TEST2345";
            module.Start();
            try
            {
                DownloadService service = module.Service;
                service.RememberFolder(downloads);

                // 1) Page path: audio MP3 from YouTube.
                service.Prefs.Mode = Modes.Audio;
                service.Prefs.AudioFormat = "mp3";
                True(await service.AddAsync(new[] { "https://www.youtube.com/watch?v=jNQXAC9IVRw" }, downloads), "add sent");
                DownloadItem mp3 = await WaitFinished(service, i => i.Url.Contains("jNQXAC9IVRw"), TimeSpan.FromMinutes(4));
                True(mp3 != null && mp3.IsDone && File.Exists(mp3.FilePath) && mp3.FilePath.EndsWith(".mp3"), "mp3: " + mp3?.Detail + " " + mp3?.FilePath);
                Console.WriteLine("   mp3 → " + mp3?.FilePath);

                // 2) Extension path: POST /download through the bridge, video mode, with cookies.
                service.Prefs.Mode = Modes.Video;
                service.Prefs.VideoQuality = "360";
                using (var http = new HttpClient())
                {
                    var request = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:" + module.Bridge.Port + "/download")
                    {
                        Content = new StringContent("{\"urls\":[\"https://www.youtube.com/watch?v=jNQXAC9IVRw\"],\"mode\":\"video\",\"pageUrl\":\"https://www.youtube.com/watch?v=jNQXAC9IVRw\"," +
                                                    "\"cookies\":[{\"name\":\"PREF\",\"value\":\"f6=40000000\",\"domain\":\".youtube.com\",\"path\":\"/\",\"secure\":true}]}", Encoding.UTF8, "application/json"),
                    };
                    request.Headers.Add("Authorization", "Bearer TEST2345");
                    HttpResponseMessage response = await http.SendAsync(request);
                    Equal(HttpStatusCode.Accepted, response.StatusCode);
                }
                True(File.Exists(Path.Combine(data, "cookies", "youtube.com.txt")), "cookies saved for youtube.com");
                DownloadItem mp4 = await WaitFinished(service, i => i.Url.Contains("jNQXAC9IVRw") && i.Mode == Modes.Video, TimeSpan.FromMinutes(4));
                True(mp4 != null && mp4.IsDone && File.Exists(mp4.FilePath) && mp4.FilePath.EndsWith(".mp4"), "mp4: " + mp4?.Detail + " " + mp4?.FilePath);
                Console.WriteLine("   mp4 → " + mp4?.FilePath);

                // 3) Pause, resume and cancel a direct file (local throttled server: 40 MiB, ~1.6 MiB/s with 8 connections).
                using (var files = new RangeServer(40L * 1024 * 1024, 200 * 1024))
                {
                    await DirectFileAsync(service, downloads, files.Url("100Mb.dat"));
                }

                // 4) Channel check (first check only learns ids).
                object[] results = await service.CheckChannelsAsync(new[] { new Channel { Id = "c1", Url = "https://www.youtube.com/@NASA" } });
                var first = results?.OfType<Dictionary<string, object>>().FirstOrDefault();
                True(first != null && first.ContainsKey("ids") && ((object[])first["ids"]).Length > 5 && ((object[])first["novos"]).Length == 0, "channel seeded");
            }
            finally
            {
                module.Stop();
                module.Dispose();
            }
        }

        private static async Task DirectFileAsync(DownloadService service, string downloads, string url)
        {
            {
                True(await service.AddAsync(new[] { url }, downloads), "add direct");
                DownloadItem big = await WaitFor(service, i => i.Url.EndsWith("100Mb.dat") && i.Status == Statuses.Downloading && i.Progress > 3, TimeSpan.FromMinutes(3));
                True(big != null, "direct file started");
                if (big != null)
                {
                    service.Pause(big);
                    DownloadItem paused = await WaitFor(service, i => i == big && i.IsPaused, TimeSpan.FromSeconds(40));
                    True(paused != null, "paused: " + big.Detail);
                    double at = big.Progress;
                    await service.ResumeAsync(big);
                    DownloadItem resumed = await WaitFor(service, i => i == big && i.Status == Statuses.Downloading && i.Progress >= at - 1, TimeSpan.FromMinutes(1));
                    True(resumed != null, $"resumed from {at:0.0}% → {big.Progress:0.0}%");
                    service.Remove(big);
                    for (int i = 0; i < 40 && Directory.GetFiles(downloads, "100Mb.dat*").Any(); i++)
                    {
                        await Task.Delay(250);
                    }
                    True(!Directory.GetFiles(downloads, "100Mb.dat*").Any(), "partial files removed after cancel: " + string.Join(",", Directory.GetFiles(downloads, "100Mb*")));
                }
            }
        }

        private static int Serve(string data, string code, int seconds)
        {
            int exit = 2;
            Dispatcher dispatcher = Dispatcher.CurrentDispatcher;
            dispatcher.BeginInvoke(new Action(async () =>
            {
                var module = new CachalotModule();
                module.Initialize(new TestContext(data));
                module.Prefs.BridgeCode = code;
                string folder = Path.Combine(data, "baixados");
                Directory.CreateDirectory(folder);
                module.Service.RememberFolder(folder);
                module.Start();
                Console.WriteLine("SERVING 127.0.0.1:" + module.Bridge.Port);
                DownloadItem done = await WaitFor(module.Service, i => i.IsDone || i.IsError, TimeSpan.FromSeconds(seconds));
                Console.WriteLine(done == null ? "RESULT timeout" : $"RESULT {done.Status} mode={done.Mode} file={done.FilePath} detail={done.Detail}");
                exit = done != null && done.IsDone && File.Exists(done.FilePath) ? 0 : 1;
                module.Stop();
                module.Dispose();
                dispatcher.BeginInvokeShutdown(DispatcherPriority.Background);
            }));
            Dispatcher.Run();
            return exit;
        }

        private static async Task<DownloadItem> WaitFinished(DownloadService service, Func<DownloadItem, bool> match, TimeSpan timeout) =>
            await WaitFor(service, i => match(i) && (i.IsDone || i.IsError), timeout);

        private static async Task<DownloadItem> WaitFor(DownloadService service, Func<DownloadItem, bool> match, TimeSpan timeout)
        {
            DateTime deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline)
            {
                DownloadItem found = service.Active.Concat(service.Completed).FirstOrDefault(match);
                if (found != null)
                {
                    return found;
                }
                await Task.Delay(250);
            }
            return null;
        }

        private static void ChromeDetection()
        {
            string userData = TempDir();
            string folder = Path.Combine(TempDir(), "extensao-chrome");
            var probe = new ChromeProbe(userData);
            File.WriteAllText(Path.Combine(userData, "Local State"),
                "{\"profile\":{\"last_used\":\"Profile 2\",\"info_cache\":{\"Default\":{},\"Profile 2\":{}}}}");
            Directory.CreateDirectory(Path.Combine(userData, "Default"));
            Directory.CreateDirectory(Path.Combine(userData, "Profile 2"));

            ChromeState state = probe.Read(folder);
            True(state.Found && state.LastProfile == "Profile 2" && !state.DeveloperMode && !state.Installed, "fresh profiles: nothing on");

            // Synced profile: developer mode under account_values, in Secure Preferences.
            File.WriteAllText(Path.Combine(userData, "Profile 2", "Secure Preferences"),
                "{\"account_values\":{\"extensions\":{\"ui\":{\"developer_mode\":true}}},\"extensions\":{\"settings\":{}}}");
            True(probe.Read(folder).DeveloperMode, "developer mode from account_values");

            // Developer mode in another profile does not count; the extension in any profile does.
            File.WriteAllText(Path.Combine(userData, "Profile 2", "Secure Preferences"), "{\"extensions\":{\"settings\":{}}}");
            string escaped = folder.Replace("\\", "\\\\");
            File.WriteAllText(Path.Combine(userData, "Default", "Secure Preferences"),
                "{\"extensions\":{\"ui\":{\"developer_mode\":true},\"settings\":{" +
                "\"aaaa\":{\"location\":1,\"path\":\"" + escaped + "\"}," +
                "\"bbbb\":{\"location\":4,\"path\":\"" + escaped.ToLowerInvariant() + "\\\\\",\"disable_reasons\":[1]}}}}");
            state = probe.Read(folder);
            True(!state.DeveloperMode, "developer mode is read from the last used profile");
            True(state.Installed && state.InstalledProfiles.SequenceEqual(new[] { "Default" }), "unpacked from our folder (case and trailing slash ignored)");
            True(state.InstalledButDisabled, "disabled through disable_reasons");

            True(!new ChromeProbe(Path.Combine(userData, "missing")).Read(folder).Found, "no user data, no executable: not found");
        }

        private static void ExtensionInstall()
        {
            string bundle = TempDir();
            string target = Path.Combine(TempDir(), "extensao-chrome");
            File.WriteAllText(Path.Combine(bundle, "manifest.json"), "{\"version\":\"1\"}");
            Directory.CreateDirectory(Path.Combine(bundle, "src"));
            File.WriteAllText(Path.Combine(bundle, "src", "a.js"), "a");
            var installer = new ExtensionInstaller(bundle, target);
            True(installer.HasBundle && !installer.IsCopied, "bundle present, nothing copied yet");

            string hash = installer.BundleHash();
            installer.Install("ABCD2345", hash);
            True(installer.IsCopied && File.Exists(Path.Combine(target, "src", "a.js")), "copied");
            True(File.ReadAllText(Path.Combine(target, ExtensionInstaller.PairingFile)).Contains("ABCD2345"), "pairing file");
            string build1 = File.ReadAllText(Path.Combine(target, ExtensionInstaller.BuildFile));
            True(build1.Contains(hash.Substring(0, 12)), "build stamp carries the bundle hash");

            // New bundle: removed files go away, the pairing file stays, the stamp changes.
            File.Delete(Path.Combine(bundle, "src", "a.js"));
            File.WriteAllText(Path.Combine(bundle, "src", "b.js"), "b");
            string hash2 = installer.BundleHash();
            True(hash2 != hash, "hash follows the bundle");
            System.Threading.Thread.Sleep(1100);
            installer.Install("ABCD2345", hash2);
            True(!File.Exists(Path.Combine(target, "src", "a.js")) && File.Exists(Path.Combine(target, "src", "b.js")), "mirrored");
            True(File.ReadAllText(Path.Combine(target, ExtensionInstaller.BuildFile)) != build1, "new stamp");

            installer.WritePairing("WXYZ6789");
            True(File.ReadAllText(Path.Combine(target, ExtensionInstaller.PairingFile)).Contains("WXYZ6789"), "new code written");
        }

        // ── tiny harness ──

        private static void Run(string name, Action test)
        {
            try
            {
                test();
                _passed++;
                Console.WriteLine("PASS " + name);
            }
            catch (Exception error)
            {
                _failed++;
                Console.WriteLine("FAIL " + name + ": " + error.Message);
            }
        }

        private static void RunOnDispatcher(string name, Func<Task> test)
        {
            Dispatcher dispatcher = Dispatcher.CurrentDispatcher;
            dispatcher.BeginInvoke(new Action(async () =>
            {
                try
                {
                    await test();
                    _passed++;
                    Console.WriteLine("PASS " + name);
                }
                catch (Exception error)
                {
                    _failed++;
                    Console.WriteLine("FAIL " + name + ": " + error.Message);
                }
                finally
                {
                    dispatcher.BeginInvokeShutdown(DispatcherPriority.Background);
                }
            }));
            Dispatcher.Run();
        }

        private static void Equal<T>(T expected, T actual)
        {
            if (!EqualityComparer<T>.Default.Equals(expected, actual))
            {
                throw new Exception($"expected «{expected}», got «{actual}»");
            }
        }

        private static void True(bool condition, string what)
        {
            if (!condition)
            {
                throw new Exception(what);
            }
            Console.WriteLine("   ok " + what);
        }

        private static string TempDir()
        {
            string dir = Path.Combine(Path.GetTempPath(), "cachalot-test-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    internal sealed class ConsoleLog : IModuleLog
    {
        public void Info(string message) => Console.WriteLine("   [info] " + message);
        public void Warn(string message) => Console.WriteLine("   [warn] " + message);
        public void Error(string message, Exception exception = null) => Console.WriteLine("   [error] " + message + " " + exception?.Message);
    }

    internal sealed class TestContext : IModuleContext
    {
        public TestContext(string data)
        {
            DataDirectory = data;
            Dispatcher = Dispatcher.CurrentDispatcher;
        }

        public string ModuleId => "vd-get";
        public Version ModuleVersion => typeof(CachalotModule).Assembly.GetName().Version;
        public Version HostVersion => new Version(0, 5, 3);
        public string InstallDirectory => AppDomain.CurrentDomain.BaseDirectory;
        public string DataDirectory { get; }
        public Dispatcher Dispatcher { get; }
        public IModuleLog Log { get; } = new ConsoleLog();
        public void Notify(string message, NotificationKind kind = NotificationKind.Info) => Console.WriteLine($"   [toast {kind}] {message}");
        public void ShowModulePage() { }
    }
}
