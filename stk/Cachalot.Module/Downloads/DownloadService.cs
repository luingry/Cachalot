using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Threading;
using SwissTechKnife.Sdk;
using Cachalot.Module.Backend;
using Cachalot.Module.Native;

namespace Cachalot.Module.Downloads
{
    /// <summary>Extra data for one add request (browser extension, channels, retries).</summary>
    internal sealed class AddRequest
    {
        public string Mode { get; set; }
        public string Quality { get; set; }
        public string Title { get; set; }
        public Dictionary<string, object> Headers { get; set; }
    }

    /// <summary>
    /// The page's model: active and finished lists, the bridge to the backend, and what is remembered between
    /// sessions. Lives as long as the module (downloads keep going on other pages). UI thread only.
    /// </summary>
    internal sealed class DownloadService : IDisposable
    {
        private const int MaxHistory = 200;
        private const int MaxFolders = 10;

        private readonly IModuleContext _context;
        private readonly SettingsStore _store;
        private readonly PreferencesStore _prefsStore;
        private readonly Dictionary<string, DownloadItem> _byId = new Dictionary<string, DownloadItem>();
        private readonly DispatcherTimer _saveTimer;
        private readonly DispatcherTimer _prefsTimer;
        private readonly PowerRequest _awake = new PowerRequest();
        private TaskCompletionSource<object[]> _channelReply;
        private readonly ConcurrentDictionary<string, TaskCompletionSource<Dictionary<string, object>>> _transientReplies =
            new ConcurrentDictionary<string, TaskCompletionSource<Dictionary<string, object>>>();
        private bool _disposed;

        public DownloadService(IModuleContext context, Preferences prefs, PreferencesStore prefsStore)
        {
            _context = context;
            _prefsStore = prefsStore;
            Prefs = prefs;
            Directory.CreateDirectory(context.DataDirectory);
            DefaultFolder = KnownFolders.Downloads();
            Cookies = new CookieStore(context.DataDirectory);
            Backend = new BackendHost(Path.Combine(context.InstallDirectory, "backend"), context.DataDirectory, DefaultFolder, context.Log);
            Backend.MessageReceived += message => _context.Dispatcher.BeginInvoke(new Action(() => OnMessage(message)));
            Backend.StateChanged += state => _context.Dispatcher.BeginInvoke(new Action(OnBackendStateChanged));

            // Before loading: migrating a 1.x state.json schedules saves.
            _saveTimer = new DispatcherTimer(TimeSpan.FromMilliseconds(600), DispatcherPriority.Background, (s, e) => SaveNow(), context.Dispatcher);
            _saveTimer.Stop();
            _prefsTimer = new DispatcherTimer(TimeSpan.FromMilliseconds(500), DispatcherPriority.Background, (s, e) => FlushPreferences(), context.Dispatcher);
            _prefsTimer.Stop();

            _store = new SettingsStore(context.DataDirectory);
            State = _store.Load();
            MigrateLegacyQuality();
            if (State.Folders.Count == 0)
            {
                State.Folders.Add(DefaultFolder);
            }
            if (string.IsNullOrEmpty(State.Folder))
            {
                State.Folder = State.Folders[0];
            }
            foreach (HistoryRecord record in State.History.OrderByDescending(r => r.FinishedTs))
            {
                DownloadItem item = FromRecord(record, finished: true);
                _byId[item.Id] = item;
                Completed.Add(item);
            }
            foreach (HistoryRecord record in State.Unfinished)
            {
                DownloadItem item = FromRecord(record, finished: false);
                _byId[item.Id] = item;
                Active.Add(item);
            }
            SortCompleted();
            Active.CollectionChanged += (s, e) => UpdateAwake();
        }

        public BackendHost Backend { get; }

        public SavedState State { get; }

        public Preferences Prefs { get; }

        public CookieStore Cookies { get; }

        /// <summary>
        /// Saves the cookies the extension sent with a page on <paramref name="host"/>, unless cookies are off (globally
        /// or for that site in Configurações › Login e cookies). Returns how many were saved (0 when skipped).
        /// </summary>
        public int SaveBrowserCookies(string host, IEnumerable<Dictionary<string, object>> cookies)
        {
            if (cookies == null || !Prefs.CookiesAllowedFor(host))
            {
                return 0;
            }
            return Cookies.SaveFromBrowser(host, cookies);
        }

