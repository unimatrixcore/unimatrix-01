using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using UnimatrixTV.Configuration;

namespace UnimatrixTV;

public static partial class IndexTransformer
{
    public const int MaximumIndexBytes = 2 * 1024 * 1024;
    private const string StartMarker = "<!-- unimatrix-tv:start -->";
    private const string EndMarker = "<!-- unimatrix-tv:end -->";
    [GeneratedRegex(@"<!-- unimatrix-tv:start -->.*?<!-- unimatrix-tv:end -->", RegexOptions.Singleline | RegexOptions.CultureInvariant, 1000)]
    private static partial Regex InjectionBlocks();
    [GeneratedRegex(@"<script\b[^>]*\bsrc\s*=\s*['""](?:[^'""]*/)?(?:unimatrix-theme/|UnimatrixTV/)[^'""]*['""][^>]*>\s*</script>|<link\b[^>]*\bhref\s*=\s*['""](?:[^'""]*/)?(?:unimatrix-theme/|UnimatrixTV/)[^'""]*['""][^>]*>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, 1000)]
    private static partial Regex LegacyAssetTags();

    public static string Transform(string html, AssetsCatalog assets, PluginConfiguration config, string baseUrl, bool standardView)
    {
        html = LegacyAssetTags().Replace(InjectionBlocks().Replace(html, ""), "");
        if (standardView || !config.Enabled) return html;
        var head = html.IndexOf("<head", StringComparison.OrdinalIgnoreCase);
        var headEnd = html.IndexOf('>', head < 0 ? 0 : head);
        var closeHead = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        if (head < 0 || headEnd < 0 || closeHead < headEnd) throw new InvalidDataException("Native web index has no complete head element.");
        var assetUrl = baseUrl.TrimEnd('/') + "/UnimatrixTV/";
        var settings = JsonSerializer.Serialize(new { enabled = config.Enabled, bootGate = config.EnableBootGate, requestsUrl = config.SafeRequestsUrl, assetsBase = assetUrl + "assets/" });
        var early = StartMarker + "<script>window.__unimatrixTVConfig=" + settings + ";</script>";
        if (config.EnableBootGate) early += "<style id=\"unimatrix-tv-critical\">" + assets.Text("critical.css").Replace("</style", "<\\/style", StringComparison.OrdinalIgnoreCase) + "</style><script>" + assets.Text("bootstrap.js").Replace("</script", "<\\/script", StringComparison.OrdinalIgnoreCase) + "</script>";
        early += EndMarker;
        var late = StartMarker + "<link rel=\"stylesheet\" href=\"" + HtmlEncoder.Default.Encode(assetUrl + "presentation.css?v=" + assets.Revision) + "\"><script defer src=\"" + HtmlEncoder.Default.Encode(assetUrl + "unimatrix.js?v=" + assets.Revision) + "\"></script>" + EndMarker;
        html = html.Insert(closeHead, late);
        return html.Insert(headEnd + 1, early);
    }
}
