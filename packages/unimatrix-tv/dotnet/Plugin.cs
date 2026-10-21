using System;
using System.Collections.Generic;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using UnimatrixTV.Configuration;

namespace UnimatrixTV;

public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Unimatrix-TV";

    public override string Description => "Unimatrix-TV presentation and UX refinement plugin.";

    public override Guid Id => Guid.Parse("f6b0f02e-128b-4a57-b088-3e4b7b20e001");

    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = "UnimatrixTV",
                EmbeddedResourcePath = GetType().Namespace + ".Web.configPage.html",
                EnableInMainMenu = false,
                MenuSection = "server",
                MenuIcon = "tv"
            }
        };
    }
}
