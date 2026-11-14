using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Threading;
using Cachalot.Module.Downloads;
using SwissTechKnife.Sdk;

namespace Cachalot.Module.Channels
{
    /// <summary>
    /// Checks followed channels for new uploads. One one-shot timer aimed at the next due channel — nothing
    /// ticks while no channel is followed. A check starts the backend, which closes itself again when idle.
    /// The first check of a channel only learns what already exists (no backlog download).
    /// </summary>
    internal sealed class ChannelWatcher : IDisposable
    {
        private const int MaxSeen = 500;
        private static readonly TimeSpan FirstDelay = TimeSpan.FromSeconds(30);

        private readonly IModuleContext _context;
        private readonly Preferences _prefs;
        private readonly Func<DownloadService> _service;
        private readonly DispatcherTimer _timer;
        private bool _checking;
        private bool _started;

        public ChannelWatcher(IModuleContext context, Preferences prefs, Func<DownloadService> service)
        {
            _context = context;
            _prefs = prefs;
            _service = service;
            _timer = new DispatcherTimer(DispatcherPriority.Background, context.Dispatcher);
            _timer.Tick += async (s, e) =>
            {
                _timer.Stop();
                await CheckDueAsync(force: false);
            };
        }

        /// <summary>Raised on the UI thread after a check changed any channel.</summary>
        public event Action Changed;

        public bool IsChecking => _checking;

        public void Start()
        {
            _started = true;
            Reschedule(FirstDelay);
        }

        public void Stop()
        {
            _started = false;
            _timer.Stop();
        }

        /// <summary>Call after the list or an interval changed.</summary>
        public void Reschedule(TimeSpan? minimum = null)
        {
            _timer.Stop();
            if (!_started || _prefs.Channels.Count == 0)
            {
                return;
            }
            double now = Now();
            double due = _prefs.Channels.Min(c => c.LastCheckedTs + c.IntervalMinutes * 60.0);
            TimeSpan wait = TimeSpan.FromSeconds(Math.Max(1, due - now));
            if (minimum.HasValue && wait < minimum.Value)
            {
                wait = minimum.Value;
            }
            _timer.Interval = wait;
            _timer.Start();
        }

        public Task CheckNowAsync(Channel channel = null) => CheckDueAsync(force: true, only: channel);

        /// <summary>Queues the new items found in the last check of this channel.</summary>
        public async Task DownloadNewAsync(Channel channel)
        {
            if (channel.NewItems.Count == 0)
            {
                return;
            }
            DownloadService service = _service();
            bool sent = await service.AddAsync(channel.NewItems.Select(i => i.Url), service.State.Folder ?? service.DefaultFolder).ConfigureAwait(true);
            if (sent)
            {
                channel.NewItems.Clear();
                channel.NewCount = 0;
                Changed?.Invoke();
                service.PreferencesChanged();
            }
        }

        public void Dispose()
        {
            _started = false;
            _timer.Stop();
        }

        private async Task CheckDueAsync(bool force, Channel only = null)
        {
            if (_checking)
            {
                return;
            }
            double now = Now();
            List<Channel> due = only != null
                ? new List<Channel> { only }
                : _prefs.Channels.Where(c => force || now - c.LastCheckedTs >= c.IntervalMinutes * 60.0).ToList();
            if (due.Count == 0)
            {
                Reschedule();
                return;
            }
            _checking = true;
            Changed?.Invoke();
            try
            {
                DownloadService service = _service();
                object[] results = await service.CheckChannelsAsync(due).ConfigureAwait(true);
                if (results == null)
                {
                    foreach (Channel c in due)
                    {
                        c.LastError = "O Cachalot não respondeu; tenta de novo na próxima verificação.";
                        c.LastCheckedTs = Now();
                    }
                }
                else
                {
                    Apply(service, due, results);
                }
                service.PreferencesChanged();
            }
            catch (Exception error)
            {
                _context.Log.Error("Channel check failed.", error);
            }
            finally
            {
                _checking = false;
                Changed?.Invoke();
                Reschedule(TimeSpan.FromSeconds(30));
            }
        }

        private void Apply(DownloadService service, List<Channel> due, object[] results)
        {
            foreach (Dictionary<string, object> result in results.OfType<Dictionary<string, object>>())
            {
                Channel channel = due.FirstOrDefault(c => c.Id == Str(result, "id"));
                if (channel == null)
                {
                    continue;
                }
                channel.LastCheckedTs = Now();
                string error = Str(result, "erro");
                if (error.Length > 0)
                {
                    channel.LastError = error;
                    continue;
                }
                channel.LastError = string.Empty;
                string title = Str(result, "titulo");
                if (title.Length > 0)
                {
                    channel.Title = title;
                }
                List<string> ids = (result.TryGetValue("ids", out object rawIds) && rawIds is object[] idArray ? idArray : new object[0])
                    .Select(i => Convert.ToString(i, CultureInfo.InvariantCulture)).Where(i => !string.IsNullOrEmpty(i)).ToList();
                var fresh = new List<ChannelItem>();
                if (result.TryGetValue("novos", out object rawNew) && rawNew is object[] newArray)
                {
                    foreach (Dictionary<string, object> n in newArray.OfType<Dictionary<string, object>>())
                    {
                        string url = Str(n, "url");
                        if (url.Length > 0 && channel.NewItems.All(x => x.Url != url))
                        {
                            fresh.Add(new ChannelItem { Url = url, Title = Str(n, "titulo") });
                        }
                    }
                }
                channel.Seen = ids.Concat(channel.Seen).Distinct().Take(MaxSeen).ToList();
                channel.Seeded = true;
                if (fresh.Count == 0)
                {
                    continue;
                }
                string name = string.IsNullOrEmpty(channel.Title) ? channel.Url : channel.Title;
                if (channel.AutoDownload)
                {
                    _ = service.AddAsync(fresh.Select(f => f.Url), service.State.Folder ?? service.DefaultFolder);
                    _context.Notify($"{name}: {Plural(fresh.Count, "vídeo novo", "vídeos novos")} na fila.", NotificationKind.Info);
                }
                else
                {
                    channel.NewItems.AddRange(fresh);
                    channel.NewCount = channel.NewItems.Count;
                    _context.Notify($"{name}: {Plural(fresh.Count, "vídeo novo", "vídeos novos")}. Baixe em Configurações › Canais.", NotificationKind.Info);
                }
            }
        }

        private static string Plural(int n, string one, string many) => n == 1 ? "1 " + one : n + " " + many;

        private static double Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;

        private static string Str(Dictionary<string, object> data, string key) =>
            data.TryGetValue(key, out object value) && value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : string.Empty;
    }
}
