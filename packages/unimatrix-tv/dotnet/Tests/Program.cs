using System.Net;
using System.Reflection;
using System.Text.Encodings.Web;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Model.Serialization;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UnimatrixTV;
using UnimatrixTV.Configuration;

var directory = Path.Combine(Path.GetTempPath(), "utv-tests-" + Guid.NewGuid());
Directory.CreateDirectory(directory);
const string native = "<!doctype html><html><head><script src=\"native.js\"></script><link rel=\"stylesheet\" href=\"native.css\"><link href=\"/web/unimatrix-theme/presentation.css?v=old\" rel=\"stylesheet\"><script src=\"/UnimatrixTV/unimatrix.js?v=old\"></script></head><body>native</body></html>";
File.WriteAllText(Path.Combine(directory, "index.html"), native);
var paths = FakeProxy.Make<IServerApplicationPaths>();
((FakeProxy)(object)paths).Values["get_WebPath"] = directory;
((FakeProxy)(object)paths).DefaultDirectory = directory;
var serializer = FakeProxy.Make<IXmlSerializer>();
var plugin = new Plugin(paths, serializer);
var configuration = new PluginConfiguration();
plugin.UpdateConfiguration(configuration);
var server = FakeProxy.Make<IServerConfigurationManager>();
((FakeProxy)(object)server).Values["get_ApplicationPaths"] = paths;
((FakeProxy)(object)server).Values["GetConfiguration"] = new NetworkConfiguration { BaseUrl = "" };
var assets = new AssetsCatalog();
Assert(assets.Complete, "Embedded assets are complete");
using var host = Host.CreateDefaultBuilder().ConfigureLogging(logging => logging.ClearProviders()).ConfigureWebHostDefaults(web => web.UseUrls("http://127.0.0.1:0").ConfigureServices(services =>
{
 services.AddSingleton(server);
 new ServiceRegistrator().RegisterServices(services, null!);
 services.AddControllers().AddApplicationPart(typeof(Plugin).Assembly);
 services.AddResponseCompression();
 services.AddAuthentication("Test").AddScheme<AuthenticationSchemeOptions, TestAuthentication>("Test", _ => { });
 services.AddAuthorization(options => options.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());
}).Configure(app =>
{
 app.UseResponseCompression();
 app.UseRouting(); app.UseAuthentication(); app.UseAuthorization();
 app.UseEndpoints(endpoints => { endpoints.MapControllers(); endpoints.MapGet("/Items", () => "private library").RequireAuthorization(); endpoints.MapGet("/web/index.html", () => "native fallback").AllowAnonymous(); });
})).Build();
await host.StartAsync();
using var client = new HttpClient { BaseAddress = new Uri(host.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single()) };
var request = new HttpRequestMessage(HttpMethod.Get, "/web/index.html");
request.Headers.TryAddWithoutValidation("Accept-Encoding", "gzip"); request.Headers.TryAddWithoutValidation("If-None-Match", "\"old-native-index\""); request.Headers.TryAddWithoutValidation("If-Modified-Since", DateTime.UtcNow.ToString("R"));
var response = await client.SendAsync(request); var html = await response.Content.ReadAsStringAsync();
Assert(response.StatusCode == HttpStatusCode.OK && !response.Content.Headers.ContentEncoding.Any(), "Index bypasses old conditional cache and compression");
Assert(html.IndexOf("unimatrix-tv-critical", StringComparison.Ordinal) < html.IndexOf("native.js", StringComparison.Ordinal), "Critical boot CSS is before native scripts");
Assert(html.LastIndexOf("/UnimatrixTV/presentation.css", StringComparison.Ordinal) > html.IndexOf("native.css", StringComparison.Ordinal), "Presentation CSS follows native styles");
Assert(!html.Contains("unimatrix-theme") && !html.Contains("v=old"), "Legacy bootstrap tags are removed");
Assert(response.Headers.CacheControl?.NoStore == true, "Index is not cached");
var head = await client.SendAsync(new HttpRequestMessage(HttpMethod.Head, "/web/index.html"));
Assert((await head.Content.ReadAsByteArrayAsync()).Length == 0 && head.Content.Headers.ContentLength == response.Content.Headers.ContentLength, "HEAD returns no body with transformed GET length");
var standard = await client.GetStringAsync("/web/index.html?unimatrix=off");
Assert(!standard.Contains("UnimatrixTV") && !standard.Contains("unimatrix-tv") && standard.Contains("native.js"), "Standard recovery contains native web assets only");
configuration.EnableBootGate = false; plugin.UpdateConfiguration(configuration);
var ungated = await client.GetStringAsync("/web/index.html");
Assert(!ungated.Contains("unimatrix-tv-critical") && ungated.Contains("\"bootGate\":false") && ungated.Contains("/UnimatrixTV/unimatrix.js"), "Gate setting disables gate while preserving theme");
configuration.Enabled = false; plugin.UpdateConfiguration(configuration);
Assert(await client.GetStringAsync("/web/index.html") == standard, "Disabled plugin returns standard view");
configuration.Enabled = true; configuration.EnableBootGate = true; plugin.UpdateConfiguration(configuration);
Assert((await client.GetAsync("/Items")).StatusCode == HttpStatusCode.Unauthorized, "Private Jellyfin API remains authenticated");
var asset = await client.GetAsync("/UnimatrixTV/presentation.css");
Assert(asset.StatusCode == HttpStatusCode.OK && asset.Headers.ETag is not null && asset.Headers.CacheControl?.MaxAge == TimeSpan.Zero, "Public stylesheet has revalidating cache and content ETag");
var conditional = new HttpRequestMessage(HttpMethod.Get, "/UnimatrixTV/presentation.css"); conditional.Headers.IfNoneMatch.Add(asset.Headers.ETag!);
Assert((await client.SendAsync(conditional)).StatusCode == HttpStatusCode.NotModified, "Matching asset ETag returns304");
Assert((await client.GetAsync("/UnimatrixTV/assets/configPage.html")).StatusCode == HttpStatusCode.NotFound && assets.Find("../logo.png") is null && assets.Find("logo.png") is not null, "Asset allowlist rejects traversal and admin config resources");
var status = await client.GetStringAsync("/UnimatrixTV/status");
Assert(status.Contains("1.0.1.0") && !status.Contains("requestsUrl"), "Status reports actual version without configuration URLs");
((FakeProxy)(object)server).Values["GetConfiguration"] = new NetworkConfiguration { BaseUrl = "/tv" };
Assert((await client.GetStringAsync("/tv/web/index.html")).Contains("/tv/UnimatrixTV/unimatrix.js"), "Configured base URL is preserved");
Assert((await client.GetAsync("/web/index.html")).StatusCode == HttpStatusCode.OK && await client.GetStringAsync("/web/index.html") == "native fallback", "Hook does not intercept paths outside configured base URL");
((FakeProxy)(object)server).Values["GetConfiguration"] = new NetworkConfiguration { BaseUrl = "" };
File.WriteAllText(Path.Combine(directory, "index.html"), new string('x', IndexTransformer.MaximumIndexBytes + 1));
Assert((await client.GetAsync("/web/index.html")).StatusCode == HttpStatusCode.ServiceUnavailable, "Oversized index fails closed");
Assert(new PluginConfiguration { RequestsUrl = "javascript:alert(1)" }.SafeRequestsUrl.StartsWith("https://"), "Executable URL is rejected for client navigation");
await host.StopAsync();
Directory.Delete(directory, true);
Console.WriteLine("Server HTTP/security regression checks passed.");

static void Assert(bool condition, string label) { if (!condition) throw new Exception(label); Console.WriteLine("PASS " + label); }

public class FakeProxy : DispatchProxy
{
 public Dictionary<string, object?> Values { get; } = new();
 public string DefaultDirectory { get; set; } = Path.GetTempPath();
 public static T Make<T>() where T : class => Create<T, FakeProxy>();
 protected override object? Invoke(MethodInfo? method, object?[]? args)
 {
  if (Values.TryGetValue(method!.Name, out var value)) return value;
  if (method.ReturnType == typeof(string)) return DefaultDirectory;
  if (method.ReturnType == typeof(void)) return null;
  return method.ReturnType.IsValueType ? Activator.CreateInstance(method.ReturnType) : null;
 }
}
public sealed class TestAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
 protected override Task<AuthenticateResult> HandleAuthenticateAsync() => Task.FromResult(AuthenticateResult.NoResult());
}
