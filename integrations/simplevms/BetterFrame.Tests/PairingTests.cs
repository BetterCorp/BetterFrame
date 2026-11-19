using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using BetterCorp.BetterFrame;
using NUnit.Framework;
using Shared.Models;

namespace BetterFrame.Tests;

public sealed partial class IntegrationTests
{
  [TestCase(false)]
  [TestCase(true)]
  public async Task PairingPromotionCannotSendAnotherServersTokenToAnEarlierCallback(bool reader)
  {
    using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    static int Port() { var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port; }
    var root = $"http://127.0.0.1:{Port()}"; var media = $"http://127.0.0.1:{Port()}";
    var token = new string('a', 43); var password = new string('p', 43); var camera = Guid.NewGuid(); var kiosk = Guid.NewGuid();
    var config = new Config(); config.Set("callbackUrl", root + "/events"); config.Set("integrationToken", token);
    config.Set("viewerUsername", "reader-a"); config.Set("viewerPassword", password); config.Set("rtspPort", Port().ToString()); config.Set("httpListenUrl", media);
    var plugin = new BetterFramePlugin(); plugin.Initialize(new PluginContext { Config = config, Environment = new Environment(directory), LoggerFactory = new Logs(), CameraRegistry = new Registry { Cameras = [Camera(camera, "A")] }, EventBus = new Bus(), StreamTap = new Tap() });
    // Pause the legacy callback read by publishing a new immutable paired connection.
    // This reproduces promotion between reading an old URL and reading its bearer token.
    var field = typeof(BetterFramePlugin).GetField("_pairedConnection", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;
    var replacement = JsonSerializer.Deserialize(JsonSerializer.Serialize(new { instanceId = "b", sourceId = "b", callbackUrl = "http://127.0.0.1:1/events", managementUrl = "http://127.0.0.1:1", integrationToken = new string('b', 43), viewerUsername = "reader-b", viewerPassword = new string('q', 43) }), field.FieldType, CatalogBuilder.Json);
    var promoted = 0;
    void Promote(string key) { if (key == "callbackUrl" && Interlocked.Exchange(ref promoted, 1) == 0) field.SetValue(plugin, replacement); }
    using var receiver = new HttpListener(); receiver.Prefixes.Add(root + "/"); receiver.Start();
    if (!reader) config.OnGet = Promote;
    try {
      Assert.That((await plugin.StartAsync(stop.Token)).IsT0, Is.True);
      var catalogRequest = await receiver.GetContextAsync().WaitAsync(stop.Token);
      Assert.That(catalogRequest.Request.Headers["Authorization"], Is.EqualTo("Bearer " + token));
      using var catalog = await JsonDocument.ParseAsync(catalogRequest.Request.InputStream, cancellationToken: stop.Token);
      await catalogRequest.Response.OutputStream.WriteAsync(JsonSerializer.SerializeToUtf8Bytes(new { revision = catalog.RootElement.GetProperty("revision").GetInt64() }), stop.Token); catalogRequest.Response.Close();
      if (reader) {
        config.OnGet = Promote;
        var scope = kiosk + "/" + camera;
        var secret = Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes(password), Encoding.UTF8.GetBytes(scope))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        using var client = new HttpClient(); client.DefaultRequestHeaders.TryAddWithoutValidation("Authorization", "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes("reader-a/" + scope + ":" + secret)));
        var playback = client.GetAsync(media + "/bf/" + camera + "/High/live", stop.Token);
        var access = await receiver.GetContextAsync().WaitAsync(stop.Token);
        Assert.That(access.Request.Url!.AbsolutePath, Is.EqualTo("/access"));
        Assert.That(access.Request.Headers["Authorization"], Is.EqualTo("Bearer " + token), "A new server's token must never be sent to the old server");
        await access.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes("{\"allowed\":false}"), stop.Token); access.Response.Close();
        using var response = await playback; Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.Unauthorized));
      }
      Assert.That(promoted, Is.EqualTo(1));
    } finally { await plugin.StopAsync(CancellationToken.None); receiver.Stop(); Directory.Delete(directory, true); }
  }
  [Test] public void PrivateProxyAdministrationRequiresItsProtectedSecretAndExactHttpsOrigin()
  {
    var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    var plugin = new BetterFramePlugin(); plugin.Initialize(new PluginContext { Config = new Config(), Environment = new Environment(directory), LoggerFactory = new Logs(), CameraRegistry = new Registry(), EventBus = new Bus(), StreamTap = new Tap() });
    var token = new string('x', 43); var origin = "https://recorder.test:8080";
    var path = Path.Combine(directory, "betterframe", "proxy-admin.json");
    try {
      Assert.That(plugin.IsTrustedPairingAdministration(origin, token), Is.False);
      File.WriteAllText(path, JsonSerializer.Serialize(new { origin, token }));
      Assert.That(plugin.IsTrustedPairingAdministration(origin, token), Is.True);
      foreach (var wrong in new[] { "https://evil.test:8080", "http://recorder.test:8080", "https://recorder.test", origin + "/other", "null" })
        Assert.That(plugin.IsTrustedPairingAdministration(wrong, token), Is.False);
      Assert.That(plugin.IsTrustedPairingAdministration(origin, new string('y', 43)), Is.False);
      Assert.That(plugin.IsTrustedPairingAdministration(origin, ""), Is.False);
      Assert.That(plugin.GetValues().Values, Does.Not.Contain(token));
      File.WriteAllText(path, "{}"); Assert.That(plugin.IsTrustedPairingAdministration(origin, token), Is.False);
    } finally { Directory.Delete(directory, true); }
  }
  [Test] public void PairingDirectorySynchronizationWorksAndFailsClosedForMissingDirectories()
  {
    if (OperatingSystem.IsWindows()) Assert.Ignore("Unix directory synchronization");
    var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString()); Directory.CreateDirectory(directory);
    try { Assert.DoesNotThrow(() => BetterFramePlugin.SyncConnectionDirectory(directory));
      Assert.Throws<IOException>(() => BetterFramePlugin.SyncConnectionDirectory(Path.Combine(directory, "missing"))); }
    finally { Directory.Delete(directory, true); }
  }
  [TestCase(false)]
  [TestCase(true)]
  public async Task AdministratorCanRestartPairingWithoutLosingAnUncertainCommittedConnection(bool committed)
  {
    using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(20));
    var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    var privateDirectory = Path.Combine(directory, "betterframe"); Directory.CreateDirectory(privateDirectory);
    var outbox = new CatalogOutbox(privateDirectory);
    static int Port() { var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port; }
    var root = $"http://127.0.0.1:{Port()}"; var source = Guid.NewGuid().ToString();
    var activePath = Path.Combine(privateDirectory, "connection.json"); var stagedPath = Path.Combine(privateDirectory, "pending-connection.json");
    var active = JsonSerializer.Serialize(new { instanceId = outbox.InstanceId, sourceId = source, callbackUrl = "", managementUrl = "https://frame.test/simplevms/instance/" + source,
      integrationToken = new string('a', 43), viewerUsername = "bf-active", viewerPassword = new string('p', 43) }, CatalogBuilder.Json);
    File.WriteAllText(activePath, active);
    File.WriteAllText(stagedPath, JsonSerializer.Serialize(new { instanceId = outbox.InstanceId, sourceId = source, callbackUrl = root + "/events", managementUrl = root,
      activationUrl = root + "/api/simplevms/inactive/pair/activate", integrationToken = new string('s', 43), viewerUsername = "bf-staged", viewerPassword = new string('q', 43) }, CatalogBuilder.Json));
    using var receiver = new HttpListener(); receiver.Prefixes.Add(root + "/"); receiver.Start();
    var attempted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var probed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var synced = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var activationAttempts = 0;
    var serving = Task.Run(async () => {
      while (!stop.IsCancellationRequested) {
        var request = await receiver.GetContextAsync().WaitAsync(stop.Token);
        if (request.Request.Url!.AbsolutePath.EndsWith("/pair/activate")) {
          Interlocked.Increment(ref activationAttempts);
          // Simulate a server that may already have committed even though its response failed.
          request.Response.StatusCode = committed ? 503 : 404; request.Response.Close(); attempted.TrySetResult();
        } else if (request.Request.HttpMethod == "GET") {
          if (committed) {
            request.Response.ContentType = "application/json";
            await request.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes("{\"allowed\":false}"), stop.Token);
          } else request.Response.StatusCode = 404;
          request.Response.Close(); probed.TrySetResult();
        } else {
          using var json = await JsonDocument.ParseAsync(request.Request.InputStream, cancellationToken: stop.Token);
          var revision = json.RootElement.GetProperty("revision").GetInt64();
          await request.Response.OutputStream.WriteAsync(JsonSerializer.SerializeToUtf8Bytes(new { revision, grants = Array.Empty<object>() }), stop.Token);
          request.Response.Close(); synced.TrySetResult();
        }
      }
    });
    var config = new Config(); config.Set("betterFrameUrl", "https://frame.test"); config.Set("rtspPort", Port().ToString()); config.Set("httpListenUrl", $"http://127.0.0.1:{Port()}");
    var context = new PluginContext { Config = config, Environment = new Environment(directory), LoggerFactory = new Logs(), CameraRegistry = new Registry(), EventBus = new Bus(), StreamTap = new Tap() };
    var plugin = new BetterFramePlugin(); plugin.Initialize(context);
    try {
      Assert.That((await plugin.StartAsync(stop.Token)).IsT0, Is.True); await attempted.Task.WaitAsync(stop.Token);
      var values = new Dictionary<string, string> { ["returnUrl"] = "https://recorder.test/betterframe-pairing-return" };
      var fresh = await plugin.BeginPairingAsync(values, stop.Token);
      Assert.That(fresh.IsT0, Is.True); Assert.That(File.Exists(stagedPath), Is.False);
      if (!committed) Assert.That(File.ReadAllText(activePath), Is.EqualTo(active));
      var cancelledAttempts = Volatile.Read(ref activationAttempts);
      await plugin.StopAsync(CancellationToken.None);
      plugin = new BetterFramePlugin(); plugin.Initialize(context); Assert.That((await plugin.StartAsync(stop.Token)).IsT0, Is.True);
      await probed.Task.WaitAsync(stop.Token);
      if (committed) {
        await synced.Task.WaitAsync(stop.Token);
        using var restored = JsonDocument.Parse(File.ReadAllText(activePath));
        Assert.That(restored.RootElement.GetProperty("integrationToken").GetString(), Is.EqualTo(new string('s', 43)), "An abandoned new browser flow must not lose credentials BF already activated");
      } else Assert.That(File.ReadAllText(activePath), Is.EqualTo(active));
      Assert.That((await plugin.BeginPairingAsync(values, stop.Token)).IsT0, Is.True, "An abandoned new pairing must not block another attempt");
      Assert.That(File.Exists(stagedPath), Is.False);
      Assert.That(Volatile.Read(ref activationAttempts), Is.EqualTo(cancelledAttempts), "Cancelled handoffs may be probed but must never be activated again");
    } finally {
      await plugin.StopAsync(CancellationToken.None); stop.Cancel(); receiver.Stop();
      try { await serving; } catch (OperationCanceledException) { } catch (HttpListenerException) { }
      Directory.Delete(directory, true);
    }
  }
  [TestCase("127.0.0.1", "http://127.0.0.1:8555", "127.0.0.1", "127.0.0.1")]
  [TestCase("0.0.0.0", "http://0.0.0.0:8555", "127.0.0.1", "127.0.0.1")]
  [TestCase("::", "http://[::]:8555", "::1", "::1")]
  [TestCase("192.168.10.20", "https://192.168.10.20:8555", "192.168.10.20", "192.168.10.20")]
  [TestCase("2001:db8::20", "https://[2001:db8::20]:8555", "2001:db8::20", "2001:db8::20")]
  [TestCase("192.168.10.20", "http://192.168.10.20:8555", "192.168.10.20", "")]
  [TestCase("0:0:0:0:0:0:0:0", "http://[0:0:0:0:0:0:0:0]:8555", "::1", "::1")]
  [TestCase("127.0.0.2", "http://127.0.0.2:8555", "127.0.0.2", "")]
  [TestCase("*", "http://127.0.0.1:8555", "127.0.0.1", "127.0.0.1")]
  [TestCase("+", "http://127.0.0.1:8555", "127.0.0.1", "127.0.0.1")]
  public void PairingAdvertisesConfiguredLocalBindHosts(string bind, string http, string expectedRtspHost, string expectedHttpHost)
  {
    var query = BetterFramePlugin.PairingMediaAddresses(bind, 8554, "rtsp", new Uri(http), new Uri("https://recorder.test/betterframe-pairing-return"));
    var local = new Uri(query["local_address"]); Assert.That(local.Host.Trim('[', ']'), Is.EqualTo(expectedRtspHost)); Assert.That(local.Port, Is.EqualTo(8554));
    if (expectedHttpHost == "") Assert.That(query["local_http_address"], Is.Empty);
    else { var browser = new Uri(query["local_http_address"]); Assert.That(browser.Host.Trim('[', ']'), Is.EqualTo(expectedHttpHost)); Assert.That(browser.Port, Is.EqualTo(8555)); }
    if (IPAddress.TryParse(bind, out var address) && IPAddress.IsLoopback(address)) Assert.That(query["external_address"], Is.Empty);
  }
  [TestCase("listenAddress", "127.0.0.2", "127.0.0.1")]
  [TestCase("rtspPort", "9554", "127.0.0.1")]
  [TestCase("httpListenUrl", "http://127.0.0.1:9555", "127.0.0.1")]
  [TestCase("tlsCertificate", "replacement.pem", "127.0.0.1")]
  [TestCase("listenAddress", "127.0.0.2", "*")]
  [TestCase("listenAddress", "127.0.0.2", "+")]
  public async Task PairingRequiresRestartAfterListenerConfigurationChanges(string key, string value, string initialBind)
  {
    using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    static int Port() { var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port; }
    var config = new Config(); config.Set("rtspPort", Port().ToString()); config.Set("httpListenUrl", $"http://127.0.0.1:{Port()}"); config.Set("betterFrameUrl", "https://frame.test");
    config.Set("listenAddress", initialBind);
    var plugin = new BetterFramePlugin(); plugin.Initialize(new PluginContext { Config = config, Environment = new Environment(directory), LoggerFactory = new Logs(), CameraRegistry = new Registry(), EventBus = new Bus(), StreamTap = new Tap() });
    try {
      Assert.That((await plugin.StartAsync(stop.Token)).IsT0, Is.True);
      var values = new Dictionary<string, string> { ["returnUrl"] = "https://recorder.test/betterframe-pairing-return" };
      Assert.That((await plugin.BeginPairingAsync(values, stop.Token)).IsT0, Is.True);
      config.Set(key, value);
      Assert.That((await plugin.BeginPairingAsync(values, stop.Token)).IsT1, Is.True, "Pending restart must not advertise an address the listener does not use");
    } finally { await plugin.StopAsync(CancellationToken.None); Directory.Delete(directory, true); }
  }
  [TestCase(false)]
  [TestCase(true)]
  public async Task PairingKeepsCredentialsOffRedirectsPersistsThemAndImmediatelySyncsAcrossRestart(bool activationFailure)
  {
    using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(25));
    var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    static int Port() { var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port; }
    var root = $"http://127.0.0.1:{Port()}"; var source = Guid.NewGuid().ToString(); var camera = Guid.NewGuid();
    var allowActivation = !activationFailure; var activationProofs = Channel.CreateUnbounded<bool>();
    var token = new string('t', 43); var password = new string('p', 43); var username = "bf-generated-viewer";
    using var receiver = new HttpListener(); receiver.Prefixes.Add(root + "/"); receiver.Start();
    var events = Channel.CreateUnbounded<Catalog>(); var claims = Channel.CreateUnbounded<JsonElement>(); var authorizations = Channel.CreateUnbounded<string>();
    var serving = Task.Run(async () => {
      while (!stop.IsCancellationRequested) {
        var request = await receiver.GetContextAsync().WaitAsync(stop.Token);
        using var body = await JsonDocument.ParseAsync(request.Request.InputStream, cancellationToken: stop.Token);
        object response;
        if (request.Request.Url!.AbsolutePath.EndsWith("/pair/claim")) {
          claims.Writer.TryWrite(body.RootElement.Clone());
          response = new { instanceId = body.RootElement.GetProperty("instanceId").GetString(), sourceId = source,
            activationUrl = $"{root}/api/simplevms/default/pair/activate", callbackUrl = $"{root}/api/simplevms/default/{source}/events", managementUrl = $"{root}/simplevms/instance/{source}",
            integrationToken = token, viewerUsername = username, viewerPassword = password };
        } else if (request.Request.Url!.AbsolutePath.EndsWith("/pair/activate")) {
          var staged = Path.Combine(directory, "betterframe", "pending-connection.json");
          activationProofs.Writer.TryWrite(File.Exists(staged) && JsonDocument.Parse(File.ReadAllText(staged)).RootElement.GetProperty("integrationToken").GetString() == token);
          if (!Volatile.Read(ref allowActivation)) request.Response.StatusCode = 503;
          response = new { activated = true };
        } else {
          var catalog = body.RootElement.Deserialize<Catalog>(CatalogBuilder.Json)!;
          events.Writer.TryWrite(catalog); authorizations.Writer.TryWrite(request.Request.Headers["Authorization"] ?? "");
          response = new { revision = catalog.Revision, grants = Array.Empty<object>() };
        }
        request.Response.ContentType = "application/json";
        await request.Response.OutputStream.WriteAsync(JsonSerializer.SerializeToUtf8Bytes(response, CatalogBuilder.Json), stop.Token); request.Response.Close();
      }
    });
    var config = new Config(); config.Set("betterFrameUrl", root); config.Set("rtspPort", Port().ToString()); config.Set("httpListenUrl", $"http://127.0.0.1:{Port()}");
    var context = new PluginContext { Config = config, Environment = new Environment(directory), LoggerFactory = new Logs(),
      CameraRegistry = new Registry { Cameras = [Camera(camera, "Paired camera")] }, EventBus = new Bus(), StreamTap = new Tap() };
    var plugin = new BetterFramePlugin(); plugin.Initialize(context);
    try {
      Assert.That((await plugin.StartAsync(stop.Token)).IsT0, Is.True);
      var started = await plugin.BeginPairingAsync(new Dictionary<string, string> { ["returnUrl"] = "https://recorder.test/betterframe-pairing-return" }, stop.Token);
      Assert.That(started.IsT0, Is.True);
      var redirect = new Uri(started.AsT0["redirectUrl"]);
      var query = redirect.Query.TrimStart('?').Split('&').Select(pair => pair.Split('=', 2)).ToDictionary(pair => Uri.UnescapeDataString(pair[0]), pair => Uri.UnescapeDataString(pair[1]));
      Assert.That(query.Keys, Does.Not.Contain("verifier")); Assert.That(query.Keys, Does.Not.Contain("integrationToken"));
      Assert.That(query.Keys, Does.Not.Contain("viewerPassword")); Assert.That(query["state"], Has.Length.EqualTo(43));
      var values = new Dictionary<string, string> { ["code"] = new string('c', 43), ["state"] = "wrong-state", ["tenantSlug"] = "default" };
      Assert.That((await plugin.CompletePairingAsync(values, stop.Token)).IsT1, Is.True);
      Assert.That(claims.Reader.TryPeek(out _), Is.False);
      values["state"] = query["state"];
      Assert.That((await plugin.CompletePairingAsync(values, stop.Token)).IsT1, Is.True, "A BF redirect alone is not SimpleVMS consent");
      var preview = await plugin.CompletePairingAsync(new Dictionary<string, string>(values) { ["confirmation"] = "preview" }, stop.Token);
      Assert.That(preview.IsT0, Is.True); Assert.That(preview.AsT0["frameUrl"], Is.EqualTo(root));
      Assert.That(claims.Reader.TryPeek(out _), Is.False, "Confirmation preview must not redeem the BF code");
      Assert.That(File.Exists(Path.Combine(directory, "betterframe", "connection.json")), Is.False);
      Assert.That(File.Exists(Path.Combine(directory, "betterframe", "pending-connection.json")), Is.False);
      values["confirmed"] = "true";
      var completed = await plugin.CompletePairingAsync(values, stop.Token);
      if (activationFailure) {
        Assert.That(completed.IsT1, Is.True);
        Assert.That(File.Exists(Path.Combine(directory, "betterframe", "pending-connection.json")), Is.True);
        Assert.That(File.Exists(Path.Combine(directory, "betterframe", "connection.json")), Is.False);
        await plugin.StopAsync(CancellationToken.None);
        Volatile.Write(ref allowActivation, true);
        plugin = new BetterFramePlugin(); plugin.Initialize(context); Assert.That((await plugin.StartAsync(stop.Token)).IsT0, Is.True);
      } else { Assert.That(completed.IsT0, Is.True); Assert.That(completed.AsT0["redirectUrl"], Is.EqualTo($"{root}/simplevms/instance/{source}")); }
      Assert.That(await activationProofs.Reader.ReadAsync(stop.Token), Is.True, "Credentials must be durably staged before asking BF to activate them");
      var claimed = await claims.Reader.ReadAsync(stop.Token);
      var verifier = claimed.GetProperty("verifier").GetString()!;
      var digest = Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
      Assert.That(digest, Is.EqualTo(query["challenge"])); Assert.That(claimed.GetProperty("instanceId").GetString(), Is.EqualTo(query["instance_id"]));
      var catalog = await events.Reader.ReadAsync(stop.Token);
      Assert.That(catalog.Cameras.Single().Id, Is.EqualTo(camera.ToString()));
      Assert.That(await authorizations.Reader.ReadAsync(stop.Token), Is.EqualTo("Bearer " + token));
      Assert.That(config.Values.Keys, Does.Not.Contain("integrationToken")); Assert.That(plugin.GetValues().Keys, Does.Not.Contain("viewerPassword"));
      Assert.That(plugin.GetSchema().SelectMany(group => group.Fields).Select(field => field.Key), Does.Not.Contain("integrationToken"));
      Assert.That((await plugin.CompletePairingAsync(values, stop.Token)).IsT1, Is.True, "A completed native pairing cannot be replayed");
      var saved = Path.Combine(directory, "betterframe", "connection.json"); Assert.That(File.Exists(saved), Is.True);
      if (!OperatingSystem.IsWindows()) Assert.That(File.GetUnixFileMode(saved), Is.EqualTo(UnixFileMode.UserRead | UnixFileMode.UserWrite));
      await plugin.StopAsync(stop.Token);
      plugin = new BetterFramePlugin(); plugin.Initialize(context); Assert.That((await plugin.StartAsync(stop.Token)).IsT0, Is.True);
      var restored = await events.Reader.ReadAsync(stop.Token); Assert.That(restored.Revision, Is.GreaterThan(catalog.Revision));
      Assert.That(await authorizations.Reader.ReadAsync(stop.Token), Is.EqualTo("Bearer " + token));
      Assert.That(claims.Reader.TryPeek(out _), Is.False, "Restart must use the durable connection without another browser pairing");
    } finally {
      await plugin.StopAsync(CancellationToken.None); stop.Cancel(); receiver.Stop();
      try { await serving; } catch (OperationCanceledException) { } catch (HttpListenerException) { }
      Directory.Delete(directory, true);
    }
  }
}
