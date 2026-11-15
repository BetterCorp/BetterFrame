using System.Buffers.Binary;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using NUnit.Framework;
using OneOf;
using Shared.Models;
using Shared.Models.Formats;
using BetterCorp.BetterFrame;
using Microsoft.Extensions.Logging;
using System.Net;
using System.Collections.Concurrent;
using System.Threading.Channels;
using Shared.Models.Events;
using System.Security.Cryptography;

namespace BetterFrame.Tests;

public sealed class IntegrationTests
{
  [TestCase("integrationToken", 31, 32)]
  [TestCase("viewerPassword", 15, 16)]
  public void InvalidCredentialsAreRejectedBeforeAnySettingsAreWritten(string key, int tooShort, int minimum)
  {
    var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    try {
      var settings = new Config(); var plugin = new BetterFramePlugin();
      plugin.Initialize(new PluginContext { Config = settings, Environment = new Environment(directory), LoggerFactory = new Logs(), CameraRegistry = new Registry(), EventBus = new Bus(), StreamTap = new Tap() });
      Assert.That(plugin.ValidateValue(key, new string('x', tooShort)).IsT1, Is.True);
      var failed = plugin.ApplyValues(new Dictionary<string, string> { ["name"] = "Must not persist", [key] = new string('x', tooShort) });
      Assert.That(failed.IsT1, Is.True); Assert.That(settings.Values, Is.Empty);
      Assert.That(plugin.ValidateValue(key, new string('x', minimum)).IsT0, Is.True);
      Assert.That(plugin.ApplyValues(new Dictionary<string, string> { [key] = new string('x', minimum) }).IsT0, Is.True);
      Assert.That(settings.Get(key, ""), Has.Length.EqualTo(minimum));
      Assert.That(plugin.ValidateValue("name", new string('n', 256)).IsT1, Is.True);
      Assert.That(plugin.ValidateValue("name", new string('n', 255)).IsT0, Is.True);
    } finally { Directory.Delete(directory, true); }
  }
  [Test] public void OlderAccessResponsesCannotRestoreGrantsRemovedByANewerSnapshot()
  {
    var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    try {
      var cache = new ReaderAccessCache(directory); cache.Record("authority", "kiosk/camera", true);
      var requestGeneration = cache.Generation;
      cache.Replace("authority", []);
      Assert.That(cache.Record("authority", "kiosk/camera", true, requestGeneration), Is.False);
      Assert.That(new ReaderAccessCache(directory).Allows("authority", "kiosk/camera"), Is.False);
      Assert.That(cache.Record("authority", "kiosk/camera", true, cache.Generation), Is.True);
      var concurrent = cache.Generation;
      Assert.That(cache.Record("authority", "other/camera", true, concurrent), Is.True);
      Assert.That(cache.Record("authority", "another/camera", true, concurrent), Is.True);
      cache.Replace("authority", ["kiosk/camera"]);
      Assert.That(cache.Record("authority", "kiosk/camera", false, concurrent), Is.False);
      Assert.That(new ReaderAccessCache(directory).Allows("authority", "kiosk/camera"), Is.False);
    } finally { Directory.Delete(directory, true); }
  }
  [TestCase(true)] [TestCase(false)] public void ConcurrentResponsesRetryFailedDurableRevocationWrites(bool lateAllowed)
  {
    var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    try {
      var cache = new ReaderAccessCache(directory); cache.Record("authority", "kiosk/camera", true);
      var concurrent = cache.Generation;
      Directory.CreateDirectory(Path.Combine(directory, "access.json.tmp"));
      Assert.Throws<UnauthorizedAccessException>(() => cache.Record("authority", "kiosk/camera", false, concurrent));
      Assert.That(cache.Allows("authority", "kiosk/camera"), Is.False);
      Directory.Delete(Path.Combine(directory, "access.json.tmp"));
      Assert.That(cache.Record("authority", "kiosk/camera", lateAllowed, concurrent), Is.False);
      Assert.That(new ReaderAccessCache(directory).Allows("authority", "kiosk/camera"), Is.False);
    } finally { Directory.Delete(directory, true); }
  }
  [Test] public void ReaderGrantsAndRevocationsSurviveRestartWhileUnknownReadersRemainDenied()
  {
    var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    try {
      var cache = new ReaderAccessCache(directory); cache.Record("authority", "kiosk/camera", true);
      cache = new ReaderAccessCache(directory);
      Assert.That(cache.Allows("authority", "kiosk/camera"), Is.True);
      Assert.That(cache.Allows("authority", "other/camera"), Is.False);
      Assert.That(cache.Allows("other-authority", "kiosk/camera"), Is.False);
      cache.Record("authority", "kiosk/camera", false);
      cache = new ReaderAccessCache(directory); Assert.That(cache.Allows("authority", "kiosk/camera"), Is.False);
      cache.Replace("authority", ["kiosk/camera", "new/camera"]);
      Assert.That(cache.Allows("authority", "kiosk/camera"), Is.False);
      Assert.That(cache.Allows("authority", "new/camera"), Is.True);
    } finally { Directory.Delete(directory, true); }
  }
  [Test] public async Task NativeSettingsManageNamedGroupsAndCameraMembershipWithoutChangingRecording()
  {
    var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    try {
      var settings = new Config(); var plugin = new BetterFramePlugin();
      plugin.Initialize(new PluginContext { Config = settings, Environment = new Environment(directory), LoggerFactory = new Logs(), CameraRegistry = new Registry(), EventBus = new Bus(), StreamTap = new Tap() });
      plugin.ApplyValues(new Dictionary<string, string> { ["newGroupName"] = "Outside" });
      var group = CatalogBuilder.ParseGroups(settings.Get("groups", "[]")).Single(); var camera = Guid.NewGuid();
      plugin.ApplyValues(camera, new Dictionary<string, string> { ["member_" + group.Id] = "true" });
      Assert.That(plugin.GetValues(camera)["member_" + group.Id], Is.EqualTo("true"));
      plugin.ApplyValues(new Dictionary<string, string> { ["groupName_" + group.Id] = "Perimeter" });
      Assert.That(CatalogBuilder.ParseGroups(settings.Get("groups", "[]")).Single().Id, Is.EqualTo(group.Id));
      Assert.That(plugin.GetSchema(camera).Single().Fields.Single().Label, Is.EqualTo("Perimeter"));
      await plugin.OnRemovedAsync(camera, default);
      Assert.That(CatalogBuilder.ParseGroups(settings.Get("groups", "[]")).Single().CameraIds, Is.Empty);
      plugin.ApplyValues(new Dictionary<string, string> { ["deleteGroup_" + group.Id] = "true" });
      Assert.That(CatalogBuilder.ParseGroups(settings.Get("groups", "[]")), Is.Empty);
      Assert.That(settings.Values.Keys.Any(k => k.Contains("record", StringComparison.OrdinalIgnoreCase)), Is.False);
    } finally { Directory.Delete(directory, true); }
  }

