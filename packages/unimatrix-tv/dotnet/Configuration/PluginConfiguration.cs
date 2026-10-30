using MediaBrowser.Model.Plugins;

namespace UnimatrixTV.Configuration;

public sealed class PluginConfiguration : BasePluginConfiguration
{
    public bool Enabled { get; set; } = true;
    public bool EnableBootGate { get; set; } = true;
    public string RequestsUrl { get; set; } = "https://requests.unimatrix-01.dev/";
    [System.Text.Json.Serialization.JsonIgnore]
    [System.Xml.Serialization.XmlIgnore]
    public string SafeRequestsUrl => Uri.TryCreate(RequestsUrl, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps && string.IsNullOrEmpty(uri.UserInfo) ? uri.AbsoluteUri : "https://requests.unimatrix-01.dev/";
}
