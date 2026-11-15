using System.Text.Json;
using Shared.Models;

namespace BetterCorp.BetterFrame;

public sealed record DisplayGroup(Guid Id, string Name, Guid[] CameraIds);
public sealed record Profile(string Id, string Name, string Role, string Codec, int Width, int Height, decimal Fps);
public sealed record Camera(string Id, string Name, bool Enabled, Profile[] Profiles);
public sealed record Group(string Id, string Name, string[] CameraIds);
public sealed record Catalog(int Version, string InstanceId, long Revision, string Name, Camera[] Cameras, Group[] Groups);

public static class CatalogBuilder
{
  public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
  public const int MaxCameras = 4096;
  // Leave space for the outbox's durable revision, which is assigned after building.
  public const int MaxCatalogBytes = 4 * 1024 * 1024 - 256;
  public static DisplayGroup[] ParseGroups(string input)
  {
    var groups = JsonSerializer.Deserialize<DisplayGroup[]>(input, Json) ?? throw new ArgumentException("Groups must be an array");
    if (groups.Length > 1024 || groups.Select(g => g.Id).Distinct().Count() != groups.Length) throw new ArgumentException("Duplicate or excessive groups");
    foreach (var g in groups)
      if (g.Id == Guid.Empty || string.IsNullOrWhiteSpace(g.Name) || g.Name.Length > 255 || g.CameraIds == null
        || g.CameraIds.Length > 32 || g.CameraIds.Distinct().Count() != g.CameraIds.Length)
        throw new ArgumentException("Groups require a stable ID, name and up to 32 distinct cameras");
    return groups;
  }
  public static Catalog Build(string instance, long revision, string name, IReadOnlyList<CameraInfo> cameras, DisplayGroup[] groups)
  {
    // Groups generate layouts; ungrouped cameras remain available for custom layouts.
    // Never export upstream credentials or addresses.
    var result = cameras.OrderBy(c => c.Id).Select(camera => new Camera(camera.Id.ToString(), Label(camera.Name, camera.Id.ToString()), true, SupportedProfiles(camera)))
      .Where(camera => camera.Profiles.Length > 0).Take(MaxCameras).ToArray();
    Catalog Prefix(int count) {
      var selected = result.Take(count).ToArray();
      var present = selected.Select(c => c.Id).ToHashSet();
      return new(1, instance, revision, Label(name, "SimpleVMS"), selected, groups.OrderBy(g => g.Id).Select(g => new Group(g.Id.ToString(), Label(g.Name, g.Id.ToString()),
        g.CameraIds.Select(id => id.ToString()).Where(present.Contains).ToArray())).ToArray());
    }
    var catalog = Prefix(result.Length);
    if (JsonSerializer.SerializeToUtf8Bytes(catalog, Json).Length <= MaxCatalogBytes) return catalog;
    // Membership only grows with this stable prefix, so serialized size is monotonic.
    var low = 0; var high = result.Length;
    while (low < high) {
      var count = low + (high - low + 1) / 2;
      if (JsonSerializer.SerializeToUtf8Bytes(Prefix(count), Json).Length <= MaxCatalogBytes) low = count;
      else high = count - 1;
    }
    catalog = Prefix(low);
    if (JsonSerializer.SerializeToUtf8Bytes(catalog, Json).Length > MaxCatalogBytes) throw new ArgumentException("Display-group metadata exceeds the catalog size limit");
    return catalog;
  }
  public static Profile[] SupportedProfiles(CameraInfo camera)
  {
    var streams = camera.Streams.Where(s => s.IsRootStream && s.Profile is { Length: > 0 and <= 128 } && s.Codec?.ToLowerInvariant() is "h264" or "h265" or "hevc")
      .OrderByDescending(s => Pixels(s.Resolution)).ThenBy(s => s.Profile, StringComparer.Ordinal).DistinctBy(s => s.Profile, StringComparer.Ordinal).Take(32).ToArray();
    return streams.Select((s, index) => {
      var dimensions = (s.Resolution ?? "").Split('x', '×');
      int.TryParse(dimensions.ElementAtOrDefault(0), out var width);
      int.TryParse(dimensions.ElementAtOrDefault(1), out var height);
      return new Profile(s.Profile, s.Profile, index == 0 ? "main" : index == streams.Length - 1 ? "sub" : "other", s.Codec!, Math.Clamp(width, 0, 32768), Math.Clamp(height, 0, 32768), Math.Clamp(s.Fps ?? 0, 0, 1000));
    }).ToArray();
  }
  private static string Label(string value, string fallback) => string.IsNullOrWhiteSpace(value) ? fallback : value[..Math.Min(255, value.Length)];
  private static long Pixels(string? value)
  {
    var dimensions = (value ?? "").Split('x', '×');
    return long.TryParse(dimensions.ElementAtOrDefault(0), out var w) && long.TryParse(dimensions.ElementAtOrDefault(1), out var h) ? w * h : 0;
  }
}

/// <summary>Full snapshots let the newest durable revision safely supersede unsent older revisions.</summary>
public sealed class CatalogOutbox
{
  private readonly string _path;
  public string InstanceId { get; }
  public Catalog? Pending { get; private set; }
  public long Revision { get; private set; }
  private string? _lastContent;
  private sealed record State(string InstanceId, long Revision, string? LastContent, Catalog? Pending);
  public CatalogOutbox(string directory)
  {
    Directory.CreateDirectory(directory); _path = Path.Combine(directory, "outbox.json");
    var state = File.Exists(_path) ? JsonSerializer.Deserialize<State>(File.ReadAllText(_path), CatalogBuilder.Json) : null;
    InstanceId = state?.InstanceId ?? Guid.NewGuid().ToString(); Revision = state?.Revision ?? 0;
    Pending = state?.Pending; _lastContent = state?.LastContent; Save();
  }
  public bool Enqueue(Catalog catalog, bool force = false)
  {
    var content = JsonSerializer.Serialize(catalog with { Revision = 0 }, CatalogBuilder.Json);
    if (!force && content == _lastContent) return false;
    var previous = (Revision, Pending, _lastContent);
    Revision = checked(Revision + 1); Pending = catalog with { InstanceId = InstanceId, Revision = Revision };
    _lastContent = content;
    try { Save(); } catch { (Revision, Pending, _lastContent) = previous; throw; }
    return true;
  }
  public void Acknowledge(long revision)
  {
    var previous = (Revision, Pending);
    Revision = Math.Max(Revision, revision);
    if (Pending?.Revision <= revision) Pending = null;
    try { Save(); } catch { (Revision, Pending) = previous; throw; }
  }
  private void Save()
  {
    var temporary = _path + ".tmp";
    using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None)) {
      JsonSerializer.Serialize(stream, new State(InstanceId, Revision, _lastContent, Pending), CatalogBuilder.Json); stream.Flush(true);
    }
    if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    File.Move(temporary, _path, true);
  }
}