        public string DefaultFolder { get; }

        public ObservableCollection<DownloadItem> Active { get; } = new ObservableCollection<DownloadItem>();

        public ObservableCollection<DownloadItem> Completed { get; } = new ObservableCollection<DownloadItem>();

        /// <summary>Last dependency report from the backend (ffmpeg, yt-dlp version…); null until it ran once.</summary>
        public Dictionary<string, object> Dependencies { get; private set; }

        public event Action BackendStateChanged;

        public event Action DependenciesChanged;

        public string LogPath => Path.Combine(_context.DataDirectory, "backend.log");

        public bool HasPaused => Active.Any(i => i.IsPaused);

        public bool HasPausable => Active.Any(i => i.CanPause);

        /// <summary>Queues every link (and searches) in the text. Returns false when the backend is unavailable.</summary>
        public async Task<bool> AddAsync(IEnumerable<string> urls, string folder, AddRequest request = null)
        {
            List<string> list = urls.Select(u => (u ?? string.Empty).Trim()).Where(u => u.Length > 0).Distinct().ToList();
            if (list.Count == 0)
            {
                return true;
            }
            RememberFolder(folder);
            return await Backend.SendAsync(new Dictionary<string, object>
            {
                ["acao"] = "adicionar",
                ["urls"] = list,
                ["destino"] = folder ?? string.Empty,
                ["opcoes"] = JobOptions(request?.Mode, request?.Quality, request?.Headers),
                ["config"] = Prefs.ToBackendConfig(),
            }).ConfigureAwait(true);
        }

        public Task<bool> RetryAsync(DownloadItem item)
        {
            Remove(item);
            return AddAsync(new[] { item.Url }, string.IsNullOrEmpty(item.Destination) ? State.Folder : item.Destination,
                new AddRequest { Mode = item.Mode, Quality = item.Quality, Headers = item.Headers });
        }

        public void Pause(DownloadItem item)
        {
            if (!item.CanPause)
            {
                return;
            }
            item.Pausing = item.IsRunning;
            if (!item.IsRunning)
            {
                item.Status = Statuses.Paused;
            }
            Send(new Dictionary<string, object> { ["acao"] = "pausar", ["id"] = item.Id });
            ScheduleSave();
        }

        public void PauseAll()
        {
            foreach (DownloadItem item in Active.Where(i => i.CanPause).ToList())
            {
                Pause(item);
            }
        }

        /// <summary>Resumes; the backend recreates the download from these fields when it no longer knows the id.</summary>
        public Task<bool> ResumeAsync(DownloadItem item)
        {
            item.Status = Statuses.Pending;
            item.Error = string.Empty;
            return Backend.SendAsync(ResumeMessage(item));
        }

        public async Task ResumeAllAsync()
        {
            foreach (DownloadItem item in Active.Where(i => i.IsPaused).ToList())
            {
                await ResumeAsync(item).ConfigureAwait(true);
            }
        }

        /// <summary>Removes from the list; a running download is cancelled and its partial files deleted.</summary>
        public void Remove(DownloadItem item)
        {
            Drop(item.Id);
            Send(new Dictionary<string, object> { ["acao"] = "cancelar", ["id"] = item.Id });
        }

        public void ClearCompleted()
        {
            foreach (DownloadItem item in Completed.ToList())
            {
                _byId.Remove(item.Id);
            }
            Completed.Clear();
            ScheduleSave();
            Send(new Dictionary<string, object> { ["acao"] = "limpar_concluidos" });
        }

        public void ToggleSort()
        {
            State.OldestFirst = !State.OldestFirst;
            SortCompleted();
            ScheduleSave();
        }

        public void RememberFolder(string folder)
        {
            if (string.IsNullOrWhiteSpace(folder))
            {
                return;
            }
            folder = folder.Trim();
            State.Folders.RemoveAll(f => string.Equals(f, folder, StringComparison.OrdinalIgnoreCase));
            State.Folders.Insert(0, folder);
            if (State.Folders.Count > MaxFolders)
            {
                State.Folders.RemoveRange(MaxFolders, State.Folders.Count - MaxFolders);
            }
            State.Folder = folder;
            ScheduleSave();
        }

