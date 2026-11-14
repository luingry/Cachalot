using System;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Windows;

namespace Cachalot.Module.Native
{
    /// <summary>Reads links from the clipboard without throwing when another app holds it open.</summary>
    internal static class ClipboardLinks
    {
        private static readonly Regex Link = new Regex(@"(?:https?://|magnet:\?)[^\s<>""']+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        /// <summary>First http(s)/magnet link in the clipboard text, or null.</summary>
        public static string Read()
        {
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    return Clipboard.ContainsText() ? First(Clipboard.GetText()) : null;
                }
                catch (COMException)
                {
                    System.Threading.Thread.Sleep(30);
                }
                catch (ExternalException)
                {
                    System.Threading.Thread.Sleep(30);
                }
            }
            return null;
        }

        public static string First(string text)
        {
            if (string.IsNullOrWhiteSpace(text) || text.Length > 20000)
            {
                return null;
            }
            Match match = Link.Match(text);
            return match.Success ? match.Value.TrimEnd(')', '.', ',', ';', ']', '}', '>') : null;
        }

        /// <summary>"youtube.com/watch?v=…" — short form for a suggestion line.</summary>
        public static string Short(string link)
        {
            if (link.StartsWith("magnet:", StringComparison.OrdinalIgnoreCase))
            {
                Match name = Regex.Match(link, @"[?&]dn=([^&]+)");
                return name.Success ? "Torrent: " + Uri.UnescapeDataString(name.Groups[1].Value.Replace('+', ' ')) : "Link magnet";
            }
            if (!Uri.TryCreate(link, UriKind.Absolute, out Uri uri))
            {
                return link;
            }
            string host = uri.Host.StartsWith("www.", StringComparison.OrdinalIgnoreCase) ? uri.Host.Substring(4) : uri.Host;
            string rest = uri.PathAndQuery == "/" ? string.Empty : uri.PathAndQuery;
            string text = host + rest;
            return text.Length > 64 ? text.Substring(0, 63) + "…" : text;
        }
    }
}
