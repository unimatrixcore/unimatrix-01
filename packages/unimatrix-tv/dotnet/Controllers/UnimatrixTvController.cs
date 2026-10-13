using System;
using System.IO;
using System.Reflection;
using Microsoft.AspNetCore.Mvc;
using UnimatrixTV.Configuration;

namespace UnimatrixTV.Controllers;

[ApiController]
[Route("UnimatrixTV")]
public class UnimatrixTvController : ControllerBase
{
    private static Stream? GetEmbeddedStream(string relativeName)
    {
        var asm = Assembly.GetExecutingAssembly();
        var fullResourceName = $"UnimatrixTV.Resources.{relativeName}";
        return asm.GetManifestResourceStream(fullResourceName);
    }

    [HttpGet("status")]
    [HttpHead("status")]
    public ActionResult GetStatus()
    {
        var config = Plugin.Instance?.Configuration;
        return Ok(new
        {
            status = "active",
            name = "Unimatrix TV",
            version = "1.0.0.0",
            enabled = config?.Enabled ?? true,
            bootGate = config?.EnableBootGate ?? true,
            requestsUrl = config?.RequestsUrl ?? "https://requests.unimatrix-01.dev/"
        });
    }

    [HttpGet("presentation.css")]
    [HttpHead("presentation.css")]
    [ResponseCache(Duration = 31536000, Location = ResponseCacheLocation.Any)]
    public ActionResult GetPresentationCss()
    {
        var stream = GetEmbeddedStream("presentation.css");
        if (stream == null)
        {
            return NotFound("presentation.css resource not found");
        }
        return File(stream, "text/css; charset=utf-8");
    }

    [HttpGet("unimatrix.js")]
    [HttpHead("unimatrix.js")]
    [ResponseCache(Duration = 31536000, Location = ResponseCacheLocation.Any)]
    public ActionResult GetUnimatrixJs()
    {
        var stream = GetEmbeddedStream("unimatrix.js");
        if (stream == null)
        {
            return NotFound("unimatrix.js resource not found");
        }
        return File(stream, "application/javascript; charset=utf-8");
    }

    [HttpGet("assets/{fileName}")]
    [HttpHead("assets/{fileName}")]
    [ResponseCache(Duration = 31536000, Location = ResponseCacheLocation.Any)]
    public ActionResult GetAsset([FromRoute] string fileName)
    {
        var cleanName = Path.GetFileName(fileName);
        var stream = GetEmbeddedStream($"assets.{cleanName}");
        if (stream == null)
        {
            return NotFound($"Asset {cleanName} not found");
        }

        var contentType = cleanName switch
        {
            var s when s.EndsWith(".png", StringComparison.OrdinalIgnoreCase) => "image/png",
            var s when s.EndsWith(".svg", StringComparison.OrdinalIgnoreCase) => "image/svg+xml",
            var s when s.EndsWith(".woff2", StringComparison.OrdinalIgnoreCase) => "font/woff2",
            var s when s.EndsWith(".ttf", StringComparison.OrdinalIgnoreCase) => "font/ttf",
            var s when s.EndsWith(".css", StringComparison.OrdinalIgnoreCase) => "text/css; charset=utf-8",
            var s when s.EndsWith(".js", StringComparison.OrdinalIgnoreCase) => "application/javascript; charset=utf-8",
            _ => "application/octet-stream"
        };

        return File(stream, contentType);
    }
}
