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
    string IntegrationToken, string ViewerUsername, string ViewerPassword);
  private sealed record PendingPairing(Uri Frame, string State, string Verifier, DateTimeOffset Expires);
  private string _pairedConnectionPath = "";
  private PairedConnection? _pairedConnection;
  private PendingPairing? _pendingPairing;
  private readonly SemaphoreSlim _pairingGate = new(1);
  private static string NewProof() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
  private static string Challenge(string verifier) => Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
  private static string LocalListenerHost(string host)
  {
    host = host.Trim('[', ']');
    if (host is "*" or "+" || host == IPAddress.Any.ToString()) return IPAddress.Loopback.ToString();
    if (host == IPAddress.IPv6Any.ToString()) return IPAddress.IPv6Loopback.ToString();
    return host;
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
    var frame = Authority(Config("betterFrameUrl"));
    if (frame.UserInfo != "" || frame.AbsolutePath != "/" || frame.Query != "" || frame.Fragment != "") throw new ArgumentException("Use the BetterFrame server URL");
    var returnUri = new Uri(values["returnUrl"], UriKind.Absolute);
    if (returnUri.Scheme is not ("http" or "https") || returnUri.UserInfo != "" || returnUri.Query != "" || returnUri.Fragment != ""
      || returnUri.AbsolutePath != "/betterframe-pairing-return") throw new ArgumentException("Invalid SimpleVMS return URL");
    var pending = new PendingPairing(frame, NewProof(), NewProof(), DateTimeOffset.UtcNow.AddMinutes(10));
    var port = int.Parse(Config("rtspPort", "8554")); var scheme = Config("tlsCertificate") == "" ? "rtsp" : "rtsps";
    var local = new UriBuilder(scheme, LocalListenerHost(Config("listenAddress", "127.0.0.1")), port).Uri.AbsoluteUri.TrimEnd('/');
    var external = returnUri.IsLoopback || Config("listenAddress", "127.0.0.1") is "127.0.0.1" or "::1" ? "" : new UriBuilder(scheme, returnUri.Host, port).Uri.AbsoluteUri.TrimEnd('/');
    var http = new Uri(Config("httpListenUrl", "http://127.0.0.1:8555"));
    var localHttpUri = new UriBuilder(http) { Host = LocalListenerHost(http.Host) }.Uri;
    // BF permits cleartext browser media only on loopback; camera pairing can still work without preview.
    var localHttp = localHttpUri.Scheme == "http" && !localHttpUri.IsLoopback ? "" : localHttpUri.GetLeftPart(UriPartial.Authority);
    var externalHttp = http.Scheme != "https" || returnUri.IsLoopback || http.IsLoopback ? "" : new UriBuilder(http) { Host = returnUri.Host }.Uri.GetLeftPart(UriPartial.Authority);
    var parameters = new Dictionary<string, string> { ["instance_id"] = _outbox.InstanceId, ["name"] = Config("name", "SimpleVMS"),
      ["redirect_uri"] = returnUri.AbsoluteUri, ["state"] = pending.State, ["challenge"] = Challenge(pending.Verifier),
      ["local_address"] = local, ["external_address"] = external, ["local_http_address"] = localHttp, ["external_http_address"] = externalHttp };
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
    var callback = Authority(paired.CallbackUrl); var management = Authority(paired.ManagementUrl);
    if (callback.GetLeftPart(UriPartial.Authority) != pending.Frame.GetLeftPart(UriPartial.Authority) || management.GetLeftPart(UriPartial.Authority) != pending.Frame.GetLeftPart(UriPartial.Authority)
      || callback.AbsolutePath != $"/api/simplevms/{Uri.EscapeDataString(tenant)}/{paired.SourceId}/events" || management.AbsolutePath != $"/simplevms/instance/{paired.SourceId}"
      || callback.Query != "" || callback.Fragment != "" || management.Query != "" || management.Fragment != "") throw new ArgumentException("Invalid pairing destination");
    var temporary = _pairedConnectionPath + ".tmp";
    var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write, Share = FileShare.None };
    if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
    using (var file = new FileStream(temporary, options)) { JsonSerializer.Serialize(file, paired, CatalogBuilder.Json); file.Flush(true); }
    if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    File.Move(temporary, _pairedConnectionPath, true);
    _pairedConnection = paired; _pendingPairing = null; Changed(true);
    return OneOf<IReadOnlyDictionary<string, string>, Error>.FromT0(new Dictionary<string, string> { ["redirectUrl"] = paired.ManagementUrl });
  }
}
