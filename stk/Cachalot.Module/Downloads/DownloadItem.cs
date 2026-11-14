using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.CompilerServices;
using System.Windows.Media;

namespace Cachalot.Module.Downloads
{
    /// <summary>One download as shown on the page. Mutated on the UI thread only.</summary>
    internal sealed class DownloadItem : INotifyPropertyChanged
    {
        private static readonly CultureInfo PtBr = CultureInfo.GetCultureInfo("pt-BR");

        private string _status = Statuses.Pending;
        private double _progress;
        private string _speed = string.Empty;
        private string _eta = string.Empty;
        private string _downloaded = string.Empty;
        private string _total = string.Empty;
        private string _title = string.Empty;
        private string _thumb = string.Empty;
        private ImageSource _thumbnail;
        private string _error = string.Empty;
        private string _hint = string.Empty;
        private string _filePath = string.Empty;
        private string _platform = string.Empty;
        private string _phase = string.Empty;
        private string _engine = string.Empty;
        private string _destination = string.Empty;
        private int _attempt;
        private int _files;
        private double _finishedTs;
        private bool _pausing;

        public event PropertyChangedEventHandler PropertyChanged;

        public string Id { get; set; }

        public string Url { get; set; }

        public string Mode { get; set; } = Modes.Video;

        /// <summary>Video quality or audio format chosen when the download was added.</summary>
        public string Quality { get; set; } = VideoQualities.Best;

        public string Group { get; set; } = string.Empty;

        public double CreatedTs { get; set; }

        /// <summary>Headers captured by the browser extension (Referer, User-Agent…), kept for resume.</summary>
        public Dictionary<string, object> Headers { get; set; }

        public string Destination { get => _destination; set => Set(ref _destination, value ?? string.Empty); }

        public string Status
        {
            get => _status;
            set
            {
                if (Set(ref _status, value ?? Statuses.Pending))
                {
                    _pausing = false;
                    Notify(nameof(IsActive));
                    Notify(nameof(IsRunning));
                    Notify(nameof(IsError));
                    Notify(nameof(IsDone));
                    Notify(nameof(IsPaused));
                    Notify(nameof(CanPause));
                    Notify(nameof(IsIndeterminate));
                    Notify(nameof(CanOpenFile));
                    Notify(nameof(CanOpenFolder));
                    Notify(nameof(Detail));
                }
            }
        }

        public double Progress
        {
            get => _progress;
            set
            {
                if (Set(ref _progress, value))
                {
                    Notify(nameof(IsIndeterminate));
                    Notify(nameof(Detail));
                }
            }
        }

        public string Speed { get => _speed; set { if (Set(ref _speed, value ?? string.Empty)) Notify(nameof(Detail)); } }

        public string Eta { get => _eta; set { if (Set(ref _eta, value ?? string.Empty)) Notify(nameof(Detail)); } }

        public string Downloaded { get => _downloaded; set { if (Set(ref _downloaded, value ?? string.Empty)) Notify(nameof(Detail)); } }

        public string Total { get => _total; set { if (Set(ref _total, value ?? string.Empty)) Notify(nameof(Detail)); } }

        public string Title { get => _title; set => Set(ref _title, value ?? string.Empty); }

        /// <summary>Thumbnail source from the backend: an http(s) URL or a data: URI.</summary>
        public string Thumb { get => _thumb; set => Set(ref _thumb, value ?? string.Empty); }

        public ImageSource Thumbnail { get => _thumbnail; set => Set(ref _thumbnail, value); }

        public string Error { get => _error; set { if (Set(ref _error, value ?? string.Empty)) Notify(nameof(Detail)); } }

        /// <summary>What the user can do about the error (import cookies, wait…).</summary>
        public string Hint { get => _hint; set { if (Set(ref _hint, value ?? string.Empty)) Notify(nameof(Detail)); } }

        public string Platform { get => _platform; set { if (Set(ref _platform, value ?? string.Empty)) Notify(nameof(Detail)); } }

        /// <summary>What the engine is doing right now ("Juntando vídeo e áudio", "3 arquivos", "12 pares").</summary>
        public string Phase { get => _phase; set { if (Set(ref _phase, value ?? string.Empty)) Notify(nameof(Detail)); } }

        /// <summary>yt-dlp, nativo, galeria, direto, torrent, navegador.</summary>
        public string Engine { get => _engine; set { if (Set(ref _engine, value ?? string.Empty)) Notify(nameof(KindGlyph)); } }

        public int Attempt { get => _attempt; set { if (Set(ref _attempt, value)) Notify(nameof(Detail)); } }

        public int Files { get => _files; set { if (Set(ref _files, value)) { Notify(nameof(Detail)); Notify(nameof(CanOpenFile)); } } }

        public string FilePath
        {
            get => _filePath;
            set
            {
                if (Set(ref _filePath, value ?? string.Empty))
                {
                    Notify(nameof(CanOpenFile));
                    Notify(nameof(Detail));
                }
            }
        }

        public double FinishedTs { get => _finishedTs; set { if (Set(ref _finishedTs, value)) Notify(nameof(Detail)); } }

