using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ChatMCP.Native;

// The per-launch Hub credential as seen by the desktop shell, the installer and the WebView2 smoke test: read the file the
// Hub published (<state dir>\run\hub-session.json, readable by this Windows account only), refuse a stale one, present the
// secret as a bearer and trade it for a one-time ticket the dashboard can sign in with. One copy of this logic is linked
// into every native project so the tests exercise the code that ships.
internal sealed record HubSessionInfo(int Pid, int Port, string Secret);

internal static class HubSession
{
    internal const string BootFragment = "chatmcp-boot";
    private static readonly Regex SecretPattern = new("^[A-Za-z0-9_-]{32,256}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>Where a Hub started without --state-dir keeps its data (the same rule as defaultDataDirectory() in manager.mjs).</summary>
    internal static string DefaultStateDirectory()
    {
        var configured = Environment.GetEnvironmentVariable("CHATMCP_STATE_DIR");
        if (!string.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured);
        var local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        if (string.IsNullOrWhiteSpace(local)) local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(local, "ChatMCP", "hub");
    }

    internal static string SessionPath(string stateDirectory) => Path.Combine(stateDirectory, "run", "hub-session.json");

    /// <summary>The published session for <paramref name="port"/>, or null when the file is missing, malformed or for another port.</summary>
    internal static HubSessionInfo? Read(string stateDirectory, int port)
    {
        try
        {
            var file = new FileInfo(SessionPath(stateDirectory));
            if (!file.Exists || file.Length > 4096) return null;
            // Share everything, delete included: the Hub replaces this file by renaming over it, and a reader that blocks that
            // rename (polling every few seconds) would make the Hub fail to start.
            using var stream = new FileStream(file.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            using var document = JsonDocument.Parse(reader.ReadToEnd());
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("version", out var version) || !version.TryGetInt32(out var v) || v != 1) return null;
            if (!root.TryGetProperty("app", out var app) || app.ValueKind != JsonValueKind.String || app.GetString() != "chatmcp-local-hub") return null;
            if (!root.TryGetProperty("pid", out var pid) || !pid.TryGetInt32(out var processId) || processId < 1) return null;
            if (!root.TryGetProperty("port", out var filePort) || !filePort.TryGetInt32(out var publishedPort) || publishedPort != port) return null;
            if (!root.TryGetProperty("secret", out var secret) || secret.ValueKind != JsonValueKind.String) return null;
            var text = secret.GetString() ?? "";
            return SecretPattern.IsMatch(text) ? new HubSessionInfo(processId, publishedPort, text) : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { return null; }
    }

    /// <summary>
    /// <see cref="Read"/>, plus proof that the file is not left over from an earlier launch: its process must be the one
    /// listening on the port right now. A secret is never presented to a program that merely listens on the port.
    /// </summary>
    internal static HubSessionInfo? ReadForListener(string stateDirectory, int port)
    {
        var session = Read(stateDirectory, port);
        return session != null && HubLifecycle.ListenerPid(port) == session.Pid ? session : null;
    }

    internal static HttpRequestMessage Authorized(HttpMethod method, string url, string secret)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        return request;
    }

    /// <summary>A one-time sign-in ticket from the running Hub (valid for a minute, redeemable once, by the Hub's own page).</summary>
    internal static async Task<string> RequestTicket(HttpClient client, string origin, string secret)
    {
        using var request = Authorized(HttpMethod.Post, origin + "/api/session/ticket", secret);
        request.Content = new StringContent("{}", Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException("The Hub refused a session ticket (HTTP " + (int)response.StatusCode + "). Close and reopen ChatMCP.");
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (!body.RootElement.TryGetProperty("ticket", out var ticket) || ticket.ValueKind != JsonValueKind.String ||
            !Regex.IsMatch(ticket.GetString() ?? "", "^[A-Za-z0-9_-]{16,256}$"))
            throw new InvalidOperationException("The Hub returned an invalid session ticket.");
        return ticket.GetString()!;
    }

    /// <summary>The address to load into WebView2: the dashboard plus the ticket in the fragment (never sent to the server, stripped by the page).</summary>
    internal static string DashboardUrl(string origin, string ticket) => origin.TrimEnd('/') + "/#" + BootFragment + "=" + Uri.EscapeDataString(ticket);
}
