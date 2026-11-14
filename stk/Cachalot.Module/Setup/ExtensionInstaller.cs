using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace Cachalot.Module.Setup
{
    /// <summary>
    /// Keeps the folder Chrome loads the unpacked extension from in step with the copy bundled in the module.
    /// Besides the extension's own files it writes two that the extension reads at startup:
    /// <c>pairing.json</c> (the bridge code, so it pairs itself) and <c>build.json</c> (a stamp that changes with
    /// every new copy, so an already loaded extension reloads itself). Neither is web-accessible.
    /// </summary>
    internal sealed class ExtensionInstaller
    {
        public const string PairingFile = "pairing.json";
        public const string BuildFile = "build.json";

        private readonly string _source;

        public ExtensionInstaller(string bundledFolder, string targetFolder)
        {
            _source = bundledFolder;
            Folder = targetFolder;
        }

        /// <summary>Stable folder outside the package (updates replace the install directory).</summary>
        public string Folder { get; }

        public bool HasBundle => Directory.Exists(_source) && File.Exists(Path.Combine(_source, "manifest.json"));

        public bool IsCopied => File.Exists(Path.Combine(Folder, "manifest.json"));

        /// <summary>Hash of the bundled files (paths and contents): changes whenever the module ships a different extension.</summary>
        public string BundleHash()
        {
            using (SHA1 sha = SHA1.Create())
            {
                foreach (string file in Files(_source).OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
                {
                    byte[] name = Encoding.UTF8.GetBytes(Relative(_source, file).Replace('\\', '/') + "\n");
                    sha.TransformBlock(name, 0, name.Length, null, 0);
                    byte[] content = File.ReadAllBytes(file);
                    sha.TransformBlock(content, 0, content.Length, null, 0);
                }
                sha.TransformFinalBlock(new byte[0], 0, 0);
                return string.Concat(sha.Hash.Select(b => b.ToString("x2")));
            }
        }

        /// <summary>
        /// Mirrors the bundle into <see cref="Folder"/> (files the bundle no longer has are removed), then writes the
        /// pairing code and a new build stamp. Throws IOException/UnauthorizedAccessException.
        /// </summary>
        public void Install(string pairingCode, string bundleHash)
        {
            Directory.CreateDirectory(Folder);
            var keep = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { PairingFile, BuildFile };
            foreach (string file in Files(_source))
            {
                string relative = Relative(_source, file);
                keep.Add(relative);
                string destination = Path.Combine(Folder, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                File.Copy(file, destination, true);
            }
            foreach (string file in Files(Folder))
            {
                if (!keep.Contains(Relative(Folder, file)))
                {
                    TryDelete(file);
                }
            }
            WritePairing(pairingCode);
            WriteJson(BuildFile, new Dictionary<string, object>
            {
                ["build"] = (bundleHash ?? "dev").Substring(0, Math.Min(12, (bundleHash ?? "dev").Length)) + "-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss"),
            });
        }

        /// <summary>Called when the code changes in the settings: the copied extension picks it up on its next start.</summary>
        public void WritePairing(string code)
        {
            if (Directory.Exists(Folder) && !string.IsNullOrEmpty(code))
            {
                WriteJson(PairingFile, new Dictionary<string, object> { ["code"] = code });
            }
        }

        private void WriteJson(string name, Dictionary<string, object> content)
        {
            string path = Path.Combine(Folder, name);
            string temp = path + ".tmp";
            File.WriteAllText(temp, new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(content), new UTF8Encoding(false));
            if (File.Exists(path))
            {
                File.Replace(temp, path, null);
            }
            else
            {
                File.Move(temp, path);
            }
        }

        private static IEnumerable<string> Files(string root) =>
            Directory.Exists(root) ? Directory.GetFiles(root, "*", SearchOption.AllDirectories) : Enumerable.Empty<string>();

        private static string Relative(string root, string file) => file.Substring(root.Length).TrimStart('\\', '/');

        private static void TryDelete(string file)
        {
            try
            {
                File.Delete(file);
            }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException)
            {
            }
        }
    }
}
