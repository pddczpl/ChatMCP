using System.Text.Json;
using System.Text.RegularExpressions;

namespace ChatMCP.Native;

/// <summary>The words the shell answers a page with when it was asked to apply an update: a closed set, so that no text of an exception, and no path, ever reaches the page.</summary>
internal static class UpdateCodes
{
    /// <summary>
    /// launched (the installer is running and the window is closing), busy (an update is already being applied), tasks_running, hub_unreachable, not_installed (this is not an installed copy), no_update, ambiguous,
    /// staging_unsafe, no_trusted_key, bad_signature, bad_manifest, not_newer, bad_installer, stale (what the Hub offered is not what the folder holds) and launch_failed.
    /// </summary>
    internal static readonly IReadOnlySet<string> Known = new HashSet<string>(StringComparer.Ordinal)
    {
        "launched", "busy", "tasks_running", "hub_unreachable", "not_installed", "no_update", "ambiguous", "staging_unsafe", "no_trusted_key", "bad_signature", "bad_manifest", "not_newer", "bad_installer", "stale", "launch_failed",
    };

    internal static bool IsKnown(string? code) => code != null && Known.Contains(code);
}

/// <summary>
/// What the desktop shell reads from the page and says to it. The page is not trusted: a message counts only when it comes from the dashboard itself (the exact origin, nothing else), is a JSON object of at most
/// 32 KiB (a folder picker may suggest a path of 4096 characters, which JSON can spell in six times as many) with a `type` the shell knows and an `id` of 16 to 64 hex digits and dashes, and nothing else in it is ever read (the shell computes the folder, the file and the version itself). The answer is a JSON
/// string value with a code of the closed list. No WebView2 types here, so the unit tests link it.
/// </summary>
internal static class PageMessage
{
    internal const string PickFolder = "chatmcp.pick-folder";
    internal const string ApplyUpdate = "chatmcp.apply-update";
    internal const string UpdateResult = "chatmcp.update-result";
    internal const int MaxBytes = 32 * 1024;
    internal static readonly IReadOnlySet<string> Types = new HashSet<string>(StringComparer.Ordinal) { PickFolder, ApplyUpdate };
    private static readonly Regex RequestId = new(@"^[a-fA-F0-9-]{16,64}\z", RegexOptions.CultureInvariant);

    /// <summary>Whether <paramref name="source"/> (the address of the document that sent the message) is exactly the dashboard: http, 127.0.0.1, this port, the path /, and no user name.</summary>
    internal static bool IsDashboard(string? source, int port) =>
        Uri.TryCreate(source, UriKind.Absolute, out var origin) && origin.Scheme == Uri.UriSchemeHttp && origin.Host == "127.0.0.1" && origin.Port == port && origin.AbsolutePath == "/" && string.IsNullOrEmpty(origin.UserInfo);

    /// <summary>The type and the id of a message of a kind the shell answers to; false for anything else. Whatever else the message carries is not read, and cannot be: there is nowhere to put it.</summary>
    internal static bool TryParse(string? json, out string type, out string id)
    {
        type = ""; id = "";
        if (string.IsNullOrEmpty(json) || json.Length > MaxBytes) return false;
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return false;
            if (!root.TryGetProperty("type", out var kind) || kind.ValueKind != JsonValueKind.String || !Types.Contains(kind.GetString()!)) return false;
            if (!root.TryGetProperty("id", out var identifier) || identifier.ValueKind != JsonValueKind.String || !RequestId.IsMatch(identifier.GetString()!)) return false;
            type = kind.GetString()!; id = identifier.GetString()!;
            return true;
        }
        catch (JsonException) { return false; }
    }

    /// <summary>The answer to an apply-update message. A code that is not on the closed list is not passed on: the page is told launch_failed.</summary>
    internal static string UpdateResultJson(string id, bool ok, string code) =>
        JsonSerializer.Serialize(new { type = UpdateResult, id, ok, code = UpdateCodes.IsKnown(code) ? code : "launch_failed" });
}