        public void SetDraft(string text)
        {
            State.Draft = text ?? string.Empty;
            ScheduleSave();
        }

        /// <summary>Settings changed: save soon and tell a running backend (queued downloads keep their snapshot).</summary>
        public void PreferencesChanged()
        {
            if (_disposed)
            {
                return;
            }
            _prefsTimer.Stop();
            _prefsTimer.Start();
        }

        public void RequestDependencies() => Send(new Dictionary<string, object> { ["acao"] = "dependencias" }, start: true);

        /// <summary>Asks the backend for the newest items of each channel. Null when the backend did not answer.</summary>
        public async Task<object[]> CheckChannelsAsync(IEnumerable<Channel> channels)
        {
            var list = channels.Select(c => (object)new Dictionary<string, object>
            {
                ["id"] = c.Id,
                ["url"] = c.Url,
                ["vistos"] = c.Seeded ? c.Seen.Cast<object>().ToList() : null,
            }).ToList();
            if (list.Count == 0)
            {
                return new object[0];
            }
            _channelReply?.TrySetResult(null);
            var reply = new TaskCompletionSource<object[]>(TaskCreationOptions.RunContinuationsAsynchronously);
            _channelReply = reply;
            bool sent = await Backend.SendAsync(new Dictionary<string, object>
            {
                ["acao"] = "verificar_canais",
                ["canais"] = list,
                ["config"] = Prefs.ToBackendConfig(),
            }).ConfigureAwait(true);
            if (!sent)
            {
                return null;
            }
            Task finished = await Task.WhenAny(reply.Task, Task.Delay(TimeSpan.FromMinutes(5))).ConfigureAwait(true);
            return finished == reply.Task ? reply.Task.Result : null;
        }

        /// <summary>
        /// Transient mode (browser extension): one request to the backend's "transiente" action (op = preparar, estado,
        /// exportar, abrir) and its answer. Null when the backend is unavailable or did not answer in time.
        /// </summary>
        public async Task<Dictionary<string, object>> TransientAsync(string op, Dictionary<string, object> fields, TimeSpan timeout)
        {
            string id = Guid.NewGuid().ToString("N");
            var reply = new TaskCompletionSource<Dictionary<string, object>>(TaskCreationOptions.RunContinuationsAsynchronously);
            _transientReplies[id] = reply;
            var message = new Dictionary<string, object>(fields ?? new Dictionary<string, object>())
            {
                ["acao"] = "transiente",
                ["op"] = op,
                ["pedido"] = id,
                ["config"] = Prefs.ToBackendConfig(),
            };
            try
            {
                if (!await Backend.SendAsync(message).ConfigureAwait(false))
                {
                    return null;
                }
                Task finished = await Task.WhenAny(reply.Task, Task.Delay(timeout)).ConfigureAwait(false);
                return finished == reply.Task ? reply.Task.Result : null;
            }
            finally
            {
                _transientReplies.TryRemove(id, out _);
            }
        }

        /// <summary>Options of the hidden audio download behind transient mode (headers the page used).</summary>
        public Dictionary<string, object> TransientOptions(Dictionary<string, object> headers) => JobOptions(Modes.Audio, AudioFormats.Original, headers);

        /// <summary>Explorer on a file (selected) or a folder the transient mode exported, in front of the browser.</summary>
        public bool Reveal(string path)
        {
            try
            {
                List<IntPtr> before = ExplorerWindow.Snapshot();
                if (File.Exists(path))
                {
                    Process.Start(new ProcessStartInfo("explorer.exe", "/select,\"" + path + "\"") { UseShellExecute = false });
                    ExplorerWindow.BringForward(before, Path.GetFileName(Path.GetDirectoryName(path)), _context.Dispatcher);
                    return true;
                }
                if (Directory.Exists(path))
                {
                    Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
                    ExplorerWindow.BringForward(before, Path.GetFileName(path.TrimEnd('\\', '/')), _context.Dispatcher);
                    return true;
                }
            }
            catch (Exception error) when (error is System.ComponentModel.Win32Exception || error is InvalidOperationException)
            {
                _context.Log.Warn("Could not open the folder: " + error.Message);
            }
            return false;
        }