  [Test] public async Task PluginPushesInitialAndChangedCatalogsRetriesDeliveryAndDoesNotPoll()
  {
    var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
    static int FreePort() { var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start(); var port = ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop(); return port; }
    var callbackPort = FreePort(); using var receiver = new HttpListener(); receiver.Prefixes.Add($"http://127.0.0.1:{callbackPort}/"); receiver.Start();
    var settings = new Config(); settings.Set("callbackUrl", $"http://127.0.0.1:{callbackPort}/events"); settings.Set("integrationToken", new string('x', 40));
    settings.Set("rtspPort", FreePort().ToString()); settings.Set("httpListenUrl", $"http://127.0.0.1:{FreePort()}");
    var registry = new Registry(); var bus = new Bus(); var plugin = new BetterFramePlugin();
    plugin.Initialize(new PluginContext { Config = settings, Environment = new Environment(directory), LoggerFactory = new Logs(), CameraRegistry = registry, EventBus = bus, StreamTap = new Tap() });
    await plugin.StartAsync(timeout.Token);
    try {
      var first = await receiver.GetContextAsync().WaitAsync(timeout.Token);
      var initial = await JsonSerializer.DeserializeAsync<Catalog>(first.Request.InputStream, CatalogBuilder.Json, timeout.Token);
      first.Response.StatusCode = 503; first.Response.Close();
      Assert.That(initial!.Revision, Is.EqualTo(1)); Assert.That(registry.Calls, Is.EqualTo(1));
      await Task.Delay(200, timeout.Token); Assert.That(registry.Calls, Is.EqualTo(1));
      var id = Guid.NewGuid(); registry.Cameras = [Camera(id, "New camera")];
      await bus.PublishAsync(new CameraAdded { CameraId = id, Timestamp = 1 }, timeout.Token);
      var changed = await receiver.GetContextAsync().WaitAsync(timeout.Token);
      var catalog = await JsonSerializer.DeserializeAsync<Catalog>(changed.Request.InputStream, CatalogBuilder.Json, timeout.Token);
      Assert.That(catalog!.Revision, Is.GreaterThan(initial.Revision)); Assert.That(catalog.Cameras.Single().Name, Is.EqualTo("New camera"));
      var response = Encoding.UTF8.GetBytes($"{{\"revision\":{catalog.Revision}}}"); changed.Response.ContentType = "application/json";
      await changed.Response.OutputStream.WriteAsync(response, timeout.Token); changed.Response.Close();
      var calls = registry.Calls; await Task.Delay(200, timeout.Token); Assert.That(registry.Calls, Is.EqualTo(calls));
      await plugin.StopAsync(default);
      Assert.That((await plugin.StartAsync(timeout.Token)).IsT0, Is.True);
      var restarted = await receiver.GetContextAsync().WaitAsync(timeout.Token);
      var replay = await JsonSerializer.DeserializeAsync<Catalog>(restarted.Request.InputStream, CatalogBuilder.Json, timeout.Token);
      Assert.That(replay!.Revision, Is.GreaterThan(catalog.Revision));
      var acknowledgement = Encoding.UTF8.GetBytes($"{{\"revision\":{replay.Revision}}}");
      await restarted.Response.OutputStream.WriteAsync(acknowledgement, timeout.Token); restarted.Response.Close();
    } finally { await plugin.StopAsync(default); receiver.Stop(); Directory.Delete(directory, true); }
  }
  [Test] public void CatalogExportsUngroupedCamerasWithoutUpstreamSecretsAndPreservesGroupOrder()
  {
    var a = Guid.NewGuid(); var b = Guid.NewGuid();
    var cameras = new[] { Camera(a, "A"), Camera(b, "B") };
    var catalog = CatalogBuilder.Build("instance", 1, "NVR", cameras, [new DisplayGroup(Guid.NewGuid(), "Wall", [a])]);
    Assert.That(catalog.Cameras, Has.Length.EqualTo(2));
    Assert.That(catalog.Groups[0].CameraIds, Is.EqualTo(new[] { a.ToString() }));
    Assert.That(JsonSerializer.Serialize(catalog), Does.Not.Contain("secret"));
    Assert.That(catalog.Cameras[0].Profiles.Select(p => p.Role), Is.EqualTo(new[] { "main", "sub" }));
  }
  [Test] public void UnsupportedCamerasAreExcludedFromCatalogAndGroupMembership()
  {
    var playable = Camera(Guid.NewGuid(), "Playable");
    var unsupported = new CameraInfo { Id = Guid.NewGuid(), Name = "Unsupported", Address = "unused", ProviderId = "onvif", Capabilities = [], Streams = [
      new() { Id = Guid.NewGuid(), Profile = "JPEG", Kind = StreamKind.Quality, FormatId = "mjpeg", Codec = "mjpeg", IsRootStream = true, Uri = "unused" },
      new() { Id = Guid.NewGuid(), Profile = "Derived", Kind = StreamKind.Quality, FormatId = "h264", Codec = "h264", IsRootStream = false, Uri = "unused" }
    ] };
    var catalog = CatalogBuilder.Build("instance", 1, "NVR", [playable, unsupported], [new DisplayGroup(Guid.NewGuid(), "Mixed", [unsupported.Id, playable.Id])]);
    Assert.That(catalog.Cameras.Select(camera => camera.Id), Is.EqualTo(new[] { playable.Id.ToString() }));
    Assert.That(catalog.Groups.Single().CameraIds, Is.EqualTo(new[] { playable.Id.ToString() }));
    catalog = CatalogBuilder.Build("instance", 2, "NVR", [unsupported], [new DisplayGroup(Guid.NewGuid(), "Unsupported only", [unsupported.Id])]);
    Assert.That(catalog.Cameras, Is.Empty); Assert.That(catalog.Groups.Single().CameraIds, Is.Empty);
  }
  [Test] public void OutboxSurvivesRestartAndLostAcknowledgements()
  {
    var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    try {
      var box = new CatalogOutbox(directory); var identity = box.InstanceId;
      var catalog = new Catalog(1, identity, 0, "NVR", [], []);
      Assert.That(box.Enqueue(catalog), Is.True); Assert.That(box.Revision, Is.EqualTo(1));
      box = new CatalogOutbox(directory); Assert.That(box.InstanceId, Is.EqualTo(identity));
      Assert.That(box.Pending!.Revision, Is.EqualTo(1));
      Assert.That(box.Enqueue(catalog), Is.False);
      box.Enqueue(catalog with { Name = "Renamed" }); box.Acknowledge(1);
      Assert.That(box.Pending!.Revision, Is.EqualTo(2)); box.Acknowledge(2);
      Assert.That(new CatalogOutbox(directory).Pending, Is.Null);
      box.Acknowledge(100); box.Enqueue(catalog with { Name = "Recovered" });
      Assert.That(box.Pending!.Revision, Is.EqualTo(101));
    } finally { Directory.Delete(directory, true); }
  }
  [TestCase(false)] [TestCase(true)] public void FragmentedRtpReassemblesOriginalNal(bool hevc)
  {
    var nal = new byte[4500]; new Random(42).NextBytes(nal); nal[0] = hevc ? (byte)0x26 : (byte)0x65; nal[1] = 1;
    var packets = new RtpPacketizer(hevc).Packetize(nal, 90000, true).ToArray();
    Assert.That(packets.Length, Is.GreaterThan(1));
    var header = hevc ? 3 : 2; var reconstructed = new List<byte>(); reconstructed.Add(nal[0]); if (hevc) reconstructed.Add(nal[1]);
    for (var i = 0; i < packets.Length; i++) {
      var p = packets[i]; Assert.That(p.Length, Is.LessThanOrEqualTo(1212));
      Assert.That(BinaryPrimitives.ReadUInt32BigEndian(p.AsSpan(4)), Is.EqualTo(90000));
      Assert.That((p[1] & 0x80) != 0, Is.EqualTo(i == packets.Length - 1));
      if (i > 0) Assert.That(BinaryPrimitives.ReadUInt16BigEndian(p.AsSpan(2)), Is.EqualTo(unchecked((ushort)(BinaryPrimitives.ReadUInt16BigEndian(packets[i - 1].AsSpan(2)) + 1))));
      reconstructed.AddRange(p.AsSpan(12 + header).ToArray());
    }
    Assert.That(reconstructed, Is.EqualTo(nal));
  }
  [Test] public void DisplayGroupsRejectDuplicatesAndExcessiveWalls()
  {
    var id = Guid.NewGuid();
    Assert.Throws<ArgumentException>(() => CatalogBuilder.ParseGroups(JsonSerializer.Serialize(new[] { new DisplayGroup(id, "A", []), new DisplayGroup(id, "B", []) }, CatalogBuilder.Json)));
    Assert.Throws<ArgumentException>(() => CatalogBuilder.ParseGroups(JsonSerializer.Serialize(new[] { new DisplayGroup(id, "A", Enumerable.Range(0, 33).Select(_ => Guid.NewGuid()).ToArray()) }, CatalogBuilder.Json)));
  }
  [Test] public async Task RtspAuthenticatesStreamsAndReleasesNativeDemandOnDisconnectAndRevocation()
  {
    using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    var camera = Guid.NewGuid(); var tap = new Tap(); var allowed = true;
    var server = new NativeRtspServer(tap, (id, profile, _) => Task.FromResult(allowed && id == camera && profile == "High"), () => ("viewer", "viewer-password-at-least-16"));
    var running = server.RunAsync("127.0.0.1", 0, "", "", stop.Token);
    var port = await server.ListeningPort.WaitAsync(stop.Token);
    try {
      using (var client = new TcpClient()) {
        await client.ConnectAsync("127.0.0.1", port, stop.Token); var stream = client.GetStream();
        var uri = $"rtsp://127.0.0.1:{port}/bf/{camera}/High";
        var basic = Convert.ToBase64String(Encoding.UTF8.GetBytes("viewer:viewer-password-at-least-16"));
        async Task<string> Send(string method, string extra = "", bool auth = true) {
          await stream.WriteAsync(Encoding.ASCII.GetBytes($"{method} {uri} RTSP/1.0\r\nCSeq: 1\r\n{(auth ? "Authorization: Basic " + basic + "\r\n" : "")}{extra}\r\n"), stop.Token);
          return await ReadResponse(stream, stop.Token);
        }
        Assert.That(await Send("DESCRIBE", auth: false), Does.StartWith("RTSP/1.0 401")); Assert.That(tap.Count, Is.EqualTo(0));
        Assert.That(await Send("DESCRIBE"), Does.Contain("H264/90000")); Assert.That(tap.Count, Is.EqualTo(1));
        var setup = await Send("SETUP", "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n");
        var session = setup.Split("\r\n").Single(l => l.StartsWith("Session:")).Split(':', 2)[1].Split(';')[0].Trim();
        Assert.That(await Send("PLAY", $"Session: {session}\r\n"), Does.StartWith("RTSP/1.0 200"));
        var header = new byte[4]; await stream.ReadExactlyAsync(header, stop.Token); Assert.That(header[0], Is.EqualTo((byte)'$'));
        var payload = new byte[BinaryPrimitives.ReadUInt16BigEndian(header.AsSpan(2))]; await stream.ReadExactlyAsync(payload, stop.Token);
        Assert.That(payload[0], Is.EqualTo(0x80));
        allowed = false; server.Invalidate();
        for (var i = 0; i < 100 && tap.Count != 0; i++) await Task.Delay(10, stop.Token);
        Assert.That(tap.Count, Is.EqualTo(0), "Revocation must release demand while the playing client is still open");
      }
      for (var i = 0; i < 100 && tap.Count != 0; i++) await Task.Delay(10, stop.Token);
      Assert.That(tap.Count, Is.EqualTo(0));
    } finally { stop.Cancel(); try { await running; } catch (OperationCanceledException) { } }
    Assert.That(tap.Count, Is.EqualTo(0));
  }
  [Test] public async Task BrowserMediaAuthenticatesRemuxesNativeFramesAndReleasesDemand()
  {
    using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start(); var port = ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
    var tap = new Tap();
    var context = new PluginContext { Config = new Config(), Environment = new Environment(directory), LoggerFactory = new Logs(), CameraRegistry = new Registry(), EventBus = new Bus(), StreamTap = tap };
    var server = new NativeHttpServer(context, (_, _, _) => Task.FromResult(true), (header, _) => Task.FromResult(header == "Basic authorized"));
    var running = server.RunAsync($"http://127.0.0.1:{port}", stop.Token); await server.Ready.WaitAsync(stop.Token);
    using var client = new HttpClient(new SocketsHttpHandler { MaxResponseDrainSize = 0, ResponseDrainTimeout = TimeSpan.Zero });
    var address = $"http://127.0.0.1:{port}/bf/{Guid.NewGuid()}/High/live";
    try {
      using (var denied = await client.GetAsync(address, stop.Token)) Assert.That((int)denied.StatusCode, Is.EqualTo(401));
      Assert.That(tap.Count, Is.EqualTo(0));
      using (var request = new HttpRequestMessage(HttpMethod.Get, address)) {
        request.Headers.TryAddWithoutValidation("Authorization", "Basic authorized");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, stop.Token);
        Assert.That((int)response.StatusCode, Is.EqualTo(200));
        Assert.That(response.Headers.GetValues("X-BetterFrame-Mime").Single(), Does.Contain("avc1"));
        await using var stream = await response.Content.ReadAsStreamAsync(stop.Token);
        var box = new byte[8]; await stream.ReadExactlyAsync(box, stop.Token);
        Assert.That(Encoding.ASCII.GetString(box, 4, 4), Is.EqualTo("ftyp")); Assert.That(tap.Count, Is.EqualTo(1));
      }
      for (var i = 0; i < 100 && tap.Count != 0; i++) await Task.Delay(10, stop.Token);
      Assert.That(tap.Count, Is.EqualTo(0));
    } finally { stop.Cancel(); try { await running; } catch (OperationCanceledException) { } }
  }
  [Test] public async Task PluginReaderCredentialsCannotBeReusedForAnotherCameraOrAfterUnlinking()
  {
    using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(20));
    var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    static int Port() { var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start(); var port = ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop(); return port; }
    var callbackPort = Port(); var httpPort = Port();
    using var receiver = new HttpListener(); receiver.Prefixes.Add($"http://127.0.0.1:{callbackPort}/"); receiver.Start();
    var settings = new Config(); settings.Set("callbackUrl", $"http://127.0.0.1:{callbackPort}/events"); settings.Set("integrationToken", new string('x', 40));
    settings.Set("rtspPort", Port().ToString()); settings.Set("httpListenUrl", $"http://127.0.0.1:{httpPort}");
    settings.Set("viewerUsername", "reader"); settings.Set("viewerPassword", "test-root-reader-password");
    var a = Guid.NewGuid(); var b = Guid.NewGuid(); var kiosk = Guid.NewGuid(); var tap = new Tap();
    var registry = new Registry { Cameras = [Camera(a, "A"), Camera(b, "B")] }; var plugin = new BetterFramePlugin();
    plugin.Initialize(new PluginContext { Config = settings, Environment = new Environment(directory), LoggerFactory = new Logs(), CameraRegistry = registry, EventBus = new Bus(), StreamTap = tap });
    Assert.That((await plugin.StartAsync(stop.Token)).IsT0, Is.True);
    try {
      var initial = await receiver.GetContextAsync().WaitAsync(stop.Token);
      var catalog = await JsonSerializer.DeserializeAsync<Catalog>(initial.Request.InputStream, CatalogBuilder.Json, stop.Token);
      await initial.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes($"{{\"revision\":{catalog!.Revision}}}"), stop.Token); initial.Response.Close();
      var scope = $"{kiosk}/{a}";
      var password = Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes(settings.Get("viewerPassword", "")), Encoding.UTF8.GetBytes(scope))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
      using var client = new HttpClient(new SocketsHttpHandler { MaxResponseDrainSize = 0, ResponseDrainTimeout = TimeSpan.Zero });
      client.DefaultRequestHeaders.TryAddWithoutValidation("Authorization", "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes($"reader/{scope}:{password}")));
      async Task Access(bool allowed) {
        var request = await receiver.GetContextAsync().WaitAsync(stop.Token);
        Assert.That(request.Request.Url!.AbsolutePath, Is.EqualTo("/access"));
        Assert.That(request.Request.QueryString["cameraId"], Is.EqualTo(a.ToString()));
        Assert.That(request.Request.QueryString["kioskId"], Is.EqualTo(kiosk.ToString()));
        await request.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(allowed ? "{\"allowed\":true}" : "{\"allowed\":false}"), stop.Token); request.Response.Close();
      }
      var mismatch = client.GetAsync($"http://127.0.0.1:{httpPort}/bf/{b}/High/live", stop.Token);
      await Access(true); using (var denied = await mismatch) Assert.That((int)denied.StatusCode, Is.EqualTo(404));
      Assert.That(tap.Count, Is.EqualTo(0));
      using var validRequest = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{httpPort}/bf/{a}/High/live");
      var live = client.SendAsync(validRequest, HttpCompletionOption.ResponseHeadersRead, stop.Token); await Access(true);
      using (var response = await live) {
        Assert.That((int)response.StatusCode, Is.EqualTo(200));
        await using var stream = await response.Content.ReadAsStreamAsync(stop.Token); var box = new byte[8]; await stream.ReadExactlyAsync(box, stop.Token);
        Assert.That(Encoding.ASCII.GetString(box, 4, 4), Is.EqualTo("ftyp"));
      }
      receiver.Stop(); // BF is unavailable; a previously authorized camera must still play.
      using (var offlineRequest = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{httpPort}/bf/{a}/High/live")) {
        using var offline = await client.SendAsync(offlineRequest, HttpCompletionOption.ResponseHeadersRead, stop.Token);
        Assert.That((int)offline.StatusCode, Is.EqualTo(200));
        await using var stream = await offline.Content.ReadAsStreamAsync(stop.Token); var box = new byte[8]; await stream.ReadExactlyAsync(box, stop.Token);
        Assert.That(Encoding.ASCII.GetString(box, 4, 4), Is.EqualTo("ftyp"));
      }
      receiver.Start();
      var revoked = client.GetAsync($"http://127.0.0.1:{httpPort}/bf/{a}/High/live", stop.Token);
      await Access(false); using (var denied = await revoked) Assert.That((int)denied.StatusCode, Is.EqualTo(401));
    } finally { await plugin.StopAsync(default); receiver.Stop(); Directory.Delete(directory, true); }
    Assert.That(tap.Count, Is.EqualTo(0));
  }
  private static async Task<string> ReadResponse(Stream stream, CancellationToken ct)
  {
    using var buffer = new MemoryStream(); var one = new byte[1];
    while (true) {
      await stream.ReadExactlyAsync(one, ct); buffer.WriteByte(one[0]);
      if (buffer.Length >= 4 && buffer.GetBuffer().AsSpan((int)buffer.Length - 4, 4).SequenceEqual("\r\n\r\n"u8)) break;
    }
    var header = Encoding.ASCII.GetString(buffer.ToArray());
    var length = int.Parse(header.Split("\r\n").Single(l => l.StartsWith("Content-Length:")).Split(':')[1]);
    var body = new byte[length]; await stream.ReadExactlyAsync(body, ct); return header + Encoding.UTF8.GetString(body);
  }
  private static CameraInfo Camera(Guid id, string name) => new() { Id = id, Name = name, Address = "rtsp://secret:secret@camera/", ProviderId = "onvif", Capabilities = [], Streams = [
    new() { Id = Guid.NewGuid(), Profile = "High", Kind = StreamKind.Quality, FormatId = "h264", Codec = "h264", Resolution = "1920x1080", IsRootStream = true, Uri = "secret" },
    new() { Id = Guid.NewGuid(), Profile = "Low", Kind = StreamKind.Quality, FormatId = "h264", Codec = "h264", Resolution = "640x360", IsRootStream = true, Uri = "secret" }
  ] };
  private sealed class Tap : IStreamTap
  {
    public int Count;
    public Task<OneOf<IDataStream, Error>> TapAsync(Guid camera, string profile, CancellationToken ct) { Interlocked.Increment(ref Count); return Task.FromResult<OneOf<IDataStream, Error>>(new Stream(this)); }
    private sealed class Stream(Tap owner) : IDataStream<H264NalUnit>, IDisposable
    {
      public StreamInfo Info { get; } = new() { DataFormat = "h264", FormatParameters = new H264Parameters { Sps = new byte[] { 0x67, 0x42, 0x00, 0x2a, 0x96, 0x35, 0x40, 0xf0, 0x04, 0x4f, 0xcb, 0x37, 0x01, 0x01, 0x01, 0x40, 0x00, 0x01, 0xc2, 0x00, 0x00, 0x57, 0xe4, 0x01 }, Pps = new byte[] { 0x68, 0xce, 6, 0xe2 } } };
      public Type FrameType => typeof(H264NalUnit);
      public async IAsyncEnumerable<H264NalUnit> ReadAsync([EnumeratorCancellation] CancellationToken ct) {
        var parameters = (H264Parameters)Info.FormatParameters!;
        yield return new H264NalUnit { Data = parameters.Sps, Timestamp = 0, MediaTimestamp = 0, IsHeader = true, IsSyncPoint = true, NalType = H264NalType.Sps };
        yield return new H264NalUnit { Data = parameters.Pps, Timestamp = 0, MediaTimestamp = 0, IsHeader = true, IsSyncPoint = true, NalType = H264NalType.Pps };
        ulong timestamp = 0;
        while (!ct.IsCancellationRequested) { yield return new H264NalUnit { Data = new byte[] { 0x65, 1, 2 }, Timestamp = timestamp, MediaTimestamp = timestamp, IsSyncPoint = true, IsHeader = false, NalType = H264NalType.Idr }; timestamp += 3600; await Task.Delay(10, ct); }
      }
      public void Dispose() => Interlocked.Decrement(ref owner.Count);
    }
  }
  private sealed class Environment(string path) : IServerEnvironment { public string DataPath => path; }
  private sealed class Logs : IPluginLoggerFactory { public ILogger CreateLogger(string categoryName) => Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance; }
  private sealed class Config : IConfig {
    public ConcurrentDictionary<string, string> Values { get; } = new();
    public string Get(string key, string fallback) => Values.GetValueOrDefault(key, fallback);
    public void Set(string key, string value) => Values[key] = value;
  }
  private sealed class Registry : ICameraRegistry {
    public CameraInfo[] Cameras = []; public int Calls;
    public Task<OneOf<IReadOnlyList<CameraInfo>, Error>> GetCamerasAsync(CancellationToken ct) { Interlocked.Increment(ref Calls); return Task.FromResult<OneOf<IReadOnlyList<CameraInfo>, Error>>(Cameras); }
    public Task<OneOf<CameraInfo, Error>> GetCameraAsync(Guid id, CancellationToken ct) => Task.FromResult<OneOf<CameraInfo, Error>>(Cameras.Single(c => c.Id == id));
  }
  private sealed class Bus : IEventBus {
    private readonly ConcurrentDictionary<Type, Channel<object>> _channels = new();
    public Task PublishAsync<T>(T item, CancellationToken ct) where T : ISystemEvent { _channels.GetOrAdd(typeof(T), _ => Channel.CreateUnbounded<object>()).Writer.TryWrite(item); return Task.CompletedTask; }
    public async IAsyncEnumerable<T> SubscribeAsync<T>([EnumeratorCancellation] CancellationToken ct) where T : ISystemEvent {
      await foreach (var item in _channels.GetOrAdd(typeof(T), _ => Channel.CreateUnbounded<object>()).Reader.ReadAllAsync(ct)) yield return (T)item;
    }
  }
}
