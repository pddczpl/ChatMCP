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
            if (!acquired) throw new InvalidOperationException("Another DatGold installation/update is in progress. Wait for it to finish.");
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
            throw new InvalidOperationException("Port 3007 is not a verified DatGold Hub. No process was stopped.");
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
                throw new InvalidOperationException("Port 3007 belongs to a different installation or process. It was not stopped.");
            // Confirm the exact script as well as the bundled executable. WMI is
            // read-only; the only generated query argument is an integer PID.
            var psi = WindowsPowerShell($"(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid.Value}').CommandLine | ConvertTo-Json -Compress");
            psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
            using var probe = Process.Start(psi) ?? throw new IOException("Cannot verify the Hub command line.");
            var output = probe.StandardOutput.ReadToEndAsync(); var errors = probe.StandardError.ReadToEndAsync();
            if (!probe.WaitForExit(10000)) { probe.Kill(); throw new IOException("Hub ownership query timed out."); }
            if (probe.ExitCode != 0) throw new IOException("Hub ownership query failed.");
            var command = JsonSerializer.Deserialize<string>(output.GetAwaiter().GetResult()) ?? "";
            var script = Path.GetFullPath(Path.Combine(root, "CHATMCP-HUB", "hub.mjs"));
            if (!IsHubCommand(command, script))
                throw new InvalidOperationException("The listener is not the installed Hub script. It was not stopped.");
            if (process.HasExited || ListenerPid() != process.Id) throw new IOException("Hub changed during inspection; retry.");
            return process;
        }
        catch { process.Dispose(); throw; }
    }
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
            throw new InvalidOperationException("The running Hub requires its session file, which is missing or unreadable. Nothing was stopped; close DatGold, run STOP-CHATMCP-HUB.cmd and retry.");
        using var state = await GetJson(client, "/api/state", secret);
        var data = state.RootElement;
        if (!data.TryGetProperty("agent", out var agent) || HasWork(agent))
            throw new InvalidOperationException("Stop active DatGold tasks before installing or uninstalling. Nothing was cancelled.");
        if (data.TryGetProperty("studio", out var studio) && studio.ValueKind == JsonValueKind.Object)
            foreach (var name in new[] { "terminals", "delegates", "dynamicDelegates" })
                if (studio.TryGetProperty(name, out var work) && HasWork(work))
                    throw new InvalidOperationException("Stop DatGold terminals and background workers before upgrading.");
        using var coding = await GetJson(client, "/api/studio/coding", secret);
        if (HasWork(coding.RootElement)) throw new InvalidOperationException("Stop background coding jobs before upgrading.");
        if (!data.TryGetProperty("csrfToken", out var token) || token.ValueKind != JsonValueKind.String ||
            !System.Text.RegularExpressions.Regex.IsMatch(token.GetString() ?? "", "^[A-Za-z0-9_-]{16,256}$"))
            throw new InvalidOperationException("Hub shutdown session is invalid.");
        if (process.HasExited || ListenerPid() != process.Id) throw new IOException("Hub changed before shutdown; retry.");
        using var request = secret == null ? new HttpRequestMessage(HttpMethod.Post, Origin + "/api/hub/shutdown") : HubSession.Authorized(HttpMethod.Post, Origin + "/api/hub/shutdown", secret);
        request.Content = new StringContent("{}", Encoding.UTF8, "application/json");
        request.Headers.Add("Origin", Origin); request.Headers.Add("X-ChatMCP-Request", "local-dashboard");
        request.Headers.Add("X-ChatMCP-CSRF", token.GetString());
        try
        {
            using var response = await client.SendAsync(request);
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException("The installed Hub refused shutdown.");
        }
        catch (HttpRequestException) { /* ACK can be lost. Do not resend; verify exit. */ }
        catch (TaskCanceledException) { /* Same rule on a lost/timed-out ACK. */ }
        if (!process.WaitForExit(15000) || ListenerPid() != null)
            throw new IOException("Hub shutdown could not be confirmed. No files were replaced; wait and retry.");
    }
}
