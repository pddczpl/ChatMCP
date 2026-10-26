using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace ChatMCP.Native;

// Shared by the real desktop and installer; no test-only bypasses or credentials.
internal static class HubLifecycle
{
    internal const string Origin = "http://127.0.0.1:3007";
    internal static string Version => Assembly.GetExecutingAssembly().GetName().Version?.ToString(3)
        ?? throw new InvalidOperationException("Missing native application version.");
    internal static string UserKey => WindowsIdentity.GetCurrent().User?.Value
        ?? throw new InvalidOperationException("Windows user identity is unavailable.");
    internal static string UpdateLockName(string root) => "Local\\ChatMCP.Update." + UserKey + "." +
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(root).TrimEnd('\\', '/').ToUpperInvariant())));
    internal static Mutex AcquireUpdateLock(string root)
    {
        var mutex = new Mutex(false, UpdateLockName(root));
        try
        {
            bool acquired;
            try { acquired = mutex.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
            if (!acquired) throw new InvalidOperationException("Another DatGold installation/update is in progress. Wait for it to finish.").Tag("another_update");
            return mutex;
        }
        catch { mutex.Dispose(); throw; }
    }
    /// <summary>
    /// The most the Hub may answer with. /api/state grows with use (445,101 bytes on the owner's machine) and is read whole before the installer stops the Hub,
    /// so a cap of 256 KiB made every upgrade and uninstall of a used installation fail ("Cannot write more bytes to the buffer than the configured maximum buffer size: 262144").
    /// The Hub being asked is the installed one (OwnedHub checked the process and its command line first), so the cap is only there to bound a runaway answer.
    /// </summary>
    internal const long MaxResponseBytes = 64L * 1024 * 1024;
    internal static HttpClient Client(long maxResponseBytes = MaxResponseBytes) => new(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false })
        { Timeout = TimeSpan.FromSeconds(4), MaxResponseContentBufferSize = maxResponseBytes };

    internal static async Task<JsonDocument> GetJson(HttpClient client, string path, string? secret = null, string? origin = null)
    {
        var address = (origin ?? Origin) + path;
        using var request = secret == null ? new HttpRequestMessage(HttpMethod.Get, address) : HubSession.Authorized(HttpMethod.Get, address, secret);
        using var response = await client.SendAsync(request);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("Hub returned HTTP " + (int)response.StatusCode + " for " + path + ".");
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync());
    }
    /// <summary>True when /api/health says the Hub requires the per-launch bearer. A Hub without that field predates it (v3.9.0 and older).</summary>
    internal static bool RequiresBearer(JsonElement health) =>
        health.ValueKind == JsonValueKind.Object && health.TryGetProperty("auth", out var auth) &&
        auth.ValueKind == JsonValueKind.String && auth.GetString() == "bearer";
    internal static void ValidateHealth(JsonElement health, string? expectedVersion = null, bool requireBearer = false)
    {
        if (health.ValueKind != JsonValueKind.Object || !health.TryGetProperty("app", out var app) ||
            app.ValueKind != JsonValueKind.String || app.GetString() != "chatmcp-local-hub")
            throw new InvalidOperationException("Port 3007 is not a verified DatGold Hub. No process was stopped.").Tag("foreign_listener");
        if (expectedVersion != null)
        {
            var actual = health.TryGetProperty("version", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : "unknown";
            var build = health.TryGetProperty("uiBuild", out var b) && b.ValueKind == JsonValueKind.String ? b.GetString() : "unknown";
            if (actual != expectedVersion || build != expectedVersion + "-react-agent")
                throw new InvalidOperationException($"Hub version mismatch: desktop {expectedVersion}, Hub {actual}. Stop the old Hub using its STOP-CHATMCP-HUB.cmd, then reopen the installed app. No task was replayed.");
        }
        // The same version number can still be a Hub that serves its CSRF token to any local process. Never attach to it.
        if (requireBearer && !RequiresBearer(health))
            throw new InvalidOperationException("The running Hub predates session authentication (an older build of the same version). Stop it using its STOP-CHATMCP-HUB.cmd, then reopen the installed app. No task was replayed.");
    }
    internal static bool IsRefused(Exception error)
    {
        for (Exception? e = error; e != null; e = e.InnerException)
            if (e is SocketException socket && socket.SocketErrorCode == SocketError.ConnectionRefused) return true;
        return false;
    }
    internal static async Task<bool> IsReady(string expectedVersion)
    {
        using var client = Client();
        try
        {
            using var health = await GetJson(client, "/api/health");
            ValidateHealth(health.RootElement, expectedVersion, requireBearer: true);
            return health.RootElement.TryGetProperty("initialized", out var ready) && ready.ValueKind == JsonValueKind.True;
        }
        catch (HttpRequestException error) when (IsRefused(error)) { return false; }
        // Wrong service, version, malformed JSON or timeout MUST NOT be treated
        // as an empty port. The native window displays the failure, not a stale UI.
    }

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);
    internal static int? ListenerPid(int listenPort = 3007)
    {
        int size = 0;
        uint code = GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 3, 0); // AF_INET, OWNER_PID_LISTENER
        if (code != 122 && code != 0) throw new IOException("Cannot inspect the Hub listener.");
        if (size < 4 || size > 16 * 1024 * 1024) throw new IOException("Invalid TCP ownership table.");
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            code = GetExtendedTcpTable(buffer, ref size, false, 2, 3, 0);
            if (code != 0) throw new IOException("Hub listener changed during inspection; retry installation.");
            int count = Marshal.ReadInt32(buffer);
            if (count < 0 || 4L + 24L * count > size) throw new IOException("Truncated TCP ownership table.");
            var owners = new HashSet<int>();
            for (int i = 0; i < count; ++i)
            {
                var row = IntPtr.Add(buffer, 4 + 24 * i);
                int port = (Marshal.ReadByte(row, 8) << 8) | Marshal.ReadByte(row, 9);
                uint address = unchecked((uint)Marshal.ReadInt32(row, 4));
                if (port == listenPort && (address == 0 || address == 0x0100007f)) owners.Add(Marshal.ReadInt32(row, 20));
            }
            if (owners.Count > 1) throw new IOException("Ambiguous listener ownership on port " + listenPort + ".");
            return owners.Count == 1 ? owners.Single() : null;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
    internal static bool IsHubCommand(string command, string script)
    {
        if (string.IsNullOrWhiteSpace(command) || command.Length > 32768) return false;
        var argv = CommandLineToArgvW(command, out var count);
        if (argv == IntPtr.Zero) return false;
        try
        {
            if (count < 2 || count > 64) return false;
            var entry = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, IntPtr.Size));
            // Check the actual Node entrypoint, not a matching string supplied as
            // an argument to a different script sharing the bundled executable.
            return entry != null && Path.IsPathFullyQualified(entry) &&
                string.Equals(Path.GetFullPath(entry), script, StringComparison.OrdinalIgnoreCase);
        }
        finally { LocalFree(argv); }
    }
    /// <summary>
    /// Windows PowerShell 5.1, the powershell.exe of this machine, as a child of this process that runs <paramref name="command"/> without a window. The child is given no
    /// PSModulePath: a process started from PowerShell 7 inherits it with PowerShell 7's module folders first, and Windows PowerShell then finds PowerShell 7's modules
    /// before its own and loses what they define (Get-FileHash and the other script functions of Microsoft.PowerShell.Utility). Without the variable it works out the
    /// default module path of the machine. The caller adds redirections; the start must not go through the shell, which ignores Environment.
    /// </summary>
    internal static ProcessStartInfo WindowsPowerShell(string command)
    {
        var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"))
            { UseShellExecute = false, CreateNoWindow = true };
        start.ArgumentList.Add("-NoProfile"); start.ArgumentList.Add("-NonInteractive"); start.ArgumentList.Add("-EncodedCommand");
        start.ArgumentList.Add(Convert.ToBase64String(Encoding.Unicode.GetBytes(command)));
        foreach (var name in start.Environment.Keys.Where(key => string.Equals(key, "PSModulePath", StringComparison.OrdinalIgnoreCase)).ToList())
            start.Environment.Remove(name);
        return start;
    }
    private static Process? OwnedHub(string root)
    {
        var pid = ListenerPid();
        if (pid == null) return null;
        var process = Process.GetProcessById(pid.Value);
        try
        {
            var expected = Path.GetFullPath(Path.Combine(root, "runtimes", "node", "node.exe"));
            if (!string.Equals(process.MainModule?.FileName, expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Port 3007 belongs to a different installation or process. It was not stopped.").Tag("foreign_listener");
            // Confirm the exact script as well as the bundled executable. WMI is
            // read-only; the only generated query argument is an integer PID.
            var psi = WindowsPowerShell($"(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid.Value}').CommandLine | ConvertTo-Json -Compress");
            psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
            using var probe = Process.Start(psi) ?? throw new IOException("Cannot verify the Hub command line.").Tag("hub_stop_failed");
            var output = probe.StandardOutput.ReadToEndAsync(); var errors = probe.StandardError.ReadToEndAsync();
            if (!probe.WaitForExit(10000)) { probe.Kill(); throw new IOException("Hub ownership query timed out.").Tag("hub_stop_failed"); }
            if (probe.ExitCode != 0) throw new IOException("Hub ownership query failed.").Tag("hub_stop_failed");
            var command = JsonSerializer.Deserialize<string>(output.GetAwaiter().GetResult()) ?? "";
            var script = Path.GetFullPath(Path.Combine(root, "CHATMCP-HUB", "hub.mjs"));
            if (!IsHubCommand(command, script))
                throw new InvalidOperationException("The listener is not the installed Hub script. It was not stopped.").Tag("foreign_listener");
            if (process.HasExited || ListenerPid() != process.Id) throw new IOException("Hub changed during inspection; retry.").Tag("hub_stop_failed");
            return process;
        }
        catch { process.Dispose(); throw; }
    }
    /// <summary>
    /// The words that say why the Hub's state (GET /api/state) holds work that an update would cut off, or null when it holds none: an agent that is not idle, or terminals and workers that run. A state with no `agent` is
    /// work too (the Hub is not fully loaded: fail closed). The rule the installer applies before it stops the Hub and the shell applies before it exits, held to one list of cases with the page's port of it
    /// (CHATMCP-HUB/tests/fixtures/active-work-cases.json).
    /// </summary>
    internal static string? WorkInState(JsonElement data)
    {
        if (data.ValueKind != JsonValueKind.Object || !data.TryGetProperty("agent", out var agent) || HasWork(agent))
            return "Stop active DatGold tasks before installing or uninstalling. Nothing was cancelled.";
        if (data.TryGetProperty("studio", out var studio) && studio.ValueKind == JsonValueKind.Object)
            foreach (var name in new[] { "terminals", "delegates", "dynamicDelegates" })
                if (studio.TryGetProperty(name, out var work) && HasWork(work))
                    return "Stop DatGold terminals and background workers before upgrading.";
        return null;
    }

    /// <summary>The words that say why the answer of GET /api/studio/coding holds a coding run that an update would cut off, or null.</summary>
    internal static string? WorkInCoding(JsonElement coding) => HasWork(coding) ? "Stop background coding jobs before upgrading." : null;

    /// <summary>
    /// Asks the Hub at <paramref name="origin"/> (with its session secret when it has one) what the shell must know before it exits for an update, with the same two requests and the same rule as StopInstalledHub:
    /// the words that say why the Hub is doing work, or null when it is idle (the installer's own refusal comes after the window is already gone, so the shell asks first), and the version that the Hub says
    /// it has downloaded and checked (`update.download` with state ready), which the page showed the owner. Throws when the Hub cannot be asked or does not answer as a Hub: that is no answer, never "idle".
    /// </summary>
    internal static async Task<UpdatePreflight> PreflightForUpdate(HttpClient client, string origin, string? secret)
    {
        using var state = await GetJson(client, "/api/state", secret, origin);
        var offered = OfferedVersion(state.RootElement);
        var inState = WorkInState(state.RootElement);
        if (inState != null) return new UpdatePreflight(inState, offered);
        using var coding = await GetJson(client, "/api/studio/coding", secret, origin);
        return new UpdatePreflight(WorkInCoding(coding.RootElement), offered);
    }

    private static string? OfferedVersion(JsonElement state) =>
        state.ValueKind == JsonValueKind.Object && state.TryGetProperty("update", out var update) && update.ValueKind == JsonValueKind.Object &&
        update.TryGetProperty("download", out var download) && download.ValueKind == JsonValueKind.Object &&
        download.TryGetProperty("state", out var phase) && phase.ValueKind == JsonValueKind.String && phase.GetString() == "ready" &&
        download.TryGetProperty("version", out var version) && version.ValueKind == JsonValueKind.String ? version.GetString() : null;

    private static bool HasWork(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Array) return value.EnumerateArray().Any(HasWork);
        if (value.ValueKind != JsonValueKind.Object) return false;
        foreach (var property in value.EnumerateObject())
        {
            if ((property.Name is "activeTaskId" or "activeRunId") && property.Value.ValueKind == JsonValueKind.String &&
                !string.IsNullOrEmpty(property.Value.GetString())) return true;
            if (property.Name == "activeTaskIds" && property.Value.ValueKind == JsonValueKind.Array && property.Value.GetArrayLength() > 0) return true;
            if ((property.Name is "running" or "integrating") && property.Value.ValueKind == JsonValueKind.True) return true;
            if ((property.Name is "status" or "state") && property.Value.ValueKind == JsonValueKind.String &&
                new[] { "running", "preparing", "queued", "planning", "verifying", "waiting_approval" }.Contains(property.Value.GetString())) return true;
        }
        return false;
    }
    internal static async Task StopInstalledHub(string root)
    {
        using var process = OwnedHub(root);
        if (process == null) return;
        using var client = Client();
        using var health = await GetJson(client, "/api/health"); ValidateHealth(health.RootElement);
        // Secret path first: the session file of THIS listener (a stale file from an earlier launch never qualifies).
        var session = HubSession.ReadForListener(HubSession.DefaultStateDirectory(), 3007);
        var secret = session != null && session.Pid == process.Id ? session.Secret : null;
        // No secret and a Hub that says it needs one: it is a current build whose session cannot be read, so refuse. Only a
        // Hub that predates the secret (v3.9.0 and older, no "auth" in its health) is stopped with the older session-token flow.
        if (secret == null && RequiresBearer(health.RootElement))
            throw new InvalidOperationException("The running Hub requires its session file, which is missing or unreadable. Nothing was stopped; close DatGold, run STOP-CHATMCP-HUB.cmd and retry.").Tag("hub_stop_failed");
        using var state = await GetJson(client, "/api/state", secret);
        var data = state.RootElement;
        var inState = WorkInState(data);
        if (inState != null) throw new InvalidOperationException(inState).Tag("tasks_running");
        using var coding = await GetJson(client, "/api/studio/coding", secret);
        var inCoding = WorkInCoding(coding.RootElement);
        if (inCoding != null) throw new InvalidOperationException(inCoding).Tag("tasks_running");
        if (!data.TryGetProperty("csrfToken", out var token) || token.ValueKind != JsonValueKind.String ||
            !System.Text.RegularExpressions.Regex.IsMatch(token.GetString() ?? "", "^[A-Za-z0-9_-]{16,256}$"))
            throw new InvalidOperationException("Hub shutdown session is invalid.").Tag("hub_stop_failed");
        if (process.HasExited || ListenerPid() != process.Id) throw new IOException("Hub changed before shutdown; retry.").Tag("hub_stop_failed");
        using var request = secret == null ? new HttpRequestMessage(HttpMethod.Post, Origin + "/api/hub/shutdown") : HubSession.Authorized(HttpMethod.Post, Origin + "/api/hub/shutdown", secret);
        request.Content = new StringContent("{}", Encoding.UTF8, "application/json");
        request.Headers.Add("Origin", Origin); request.Headers.Add("X-ChatMCP-Request", "local-dashboard");
        request.Headers.Add("X-ChatMCP-CSRF", token.GetString());
        try
        {
            using var response = await client.SendAsync(request);
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException("The installed Hub refused shutdown.").Tag("hub_stop_failed");
        }
        catch (HttpRequestException) { /* ACK can be lost. Do not resend; verify exit. */ }
        catch (TaskCanceledException) { /* Same rule on a lost/timed-out ACK. */ }
        if (!process.WaitForExit(15000) || ListenerPid() != null)
            throw new IOException("Hub shutdown could not be confirmed. No files were replaced; wait and retry.").Tag("hub_stop_failed");
    }
}

