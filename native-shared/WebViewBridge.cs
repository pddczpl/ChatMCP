using Microsoft.Web.WebView2.Core;

namespace ChatMCP.Native;

// What the desktop shell does with page requests. Shared with the WebView2 smoke test so that test runs the shipped code.
internal static class WebViewBridge
{
    /// <summary>
    /// Keep window.open / target=_blank inside the app: the request is always handled (no second WebView2 window is created)
    /// and, for an http/https address only, forwarded to the page as a web message.
    /// </summary>
    internal static void AttachNewWindowHandler(CoreWebView2 core)
    {
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (OpenLink.TryCreateMessage(e.Uri, out var json)) core.PostWebMessageAsJson(json);
        };
    }
}