        /// <summary>
        /// Shows the file selected in Explorer, or the destination folder when the file is gone. <paramref name="bringForward"/>:
        /// asked from outside Cachalot (the extension), so the window is brought in front of the app that has the focus.
        /// </summary>
        public bool OpenFolder(DownloadItem item, bool bringForward = false)
        {
            try
            {
                List<IntPtr> before = bringForward ? ExplorerWindow.Snapshot() : null;
                if (!string.IsNullOrEmpty(item.FilePath) && File.Exists(item.FilePath))
                {
                    Process.Start(new ProcessStartInfo("explorer.exe", "/select,\"" + item.FilePath + "\"") { UseShellExecute = false });
                    if (bringForward)
                    {
                        ExplorerWindow.BringForward(before, Path.GetFileName(Path.GetDirectoryName(item.FilePath)), _context.Dispatcher);
                    }
                    return true;
                }
                string folder = string.IsNullOrEmpty(item.Destination) ? DefaultFolder : item.Destination;
                if (Directory.Exists(folder))
                {
                    Process.Start(new ProcessStartInfo(folder) { UseShellExecute = true });
                    if (bringForward)
                    {
                        ExplorerWindow.BringForward(before, Path.GetFileName(folder.TrimEnd('\\', '/')), _context.Dispatcher);
                    }
                    return true;
                }
            }
            catch (Exception error) when (error is System.ComponentModel.Win32Exception || error is InvalidOperationException)
            {
                _context.Log.Warn("Could not open the folder: " + error.Message);
            }
            return false;
        }

        public bool OpenFile(DownloadItem item)
        {
            if (string.IsNullOrEmpty(item.FilePath) || !File.Exists(item.FilePath))
            {
                return false;
            }
            try
            {
                Process.Start(new ProcessStartInfo(item.FilePath) { UseShellExecute = true });
                return true;
            }
            catch (Exception error) when (error is System.ComponentModel.Win32Exception || error is InvalidOperationException)
            {
                _context.Log.Warn("Could not open the file: " + error.Message);
                return false;
            }
        }

        public void OpenLog()
        {
            if (File.Exists(LogPath))
            {
                try
                {
                    Process.Start(new ProcessStartInfo(LogPath) { UseShellExecute = true });
                }
                catch (System.ComponentModel.Win32Exception)
                {
                }
            }
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            _saveTimer.Stop();
            _prefsTimer.Stop();
            FlushPreferences();
            SaveNow();
            _channelReply?.TrySetResult(null);
            foreach (TaskCompletionSource<Dictionary<string, object>> pending in _transientReplies.Values)
            {
                pending.TrySetResult(null);
            }
            Backend.Dispose();
            _awake.Dispose();
        }

        private Dictionary<string, object> JobOptions(string mode, string quality, Dictionary<string, object> headers)
        {
            string m = Modes.Normalize(mode ?? Prefs.Mode);
            var options = new Dictionary<string, object> { ["modo"] = m };
            if (m == Modes.Audio)
            {
                options["formato_audio"] = AudioFormats.Normalize(quality ?? Prefs.AudioFormat);
            }
            else
            {
                options["qualidade"] = VideoQualities.Normalize(quality ?? Prefs.VideoQuality);
            }
            if (headers != null && headers.Count > 0)
            {
                options["cabecalhos"] = headers;
            }
            return options;
        }

        private Dictionary<string, object> ResumeMessage(DownloadItem item) => new Dictionary<string, object>
        {
            ["acao"] = "retomar",
            ["id"] = item.Id,
            ["url"] = item.Url,
            ["destino"] = item.Destination ?? string.Empty,
            ["titulo"] = item.Title == item.Url ? string.Empty : item.Title,
            ["grupo"] = item.Group ?? string.Empty,
            ["opcoes"] = JobOptions(item.Mode, item.Quality, item.Headers),
            ["config"] = Prefs.ToBackendConfig(),
        };

        /// <summary>Fire-and-forget command. Commands that only make sense for a running backend do not start it.</summary>
        private void Send(Dictionary<string, object> message, bool start = false)
        {
            if (start || Backend.State == BackendState.Ready)
            {
                _ = Backend.SendAsync(message);
            }
        }

