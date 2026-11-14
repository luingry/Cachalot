using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Cachalot.Tests
{
    /// <summary>Local, throttled HTTP file server with Range support: deterministic pause/resume/cancel tests.</summary>
    internal sealed class RangeServer : IDisposable
    {
        private readonly TcpListener _listener = new TcpListener(IPAddress.Loopback, 0);
        private readonly long _size;
        private readonly int _bytesPerSecondPerConnection;
        private readonly CancellationTokenSource _stop = new CancellationTokenSource();

        public RangeServer(long size, int bytesPerSecondPerConnection)
        {
            _size = size;
            _bytesPerSecondPerConnection = bytesPerSecondPerConnection;
            _listener.Start();
            Task.Run(AcceptAsync);
        }

        public string Url(string name) => $"http://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}/{name}";

        public void Dispose()
        {
            _stop.Cancel();
            _listener.Stop();
        }

        private async Task AcceptAsync()
        {
            while (!_stop.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await _listener.AcceptTcpClientAsync().ConfigureAwait(false);
                }
                catch (Exception)
                {
                    return;
                }
                _ = Task.Run(() => ServeAsync(client));
            }
        }

        private async Task ServeAsync(TcpClient client)
        {
            using (client)
            {
                try
                {
                    NetworkStream stream = client.GetStream();
                    var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                    string requestLine = await reader.ReadLineAsync().ConfigureAwait(false);
                    if (requestLine == null)
                    {
                        return;
                    }
                    long from = 0, to = _size - 1;
                    bool ranged = false;
                    string line;
                    while (!string.IsNullOrEmpty(line = await reader.ReadLineAsync().ConfigureAwait(false)))
                    {
                        Match m = Regex.Match(line, @"^Range:\s*bytes=(\d+)-(\d*)", RegexOptions.IgnoreCase);
                        if (m.Success)
                        {
                            ranged = true;
                            from = long.Parse(m.Groups[1].Value);
                            if (m.Groups[2].Value.Length > 0)
                            {
                                to = Math.Min(_size - 1, long.Parse(m.Groups[2].Value));
                            }
                        }
                    }
                    bool head = requestLine.StartsWith("HEAD", StringComparison.Ordinal);
                    long length = to - from + 1;
                    string headers = (ranged ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n") +
                                     "Content-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\n" +
                                     $"Content-Length: {length}\r\n" +
                                     (ranged ? $"Content-Range: bytes {from}-{to}/{_size}\r\n" : string.Empty) +
                                     "Connection: close\r\n\r\n";
                    byte[] headerBytes = Encoding.ASCII.GetBytes(headers);
                    await stream.WriteAsync(headerBytes, 0, headerBytes.Length).ConfigureAwait(false);
                    if (head)
                    {
                        return;
                    }
                    var chunk = new byte[16 * 1024];
                    long sent = 0;
                    int perTick = Math.Max(1024, _bytesPerSecondPerConnection / 20);
                    while (sent < length && !_stop.IsCancellationRequested)
                    {
                        int n = (int)Math.Min(Math.Min(chunk.Length, perTick), length - sent);
                        for (int i = 0; i < n; i++)
                        {
                            chunk[i] = (byte)((from + sent + i) % 251);
                        }
                        await stream.WriteAsync(chunk, 0, n).ConfigureAwait(false);
                        sent += n;
                        await Task.Delay(50).ConfigureAwait(false);
                    }
                }
                catch (Exception)
                {
                    // Client went away (pause/cancel): expected.
                }
            }
        }
    }
}
