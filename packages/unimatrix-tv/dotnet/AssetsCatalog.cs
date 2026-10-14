using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace UnimatrixTV;

public sealed record WebAsset(byte[] Bytes, string ContentType, string ETag);

public sealed class AssetsCatalog
{
    private readonly Dictionary<string, WebAsset> assets = new(StringComparer.Ordinal);
    private static readonly HashSet<string> PublicFiles = new(StringComparer.Ordinal) { "presentation.css", "unimatrix.js", "critical.css", "bootstrap.js", "logo.png", "geist-mono.woff2", "manrope.ttf", "favicon.ico" };
    private static readonly string[] Required = ["presentation.css", "unimatrix.js", "critical.css", "bootstrap.js"];
    public AssetsCatalog() : this(typeof(Plugin).Assembly) { }
    public AssetsCatalog(Assembly assembly)
    {
        const string prefix = "UnimatrixTV.Resources.";
        foreach (var name in assembly.GetManifestResourceNames().Where(n => n.StartsWith(prefix, StringComparison.Ordinal)))
        {
            var file = name[prefix.Length..];
            if (file.StartsWith("assets.", StringComparison.Ordinal)) file = file[7..];
            if (!ValidFile(file) || !PublicFiles.Contains(file)) continue;
            using var stream = assembly.GetManifestResourceStream(name)!;
            using var memory = new MemoryStream();
            stream.CopyTo(memory);
            var bytes = memory.ToArray();
            assets.Add(file, new(bytes, ContentType(file), "\"" + Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() + "\""));
        }
        Revision = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("|", assets.OrderBy(a => a.Key, StringComparer.Ordinal).Select(a => a.Key + a.Value.ETag))))).ToLowerInvariant()[..16];
    }
    public string Revision { get; }
    public bool Complete => Required.All(assets.ContainsKey);
    public WebAsset? Find(string name) => ValidFile(name) && assets.TryGetValue(name, out var asset) ? asset : null;
    public string Text(string name) => Encoding.UTF8.GetString(Find(name)?.Bytes ?? throw new InvalidOperationException("Missing embedded asset: " + name));
    public static bool ValidFile(string name) => name.Length is > 0 and <= 100 && !name.StartsWith('.') && name.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.') && !name.Contains("..", StringComparison.Ordinal);
    private static string ContentType(string name) => Path.GetExtension(name).ToLowerInvariant() switch
    {
        ".css" => "text/css; charset=utf-8", ".js" => "application/javascript; charset=utf-8",
        ".png" => "image/png", ".ico" => "image/x-icon", ".svg" => "image/svg+xml",
        ".woff2" => "font/woff2", ".ttf" => "font/ttf", _ => "application/octet-stream"
    };
}
