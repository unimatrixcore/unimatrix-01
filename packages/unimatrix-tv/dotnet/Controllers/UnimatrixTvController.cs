using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace UnimatrixTV.Controllers;

[ApiController]
[AllowAnonymous]
[Route("UnimatrixTV")]
public sealed class UnimatrixTvController(AssetsCatalog assets) : ControllerBase
{
    [HttpGet("status")]
    [HttpHead("status")]
    public IActionResult GetStatus()
    {
        Response.Headers.CacheControl = "no-store";
        var config = Plugin.Instance?.Configuration;
        return Ok(new { status = Plugin.Instance is null ? "unavailable" : "active", name = "Unimatrix-TV", version = typeof(Plugin).Assembly.GetName().Version?.ToString(), revision = assets.Revision, assetsReady = assets.Complete, enabled = config?.Enabled ?? false, bootGate = config?.EnableBootGate ?? false });
    }

    [HttpGet("presentation.css")]
    [HttpHead("presentation.css")]
    public IActionResult GetPresentationCss() => Serve("presentation.css");
    [HttpGet("unimatrix.js")]
    [HttpHead("unimatrix.js")]
    public IActionResult GetUnimatrixJs() => Serve("unimatrix.js");
    [HttpGet("assets/{fileName}")]
    [HttpHead("assets/{fileName}")]
    public IActionResult GetAsset(string fileName) => Serve(fileName);

    private IActionResult Serve(string name)
    {
        var asset = assets.Find(name);
        if (asset is null) return NotFound();
        Response.Headers.CacheControl = "public, max-age=0, must-revalidate";
        Response.Headers.XContentTypeOptions = "nosniff";
        return File(asset.Bytes, asset.ContentType, lastModified: null, entityTag: new Microsoft.Net.Http.Headers.EntityTagHeaderValue(asset.ETag));
    }
}