        private void FlushPreferences()
        {
            _prefsTimer.Stop();
            _prefsStore.Save(Prefs);
            if (!_disposed && Backend.State == BackendState.Ready)
            {
                _ = Backend.SendAsync(new Dictionary<string, object> { ["acao"] = "configurar", ["config"] = Prefs.ToBackendConfig() });
            }
        }

        private void MigrateLegacyQuality()
        {
            if (string.IsNullOrEmpty(State.Quality))
            {
                return;
            }
            if (State.Quality == "audio")
            {
                Prefs.Mode = Modes.Audio;
            }
            else if (State.Quality == "pior")
            {
                Prefs.Mode = Modes.Video;
                Prefs.VideoQuality = VideoQualities.Smallest;
            }
            State.Quality = null;
            PreferencesChanged();
            ScheduleSave();
        }

        private void OnMessage(Dictionary<string, object> message)
        {
            if (_disposed)
            {
                return;
            }
            switch (Str(message, "tipo"))
            {
                case "estado_inicial":
                    if (message.TryGetValue("downloads", out object list) && list is object[] downloads)
                    {
                        foreach (Dictionary<string, object> data in downloads.OfType<Dictionary<string, object>>())
                        {
                            Upsert(data);
                        }
                    }
                    if (message.TryGetValue("dependencias", out object deps) && deps is Dictionary<string, object> depsMap)
                    {
                        Dependencies = depsMap;
                        DependenciesChanged?.Invoke();
                    }
                    break;
                case "adicionar":
                case "atualizar":
                    if (message.TryGetValue("download", out object raw) && raw is Dictionary<string, object> download)
                    {
                        Upsert(download);
                    }
                    break;
                case "remover":
                    Drop(Str(message, "id"));
                    break;
                case "limpar_concluidos":
                    foreach (DownloadItem item in Completed.Where(i => i.IsDone).ToList())
                    {
                        Drop(item.Id);
                    }
                    break;
                case "aviso":
                    string text = Str(message, "mensagem");
                    if (text.Length > 0)
                    {
                        _context.Notify(text, Str(message, "nivel") == "aviso" ? NotificationKind.Warning : NotificationKind.Info);
                    }
                    break;
                case "dependencias":
                    if (message.TryGetValue("estado", out object state) && state is Dictionary<string, object> stateMap)
                    {
                        Dependencies = stateMap;
                        DependenciesChanged?.Invoke();
                    }
                    break;
                case "transiente":
                    if (_transientReplies.TryGetValue(Str(message, "pedido"), out TaskCompletionSource<Dictionary<string, object>> pending))
                    {
                        pending.TrySetResult(message);
                    }
                    break;
                case "canais":
                    _channelReply?.TrySetResult(message.TryGetValue("resultados", out object results) && results is object[] array ? array : new object[0]);
                    break;
            }
        }

