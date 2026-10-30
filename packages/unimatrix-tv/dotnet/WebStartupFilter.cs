using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Common.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace UnimatrixTV;

public sealed class ServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<AssetsCatalog>();
        serviceCollection.AddTransient<IStartupFilter, WebStartupFilter>();
    }
}

public sealed class WebStartupFilter : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.UseMiddleware<NativeWebMiddleware>();
        next(app);
    };
}

public sealed class NativeWebMiddleware(RequestDelegate next, AssetsCatalog assets, IServerConfigurationManager server)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var baseUrl = server.GetNetworkConfiguration().BaseUrl.TrimEnd('/');
        var path = context.Request.Path.Value;
        var indexRequest = path == baseUrl + "/web/" || path == baseUrl + "/web/index.html";
        if (!indexRequest || !(HttpMethods.IsGet(context.Request.Method) || HttpMethods.IsHead(context.Request.Method)))
        {
            await next(context);
            return;
        }
        var config = Plugin.Instance?.Configuration ?? new Configuration.PluginConfiguration { Enabled = false };
        var file = new FileInfo(Path.Combine(server.ApplicationPaths.WebPath, "index.html"));
        if (!file.Exists || file.Length > IndexTransformer.MaximumIndexBytes)
        {
            if (!config.Enabled || context.Request.Query["unimatrix"].Any(v => v == "off")) { await next(context); return; }
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            context.Response.Headers.CacheControl = "no-store";
            return;
        }
        var standard = context.Request.Query["unimatrix"].Any(v => v == "off");
        if (!standard && config.Enabled && !assets.Complete)
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            context.Response.Headers.CacheControl = "no-store";
            context.Response.ContentType = "text/html; charset=utf-8";
            if (!HttpMethods.IsHead(context.Request.Method)) await context.Response.WriteAsync("<!doctype html><title>Unimatrix-TV</title><p>Unimatrix-TV assets could not load.</p><a href=\"?unimatrix=off\">Open standard view</a>", context.RequestAborted);
            return;
        }
        await using var stream = file.OpenRead();
        var buffer = new byte[IndexTransformer.MaximumIndexBytes + 1];
        var count = 0;
        while (count < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(count), context.RequestAborted);
            if (read == 0) break;
            count += read;
        }
        if (count > IndexTransformer.MaximumIndexBytes) throw new InvalidDataException("Native index exceeded size limit.");
        var html = System.Text.Encoding.UTF8.GetString(buffer, 0, count);
        html = IndexTransformer.Transform(html, assets, config, baseUrl, standard);
        context.Response.StatusCode = StatusCodes.Status200OK;
        context.Response.Headers.CacheControl = "no-store, max-age=0";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        context.Response.ContentType = "text/html; charset=utf-8";
        context.Response.ContentLength = System.Text.Encoding.UTF8.GetByteCount(html);
        if (!HttpMethods.IsHead(context.Request.Method)) await context.Response.WriteAsync(html, context.RequestAborted);
    }
}
