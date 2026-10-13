using MediaBrowser.Model.Plugins;

namespace UnimatrixTV.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    public bool Enabled { get; set; } = true;

    public bool EnableBootGate { get; set; } = true;

    public string RequestsUrl { get; set; } = "https://requests.unimatrix-01.dev/";

    public PluginConfiguration()
    {
    }
}