        private void Upsert(Dictionary<string, object> data)
        {
            string id = Str(data, "id");
            if (string.IsNullOrEmpty(id))
            {
                return;
            }
            bool isNew = !_byId.TryGetValue(id, out DownloadItem item);
            if (isNew)
            {
                item = new DownloadItem
                {
                    Id = id,
                    CreatedTs = Num(data, "criado_ts"),
                };
                _byId[id] = item;
            }

            bool wasActive = !isNew && item.IsActive && !item.IsPaused;
            item.Url = FirstNonEmpty(Str(data, "url"), item.Url);
            item.Mode = Modes.Normalize(FirstNonEmpty(Str(data, "modo"), item.Mode));
            string quality = Str(data, "resolucao");
            if (quality.Length > 0 && item.Mode == Modes.Video)
            {
                item.Quality = quality;
            }
            item.Group = Str(data, "grupo");
            item.Destination = FirstNonEmpty(Str(data, "destino"), item.Destination);
            item.Status = Str(data, "status");
            item.Progress = Num(data, "progresso");
            item.Speed = Str(data, "velocidade");
            item.Eta = Str(data, "eta");
            item.Downloaded = Str(data, "baixado");
            item.Total = Str(data, "total");
            item.Title = FirstNonEmpty(Str(data, "titulo"), item.Url);
            item.Error = Str(data, "erro");
            item.Hint = Str(data, "dica");
            item.Platform = Str(data, "plataforma");
            item.Phase = Str(data, "fase");
            item.Engine = Str(data, "motor");
            item.Attempt = (int)Num(data, "tentativa");
            item.Files = (int)Num(data, "arquivos");
            item.FilePath = Str(data, "arquivo");
            item.FinishedTs = Num(data, "finalizado_ts");
            string thumb = Str(data, "thumb");
            if (thumb != item.Thumb)
            {
                item.Thumb = thumb;
                LoadThumbnail(item);
            }

            if (item.IsActive)
            {
                if (isNew || !Active.Contains(item))
                {
                    Completed.Remove(item);
                    Active.Insert(0, item);
                }
                UpdateAwake();
            }
            else if (isNew || wasActive || !Completed.Contains(item))
            {
                Active.Remove(item);
                InsertCompleted(item);
                ScheduleSave();
                if (wasActive)
                {
                    _context.Notify(item.IsDone ? "Download concluído: " + item.Title : "Download falhou: " + item.Title,
                        item.IsDone ? NotificationKind.Success : NotificationKind.Warning);
                }
            }
        }

        private void Drop(string id)
        {
            if (string.IsNullOrEmpty(id) || !_byId.TryGetValue(id, out DownloadItem item))
            {
                return;
            }
            _byId.Remove(id);
            Active.Remove(item);
            Completed.Remove(item);
            ScheduleSave();
        }

        /// <summary>The backend restarts with an empty queue: whatever was unfinished waits, paused, to be resumed.</summary>
        private void OnBackendStateChanged()
        {
            if (_disposed)
            {
                return;
            }
            BackendState state = Backend.State;
            if (state == BackendState.Ready)
            {
                _ = Backend.SendAsync(new Dictionary<string, object> { ["acao"] = "configurar", ["config"] = Prefs.ToBackendConfig() });
            }
            else if (state == BackendState.Stopped || state == BackendState.Failed || state == BackendState.NoPython)
            {
                foreach (DownloadItem item in Active.Where(i => !i.IsPaused).ToList())
                {
                    item.Status = Statuses.Paused;
                    item.Speed = item.Eta = string.Empty;
                }
                _channelReply?.TrySetResult(null);
                ScheduleSave();
                UpdateAwake();
            }
            BackendStateChanged?.Invoke();
        }

        private void UpdateAwake() => _awake.Set(Prefs.PreventSleep && Active.Any(i => i.IsRunning || i.Status == Statuses.Pending));

        private void LoadThumbnail(DownloadItem item)
        {
            string source = item.Thumb;
            ThumbnailLoader.LoadAsync(source).ContinueWith(task =>
            {
                if (task.Status == TaskStatus.RanToCompletion && task.Result != null)
                {
                    _context.Dispatcher.BeginInvoke(new Action(() =>
                    {
                        if (item.Thumb == source)
                        {
                            item.Thumbnail = task.Result;
                        }
                    }), DispatcherPriority.Background);
                }
            }, TaskScheduler.Default);
        }

        private void InsertCompleted(DownloadItem item)
        {
            int index = 0;
            while (index < Completed.Count && Before(Completed[index], item))
            {
                index++;
            }
            Completed.Insert(index, item);
        }

        private void SortCompleted()
        {
            List<DownloadItem> sorted = State.OldestFirst ? Completed.OrderBy(Key).ToList() : Completed.OrderByDescending(Key).ToList();
            for (int target = 0; target < sorted.Count; target++)
            {
                int current = Completed.IndexOf(sorted[target]);
                if (current != target)
                {
                    Completed.Move(current, target);
                }
            }
        }

        private bool Before(DownloadItem existing, DownloadItem item) =>
            State.OldestFirst ? Key(existing) <= Key(item) : Key(existing) >= Key(item);

        private static double Key(DownloadItem item) => item.FinishedTs > 0 ? item.FinishedTs : item.CreatedTs;

        private void ScheduleSave()
        {
            if (_disposed)
            {
                return;
            }
            _saveTimer.Stop();
            _saveTimer.Start();
        }