        /// <summary>The pause was requested and the backend has not confirmed it yet.</summary>
        public bool Pausing
        {
            get => _pausing;
            set
            {
                if (Set(ref _pausing, value))
                {
                    Notify(nameof(Detail));
                    Notify(nameof(CanPause));
                }
            }
        }

        public bool IsActive => Statuses.IsActive(_status) || _status == Statuses.Paused;

        /// <summary>Doing work now (not waiting in the queue, not paused).</summary>
        public bool IsRunning => _status == Statuses.Analyzing || _status == Statuses.Downloading || _status == Statuses.Processing;

        public bool IsError => _status == Statuses.Error;

        public bool IsDone => _status == Statuses.Done;

        public bool IsPaused => _status == Statuses.Paused;

        public bool CanPause => Statuses.IsActive(_status) && !_pausing;

        /// <summary>Analysing, processing, waiting, or downloading without a known size.</summary>
        public bool IsIndeterminate =>
            _status == Statuses.Pending || _status == Statuses.Analyzing || _status == Statuses.Processing ||
            (_status == Statuses.Downloading && _progress <= 0);

        public bool CanOpenFile => IsDone && !string.IsNullOrEmpty(_filePath);

        public bool CanOpenFolder => IsDone;

        /// <summary>Placeholder glyph for items without a thumbnail.</summary>
        public string KindGlyph
        {
            get
            {
                switch (_engine)
                {
                    case "torrent": return "";
                    case "galeria": return "";
                    case "direto": return "";
                    default: return Mode == Modes.Audio ? "" : "";
                }
            }
        }

        /// <summary>One caption line under the title.</summary>
        public string Detail
        {
            get
            {
                string text;
                switch (_status)
                {
                    case Statuses.Pending:
                        text = _attempt > 0
                            ? Join("Nova tentativa em instantes (" + _attempt + "ª)", _hint)
                            : "Na fila";
                        break;
                    case Statuses.Analyzing:
                        text = string.IsNullOrEmpty(_phase) ? "Analisando o link" : _phase;
                        break;
                    case Statuses.Processing:
                        text = string.IsNullOrEmpty(_phase) ? "Finalizando o arquivo" : _phase;
                        break;
                    case Statuses.Downloading:
                        text = _engine == "galeria"
                            ? (string.IsNullOrEmpty(_phase) ? "Baixando a galeria" : _phase)
                            : Join(_phase, _progress > 0 ? _progress.ToString("0.0", PtBr) + "%" : null, SizeText(), Clean(_speed),
                                   string.IsNullOrEmpty(Clean(_eta)) ? null : "faltam " + Clean(_eta));
                        break;
                    case Statuses.Paused:
                        text = _progress > 0 ? "Pausado em " + _progress.ToString("0", PtBr) + "%" : "Pausado";
                        break;
                    case Statuses.Error:
                        return Join(_platform, string.IsNullOrEmpty(_error) ? "Falhou" : _error, _hint);
                    default:
                        text = Join(FinishedText(), _files > 1 ? _files + " arquivos" : string.IsNullOrEmpty(_filePath) ? null : Path.GetFileName(_filePath));
                        break;
                }
                if (_pausing)
                {
                    text = "Pausando…";
                }
                return Join(_platform, text);
            }
        }

        private string SizeText()
        {
            string total = Clean(_total);
            string done = Clean(_downloaded);
            if (string.IsNullOrEmpty(total) || total == "?")
            {
                return string.IsNullOrEmpty(done) ? null : done;
            }
            return string.IsNullOrEmpty(done) ? total : done + " de " + total;
        }

        private string FinishedText()
        {
            if (_finishedTs <= 0)
            {
                return null;
            }
            DateTime when = DateTimeOffset.FromUnixTimeMilliseconds((long)(_finishedTs * 1000)).LocalDateTime;
            return when.Date == DateTime.Today ? "Hoje, " + when.ToString("HH:mm", PtBr) : when.ToString("dd/MM/yyyy HH:mm", PtBr);
        }

        private static string Clean(string value) =>
            string.IsNullOrWhiteSpace(value) || value.Trim() == "..." || value.Trim() == "Unknown" ? null : value.Trim();

        private static string Join(params string[] parts)
        {
            var kept = new List<string>();
            foreach (string part in parts)
            {
                if (!string.IsNullOrWhiteSpace(part))
                {
                    kept.Add(part.Trim());
                }
            }
            return string.Join(" · ", kept);
        }

        private bool Set<T>(ref T field, T value, [CallerMemberName] string name = null)
        {
            if (EqualityComparer<T>.Default.Equals(field, value))
            {
                return false;
            }
            field = value;
            Notify(name);
            return true;
        }

        private void Notify(string name) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }

    /// <summary>Status values used by servidor.py.</summary>
    internal static class Statuses
    {
        public const string Pending = "pendente";
        public const string Analyzing = "analisando";
        public const string Downloading = "baixando";
        public const string Processing = "processando";
        public const string Paused = "pausado";
        public const string Done = "concluido";
        public const string Error = "erro";

        /// <summary>Queued or running (paused is listed with the active ones but is not "active" work).</summary>
        public static bool IsActive(string status) =>
            status == Pending || status == Analyzing || status == Downloading || status == Processing;
    }
}
