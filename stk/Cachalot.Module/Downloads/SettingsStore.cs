using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Cachalot.Module.Backend;

namespace Cachalot.Module.Downloads
{
    /// <summary>What the page remembers between sessions: folders, draft, history and unfinished downloads.</summary>
    internal sealed class SavedState
    {
        public List<string> Folders { get; set; } = new List<string>();

        public string Folder { get; set; }

        /// <summary>Only read to migrate VDGET 1.x (melhor | pior | audio); the page choice now lives in settings.json.</summary>
        public string Quality { get; set; }

        public string Draft { get; set; } = string.Empty;

        public bool OldestFirst { get; set; }

        public List<HistoryRecord> History { get; set; } = new List<HistoryRecord>();

        /// <summary>Downloads that were queued, running or paused when the module closed: shown paused, resumable.</summary>
        public List<HistoryRecord> Unfinished { get; set; } = new List<HistoryRecord>();
    }

    /// <summary>A finished, failed or unfinished download.</summary>
    internal sealed class HistoryRecord
    {
        public string Id { get; set; }
        public string Url { get; set; }
        public string Status { get; set; }
        public string Quality { get; set; }
        public string Mode { get; set; }
        public string Destination { get; set; }
        public string Title { get; set; }
        public string Thumb { get; set; }
        public string Error { get; set; }
        public string Hint { get; set; }
        public string FilePath { get; set; }
        public string Platform { get; set; }
        public string Engine { get; set; }
        public string Group { get; set; }
        public int Files { get; set; }
        public double Progress { get; set; }
        public double CreatedTs { get; set; }
        public double FinishedTs { get; set; }
        public Dictionary<string, object> Headers { get; set; }
    }

    /// <summary>Reads and writes <c>state.json</c> under the module's data folder (atomic replace).</summary>
    internal sealed class SettingsStore
    {
        private const int MaxThumbChars = 200_000;
        private readonly string _path;
        private readonly object _writeGate = new object();

        public SettingsStore(string dataDirectory)
        {
            _path = Path.Combine(dataDirectory, "state.json");
        }

        public SavedState Load()
        {
            try
            {
                if (File.Exists(_path))
                {
                    var state = BackendHost.NewSerializer().Deserialize<SavedState>(File.ReadAllText(_path, Encoding.UTF8));
                    if (state != null)
                    {
                        state.Folders = state.Folders ?? new List<string>();
                        state.History = state.History ?? new List<HistoryRecord>();
                        state.Unfinished = state.Unfinished ?? new List<HistoryRecord>();
                        state.Draft = state.Draft ?? string.Empty;
                        return state;
                    }
                }
            }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException || error is ArgumentException || error is InvalidOperationException)
            {
                // A damaged file starts fresh rather than breaking the page; keep it aside so the next save cannot destroy it.
                try
                {
                    File.Copy(_path, Path.ChangeExtension(_path, ".damaged.json"), true);
                }
                catch (Exception copyError) when (copyError is IOException || copyError is UnauthorizedAccessException)
                {
                }
            }
            return new SavedState();
        }

        /// <summary>Safe to call from any thread; the caller passes a snapshot.</summary>
        public void Save(SavedState state)
        {
            foreach (HistoryRecord record in state.History)
            {
                if (record.Thumb != null && record.Thumb.Length > MaxThumbChars)
                {
                    record.Thumb = string.Empty;
                }
            }
            string json = BackendHost.NewSerializer().Serialize(state);
            lock (_writeGate)
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
