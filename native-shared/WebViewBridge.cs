using System.Diagnostics;
using Microsoft.Web.WebView2.Core;

namespace ChatMCP.Native;

// What the desktop shell does with page requests. Shared with the WebView2 smoke test so that test runs the shipped code.
internal static class WebViewBridge
{
    /// <summary>
    /// Keep window.open / target=_blank inside the app: the request is always handled (no second WebView2 window is created)
    /// and, for an http/https address only, forwarded to the page as a web message. The one exception is a release page of this project on
    /// GitHub (OpenLink.TryGetExternalLink), which opens in the system browser instead: the preview tab cannot show github.com, so "What's new"
    /// opened nothing. That only happens for a request that a person made (<c>IsUserInitiated</c>, the click on the link). The engine's flag follows its transient user activation, which a click or a key press
    /// leaves for about five seconds: script that runs without one in the last few seconds cannot start the browser of the person on its own, and its request takes the road of every other address (script that
    /// runs within those seconds of a real click can open a release page of the project, and nothing else: only an address that TryGetExternalLink accepts is opened). <paramref name="openExternal"/> is what
    /// opens it (the system browser unless a test says otherwise); it is given the parsed address and nothing else.
    /// </summary>
    internal static void AttachNewWindowHandler(CoreWebView2 core, Action<string>? openExternal = null)
    {
        var open = openExternal ?? OpenInSystemBrowser;
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (e.IsUserInitiated && OpenLink.TryGetExternalLink(e.Uri, out var external)) { open(external); return; }
            if (OpenLink.TryCreateMessage(e.Uri, out var json)) core.PostWebMessageAsJson(json);
        };
    }

    /// <summary>The default browser of the person opens <paramref name="address"/>, which has already passed OpenLink.TryGetExternalLink. No browser, no answer: nothing opens and the app goes on.</summary>
    internal static void OpenInSystemBrowser(string address)
    {
        try { Process.Start(new ProcessStartInfo(address) { UseShellExecute = true })?.Dispose(); }
        catch (Exception) { /* no default browser or no right to start it */ }
    }
}
