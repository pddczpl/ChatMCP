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

    /// <summary>The only pages a page may send the person to outside the app: the release pages of this project on GitHub.</summary>
    internal const string ExternalHost = "github.com";
    internal const string ExternalPathPrefix = "/pddczpl/ChatMCP/releases/";

    /// <summary>
    /// Whether <paramref name="uri"/> is a release page of the project (https://github.com/pddczpl/ChatMCP/releases/...) that may open in the SYSTEM browser, and the address to open: the one
    /// that was parsed (AbsoluteUri), never the text that came in, so that this check and the browser cannot read a dot segment, an encoded slash or a host differently. https only; the host
    /// exactly github.com (no subdomain, no trailing dot, no look-alike letters); no user name, no password and no port, not even the default one; the path inside the releases folder, with the
    /// owner and the repository in the letter case the project uses; no backslash, no dot segment and no encoded slash or backslash anywhere in it. Printable ASCII only, at most 2048 characters.
    /// </summary>
    internal static bool TryGetExternalLink(string? uri, out string absoluteUri)
    {
        absoluteUri = "";
        if (string.IsNullOrEmpty(uri) || uri.Length > 2048) return false;
        foreach (var c in uri) if (c < 0x21 || c > 0x7E || c == '\\') return false;
        if (!uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return false;
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return false;
        if (parsed.Scheme != Uri.UriSchemeHttps || parsed.HostNameType != UriHostNameType.Dns || parsed.Host != ExternalHost || !string.IsNullOrEmpty(parsed.UserInfo)) return false;
        // The authority as it was written: the host and nothing else (a ':' would be a port, an '@' a user name; Uri hides a default port, so the text is what is looked at).
        var authorityEnd = uri.IndexOfAny(new[] { '/', '?', '#' }, 8);
        var authority = authorityEnd < 0 ? uri[8..] : uri[8..authorityEnd];
        if (authority.Contains(':') || authority.Contains('@')) return false;
        // The path as it was written, before Uri collapses dot segments: not one of them may be there, in either spelling, and no encoded separator.
        var pathEnd = uri.IndexOfAny(new[] { '?', '#' }, authorityEnd < 0 ? uri.Length : authorityEnd);
        var rawPath = authorityEnd < 0 ? "" : uri[authorityEnd..(pathEnd < 0 ? uri.Length : pathEnd)];
        if (rawPath.Contains("%2f", StringComparison.OrdinalIgnoreCase) || rawPath.Contains("%5c", StringComparison.OrdinalIgnoreCase)) return false;
        foreach (var segment in rawPath.Split('/'))
        {
            var plain = segment.Replace("%2e", ".", StringComparison.OrdinalIgnoreCase);
            if (plain == "." || plain == "..") return false;
        }
        if (!parsed.AbsolutePath.StartsWith(ExternalPathPrefix, StringComparison.Ordinal)) return false;
        absoluteUri = parsed.AbsoluteUri;
        return true;
    }
}
