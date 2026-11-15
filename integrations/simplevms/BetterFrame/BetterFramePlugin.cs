using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using System.Security.Cryptography;
using OneOf;
using Shared.Models;
using Shared.Models.Events;

namespace BetterCorp.BetterFrame;

public sealed class BetterFramePlugin : IPlugin, IPluginSettings, IPluginCameraSettings
{
  private PluginContext _context = null!;
  private CatalogOutbox _outbox = null!;
  private ReaderAccessCache _access = null!;
  private readonly Channel<bool> _changes = Channel.CreateBounded<bool>(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropOldest });
  private CancellationTokenSource? _stop;
  private Task[] _tasks = [];
  private NativeRtspServer? _rtsp;
  private readonly HttpClient _http = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(15) };
  private readonly object _gate = new();
  private bool _force;
  public PluginMetadata Metadata { get; } = new() { Id = "bettercorp-betterframe", Name = "BetterFrame", Version = "1.0.0", Description = "Event-driven NVR and display-group synchronization with native RTSP output" };
  public OneOf<Success, Error> Initialize(PluginContext context)
  {
    if (context.CameraRegistry == null || context.EventBus == null || context.StreamTap == null) throw new InvalidOperationException("BetterFrame requires native camera registry, events and stream taps");
    _context = context;
    var directory = Path.Combine(context.Environment.DataPath, "betterframe");
    _outbox = new CatalogOutbox(directory); _access = new ReaderAccessCache(directory); return new Success();
  }
  private string Config(string key, string fallback = "") => _context.Config.Get(key, fallback);
  private DisplayGroup[] Groups() => CatalogBuilder.ParseGroups(Config("groups", "[]"));
  private void Changed(bool force = false, bool revoke = true)
  {
    lock (_gate) _force |= force;
    if (revoke) _rtsp?.Invalidate();
    _changes.Writer.TryWrite(true);
  }
  public async Task<OneOf<Success, Error>> StartAsync(CancellationToken ct)
  {
    _stop = CancellationTokenSource.CreateLinkedTokenSource(ct); var token = _stop.Token;
    _rtsp = new NativeRtspServer(_context.StreamTap!, CanViewAsync, () => (Config("viewerUsername", "betterframe"), Config("viewerPassword")), ValidateViewerAsync, ViewerCameraMatches);
    var http = new NativeHttpServer(_context, CanViewAsync, ValidateViewerAsync, ViewerCameraMatches);
    var rtspRun = _rtsp.RunAsync(Config("listenAddress", "127.0.0.1"), int.Parse(Config("rtspPort", "8554")), Config("tlsCertificate"), Config("tlsKey"), token);
    var httpRun = http.RunAsync(Config("httpListenUrl", "http://127.0.0.1:8555"), token);
    _tasks = [Watch<CameraAdded>(token), Watch<CameraUpdated>(token), Watch<CameraRemoved>(token), Watch<CameraConfigChanged>(token),
      Watch<StreamStarted>(token, false), Watch<CameraRecordingChanged>(token),
      SynchronizeAsync(token), rtspRun, httpRun];
    try {
      var ready = Task.WhenAll(_rtsp.ListeningPort, http.Ready);
      var first = await Task.WhenAny(ready, rtspRun, httpRun).WaitAsync(token);
      await first;
      if (first != ready) throw new InvalidOperationException("Native media stopped during startup");
      Changed(true); return new Success();
    } catch {
      _stop.Cancel(); try { await Task.WhenAll(_tasks); } catch { }
      return Error.Create(0x10bf, 1, Result.BadRequest, "BetterFrame media listeners could not start; check bind addresses, ports and certificates");
    }
  }
  private async Task Watch<T>(CancellationToken ct, bool revoke = true) where T : ISystemEvent
  { await foreach (var unused in _context.EventBus!.SubscribeAsync<T>(ct)) Changed(revoke: revoke); }
  private async Task SynchronizeAsync(CancellationToken ct)
  {
    // Retry delivery from disk; do not periodically query the camera catalog.
    var retry = false;
    while (!ct.IsCancellationRequested) {
      if (!retry) {
        await _changes.Reader.ReadAsync(ct); await Task.Delay(100, ct);
        while (_changes.Reader.TryRead(out _)) { }
        try {
          if (_context.RecordingControl is { IsReady: false }) throw new InvalidOperationException("Native recorder is starting");
          var cameras = await _context.CameraRegistry!.GetCamerasAsync(ct);
          if (cameras.IsT1) throw new InvalidOperationException("Native camera registry unavailable");
          var allowed = await FilterPolicyAsync(cameras.AsT0, ct);
          bool force; lock (_gate) { force = _force; _force = false; }
          _outbox.Enqueue(CatalogBuilder.Build(_outbox.InstanceId, 0, Config("name", "SimpleVMS"), allowed, Groups()), force);
        } catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch { await Task.Delay(TimeSpan.FromSeconds(5), ct); _changes.Writer.TryWrite(true); continue; }
      }
      retry = false; var pending = _outbox.Pending;
      if (pending == null || string.IsNullOrWhiteSpace(Config("callbackUrl"))) continue;
      try {
        var destination = new Uri(Config("callbackUrl"));
        if (destination.Scheme != "https" && !(destination.Scheme == "http" && destination.IsLoopback)) throw new InvalidOperationException("Use an HTTPS callback");
        var secret = Config("integrationToken"); if (secret.Length < 32) throw new InvalidOperationException("Configure an integration token");
        using var request = new HttpRequestMessage(HttpMethod.Post, destination);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        request.Content = new StringContent(JsonSerializer.Serialize(pending, CatalogBuilder.Json), Encoding.UTF8, "application/json");
        using var response = await _http.SendAsync(request, ct); response.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        var acknowledged = body.RootElement.GetProperty("revision").GetInt64();
        if (acknowledged < pending.Revision) throw new InvalidOperationException("Snapshot not acknowledged");
        _outbox.Acknowledge(acknowledged);
        if (body.RootElement.TryGetProperty("grants", out var grants)) {
          _access.Replace(destination.AbsoluteUri, grants.EnumerateArray().SelectMany(g => g.GetProperty("cameraIds").EnumerateArray()
            .Select(camera => g.GetProperty("kioskId").GetString() + "/" + camera.GetString())).ToArray());
        }
        if (acknowledged > pending.Revision) Changed(true, false); // Recorder state restored from an older backup.
      } catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
      catch { await Task.Delay(TimeSpan.FromSeconds(5), ct); retry = !_changes.Reader.TryPeek(out _); }
    }
  }
  private async Task<IReadOnlyList<CameraInfo>> FilterPolicyAsync(IReadOnlyList<CameraInfo> cameras, CancellationToken ct)
  {
    // An optional ControlRoom authority excludes incident-only cameras from ordinary viewer exports.
    if (string.IsNullOrEmpty(Config("controlRoomUrl"))) {
      if (File.Exists(Path.Combine(_context.Environment.DataPath, "controlroom", "policy.sqlite")))
        throw new InvalidOperationException("Configure the ControlRoom policy authority before exporting this recorder");
      return cameras;
    }
    var root = Config("controlRoomUrl").TrimEnd('/');
    async Task<JsonDocument> Read(string path) {
      using var request = new HttpRequestMessage(HttpMethod.Get, root + path);
      request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Config("controlRoomKey"));
      using var response = await _http.SendAsync(request, ct); response.EnsureSuccessStatusCode();
      return JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
    }
    using var groups = await Read("/groups"); using var bindings = await Read("/cameras");
    var allowedGroups = groups.RootElement.EnumerateArray().Where(g => g.GetProperty("purpose").GetString() != "alarm_review").Select(g => g.GetProperty("id").GetGuid()).ToHashSet();
    var allowed = bindings.RootElement.EnumerateArray().Where(c => c.GetProperty("enabled").GetBoolean() && allowedGroups.Contains(c.GetProperty("groupId").GetGuid())).Select(c => c.GetProperty("cameraId").GetGuid()).ToHashSet();
    return cameras.Where(c => allowed.Contains(c.Id)).ToArray();
  }
  private async Task<bool> CanViewAsync(Guid cameraId, string profile, CancellationToken ct)
  {
    var camera = await _context.CameraRegistry!.GetCameraAsync(cameraId, ct);
    if (camera.IsT1 || !camera.AsT0.Streams.Any(s => s.Profile == profile && s.IsRootStream)) return false;
    return (await FilterPolicyAsync([camera.AsT0], ct)).Count == 1;
  }
  private async Task<bool> ValidateViewerAsync(string authorization, CancellationToken ct)
  {
    try {
      if (!authorization.StartsWith("Basic ", StringComparison.OrdinalIgnoreCase) || authorization.Length > 2048) return false;
      var decoded = Encoding.UTF8.GetString(Convert.FromBase64String(authorization[6..]));
      var split = decoded.IndexOf(':'); if (split < 0) return false;
      var username = decoded[..split]; var password = decoded[(split + 1)..];
      var prefix = Config("viewerUsername", "betterframe") + "/";
      if (!username.StartsWith(prefix, StringComparison.Ordinal) || Config("viewerPassword").Length < 16) return false;
      var scope = username[prefix.Length..]; var parts = scope.Split('/');
      if (parts.Length != 2 || !Guid.TryParse(parts[0], out _) || !Guid.TryParse(parts[1], out _)) return false;
      var kioskId = parts[0]; var cameraId = parts[1];
      var digest = HMACSHA256.HashData(Encoding.UTF8.GetBytes(Config("viewerPassword")), Encoding.UTF8.GetBytes(scope));
      var expected = Convert.ToBase64String(digest).TrimEnd('=').Replace('+', '-').Replace('/', '_');
      if (!NativeRtspServer.ConstantEquals(password, expected)) return false;
      var destination = new Uri(Config("callbackUrl"));
      if (!destination.AbsolutePath.EndsWith("/events", StringComparison.Ordinal)) return false;
      if (destination.Scheme != "https" && !(destination.Scheme == "http" && destination.IsLoopback)) return false;
      var address = new UriBuilder(destination) { Path = destination.AbsolutePath[..^6] + "access", Query = "kioskId=" + Uri.EscapeDataString(kioskId) + "&cameraId=" + Uri.EscapeDataString(cameraId) };
      using var request = new HttpRequestMessage(HttpMethod.Get, address.Uri);
      request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Config("integrationToken"));
      try {
        using var response = await _http.SendAsync(request, ct);
        if ((int)response.StatusCode is 401 or 403 or 404) { _access.Record(destination.AbsoluteUri, scope, false); return false; }
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        var allowed = json.RootElement.GetProperty("allowed").GetBoolean();
        _access.Record(destination.AbsoluteUri, scope, allowed); return allowed;
      } catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
      catch (Exception error) when (error is HttpRequestException or TaskCanceledException) {
        // A valid signed credential can reuse a durable grant during an authority outage.
        return _access.Allows(destination.AbsoluteUri, scope);
      }
    } catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
    catch { return false; }
  }
  private static bool ViewerCameraMatches(string authorization, Guid cameraId)
  {
    try {
      var decoded = Encoding.UTF8.GetString(Convert.FromBase64String(authorization[6..]));
      var user = decoded.Split(':', 2)[0];
      return Guid.TryParse(user.Split('/').Last(), out var scoped) && scoped == cameraId;
    } catch { return false; }
  }
  public async Task<OneOf<Success, Error>> StopAsync(CancellationToken ct)
  {
    _stop?.Cancel(); try { await Task.WhenAll(_tasks).WaitAsync(ct); } catch (OperationCanceledException) { }
    _stop?.Dispose(); _stop = null; return new Success();
  }
  private static readonly (string Key, string Label, string Type, string Default)[] Fields = [
    ("name", "NVR name", "string", "SimpleVMS"), ("callbackUrl", "BetterFrame callback URL", "string", ""),
    ("integrationToken", "Integration token", "password", ""), ("viewerUsername", "Viewer username", "string", "betterframe"),
    ("viewerPassword", "Viewer password", "password", ""),
    ("listenAddress", "RTSP bind address (restart required)", "string", "127.0.0.1"), ("rtspPort", "RTSP port (restart required)", "int", "8554"),
    ("tlsCertificate", "TLS certificate PEM (restart required)", "string", ""), ("tlsKey", "TLS key PEM (restart required)", "string", ""),
    ("httpListenUrl", "Browser media listener (restart required)", "string", "http://127.0.0.1:8555"),
    ("controlRoomUrl", "ControlRoom policy URL", "string", ""), ("controlRoomKey", "ControlRoom service key", "password", "")
  ];
  public IReadOnlyList<SettingGroup> GetSchema() => [new() { Key = "betterframe", Order = 0, Label = "BetterFrame",
    Description = $"Instance ID: {_outbox.InstanceId}. Configure the same viewer credentials and integration token in BetterFrame.",
    Fields = Fields.Select((f, i) => new SettingField { Key = f.Key, Label = f.Label, Type = f.Type, Order = i, DefaultValue = f.Default }).ToArray() },
    new() { Key = "displayGroups", Order = 1, Label = "Display groups", Description = "Groups create read-only layouts in BetterFrame. Assign cameras through each camera's BetterFrame settings. Recording policies are independent.",
      Fields = new[] { new SettingField { Key = "newGroupName", Label = "New group name", Type = "string", Order = 0 } }
        .Concat(Groups().SelectMany((g, i) => new[] {
          new SettingField { Key = "groupName_" + g.Id, Label = g.Name, Type = "string", Order = i * 2 + 1 },
          new SettingField { Key = "deleteGroup_" + g.Id, Label = "Delete " + g.Name, Type = "bool", Order = i * 2 + 2, DefaultValue = "false" }
        })).ToArray() }];
  public IReadOnlyDictionary<string, string> GetValues()
  {
    var values = Fields.ToDictionary(f => f.Key, f => Config(f.Key, f.Default)); values["newGroupName"] = "";
    foreach (var group in Groups()) { values["groupName_" + group.Id] = group.Name; values["deleteGroup_" + group.Id] = "false"; }
    return values;
  }
  public OneOf<Success, Error> ValidateValue(string key, string value)
  {
    if (key == "newGroupName" || key.StartsWith("groupName_")) {
      if (value.Length > 255 || (key != "newGroupName" && string.IsNullOrWhiteSpace(value))) throw new ArgumentException("Use a group name of 1–255 characters");
      return new Success();
    }
    if (key.StartsWith("deleteGroup_")) { if (value is not ("true" or "false")) throw new ArgumentException("Invalid deletion flag"); return new Success(); }
    if (!Fields.Any(f => f.Key == key)) throw new ArgumentException("Unknown setting");
    if (key == "rtspPort" && (!int.TryParse(value, out var port) || port is < 1 or > 65535)) throw new ArgumentException("Invalid RTSP port");
    if (key == "callbackUrl" && value != "") { var u = new Uri(value); if (u.Scheme != "https" && !(u.Scheme == "http" && u.IsLoopback)) throw new ArgumentException("Use an HTTPS callback URL"); }
    return new Success();
  }
  public OneOf<Success, Error> ApplyValues(IReadOnlyDictionary<string, string> values)
  {
    foreach (var item in values) ValidateValue(item.Key, item.Value);
    lock (_gate) {
      var groups = Groups().Where(g => values.GetValueOrDefault("deleteGroup_" + g.Id) != "true")
        .Select(g => g with { Name = values.GetValueOrDefault("groupName_" + g.Id, g.Name).Trim() }).ToList();
      if (!string.IsNullOrWhiteSpace(values.GetValueOrDefault("newGroupName"))) groups.Add(new(Guid.NewGuid(), values["newGroupName"].Trim(), []));
      SaveGroups(groups.ToArray());
      foreach (var item in values.Where(v => Fields.Any(f => f.Key == v.Key))) _context.Config.Set(item.Key, item.Value);
    }
    Changed(true); return new Success();
  }
  private void SaveGroups(DisplayGroup[] groups)
  {
    var encoded = JsonSerializer.Serialize(groups, CatalogBuilder.Json); CatalogBuilder.ParseGroups(encoded); _context.Config.Set("groups", encoded);
  }
  public IReadOnlyList<SettingGroup> GetSchema(Guid cameraId) => [new() { Key = "betterframe-groups", Label = "BetterFrame display groups", Order = 0,
    Description = "Choose which generated camera walls include this camera.", Fields = Groups().Select((g, i) => new SettingField {
      Key = "member_" + g.Id, Label = g.Name, Type = "bool", Order = i, DefaultValue = "false"
    }).ToArray() }];
  public IReadOnlyDictionary<string, string> GetValues(Guid cameraId) => Groups().ToDictionary(g => "member_" + g.Id, g => g.CameraIds.Contains(cameraId) ? "true" : "false");
  public OneOf<Success, Error> ValidateValue(Guid cameraId, string key, string value)
  {
    if (!Groups().Any(g => key == "member_" + g.Id) || value is not ("true" or "false")) throw new ArgumentException("Unknown display group");
    return new Success();
  }
  public OneOf<Success, Error> ApplyValues(Guid cameraId, IReadOnlyDictionary<string, string> values)
  {
    lock (_gate) {
      foreach (var item in values) ValidateValue(cameraId, item.Key, item.Value);
      SaveGroups(Groups().Select(g => values.TryGetValue("member_" + g.Id, out var included)
        ? g with { CameraIds = included == "true" ? g.CameraIds.Append(cameraId).Distinct().ToArray() : g.CameraIds.Where(id => id != cameraId).ToArray() } : g).ToArray());
    }
    Changed(); return new Success();
  }
  public Task<OneOf<Success, Error>> OnRemovedAsync(Guid cameraId, CancellationToken ct)
  {
    lock (_gate) SaveGroups(Groups().Select(g => g with { CameraIds = g.CameraIds.Where(id => id != cameraId).ToArray() }).ToArray());
    Changed(); return Task.FromResult<OneOf<Success, Error>>(new Success());
  }
}
