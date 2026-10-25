using System.Diagnostics;
using System.Text;
using System.Text.Json;
using ChatMCP.Native;
using ChatMCP.Installer;

int checks = 0;
void Check(bool condition, string message) { if (!condition) throw new Exception(message); checks++; Console.WriteLine("PASS " + message); }
void Throws(Action action, string message)
{
    bool thrown = false; try { action(); } catch (Exception) { thrown = true; }
    Check(thrown, message);
}
Stream Bytes(string text) => new MemoryStream(Encoding.UTF8.GetBytes(text));
var scratch = Path.Combine(Path.GetTempPath(), "ChatMCP-native-unit-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(scratch);
try
{
    using var good = JsonDocument.Parse("{\"app\":\"chatmcp-local-hub\",\"version\":\"3.10.1\",\"uiBuild\":\"3.10.1-react-agent\"}");
    HubLifecycle.ValidateHealth(good.RootElement, "3.10.1"); Check(true, "exact application version and UI build accepted");
    using var old = JsonDocument.Parse("{\"app\":\"chatmcp-local-hub\",\"version\":\"3.8.3\",\"uiBuild\":\"3.8.3-react-agent\"}");
    Throws(() => HubLifecycle.ValidateHealth(old.RootElement, "3.10.1"), "old Hub refused even with HTTP 200");
    using var wrong = JsonDocument.Parse("{\"app\":\"foreign-service\",\"version\":\"3.10.1\"}");
    Throws(() => HubLifecycle.ValidateHealth(wrong.RootElement, "3.10.1"), "foreign service refused");
    using var noBuild = JsonDocument.Parse("{\"app\":\"chatmcp-local-hub\",\"version\":\"3.10.1\"}");
    Throws(() => HubLifecycle.ValidateHealth(noBuild.RootElement, "3.10.1"), "missing UI build refused");
    Check(InstallerEngine.AppVersion == "3.10.1", "installer display version derives from compiled assembly");
    var script = @"C:\Users\Native Test\ChatMCP\CHATMCP-HUB\hub.mjs";
    Check(HubLifecycle.IsHubCommand("node.exe \"" + script + "\" --port 3007 --no-open", script), "quoted Hub entrypoint with spaces is recognized");
    Check(!HubLifecycle.IsHubCommand("node.exe other.mjs \"" + script + "\" --port 3007", script), "Hub path supplied as an unrelated script argument is rejected");
    Check(!HubLifecycle.IsHubCommand("node.exe --eval \"" + script + "\"", script), "Node eval is not an owned Hub entrypoint");
    // Per-launch Hub secret: a current build says auth=bearer and is only attached to by a shell that can present the secret.
    using var bearer = JsonDocument.Parse("{\"app\":\"chatmcp-local-hub\",\"version\":\"3.10.1\",\"uiBuild\":\"3.10.1-react-agent\",\"auth\":\"bearer\"}");
    HubLifecycle.ValidateHealth(bearer.RootElement, "3.10.1", requireBearer: true); Check(HubLifecycle.RequiresBearer(bearer.RootElement), "current Hub (auth=bearer) accepted by the shell");
    Throws(() => HubLifecycle.ValidateHealth(good.RootElement, "3.10.1", requireBearer: true), "same-version Hub without session authentication is refused by the shell");
    HubLifecycle.ValidateHealth(good.RootElement); Check(!HubLifecycle.RequiresBearer(good.RootElement), "the installer can still identify (and stop) a Hub that predates the secret");

    var stateDir = Path.Combine(scratch, "hub state"); Directory.CreateDirectory(Path.Combine(stateDir, "run"));
    var sessionFile = HubSession.SessionPath(stateDir);
    var secret = new string('a', 64);
    string Session(string secretValue = "", int port = 3007, int pid = 4242, int version = 1, string app = "chatmcp-local-hub") =>
        JsonSerializer.Serialize(new { version, app, pid, port, secret = secretValue == "" ? secret : secretValue, nonce = "n", startedAt = "2026-01-01T00:00:00Z" });
    Check(HubSession.Read(stateDir, 3007) == null, "no session file: nothing to authenticate with");
    File.WriteAllText(sessionFile, Session());
    var read = HubSession.Read(stateDir, 3007);
    Check(read != null && read.Pid == 4242 && read.Port == 3007 && read.Secret == secret, "a published session is read");
    Check(HubSession.Read(stateDir, 3010) == null, "a session for another port is not used");
    File.WriteAllText(sessionFile, Session(secretValue: "short")); Check(HubSession.Read(stateDir, 3007) == null, "a weak secret is refused");
    File.WriteAllText(sessionFile, Session(app: "other-app")); Check(HubSession.Read(stateDir, 3007) == null, "a file for another application is refused");
    File.WriteAllText(sessionFile, Session(version: 2)); Check(HubSession.Read(stateDir, 3007) == null, "an unknown file version is refused");
    File.WriteAllText(sessionFile, "{not json"); Check(HubSession.Read(stateDir, 3007) == null, "a malformed file is refused");
    File.WriteAllText(sessionFile, new string(' ', 8000)); Check(HubSession.Read(stateDir, 3007) == null, "an oversized file is refused");
    File.WriteAllText(sessionFile, Session());
    Check(HubSession.ReadForListener(stateDir, 3007) == null || HubLifecycle.ListenerPid(3007) == 4242, "a file whose process is not the port's listener is stale and never used");
    Check(HubSession.DashboardUrl("http://127.0.0.1:3007", "abc_DEF-123456789012") == "http://127.0.0.1:3007/#chatmcp-boot=abc_DEF-123456789012", "the dashboard address carries the ticket in its fragment");
    var previous = Environment.GetEnvironmentVariable("CHATMCP_STATE_DIR");
    try
    {
        Environment.SetEnvironmentVariable("CHATMCP_STATE_DIR", Path.Combine(scratch, "custom"));
        Check(HubSession.DefaultStateDirectory() == Path.Combine(scratch, "custom"), "CHATMCP_STATE_DIR moves the session location like it moves the Hub's data");
        Environment.SetEnvironmentVariable("CHATMCP_STATE_DIR", null);
        Check(HubSession.DefaultStateDirectory().EndsWith(Path.Combine("ChatMCP", "hub"), StringComparison.OrdinalIgnoreCase), "otherwise %LOCALAPPDATA%\\ChatMCP\\hub, where the Hub keeps its data");
    }
    finally { Environment.SetEnvironmentVariable("CHATMCP_STATE_DIR", previous); }

    // Windows PowerShell as a child process gets no PSModulePath. A process started from PowerShell 7 has PowerShell 7's module folders first in it, and the Windows
    // PowerShell it starts would load them before its own: the helper that deletes Uninstall.exe lost Get-FileHash that way and left the file behind.
    var modulePath = Environment.GetEnvironmentVariable("PSModulePath");
    try
    {
        var marker = Path.Combine(scratch, "powershell 7 modules");
        Environment.SetEnvironmentVariable("PSModulePath", marker + ";" + modulePath);
        Environment.SetEnvironmentVariable("CHATMCP_NATIVE_UNIT_KEEP", "kept");
        var child = HubLifecycle.WindowsPowerShell("Get-Date");
        Check(child.FileName.EndsWith(@"WindowsPowerShell\v1.0\powershell.exe", StringComparison.OrdinalIgnoreCase) && Path.IsPathFullyQualified(child.FileName) && !child.UseShellExecute && child.CreateNoWindow,
            "the child is the machine's own Windows PowerShell, started without the shell and without a window");
        Check(child.ArgumentList.SequenceEqual(new[] { "-NoProfile", "-NonInteractive", "-EncodedCommand", Convert.ToBase64String(Encoding.Unicode.GetBytes("Get-Date")) }),
            "and it runs the command it is given, encoded, with no profile and no prompt");
        Check(!child.Environment.Keys.Any(key => string.Equals(key, "PSModulePath", StringComparison.OrdinalIgnoreCase)), "it is given no PSModulePath");
        Check(child.Environment["CHATMCP_NATIVE_UNIT_KEEP"] == "kept" && child.Environment.ContainsKey("Path"), "and the rest of the environment is handed on");
        Check(Environment.GetEnvironmentVariable("PSModulePath")!.StartsWith(marker, StringComparison.Ordinal), "while this process keeps its own PSModulePath");
        Environment.SetEnvironmentVariable("PSModulePath", null);
        foreach (var spelling in new[] { "psmodulepath", "PSMODULEPATH", "PsModulePath" })
        {
            Environment.SetEnvironmentVariable(spelling, marker);
            Check(!HubLifecycle.WindowsPowerShell("Get-Date").Environment.Keys.Any(key => string.Equals(key, "PSModulePath", StringComparison.OrdinalIgnoreCase)), "the child is given no " + spelling + " either");
            Environment.SetEnvironmentVariable(spelling, null);
        }
        // A real Windows PowerShell: the child that the control starts by hand sees the marker folder in its module path, the one the helper starts does not.
        Environment.SetEnvironmentVariable("PSModulePath", marker + ";" + modulePath);
        string ModulePathSeenBy(ProcessStartInfo start)
        {
            start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            using var process = Process.Start(start) ?? throw new IOException("Cannot start Windows PowerShell.");
            var output = process.StandardOutput.ReadToEndAsync(); var errors = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(60000)) { process.Kill(); throw new IOException("Windows PowerShell did not end."); }
            return output.GetAwaiter().GetResult();
        }
        var raw = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe")) { UseShellExecute = false, CreateNoWindow = true };
        foreach (var argument in new[] { "-NoProfile", "-NonInteractive", "-Command", "$env:PSModulePath" }) raw.ArgumentList.Add(argument);
        Check(ModulePathSeenBy(raw).Contains(marker, StringComparison.OrdinalIgnoreCase), "premise: a Windows PowerShell started with this environment finds the PowerShell 7 folder in its module path");
        Check(!ModulePathSeenBy(HubLifecycle.WindowsPowerShell("$env:PSModulePath")).Contains(marker, StringComparison.OrdinalIgnoreCase), "and the one HubLifecycle.WindowsPowerShell starts does not");
    }
    finally { Environment.SetEnvironmentVariable("PSModulePath", modulePath); Environment.SetEnvironmentVariable("CHATMCP_NATIVE_UNIT_KEEP", null); }

    // A link from the page reaches the shell's message as the same string and never as script text.
    var hostile = "http://127.0.0.1:3007/#back\\slash'quote\"dq</script><img src=x onerror=window.__pwned=1>";
    Check(OpenLink.TryCreateMessage(hostile, out var message), "an http address with hostile characters is forwarded");
    using (var parsedMessage = JsonDocument.Parse(message))
        Check(parsedMessage.RootElement.GetProperty("type").GetString() == OpenLink.MessageType && parsedMessage.RootElement.GetProperty("url").GetString() == hostile,
            "the address survives the JSON message exactly");
    Check(!message.Contains("</script>") && !message.Contains("<img"), "and no markup is left in the message text");
    foreach (var blocked in new[] { "javascript:window.__pwned=1", "about:blank", "file:///C:/Windows/win.ini", "data:text/html,<script>1</script>", "ftp://127.0.0.1/", "chrome://settings", "relative/path", "", "http://" + new string('a', 9000) })
        Check(!OpenLink.TryCreateMessage(blocked, out _), "dropped: " + (blocked.Length > 40 ? blocked[..40] + "..." : blocked));
    Check(OpenLink.TryCreateMessage("HTTPS://Example.com/a?b=c#d", out _), "https is accepted");

    var root = Path.Combine(scratch, "installed app with spaces"); Directory.CreateDirectory(root);
    File.WriteAllText(Path.Combine(root, "a.txt"), "old-a"); File.WriteAllText(Path.Combine(root, "b.txt"), "old-b");
    File.WriteAllText(Path.Combine(root, "user.txt"), "keep-user");
    using (var tx = new InstallTransaction(root))
    {
        tx.Add("a.txt", Bytes("new-a")); tx.Add("new.txt", Bytes("created")); tx.RemoveObsolete("b.txt");
        int changed = 0;
        Throws(() => tx.Commit((_, _) => { if (++changed == 3) throw new IOException("interrupted progress callback"); }),
            "mid-commit failure rolls back changed and obsolete files");
    }
    Check(File.ReadAllText(Path.Combine(root, "a.txt")) == "old-a" && File.ReadAllText(Path.Combine(root, "b.txt")) == "old-b" &&
        !File.Exists(Path.Combine(root, "new.txt")), "rollback restores exact old bytes and removes only new files");
    Check(!File.Exists(Path.Combine(root, InstallTransaction.PendingName)), "successful rollback clears pending marker");
    using (var locked = new FileStream(Path.Combine(root, "b.txt"), FileMode.Open, FileAccess.Read, FileShare.None))
    using (var tx = new InstallTransaction(root))
    {
        tx.Add("a.txt", Bytes("must-not-appear")); tx.Add("b.txt", Bytes("new-b"));
        Throws(() => tx.Commit((_, _) => { }), "locked destination fails preflight before any replacement");
        Check(File.ReadAllText(Path.Combine(root, "a.txt")) == "old-a", "preflight failure leaves earlier files untouched");
    }
    using (var tx = new InstallTransaction(root))
    {
        tx.Add("folder/file.txt", Bytes("one"));
        Throws(() => tx.Add("folder\\file.txt", Bytes("two")), "duplicate slash-normalized archive entry refused");
        Throws(() => tx.Add("../escape.txt", Bytes("x")), "archive traversal refused");
    }
    using (var tx = new InstallTransaction(root))
    {
        tx.Add("a.txt", Bytes("updated-a")); tx.RemoveObsolete("b.txt"); tx.Commit((_, _) => { });
    }
    Check(File.ReadAllText(Path.Combine(root, "a.txt")) == "updated-a" && !File.Exists(Path.Combine(root, "b.txt")), "successful transaction commits replacement and owned deletion");
    Check(File.ReadAllText(Path.Combine(root, "user.txt")) == "keep-user", "unrelated user file preserved");

    // An unchanged runtime must not be rewritten/backed up just because its
    // containing product version changed. Timestamp preservation proves no
    // replacement occurred; progress inspects the actual transaction backup.
    var same = Path.Combine(root, "same.txt");
    File.WriteAllText(same, "same-runtime");
    File.SetLastWriteTimeUtc(same, new DateTime(2020, 1, 2, 3, 4, 5, DateTimeKind.Utc));
    var stableTime = File.GetLastWriteTimeUtc(same);
    using (var tx = new InstallTransaction(root))
    {
        tx.Add("same.txt", Bytes("same-runtime")); tx.Add("a.txt", Bytes("fast-a"));
        bool inspected = false;
        tx.Commit((_, _) =>
        {
            if (inspected) return;
            inspected = true;
            var work = Directory.GetDirectories(root, ".ChatMCP-update-*").Single();
            Check(Directory.GetFiles(Path.Combine(work, "old")).Length == 1,
                "unchanged verified runtime is not copied into the rollback backup");
        });
        Check(tx.Files.ContainsKey("same.txt"), "unchanged verified runtime stays in the ownership manifest");
    }
    Check(File.ReadAllText(same) == "same-runtime" && File.GetLastWriteTimeUtc(same) == stableTime,
        "unchanged runtime retains exact bytes and last-write timestamp");
    using (var locked = new FileStream(same, FileMode.Open, FileAccess.Read, FileShare.None))
    using (var tx = new InstallTransaction(root))
    {
        tx.Add("a.txt", Bytes("must-not-appear")); tx.Add("same.txt", Bytes("same-runtime"));
        Throws(() => tx.Commit((_, _) => { }), "unchanged runtime still receives exclusive-lock preflight");
        Check(File.ReadAllText(Path.Combine(root, "a.txt")) == "fast-a", "unchanged-file lock refusal precedes all replacements");
    }
    using (var tx = new InstallTransaction(root))
    {
        tx.Add("a.txt", Bytes("rolled-back-a")); tx.Add("same.txt", Bytes("same-runtime"));
        bool edited = false;
        Throws(() => tx.Commit((_, _) =>
        {
            if (!edited) { edited = true; File.WriteAllText(same, "external-change"); }
        }), "unchanged runtime hash is rechecked after preflight");
    }
    Check(File.ReadAllText(same) == "external-change" && File.ReadAllText(Path.Combine(root, "a.txt")) == "fast-a",
        "concurrent edit is preserved while actual installer replacements roll back");
    using (var tx = new InstallTransaction(Path.Combine(scratch, "many runtime files")))
    {
        for (int i = 0; i < 128; i++) tx.Add($"runtime-{i}.txt", Bytes("fixture"));
        int updates = 0, last = -1;
        tx.Commit((percent, _) => { updates++; if (percent <= last) throw new Exception("Progress must advance"); last = percent; });
        Check(updates <= 36 && last == 80, "large payload progress is bounded by percentage, not file count");
    }

    File.WriteAllText(Path.Combine(root, InstallTransaction.PendingName), "{}");
    Throws(() => { using var tx = new InstallTransaction(root); }, "interrupted update marker blocks a blind second update");
    File.Delete(Path.Combine(root, InstallTransaction.PendingName));
    using (var gate = HubLifecycle.AcquireUpdateLock(root))
    {
        try
        {
            bool refused = Task.Run(() => { try { using var other = HubLifecycle.AcquireUpdateLock(root); other.ReleaseMutex(); return false; } catch (InvalidOperationException) { return true; } }).GetAwaiter().GetResult();
            Check(refused, "installer and launcher process-start lock excludes concurrent threads");
        }
        finally { gate.ReleaseMutex(); }
    }
    Console.WriteLine(JsonSerializer.Serialize(new { result = "PASS", checks, scope = "real shared native classes; Windows filesystem" }));
}
finally { Directory.Delete(scratch, recursive: true); }
