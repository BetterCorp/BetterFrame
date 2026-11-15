using System.Text.Json;

namespace BetterCorp.BetterFrame;

/// <summary>Last-known authority survives BF outages and recorder restarts. Unknown readers remain denied.</summary>
public sealed class ReaderAccessCache
{
  private readonly string _path;
  private readonly object _gate = new();
  private readonly Dictionary<string, bool> _scopes;
  private long _generation;
  private bool _dirty;
  public long Generation { get { lock (_gate) return _generation; } }
  public ReaderAccessCache(string directory)
  {
    Directory.CreateDirectory(directory); _path = Path.Combine(directory, "access.json");
    _scopes = File.Exists(_path) ? JsonSerializer.Deserialize<Dictionary<string, bool>>(File.ReadAllText(_path)) ?? [] : [];
  }
  private static string Key(string authority, string scope) => authority + "\n" + scope;
  public bool Allows(string authority, string scope) { lock (_gate) return _scopes.GetValueOrDefault(Key(authority, scope)); }
  public bool Record(string authority, string scope, bool allowed, long? generation = null)
  {
    lock (_gate) {
      var key = Key(authority, scope);
      if (generation.HasValue && generation.Value != _generation) return _scopes.GetValueOrDefault(key);
      _generation++;
      if (!_scopes.TryGetValue(key, out var previous) || previous != allowed) { _scopes[key] = allowed; _dirty = true; }
      if (_dirty) Save();
      return allowed;
    }
  }
  public void Replace(string authority, IEnumerable<string> scopes)
  {
    lock (_gate) {
      _generation++; _dirty = true;
      // Explicit revocations require a fresh successful reader check to restore access.
      var denied = _scopes.Where(item => !item.Value && item.Key.StartsWith(authority + "\n", StringComparison.Ordinal)).Select(item => item.Key).ToHashSet();
      foreach (var key in _scopes.Keys.Where(key => key.StartsWith(authority + "\n", StringComparison.Ordinal)).ToArray()) _scopes.Remove(key);
      foreach (var scope in scopes) _scopes[Key(authority, scope)] = true;
      foreach (var key in denied) _scopes[key] = false;
      Save();
    }
  }
  private void Save()
  {
    var temporary = _path + ".tmp";
    using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None)) {
      JsonSerializer.Serialize(stream, _scopes); stream.Flush(true);
    }
    if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    File.Move(temporary, _path, true);
    _dirty = false;
  }
}
