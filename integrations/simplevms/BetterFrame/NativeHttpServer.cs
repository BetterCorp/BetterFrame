using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Text;
using System.Security.Cryptography.X509Certificates;
using Format.Fmp4;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Shared.Models;
using Shared.Models.Formats;

namespace BetterCorp.BetterFrame;

/// <summary>Browser live remuxing and recording export from native SimpleVMS. No transcoding.</summary>
public sealed class NativeHttpServer(PluginContext context, Func<Guid, string, CancellationToken, Task<bool>> authorize,
  Func<string, CancellationToken, Task<bool>> validateCredentials, Func<string, Guid, bool>? cameraScope = null)
{
  private readonly SemaphoreSlim _liveSlots = new(32);
  private readonly SemaphoreSlim _exportSlots = new(2);
  private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
  public Task Ready => _ready.Task;
  public async Task RunAsync(string address, CancellationToken ct)
  {
    var builder = WebApplication.CreateSlimBuilder(); builder.WebHost.UseUrls(address);
    using var certificate = new Uri(address).Scheme == "https" ? X509Certificate2.CreateFromPemFile(context.Config.Get("tlsCertificate", ""), context.Config.Get("tlsKey", "")) : null;
    if (certificate != null) builder.WebHost.ConfigureKestrel(options => options.ConfigureHttpsDefaults(https => https.ServerCertificate = certificate));
    await using var app = builder.Build();
    app.Use(async (request, next) => {
      if (!await validateCredentials(request.Request.Headers.Authorization.ToString(), request.RequestAborted)) {
        request.Response.StatusCode = 401; return;
      }
      request.Response.Headers.CacheControl = "no-store";
      try { await next(request); }
      catch (OperationCanceledException) when (request.RequestAborted.IsCancellationRequested) { }
      catch { if (!request.Response.HasStarted) request.Response.StatusCode = 503; else request.Abort(); }
    });
    app.MapGet("/bf/{cameraId:guid}/{profile}/live", async (Guid cameraId, string profile, HttpContext request, CancellationToken token) => {
      profile = RequestedProfile(request, profile);
      if (cameraScope != null && !cameraScope(request.Request.Headers.Authorization.ToString(), cameraId)) { request.Response.StatusCode = 404; return; }
      if (!await authorize(cameraId, profile, token)) { request.Response.StatusCode = 404; return; }
      if (!await _liveSlots.WaitAsync(0, token)) { request.Response.StatusCode = 503; return; }
      using var lease = CancellationTokenSource.CreateLinkedTokenSource(token);
      Task? revalidation = null;
      IDataStream? stream = null;
      try {
        var tap = await context.StreamTap!.TapAsync(cameraId, profile, lease.Token);
        if (tap.IsT1) { request.Response.StatusCode = 503; return; }
        stream = tap.AsT0;
        var hevc = stream.Info.FormatParameters is H265Parameters;
        var muxer = new Fmp4Muxer(hevc ? MuxerCodec.H265 : MuxerCodec.H264, stream, "mp4");
        var init = stream.Info.FormatParameters switch {
          H264Parameters h => muxer.BuildInitSegment(h.Sps.Span, h.Pps.Span, [], (int)(stream.Info.Fps ?? 25)),
          H265Parameters h => muxer.BuildInitSegment(h.Sps.Span, h.Pps.Span, h.Vps.Span, (int)(stream.Info.Fps ?? 25)),
          _ => throw new InvalidOperationException("Unsupported browser codec")
        };
        request.Response.ContentType = "video/mp4";
        request.Response.Headers["X-BetterFrame-Mime"] = init.Info.MimeType;
        await request.Response.Body.WriteAsync(init.Segment, lease.Token);
        revalidation = RevalidateLiveAsync(request.Request.Headers.Authorization.ToString(), cameraId, profile, lease);
        var started = false;
        await foreach (var fragment in muxer.MuxAsync(lease.Token)) {
          if (!started && !fragment.IsSyncPoint && !fragment.IsHeader) continue;
          started |= fragment.IsSyncPoint;
          using var write = CancellationTokenSource.CreateLinkedTokenSource(lease.Token); write.CancelAfter(TimeSpan.FromSeconds(3));
          await request.Response.Body.WriteAsync(fragment.Data, write.Token); await request.Response.Body.FlushAsync(write.Token);
        }
      } finally {
        lease.Cancel();
        // The watcher cancels the lease on denial or failure; always observe it and release demand.
        if (revalidation != null) { try { await revalidation; } catch (Exception) { } }
        try { if (stream is IAsyncDisposable asynchronous) await asynchronous.DisposeAsync(); else (stream as IDisposable)?.Dispose(); }
        finally { _liveSlots.Release(); }
      }
    });
    app.MapGet("/bf/{cameraId:guid}/{profile}/recordings", async (Guid cameraId, string profile, HttpContext request, CancellationToken token) => {
      profile = RequestedProfile(request, profile);
      if (cameraScope != null && !cameraScope(request.Request.Headers.Authorization.ToString(), cameraId)) { request.Response.StatusCode = 404; return; }
      if (!DateTimeOffset.TryParse(request.Request.Query["start"], CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var start)
        || start < DateTimeOffset.UnixEpoch || !int.TryParse(request.Request.Query["duration"], out var duration) || duration is < 1 or > 600) { request.Response.StatusCode = 400; return; }
      if (context.RecordingAccess == null || !await _exportSlots.WaitAsync(0, token)) { request.Response.StatusCode = 503; return; }
      var directory = Path.Combine(Path.GetTempPath(), "betterframe-export-" + Guid.NewGuid().ToString("N"));
      try {
        var profiles = new List<string> { profile };
        if (context.CameraRegistry != null) {
          var camera = await context.CameraRegistry.GetCameraAsync(cameraId, token);
          if (camera.IsT0) profiles.AddRange(CatalogBuilder.SupportedProfiles(camera.AsT0).Select(candidate => candidate.Id));
        }
        SegmentInfo[] segments = []; var foundGaps = false;
        foreach (var candidate in profiles.Distinct(StringComparer.Ordinal)) {
          if (!await authorize(cameraId, candidate, token)) continue;
          var result = await context.RecordingAccess.QueryAsync(cameraId, candidate, start.ToUnixMicroseconds(), start.AddSeconds(duration).ToUnixMicroseconds(), token);
          if (result.IsT1 || result.AsT0.Count == 0) continue;
          var ordered = result.AsT0.OrderBy(segment => segment.StartTime).ToArray();
          // Select one profile with complete coverage; never splice profiles or missing periods.
          var coveredUntil = ordered[0].EndTime; var gap = ordered[0].StartTime > start.ToUnixMicroseconds();
          foreach (var segment in ordered.Skip(1)) {
            gap |= segment.StartTime > coveredUntil + 250000;
            coveredUntil = Math.Max(coveredUntil, segment.EndTime);
          }
          if (gap || coveredUntil < start.AddSeconds(duration).ToUnixMicroseconds()) { foundGaps = true; continue; }
          segments = ordered; profile = candidate; break;
        }
        if (segments.Length == 0) { request.Response.StatusCode = foundGaps ? 409 : 404; return; }
        if (segments.Length > 1024 || segments.Sum(s => s.SizeBytes) > 256 * 1024 * 1024) { request.Response.StatusCode = 413; return; }
        Directory.CreateDirectory(directory);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var files = new List<string>(); var total = 0L;
        foreach (var segment in segments) {
          var opened = await context.RecordingAccess.OpenSegmentAsync(segment.SegmentRef, token);
          if (opened.IsT1) throw new IOException("Recording segment unavailable");
          await using var input = opened.AsT0;
          var file = $"{files.Count:D5}.mp4";
          await using var output = File.Create(Path.Combine(directory, file));
          var buffer = new byte[65536]; int read;
          while ((read = await input.ReadAsync(buffer, token)) != 0) {
            total += read; if (total > 256 * 1024 * 1024) throw new IOException("Export exceeds limit");
            await output.WriteAsync(buffer.AsMemory(0, read), token);
          }
          files.Add($"file '{file}'");
        }
        await File.WriteAllLinesAsync(Path.Combine(directory, "segments.txt"), files, token);
        var info = new ProcessStartInfo("ffmpeg") { WorkingDirectory = directory, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        var offset = Math.Max(0, ((double)start.ToUnixMicroseconds() - segments[0].StartTime) / 1000000);
        foreach (var argument in new[] { "-nostdin", "-v", "error", "-f", "concat", "-safe", "1", "-i", "segments.txt", "-ss", offset.ToString(CultureInfo.InvariantCulture), "-t", duration.ToString(), "-c", "copy", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1" }) info.ArgumentList.Add(argument);
        using var process = Process.Start(info) ?? throw new IOException("Export remuxer unavailable");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromSeconds(60));
        using var kill = deadline.Token.Register(() => { try { process.Kill(true); } catch (InvalidOperationException) { } });
        var errors = process.StandardError.ReadToEndAsync(deadline.Token);
        request.Response.ContentType = "video/mp4";
        await process.StandardOutput.BaseStream.CopyToAsync(request.Response.Body, deadline.Token);
        await process.WaitForExitAsync(deadline.Token); await errors;
        if (process.ExitCode != 0) throw new IOException("Recording export failed");
      } finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); _exportSlots.Release(); }
    });
    await app.StartAsync(ct);
    _ready.TrySetResult();
    try { await Task.Delay(Timeout.Infinite, ct); }
    finally { await app.StopAsync(CancellationToken.None); }
  }
  private async Task RevalidateLiveAsync(string authorization, Guid cameraId, string profile, CancellationTokenSource lease)
  {
    try {
      while (!lease.IsCancellationRequested) {
        await Task.Delay(TimeSpan.FromSeconds(10), lease.Token);
        if (!await validateCredentials(authorization, lease.Token) || !await authorize(cameraId, profile, lease.Token)) break;
      }
    } finally { lease.Cancel(); }
  }
  private static string RequestedProfile(HttpContext request, string fallback)
  {
    var raw = request.Features.Get<IHttpRequestFeature>()?.RawTarget;
    if (string.IsNullOrEmpty(raw)) return fallback;
    var parts = raw.Split('?', 2)[0].Split('/');
    return parts.Length >= 2 ? Uri.UnescapeDataString(parts[^2]) : fallback;
  }
}
