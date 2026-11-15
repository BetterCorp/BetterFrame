using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Shared.Models;
using Shared.Models.Formats;

namespace BetterCorp.BetterFrame;

/// <summary>Bounded native RTSP/TCP output. One StreamTap lease per viewer; no second camera capture.</summary>
public sealed class NativeRtspServer(IStreamTap tap, Func<Guid, string, CancellationToken, Task<bool>> authorize, Func<(string User, string Password)> credentials,
  Func<string, CancellationToken, Task<bool>>? validateCredentials = null)
{
  private readonly ConcurrentDictionary<Guid, CancellationTokenSource> _sessions = new();
  private readonly SemaphoreSlim _slots = new(64);
  private readonly TaskCompletionSource<int> _listening = new(TaskCreationOptions.RunContinuationsAsynchronously);
  public Task<int> ListeningPort => _listening.Task;
  public void Invalidate() { foreach (var session in _sessions.Values) { try { session.Cancel(); } catch (ObjectDisposedException) { } } }
  public async Task RunAsync(string address, int port, string certificatePath, string keyPath, CancellationToken ct)
  {
    using var certificate = string.IsNullOrEmpty(certificatePath) ? null : X509Certificate2.CreateFromPemFile(certificatePath, keyPath);
    var listener = new TcpListener(IPAddress.Parse(address), port); listener.Start(64);
    _listening.TrySetResult(((IPEndPoint)listener.LocalEndpoint).Port);
    var tasks = new ConcurrentDictionary<Guid, Task>();
    try {
      while (!ct.IsCancellationRequested) {
        var client = await listener.AcceptTcpClientAsync(ct);
        if (!await _slots.WaitAsync(0, ct)) { client.Dispose(); continue; }
        var id = Guid.NewGuid();
        var task = HandleAsync(id, client, certificate, ct); tasks[id] = task;
        _ = task.ContinueWith(completed => { tasks.TryRemove(id, out _); }, TaskScheduler.Default);
      }
    } finally {
      listener.Stop(); Invalidate();
      await Task.WhenAll(tasks.Values);
    }
  }
  private async Task HandleAsync(Guid id, TcpClient client, X509Certificate2? certificate, CancellationToken stop)
  {
    using var lease = CancellationTokenSource.CreateLinkedTokenSource(stop);
    _sessions[id] = lease;
    IDataStream? capture = null; Task? sending = null;
    using var writeGate = new SemaphoreSlim(1);
    var sessionId = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
    Guid cameraId = Guid.Empty; string profile = ""; bool setup = false;
    try {
      using (client) {
        client.NoDelay = true;
        Stream stream = client.GetStream();
        if (certificate != null) {
          var tls = new SslStream(stream, false); stream = tls;
          await tls.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificate = certificate }, lease.Token);
        }
        await using (stream) {
          async Task Send(string cseq, int status, string headers = "", string body = "") {
            var bodyBytes = Encoding.UTF8.GetBytes(body);
            var reason = status switch { 200 => "OK", 401 => "Unauthorized", 404 => "Not Found", 461 => "Unsupported Transport", 454 => "Session Not Found", _ => "Bad Request" };
            var message = Encoding.ASCII.GetBytes($"RTSP/1.0 {status} {reason}\r\nCSeq: {cseq}\r\n{headers}Content-Length: {bodyBytes.Length}\r\n\r\n");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lease.Token); timeout.CancelAfter(TimeSpan.FromSeconds(3));
            await writeGate.WaitAsync(timeout.Token);
            try { await stream.WriteAsync(message, timeout.Token); if (bodyBytes.Length > 0) await stream.WriteAsync(bodyBytes, timeout.Token); }
            finally { writeGate.Release(); }
          }
          while (!lease.IsCancellationRequested) {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lease.Token); timeout.CancelAfter(TimeSpan.FromSeconds(65));
            var request = await ReadRequestAsync(stream, timeout.Token);
            if (request == null) break;
            var cseq = request.Headers.GetValueOrDefault("CSeq", "0");
            if (!int.TryParse(cseq, out _)) break;
            var (user, password) = credentials();
            var expected = "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes(user + ":" + password));
            var actual = request.Headers.GetValueOrDefault("Authorization", "");
            if (validateCredentials != null ? !await validateCredentials(actual, lease.Token) : password.Length < 16 || !ConstantEquals(actual, expected)) {
              await Send(cseq, 401, "WWW-Authenticate: Basic realm=\"BetterFrame\"\r\n"); continue;
            }
            if (request.Method == "OPTIONS") { await Send(cseq, 200, "Public: OPTIONS, DESCRIBE, SETUP, PLAY, GET_PARAMETER, TEARDOWN\r\n"); continue; }
            if (request.Method is "DESCRIBE" or "SETUP") {
              var parts = new Uri(request.Uri).AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
              if (parts.Length < 3 || parts[0] != "bf" || !Guid.TryParse(parts[1], out var requestedId)) { await Send(cseq, 404); continue; }
              var requestedProfile = Uri.UnescapeDataString(parts[2]);
              if (capture != null && (cameraId != requestedId || profile != requestedProfile)) { await Send(cseq, 400); continue; }
              if (!await authorize(requestedId, requestedProfile, lease.Token)) { await Send(cseq, 404); continue; }
              cameraId = requestedId; profile = requestedProfile;
              if (capture == null) {
                var result = await tap.TapAsync(cameraId, profile, timeout.Token);
                if (result.IsT1) { await Send(cseq, 404); continue; }
                capture = result.AsT0;
              }
              if (capture.Info.FormatParameters is not (H264Parameters or H265Parameters)) { await Send(cseq, 404); break; }
              if (request.Method == "DESCRIBE") {
                var sdp = Sdp(capture.Info.FormatParameters, request.Uri);
                await Send(cseq, 200, $"Content-Type: application/sdp\r\nContent-Base: {request.Uri.TrimEnd('/')}/\r\n", sdp);
              } else {
                var transport = request.Headers.GetValueOrDefault("Transport", "");
                if (!transport.Contains("RTP/AVP/TCP", StringComparison.OrdinalIgnoreCase) || !transport.Contains("interleaved=0-1", StringComparison.OrdinalIgnoreCase)) { await Send(cseq, 461); continue; }
                setup = true;
                await Send(cseq, 200, $"Session: {sessionId};timeout=60\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n");
              }
              continue;
            }
            if (!setup || request.Headers.GetValueOrDefault("Session", "").Split(';')[0] != sessionId) { await Send(cseq, 454); continue; }
            if (!await authorize(cameraId, profile, lease.Token)) { await Send(cseq, 404); break; }
            if (request.Method == "PLAY" && capture != null && sending == null) {
              await Send(cseq, 200, $"Session: {sessionId}\r\nRange: npt=0.000-\r\n");
              sending = Task.WhenAll(PumpAsync(stream, capture, writeGate, lease), RevalidateAsync(actual, cameraId, profile, lease));
            } else if (request.Method == "GET_PARAMETER") await Send(cseq, 200, $"Session: {sessionId}\r\n");
            else if (request.Method == "TEARDOWN") { await Send(cseq, 200); break; }
            else await Send(cseq, 400);
          }
        }
      }
    } catch (Exception) { /* Fail closed; never expose credential-bearing request details. */ }
    finally {
      lease.Cancel(); client.Dispose();
      if (sending != null) { try { await sending; } catch (Exception) { } }
      if (capture is IAsyncDisposable asyncDisposable) await asyncDisposable.DisposeAsync(); else (capture as IDisposable)?.Dispose();
      _sessions.TryRemove(id, out _); _slots.Release();
    }
  }
  private async Task RevalidateAsync(string authorization, Guid cameraId, string profile, CancellationTokenSource lease)
  {
    try {
      while (!lease.IsCancellationRequested) {
        await Task.Delay(TimeSpan.FromSeconds(10), lease.Token);
        if ((validateCredentials != null && !await validateCredentials(authorization, lease.Token)) || !await authorize(cameraId, profile, lease.Token)) break;
      }
    } finally { lease.Cancel(); }
  }
  public static bool ConstantEquals(string a, string b) => CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(a)), SHA256.HashData(Encoding.UTF8.GetBytes(b)));
  public static string Sdp(object parameters, string uri)
  {
    var prefix = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=SimpleVMS\r\nc=IN IP4 0.0.0.0\r\nt=0 0\r\na=control:*\r\nm=video 0 RTP/AVP 96\r\n";
    string B64(ReadOnlyMemory<byte> data) => Convert.ToBase64String(data.Span);
    return prefix + (parameters switch {
      H264Parameters h => $"a=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1;sprop-parameter-sets={B64(h.Sps)},{B64(h.Pps)}\r\n",
      H265Parameters h => $"a=rtpmap:96 H265/90000\r\na=fmtp:96 sprop-vps={B64(h.Vps)};sprop-sps={B64(h.Sps)};sprop-pps={B64(h.Pps)}\r\n",
      _ => throw new ArgumentException("Unsupported stream")
    }) + $"a=control:{uri.TrimEnd('/')}/trackID=0\r\n";
  }
  private static async Task PumpAsync(Stream output, IDataStream capture, SemaphoreSlim gate, CancellationTokenSource lease)
  {
    var packetizer = new RtpPacketizer(capture.Info.FormatParameters is H265Parameters);
    var started = false; IDataUnit? pending = null;
    uint Timestamp(IDataUnit unit) => unit switch { H264NalUnit h => (uint)h.MediaTimestamp, H265NalUnit h => (uint)h.MediaTimestamp, _ => 0 };
    async Task SendNal(ReadOnlyMemory<byte> data, uint timestamp, bool marker) {
      foreach (var packet in packetizer.Packetize(data, timestamp, marker)) {
        var framed = new byte[packet.Length + 4]; framed[0] = (byte)'$'; framed[1] = 0;
        BinaryPrimitives.WriteUInt16BigEndian(framed.AsSpan(2), (ushort)packet.Length); packet.CopyTo(framed, 4);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lease.Token); timeout.CancelAfter(TimeSpan.FromSeconds(3));
        await gate.WaitAsync(timeout.Token); try { await output.WriteAsync(framed, timeout.Token); } finally { gate.Release(); }
      }
    }
    try {
      await foreach (var unit in capture.ReadAsync(lease.Token)) {
        if (!started) {
          if (!unit.IsSyncPoint || unit.IsHeader) continue;
          started = true;
          switch (capture.Info.FormatParameters) {
            case H264Parameters h: await SendNal(h.Sps, Timestamp(unit), false); await SendNal(h.Pps, Timestamp(unit), false); break;
            case H265Parameters h: await SendNal(h.Vps, Timestamp(unit), false); await SendNal(h.Sps, Timestamp(unit), false); await SendNal(h.Pps, Timestamp(unit), false); break;
          }
        }
        if (pending != null) await SendNal(pending.Data, Timestamp(pending), Timestamp(pending) != Timestamp(unit));
        pending = unit;
      }
      if (pending != null) await SendNal(pending.Data, Timestamp(pending), true);
    } finally { lease.Cancel(); }
  }
  private sealed record Request(string Method, string Uri, Dictionary<string, string> Headers);
  private static async Task<Request?> ReadRequestAsync(Stream input, CancellationToken ct)
  {
    using var bytes = new MemoryStream(); var one = new byte[1];
    while (bytes.Length < 16384) {
      if (await input.ReadAsync(one, ct) == 0) return null;
      if (bytes.Length == 0 && one[0] == '$') {
        var header = new byte[3]; await input.ReadExactlyAsync(header, ct);
        var count = BinaryPrimitives.ReadUInt16BigEndian(header.AsSpan(1));
        if (count > 16384) throw new IOException("Oversize interleaved packet");
        await input.ReadExactlyAsync(new byte[count], ct); continue;
      }
      bytes.WriteByte(one[0]);
      if (bytes.Length >= 4 && bytes.GetBuffer().AsSpan((int)bytes.Length - 4, 4).SequenceEqual("\r\n\r\n"u8)) {
        var lines = Encoding.ASCII.GetString(bytes.ToArray()).Split("\r\n");
        var start = lines[0].Split(' '); if (start.Length != 3 || start[2] != "RTSP/1.0") throw new IOException("Invalid RTSP request");
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1).Where(l => l.Contains(':'))) { var at = line.IndexOf(':'); headers[line[..at]] = line[(at + 1)..].Trim(); }
        if (headers.TryGetValue("Content-Length", out var size)) {
          if (!int.TryParse(size, out var length) || length is < 0 or > 16384) throw new IOException("Oversize RTSP body");
          await input.ReadExactlyAsync(new byte[length], ct);
        }
        return new(start[0], start[1], headers);
      }
    }
    throw new IOException("Oversize RTSP headers");
  }
}
