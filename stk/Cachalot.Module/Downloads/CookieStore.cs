using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

namespace Cachalot.Module.Downloads
{
    /// <summary>
    /// Per-site cookie files (<c>cookies\&lt;domínio&gt;.txt</c>, Netscape format) that the backend hands to yt-dlp,
    /// gallery-dl and the native extractors for that site only. Filled by importing a cookies.txt (split by site)
    /// or by the browser extension. Never leaves the machine.
    /// </summary>
    internal sealed class CookieStore
    {
        private readonly string _folder;

        public CookieStore(string dataDirectory)
        {
            _folder = Path.Combine(dataDirectory, "cookies");
        }

        public string Folder => _folder;

        public IReadOnlyList<CookieSite> List()
        {
            if (!Directory.Exists(_folder))
            {
                return new CookieSite[0];
            }
            return Directory.GetFiles(_folder, "*.txt")
                .Select(path => new CookieSite(Path.GetFileNameWithoutExtension(path), path, CountLines(path), File.GetLastWriteTime(path)))
                .OrderBy(s => s.Domain, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        public void Delete(string domain)
        {
            string path = PathFor(domain);
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }

        /// <summary>Splits a Netscape cookies.txt by site. Returns the sites written.</summary>
        public IReadOnlyList<string> Import(string cookiesTxt)
        {
            var bySite = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
            foreach (string raw in File.ReadAllLines(cookiesTxt, Encoding.UTF8))
            {
                string line = raw.TrimEnd('\r');
                string body = line.StartsWith("#HttpOnly_", StringComparison.Ordinal) ? line.Substring("#HttpOnly_".Length) : line;
                if (body.Length == 0 || body.StartsWith("#", StringComparison.Ordinal))
                {
                    continue;
                }
                string[] fields = body.Split('\t');
                if (fields.Length < 7)
                {
                    continue;
                }
                string site = RegistrableDomain(fields[0].TrimStart('.'));
                if (site.Length == 0)
                {
                    continue;
                }
                if (!bySite.TryGetValue(site, out List<string> lines))
                {
                    bySite[site] = lines = new List<string>();
                }
                lines.Add(line);
            }
            foreach (KeyValuePair<string, List<string>> pair in bySite)
            {
                Write(pair.Key, pair.Value);
            }
            return bySite.Keys.ToList();
        }

        /// <summary>Saves cookies sent by the browser extension (chrome.cookies objects) for one site.</summary>
        public int SaveFromBrowser(string domain, IEnumerable<Dictionary<string, object>> cookies)
        {
            var lines = new List<string>();
            foreach (Dictionary<string, object> c in cookies)
            {
                string name = Str(c, "name");
                string cookieDomain = Str(c, "domain");
                if (name.Length == 0 || cookieDomain.Length == 0)
                {
                    continue;
                }
                bool hostOnly = Bool(c, "hostOnly");
                string host = hostOnly ? cookieDomain.TrimStart('.') : (cookieDomain.StartsWith(".", StringComparison.Ordinal) ? cookieDomain : "." + cookieDomain);
                double expires = Num(c, "expirationDate");
                string prefix = Bool(c, "httpOnly") ? "#HttpOnly_" : string.Empty;
                lines.Add(string.Join("\t", prefix + host, hostOnly ? "FALSE" : "TRUE", Str(c, "path").Length == 0 ? "/" : Str(c, "path"),
                    Bool(c, "secure") ? "TRUE" : "FALSE", ((long)Math.Max(0, expires)).ToString(CultureInfo.InvariantCulture), name,
                    Str(c, "value")));
            }
            string site = RegistrableDomain(domain.TrimStart('.'));
            if (site.Length == 0 || lines.Count == 0)
            {
                return 0;
            }
            Write(site, lines);
            return lines.Count;
        }

        /// <summary>Same rule as fontes.dominio_raiz in the backend: www.youtube.com → youtube.com, a.b.com.br → b.com.br.</summary>
        internal static string RegistrableDomain(string host)
        {
            string[] parts = (host ?? string.Empty).Trim().Trim('.').ToLowerInvariant().Split(new[] { '.' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length <= 2)
            {
                return string.Join(".", parts);
            }
            string second = parts[parts.Length - 2];
            if (parts[parts.Length - 1].Length == 2 && (second == "com" || second == "net" || second == "org" || second == "gov" ||
                                                         second == "edu" || second == "co" || second == "ac"))
            {
                return string.Join(".", parts.Skip(parts.Length - 3));
            }
            return string.Join(".", parts.Skip(parts.Length - 2));
        }

        private string PathFor(string domain)
        {
            string safe = new string((domain ?? string.Empty).Where(ch => char.IsLetterOrDigit(ch) || ch == '.' || ch == '-').ToArray());
            return Path.Combine(_folder, safe + ".txt");
        }

        private void Write(string site, IEnumerable<string> lines)
        {
            Directory.CreateDirectory(_folder);
            var text = new StringBuilder("# Netscape HTTP Cookie File\n# Cachalot: cookies de " + site + "\n");
            foreach (string line in lines)
            {
                text.Append(line).Append('\n');
            }
            string path = PathFor(site);
            string temp = path + ".tmp";
            File.WriteAllText(temp, text.ToString(), new UTF8Encoding(false));
            if (File.Exists(path))
            {
                File.Replace(temp, path, null);
            }
            else
            {
                File.Move(temp, path);
            }
        }

        private static int CountLines(string path)
        {
            try
            {
                return File.ReadLines(path).Count(l => l.Length > 0 && (!l.StartsWith("#", StringComparison.Ordinal) || l.StartsWith("#HttpOnly_", StringComparison.Ordinal)));
            }
            catch (IOException)
            {
                return 0;
            }
        }

        private static string Str(Dictionary<string, object> d, string key) =>
            d.TryGetValue(key, out object v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : string.Empty;

        private static bool Bool(Dictionary<string, object> d, string key) => d.TryGetValue(key, out object v) && v is bool b && b;

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

    internal sealed class CookieSite
    {
        public CookieSite(string domain, string path, int count, DateTime modified)
        {
            Domain = domain;
            Path = path;
            Count = count;
            Modified = modified;
        }

        public string Domain { get; }
        public string Path { get; }
        public int Count { get; }
        public DateTime Modified { get; }
    }
}