        private void SaveNow()
        {
            _saveTimer.Stop();
            var snapshot = new SavedState
            {
                Folders = State.Folders.ToList(),
                Folder = State.Folder,
                Draft = State.Draft,
                OldestFirst = State.OldestFirst,
                History = Completed.Take(MaxHistory).Select(ToRecord).ToList(),
                Unfinished = Active.Select(ToRecord).ToList(),
            };
            if (_disposed)
            {
                _store.Save(snapshot);
            }
            else
            {
                Task.Run(() => _store.Save(snapshot));
            }
        }

        private static HistoryRecord ToRecord(DownloadItem item) => new HistoryRecord
        {
            Id = item.Id,
            Url = item.Url,
            Status = item.Status,
            Quality = item.Quality,
            Mode = item.Mode,
            Destination = item.Destination,
            Title = item.Title,
            Thumb = item.Thumb,
            Error = item.Error,
            Hint = item.Hint,
            FilePath = item.FilePath,
            Platform = item.Platform,
            Engine = item.Engine,
            Group = item.Group,
            Files = item.Files,
            Progress = item.Progress,
            CreatedTs = item.CreatedTs,
            FinishedTs = item.FinishedTs,
            Headers = item.Headers,
        };

        private DownloadItem FromRecord(HistoryRecord record, bool finished)
        {
            string status = finished ? (record.Status == Statuses.Done ? Statuses.Done : Statuses.Error) : Statuses.Paused;
            var item = new DownloadItem
            {
                Id = string.IsNullOrEmpty(record.Id) ? Guid.NewGuid().ToString("N").Substring(0, 8) : record.Id,
                Url = record.Url ?? string.Empty,
                Mode = Modes.Normalize(record.Mode ?? (record.Quality == "audio" ? Modes.Audio : Modes.Video)),
                Quality = record.Quality == "pior" ? VideoQualities.Smallest : (record.Quality ?? VideoQualities.Best),
                Destination = record.Destination ?? string.Empty,
                CreatedTs = record.CreatedTs,
                Status = status,
                Title = FirstNonEmpty(record.Title, record.Url),
                Thumb = record.Thumb ?? string.Empty,
                Error = record.Error ?? string.Empty,
                Hint = record.Hint ?? string.Empty,
                FilePath = record.FilePath ?? string.Empty,
                Platform = record.Platform ?? string.Empty,
                Engine = record.Engine ?? string.Empty,
                Group = record.Group ?? string.Empty,
                Files = record.Files,
                FinishedTs = record.FinishedTs,
                Progress = status == Statuses.Done ? 100 : record.Progress,
                Headers = record.Headers,
            };
            LoadThumbnail(item);
            return item;
        }

        private static string Str(Dictionary<string, object> data, string key) =>
            data.TryGetValue(key, out object value) && value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : string.Empty;

        private static double Num(Dictionary<string, object> data, string key)
        {
            if (!data.TryGetValue(key, out object value) || value == null)
            {
                return 0;
            }
            try
            {
                return Convert.ToDouble(value, CultureInfo.InvariantCulture);
            }
            catch (Exception error) when (error is FormatException || error is InvalidCastException || error is OverflowException)
            {
                return 0;
            }
        }

        private static string FirstNonEmpty(string a, string b) => string.IsNullOrWhiteSpace(a) ? b ?? string.Empty : a;
    }

    internal static class KnownFolders
    {
        private static readonly Guid DownloadsId = new Guid("374DE290-123F-4565-9164-39C4925E467B");

        /// <summary>The user's Downloads folder (follows a relocated folder), or %USERPROFILE%\Downloads.</summary>
        public static string Downloads()
        {
            try
            {
                if (SHGetKnownFolderPath(DownloadsId, 0, IntPtr.Zero, out IntPtr path) == 0)
                {
                    try
                    {
                        return Marshal.PtrToStringUni(path);
                    }
                    finally
                    {
                        Marshal.FreeCoTaskMem(path);
                    }
                }
            }
            catch (EntryPointNotFoundException)
            {
            }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        }

        [DllImport("shell32.dll", PreserveSig = true)]
        private static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid id, uint flags, IntPtr token, out IntPtr path);
    }
}