/// <summary>What the Hub says before an update is applied: why it cannot be (null when it can), and the version it has downloaded and checked and the page therefore offered (null when it has none).</summary>
internal sealed record UpdatePreflight(string? BlockingWork, string? OfferedVersion);

/// <summary>
/// The code that a step of an installation carries when it refuses or fails, so that the result file (and through it the page) can say WHY in words of its own without reading the text of an exception, which can
/// hold a path. It is put in Exception.Data, so it works on any type of exception and changes none (a catch that looks for an IOException still finds it). The codes are a closed list.
/// </summary>
internal static class StepCode
{
    private const string Key = "datgold.step-code";

    /// <summary>The reasons an update can end without the new version: shell_not_exited, no_installation, not_newer, disk_full, pending_recovery, tasks_running, foreign_listener, hub_stop_failed, window_open, another_update, payload_invalid, install_failed.</summary>
    internal static readonly IReadOnlySet<string> Known = new HashSet<string>(StringComparer.Ordinal)
    {
        "shell_not_exited", "no_installation", "not_newer", "disk_full", "pending_recovery", "tasks_running", "foreign_listener", "hub_stop_failed", "window_open", "another_update", "payload_invalid", "install_failed",
    };

    internal static bool IsKnown(string? code) => code != null && Known.Contains(code);

    internal static T Tag<T>(this T error, string code) where T : Exception { error.Data[Key] = code; return error; }

    /// <summary>The code of <paramref name="error"/> or of the first exception inside it that has one; null for none (an empty code is none).</summary>
    internal static string? Of(Exception? error)
    {
        if (error == null) return null;
        if (error.Data[Key] is string code && code.Length > 0) return code;
        if (error is AggregateException many)
            foreach (var inner in many.InnerExceptions)
                if (Of(inner) is { } found) return found;
        return Of(error.InnerException);
    }
}
