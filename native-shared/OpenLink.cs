using System.Text.Json;

namespace ChatMCP.Native;

// What a page may ask the shell to open in the app's own preview tab. No WebView2 types here, so the unit tests link it.
internal static class OpenLink
{
    /// <summary>Message type the dashboard listens for (ui/src/lib/native-open-link.ts).</summary>
    internal const string MessageType = "chatmcp.open-in-app-tab";

    /// <summary>
    /// The JSON message that asks the page to open <paramref name="uri"/>, or false when it is not an absolute http/https
    /// address (about:blank, javascript:, file:, data: ... are dropped). The address is carried as a JSON string value,
    /// byte for byte as WebView2 reported it; it is never placed inside script text.
    /// </summary>
    internal static bool TryCreateMessage(string? uri, out string json)
    {
        json = "";
        if (string.IsNullOrEmpty(uri) || uri.Length > 8192) return false;
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return false;
        if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) return false;
        json = JsonSerializer.Serialize(new { type = MessageType, url = uri });
        return true;
    }
}
