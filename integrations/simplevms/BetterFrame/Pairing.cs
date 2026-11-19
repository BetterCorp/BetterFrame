using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Net;
using OneOf;
using Shared.Models;

namespace BetterCorp.BetterFrame;

public sealed partial class BetterFramePlugin
{
  private sealed record PairedConnection(string InstanceId, string SourceId, string CallbackUrl, string ManagementUrl,
    string IntegrationToken, string ViewerUsername, string ViewerPassword, string ActivationUrl = "");
  private sealed record PendingPairing(Uri Frame, string State, string Verifier, DateTimeOffset Expires);
  private string _pairedConnectionPath = "";
  private string _stagedConnectionPath = "";
  private PairedConnection? _pairedConnection;
  private PairedConnection? _stagedConnection;
  private readonly System.Threading.Channels.Channel<bool> _pairingRecovery = System.Threading.Channels.Channel.CreateBounded<bool>(1);
  private PendingPairing? _pendingPairing;
  private readonly SemaphoreSlim _pairingGate = new(1);
  private static string NewProof() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
  private static string Challenge(string verifier) => Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
  private static string RtspBindAddress(string host) => host is "*" or "+" ? IPAddress.Any.ToString() : host;
  private static string LocalListenerHost(string host)
  {
    host = host.Trim('[', ']');
    if (host is "*" or "+" || host == IPAddress.Any.ToString()) return IPAddress.Loopback.ToString();
    if (IPAddress.TryParse(host, out var address) && address.Equals(IPAddress.IPv6Any)) return IPAddress.IPv6Loopback.ToString();
    return host;
  }
  internal static Dictionary<string, string> PairingMediaAddresses(string bind, int port, string scheme, Uri http, Uri returnUri)
  {
    bind = RtspBindAddress(bind);
    var local = new UriBuilder(scheme, LocalListenerHost(bind), port).Uri.AbsoluteUri.TrimEnd('/');
    var external = returnUri.IsLoopback || IPAddress.IsLoopback(IPAddress.Parse(bind)) ? "" : new UriBuilder(scheme, returnUri.Host, port).Uri.AbsoluteUri.TrimEnd('/');
    var localHttpUri = new UriBuilder(http) { Host = LocalListenerHost(http.Host) }.Uri;
    // Match BF's explicit HTTP host allowlist, which is narrower than .NET's IsLoopback.
    var localHttp = localHttpUri.Scheme == "http" && localHttpUri.Host.Trim('[', ']') is not ("localhost" or "127.0.0.1" or "::1") ? "" : localHttpUri.GetLeftPart(UriPartial.Authority);
    var externalHttp = http.Scheme != "https" || returnUri.IsLoopback || http.IsLoopback ? "" : new UriBuilder(http) { Host = returnUri.Host }.Uri.GetLeftPart(UriPartial.Authority);
    return new() { ["local_address"] = local, ["external_address"] = external, ["local_http_address"] = localHttp, ["external_http_address"] = externalHttp };
  }
  private string? PairedValue(string key)
  {
    var paired = _pairedConnection;
    if (paired == null) return null;
    return key switch { "callbackUrl" => paired.CallbackUrl, "integrationToken" => paired.IntegrationToken,
      "viewerUsername" => paired.ViewerUsername, "viewerPassword" => paired.ViewerPassword, _ => null };
  }
  public Task<OneOf<IReadOnlyDictionary<string, string>, Error>> BeginPairingAsync(IReadOnlyDictionary<string, string> values, CancellationToken ct)
    => PairAsync(false, values, ct);
  public Task<OneOf<IReadOnlyDictionary<string, string>, Error>> CompletePairingAsync(IReadOnlyDictionary<string, string> values, CancellationToken ct)
    => PairAsync(true, values, ct);
  private async Task<OneOf<IReadOnlyDictionary<string, string>, Error>> PairAsync(bool complete, IReadOnlyDictionary<string, string> values, CancellationToken ct)
  {
    await _pairingGate.WaitAsync(ct);
    try {
      if (_stop == null || _stop.IsCancellationRequested) return Error.Create(0x10bf, 3, Result.BadRequest, "Enable the BetterFrame plugin before pairing.");
      return complete ? await FinishPairingAsync(values, ct) : BeginPairing(values);
    } catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
    catch { return Error.Create(0x10bf, 3, Result.BadRequest, "Pairing could not be completed. Check the BetterFrame URL and start pairing again."); }
    finally { _pairingGate.Release(); }
  }
  private OneOf<IReadOnlyDictionary<string, string>, Error> BeginPairing(IReadOnlyDictionary<string, string> values)
  {
    if (_listeners != ListenerConfiguration()) return Error.Create(0x10bf, 3, Result.BadRequest, "Restart the BetterFrame plugin to apply media listener changes before pairing.");
    var frame = Authority(Config("betterFrameUrl"));
    if (frame.UserInfo != "" || frame.AbsolutePath != "/" || frame.Query != "" || frame.Fragment != "") throw new ArgumentException("Use the BetterFrame server URL");
    var returnUri = new Uri(values["returnUrl"], UriKind.Absolute);
    if (returnUri.Scheme is not ("http" or "https") || returnUri.UserInfo != "" || returnUri.Query != "" || returnUri.Fragment != ""
      || returnUri.AbsolutePath != "/betterframe-pairing-return") throw new ArgumentException("Invalid SimpleVMS return URL");
    // Begin is guarded by the host's configuration-write authorization and serialized with recovery.
    // An administrator starting a new Pair explicitly abandons only the pending handoff.
    if (_stagedConnection != null) { File.Delete(_stagedConnectionPath); _stagedConnection = null; }
    var pending = new PendingPairing(frame, NewProof(), NewProof(), DateTimeOffset.UtcNow.AddMinutes(10));
    var listeners = _listeners!;
    var parameters = PairingMediaAddresses(listeners.Bind, listeners.Port, listeners.Certificate == "" ? "rtsp" : "rtsps", new Uri(listeners.Http), returnUri);
    parameters["instance_id"] = _outbox.InstanceId; parameters["name"] = Config("name", "SimpleVMS");
    parameters["redirect_uri"] = returnUri.AbsoluteUri; parameters["state"] = pending.State; parameters["challenge"] = Challenge(pending.Verifier);
    var redirect = new UriBuilder(new Uri(frame, "/simplevms/pair")) {
      Query = string.Join("&", parameters.Select(item => Uri.EscapeDataString(item.Key) + "=" + Uri.EscapeDataString(item.Value)))
    };
    _pendingPairing = pending;
    return OneOf<IReadOnlyDictionary<string, string>, Error>.FromT0(new Dictionary<string, string> { ["redirectUrl"] = redirect.Uri.AbsoluteUri });
  }
  private async Task<OneOf<IReadOnlyDictionary<string, string>, Error>> FinishPairingAsync(IReadOnlyDictionary<string, string> values, CancellationToken ct)
  {
    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(15));
    var token = deadline.Token;
    var pending = _pendingPairing;
    if (pending == null || pending.Expires < DateTimeOffset.UtcNow || !NativeRtspServer.ConstantEquals(values.GetValueOrDefault("state", ""), pending.State)) throw new ArgumentException("Expired pairing");
    var tenant = values.GetValueOrDefault("tenantSlug", ""); var code = values.GetValueOrDefault("code", "");
    if (!System.Text.RegularExpressions.Regex.IsMatch(tenant, "^[a-z0-9][a-z0-9_-]{0,127}$") || !System.Text.RegularExpressions.Regex.IsMatch(code, "^[A-Za-z0-9_-]{43}$")) throw new ArgumentException("Invalid pairing response");
    using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(pending.Frame, $"/api/simplevms/{Uri.EscapeDataString(tenant)}/pair/claim")) {
      Content = new StringContent(JsonSerializer.Serialize(new { code, verifier = pending.Verifier, instanceId = _outbox.InstanceId }), Encoding.UTF8, "application/json")
    };
    using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token); response.EnsureSuccessStatusCode();
    await using var content = await response.Content.ReadAsStreamAsync(token); using var body = new MemoryStream();
    var buffer = new byte[4096]; int read;
    while ((read = await content.ReadAsync(buffer, token)) != 0) { if (body.Length + read > 16384) throw new ArgumentException("Invalid pairing response"); body.Write(buffer, 0, read); }
    var paired = JsonSerializer.Deserialize<PairedConnection>(body.ToArray(), CatalogBuilder.Json) ?? throw new ArgumentException("Invalid pairing response");
    if (paired.InstanceId != _outbox.InstanceId || !Guid.TryParse(paired.SourceId, out _) || paired.IntegrationToken.Length is < 32 or > 256 || paired.ViewerPassword.Length is < 16 or > 512
      || !System.Text.RegularExpressions.Regex.IsMatch(paired.ViewerUsername, "^[a-zA-Z0-9_.-]{1,128}$")) throw new ArgumentException("Invalid pairing credentials");
    var callback = Authority(paired.CallbackUrl); var management = Authority(paired.ManagementUrl); var activation = Authority(paired.ActivationUrl);
    if (callback.GetLeftPart(UriPartial.Authority) != pending.Frame.GetLeftPart(UriPartial.Authority) || management.GetLeftPart(UriPartial.Authority) != pending.Frame.GetLeftPart(UriPartial.Authority)
      || callback.AbsolutePath != $"/api/simplevms/{Uri.EscapeDataString(tenant)}/{paired.SourceId}/events" || management.AbsolutePath != $"/simplevms/instance/{paired.SourceId}"
      || activation.GetLeftPart(UriPartial.Authority) != pending.Frame.GetLeftPart(UriPartial.Authority) || activation.AbsolutePath != $"/api/simplevms/{Uri.EscapeDataString(tenant)}/pair/activate"
      || activation.Query != "" || activation.Fragment != "" || callback.Query != "" || callback.Fragment != "" || management.Query != "" || management.Fragment != "") throw new ArgumentException("Invalid pairing destination");
    SaveConnection(_stagedConnectionPath, paired);
    _stagedConnection = paired; _pendingPairing = null;
    try { await ActivateSavedConnectionAsync(token); }
    finally { if (_stagedConnection != null) _pairingRecovery.Writer.TryWrite(true); }
    return OneOf<IReadOnlyDictionary<string, string>, Error>.FromT0(new Dictionary<string, string> { ["redirectUrl"] = paired.ManagementUrl });
  }
  private static void SaveConnection(string path, PairedConnection paired)
  {
    var temporary = path + ".tmp";
    var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write, Share = FileShare.None };
    if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
    using (var file = new FileStream(temporary, options)) { JsonSerializer.Serialize(file, paired, CatalogBuilder.Json); file.Flush(true); }
    if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    File.Move(temporary, path, true);
  }
  private async Task ActivateSavedConnectionAsync(CancellationToken ct)
  {
    var paired = _stagedConnection; if (paired == null) return;
    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(15));
    using var request = new HttpRequestMessage(HttpMethod.Post, paired.ActivationUrl) { Content = new StringContent(JsonSerializer.Serialize(new {
      instanceId = paired.InstanceId, sourceId = paired.SourceId, integrationToken = paired.IntegrationToken }), Encoding.UTF8, "application/json") };
    using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token); response.EnsureSuccessStatusCode();
    SaveConnection(_pairedConnectionPath, paired);
    _pairedConnection = paired;
    File.Delete(_stagedConnectionPath); _stagedConnection = null;
    Changed(true);
  }
  private async Task RecoverPairingAsync(CancellationToken ct)
  {
    while (!ct.IsCancellationRequested) {
      await _pairingRecovery.Reader.ReadAsync(ct);
      while (_stagedConnection != null) {
        await _pairingGate.WaitAsync(ct);
        try { await ActivateSavedConnectionAsync(ct); }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (HttpRequestException error) when (error.StatusCode == HttpStatusCode.BadRequest) {
          // BF rejected an expired/superseded stage; keep the previous active connection and allow a new Pair.
          File.Delete(_stagedConnectionPath); _stagedConnection = null;
        }
        catch { /* Retain the private durable stage for retry, including across recorder restarts. */ }
        finally { _pairingGate.Release(); }
        if (_stagedConnection != null) await Task.Delay(TimeSpan.FromSeconds(5), ct);
      }
    }
  }
}
