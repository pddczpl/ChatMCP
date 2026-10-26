using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
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
var kit = new TestKit(scratch); // the tests of the update steps are in their own files and count themselves
try
{
    using var good = JsonDocument.Parse("{\"app\":\"chatmcp-local-hub\",\"version\":\"3.10.2\",\"uiBuild\":\"3.10.2-react-agent\"}");
    HubLifecycle.ValidateHealth(good.RootElement, "3.10.2"); Check(true, "exact application version and UI build accepted");
    using var old = JsonDocument.Parse("{\"app\":\"chatmcp-local-hub\",\"version\":\"3.8.3\",\"uiBuild\":\"3.8.3-react-agent\"}");
    Throws(() => HubLifecycle.ValidateHealth(old.RootElement, "3.10.2"), "old Hub refused even with HTTP 200");
    using var wrong = JsonDocument.Parse("{\"app\":\"foreign-service\",\"version\":\"3.10.2\"}");
    Throws(() => HubLifecycle.ValidateHealth(wrong.RootElement, "3.10.2"), "foreign service refused");
    using var noBuild = JsonDocument.Parse("{\"app\":\"chatmcp-local-hub\",\"version\":\"3.10.2\"}");
    Throws(() => HubLifecycle.ValidateHealth(noBuild.RootElement, "3.10.2"), "missing UI build refused");
    Check(InstallerEngine.AppVersion == "3.10.2", "installer display version derives from compiled assembly");
    var script = @"C:\Users\Native Test\ChatMCP\CHATMCP-HUB\hub.mjs";
    Check(HubLifecycle.IsHubCommand("node.exe \"" + script + "\" --port 3007 --no-open", script), "quoted Hub entrypoint with spaces is recognized");
    Check(!HubLifecycle.IsHubCommand("node.exe other.mjs \"" + script + "\" --port 3007", script), "Hub path supplied as an unrelated script argument is rejected");
    Check(!HubLifecycle.IsHubCommand("node.exe --eval \"" + script + "\"", script), "Node eval is not an owned Hub entrypoint");
    // Per-launch Hub secret: a current build says auth=bearer and is only attached to by a shell that can present the secret.
    using var bearer = JsonDocument.Parse("{\"app\":\"chatmcp-local-hub\",\"version\":\"3.10.2\",\"uiBuild\":\"3.10.2-react-agent\",\"auth\":\"bearer\"}");
    HubLifecycle.ValidateHealth(bearer.RootElement, "3.10.2", requireBearer: true); Check(HubLifecycle.RequiresBearer(bearer.RootElement), "current Hub (auth=bearer) accepted by the shell");
    Throws(() => HubLifecycle.ValidateHealth(good.RootElement, "3.10.2", requireBearer: true), "same-version Hub without session authentication is refused by the shell");
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
    LinkTests.Run(kit);
    ReleaseVectorTests.Run(kit);
    StagingTests.Run(kit);
    ContractTests.Run(kit);
    WorkTests.Run(kit);
    ShortcutTests.Run(kit);
    UpdateRunTests.Run(kit);
    UpdateWordsTests.Run(kit);
    ApplyTests.Run(kit);

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
    // What the installer reads from the running Hub before it stops it. /api/state grows with use (445,101 bytes on the owner's machine) and was read
    // through a client that refused anything over 256 KiB: "Cannot write more bytes to the buffer than the configured maximum buffer size: 262144". An upgrade and an uninstall died on it
    // as soon as the state had grown that far, which no test saw because every test Hub is new. A one-shot HTTP server on a free loopback port stands in for the Hub.
    {
        (string Origin, Task Served) Serve(int padding)
        {
            var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
            var origin = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port;
            var body = Encoding.UTF8.GetBytes("{\"agent\":{\"tasks\":[]},\"padding\":\"" + new string('x', padding) + "\"}");
            var served = Task.Run(async () =>
            {
                try
                {
                    using var peer = await listener.AcceptTcpClientAsync();
                    using var stream = peer.GetStream();
                    var seen = new StringBuilder(); var buffer = new byte[4096];
                    while (!seen.ToString().Contains("\r\n\r\n")) { var read = await stream.ReadAsync(buffer); if (read == 0) break; seen.Append(Encoding.ASCII.GetString(buffer, 0, read)); }
                    await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n"));
                    await stream.WriteAsync(body); await stream.FlushAsync();
                }
                catch (IOException) { /* the client gave up on an answer that was too big: that is what one test asks for */ }
                catch (SocketException) { }
                finally { listener.Stop(); }
            });
            return (origin, served);
        }
        int PaddingOf(string origin)
        {
            using var client = HubLifecycle.Client();
            using var answer = HubLifecycle.GetJson(client, "/api/state", null, origin).GetAwaiter().GetResult();
            return answer.RootElement.GetProperty("padding").GetString()!.Length;
        }
        Check(PaddingOf(Serve(600_000).Origin) == 600_000, "the Hub's state is read whole when it is bigger than 256 KiB (the owner's was 445 KB)");
        Check(PaddingOf(Serve(5_000_000).Origin) == 5_000_000, "and when it has grown more than ten times over that");
        var runaway = Serve(3_000_000);
        using (var capped = HubLifecycle.Client(maxResponseBytes: 1_000_000))
            Throws(() => HubLifecycle.GetJson(capped, "/api/state", null, runaway.Origin).GetAwaiter().GetResult(), "an answer over the cap is still refused: the cap only bounds a runaway answer");
    }

    // Which Uninstall.exe setup takes for its own when the manifest of an installation does not list it. The setup file was ChatMCPSetup.exe (product "ChatMCP Studio Setup" up to
    // 3.10.0; "DatGold Studio Setup" but still the file name ChatMCPSetup.exe in 3.10.1 and 3.10.2) and is DatGoldSetup.exe from the release after 3.10.2. Every one of them is ours,
    // a stranger's is not, and a name in any one of the four fields is enough (the fields are what Windows shows under Properties > Details).
    {
        Check(InstallerEngine.IsOwnVersionInfo("ChatMCP Studio Setup", "ChatMCP Studio - Desktop Application Installer", "ChatMCPSetup.exe", "ChatMCPSetup.exe"), "an Uninstall.exe made by 3.10.0 or older is ours");
        Check(InstallerEngine.IsOwnVersionInfo("DatGold Studio Setup", "DatGold Studio - Desktop Application Installer", "ChatMCPSetup.exe", "ChatMCPSetup.exe"), "so is one made by 3.10.1 or 3.10.2 (new words, old file name)");
        Check(InstallerEngine.IsOwnVersionInfo("DatGold Studio Setup", "DatGold Studio - Desktop Application Installer", "DatGoldSetup.exe", "DatGoldSetup.exe"), "and one made by a setup that is called DatGoldSetup.exe");
        Check(InstallerEngine.IsOwnVersionInfo("Tools", "Installer", "Uninstall.exe", "DatGoldSetup.exe"), "the original file name alone is enough");
        Check(InstallerEngine.IsOwnVersionInfo("Tools", "Installer", "datgoldsetup.exe", "Uninstall.exe"), "so is the internal name alone, in any letter case");
        Check(InstallerEngine.IsOwnVersionInfo("DatGold Studio Setup", "", "", ""), "and the product alone");
        Check(!InstallerEngine.IsOwnVersionInfo("Contoso Tools", "Contoso uninstaller", "Uninstall.exe", "Uninstall.exe"), "an Uninstall.exe of another product is not ours");
        Check(!InstallerEngine.IsOwnVersionInfo(null, null, null, null) && !InstallerEngine.IsOwnVersionInfo("", "", "", ""), "and neither is a file without version information");
    }

    // Shortcuts. Versions up to 3.10.1 made theirs under the product's old name: the Desktop link "ChatMCP Studio.lnk" and a Start menu folder "ChatMCP" holding
    // "ChatMCP Studio.lnk" and "Uninstall ChatMCP Studio.lnk". Setup now makes the DatGold ones and removes the old ones that belong to this installation (and only
    // those); the uninstaller removes both sets. Real .lnk files, in scratch folders that stand in for the Desktop and the Start menu.
    {
        var app = Path.Combine(scratch, "shortcut app"); Directory.CreateDirectory(app);
        var launcher = Path.Combine(app, "ChatMCP.exe"); var uninstaller = Path.Combine(app, "Uninstall.exe"); var icon = Path.Combine(app, "chatmcp.ico");
        foreach (var file in new[] { launcher, uninstaller, icon }) File.WriteAllText(file, "fixture");
        var otherApp = Path.Combine(scratch, "another app"); Directory.CreateDirectory(otherApp);
        foreach (var name in new[] { "ChatMCP.exe", "Uninstall.exe" }) File.WriteAllText(Path.Combine(otherApp, name), "fixture");
        (string Desktop, string Programs) Machine(string name)
        {
            var folder = Path.Combine(scratch, "machine " + name);
            Directory.CreateDirectory(Path.Combine(folder, "Desktop")); Directory.CreateDirectory(Path.Combine(folder, "Programs"));
            return (Path.Combine(folder, "Desktop"), Path.Combine(folder, "Programs"));
        }
        void MadeBy3101((string Desktop, string Programs) machine, string installDir)
        {
            var folder = Path.Combine(machine.Programs, "ChatMCP"); Directory.CreateDirectory(folder);
            InstallerEngine.CreateShortcut(Path.Combine(machine.Desktop, "ChatMCP Studio.lnk"), Path.Combine(installDir, "ChatMCP.exe"), installDir, icon, "ChatMCP - Autonomous AI Coding Agent");
            InstallerEngine.CreateShortcut(Path.Combine(folder, "ChatMCP Studio.lnk"), Path.Combine(installDir, "ChatMCP.exe"), installDir, icon, "ChatMCP - Autonomous AI Coding Agent");
            InstallerEngine.CreateShortcut(Path.Combine(folder, "Uninstall ChatMCP Studio.lnk"), Path.Combine(installDir, "Uninstall.exe"), installDir, icon, "Uninstall ChatMCP Studio");
        }
        string TargetOf(string link)
        {
            dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")!)!;
            dynamic shortcut = shell.CreateShortcut(link);
            return (string)shortcut.TargetPath;
        }
        bool Points(string link, string target) => File.Exists(link) && string.Equals(Path.GetFullPath(TargetOf(link)), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase);
        bool Empty(string folder) => !Directory.EnumerateFileSystemEntries(folder).Any();
        string Old(string folder, params string[] parts) => Path.Combine(new[] { folder }.Concat(parts).ToArray());

        Check(InstallerEngine.AppName == "DatGold Studio" && InstallerEngine.AppDescription.StartsWith("DatGold", StringComparison.Ordinal),
            "setup names the shortcuts and the Apps & features entry DatGold Studio");

        var fresh = Machine("new install");
        InstallerEngine.CreateShortcuts(app, icon, fresh.Desktop, fresh.Programs, createDesktop: true, createStartMenu: true);
        Check(Points(Path.Combine(fresh.Desktop, "DatGold Studio.lnk"), launcher), "a new install makes the Desktop shortcut DatGold Studio.lnk, pointing at the launcher");
        Check(Points(Path.Combine(fresh.Programs, "DatGold", "DatGold Studio.lnk"), launcher) && Points(Path.Combine(fresh.Programs, "DatGold", "Uninstall DatGold Studio.lnk"), uninstaller),
            "and the Start menu folder DatGold with the launcher and the uninstaller");
        Check(!File.Exists(Path.Combine(fresh.Desktop, "ChatMCP Studio.lnk")) && !Directory.Exists(Path.Combine(fresh.Programs, "ChatMCP")), "and nothing under the old name");
        InstallerEngine.CreateShortcuts(app, icon, fresh.Desktop, fresh.Programs, true, true);
        Check(Points(Path.Combine(fresh.Desktop, "DatGold Studio.lnk"), launcher), "running setup again over its own shortcuts is harmless");
        var desktopOnly = Machine("desktop only"); InstallerEngine.CreateShortcuts(app, icon, desktopOnly.Desktop, desktopOnly.Programs, true, false);
        var menuOnly = Machine("menu only"); InstallerEngine.CreateShortcuts(app, icon, menuOnly.Desktop, menuOnly.Programs, false, true);
        Check(File.Exists(Path.Combine(desktopOnly.Desktop, "DatGold Studio.lnk")) && Empty(desktopOnly.Programs) && Empty(menuOnly.Desktop) && Directory.Exists(Path.Combine(menuOnly.Programs, "DatGold")),
            "each choice of the wizard makes only its own shortcuts");

        var upgraded = Machine("upgrade from 3.10.1"); MadeBy3101(upgraded, app);
        Check(File.Exists(Path.Combine(upgraded.Desktop, "ChatMCP Studio.lnk")) && Directory.GetFiles(Path.Combine(upgraded.Programs, "ChatMCP")).Length == 2,
            "premise: the machine holds the three shortcuts 3.10.1 made");
        InstallerEngine.ReplaceShortcuts(app, icon, upgraded.Desktop, upgraded.Programs, true, true);
        Check(!File.Exists(Path.Combine(upgraded.Desktop, "ChatMCP Studio.lnk")) && !Directory.Exists(Path.Combine(upgraded.Programs, "ChatMCP")),
            "an upgrade removes the three old shortcuts and the Start menu folder ChatMCP they leave empty");
        Check(Points(Path.Combine(upgraded.Desktop, "DatGold Studio.lnk"), launcher) && Points(Path.Combine(upgraded.Programs, "DatGold", "DatGold Studio.lnk"), launcher) &&
              Points(Path.Combine(upgraded.Programs, "DatGold", "Uninstall DatGold Studio.lnk"), uninstaller), "and makes the DatGold ones in their place");

        var declined = Machine("choices cleared"); MadeBy3101(declined, app);
        InstallerEngine.ReplaceShortcuts(app, icon, declined.Desktop, declined.Programs, false, false);
        Check(Empty(declined.Desktop) && Empty(declined.Programs), "with both choices cleared the old shortcuts still go (one name on the machine) and no new one is made");

        var userFile = Machine("user file in the old folder"); MadeBy3101(userFile, app);
        File.WriteAllText(Path.Combine(userFile.Programs, "ChatMCP", "notes.txt"), "mine");
        InstallerEngine.ReplaceShortcuts(app, icon, userFile.Desktop, userFile.Programs, true, true);
        Check(File.ReadAllText(Path.Combine(userFile.Programs, "ChatMCP", "notes.txt")) == "mine" && Directory.GetFiles(Path.Combine(userFile.Programs, "ChatMCP")).Length == 1,
            "the old folder goes only when it is empty: a file of the user's stays, the old shortcuts around it go");

        var another = Machine("another installation"); MadeBy3101(another, otherApp);
        InstallerEngine.ReplaceShortcuts(app, icon, another.Desktop, another.Programs, true, true);
        Check(Points(Path.Combine(another.Desktop, "ChatMCP Studio.lnk"), Path.Combine(otherApp, "ChatMCP.exe")) && Points(Old(another.Programs, "ChatMCP", "ChatMCP Studio.lnk"), Path.Combine(otherApp, "ChatMCP.exe")) &&
              Points(Old(another.Programs, "ChatMCP", "Uninstall ChatMCP Studio.lnk"), Path.Combine(otherApp, "Uninstall.exe")), "old-named shortcuts that point into another folder are not this installation's and are left alone");
        Check(Points(Path.Combine(another.Desktop, "DatGold Studio.lnk"), launcher), "while the new ones are made");

        // The shell stores a target as its long path; a setup started from a short (8.3) path must still recognise its own old shortcuts.
        dynamic fso = Activator.CreateInstance(Type.GetTypeFromProgID("Scripting.FileSystemObject")!)!;
        var shortApp = (string)fso.GetFolder(app).ShortPath;
        var shortened = Machine("short path"); MadeBy3101(shortened, app);
        InstallerEngine.ReplaceShortcuts(shortApp, icon, shortened.Desktop, shortened.Programs, true, true);
        Check(!File.Exists(Path.Combine(shortened.Desktop, "ChatMCP Studio.lnk")) && !Directory.Exists(Path.Combine(shortened.Programs, "ChatMCP")),
            "the old shortcuts are found whether the installation folder is spelled long or short (" + shortApp + ")");

        var stuck = Machine("locked"); MadeBy3101(stuck, app);
        var notes = new List<string>();
        using (new FileStream(Path.Combine(stuck.Desktop, "ChatMCP Studio.lnk"), FileMode.Open, FileAccess.Read, FileShare.Read)) // readable, but it cannot be deleted while it is open
            InstallerEngine.ReplaceShortcuts(app, icon, stuck.Desktop, stuck.Programs, true, true, notes.Add);
        Check(notes.Count == 1 && notes[0].Contains("ChatMCP Studio.lnk", StringComparison.Ordinal), "an old shortcut that cannot be removed is reported, once, and does not stop setup");
        Check(!Directory.Exists(Path.Combine(stuck.Programs, "ChatMCP")) && Points(Path.Combine(stuck.Desktop, "DatGold Studio.lnk"), launcher), "the other old shortcuts still go and the new ones are made");

        var both = Machine("uninstall"); MadeBy3101(both, app); InstallerEngine.CreateShortcuts(app, icon, both.Desktop, both.Programs, true, true);
        Check(Directory.GetFiles(both.Desktop).Length == 2 && Directory.GetDirectories(both.Programs).Length == 2, "premise: both name sets are on the machine (an upgrade that could not remove the old ones)");
        InstallerEngine.RemoveShortcuts(app, both.Desktop, both.Programs);
        Check(Empty(both.Desktop) && Empty(both.Programs), "the uninstaller removes the DatGold shortcuts and the old ones, and both Start menu folders");

        var foreign = Machine("uninstall with another installation's shortcuts"); MadeBy3101(foreign, otherApp);
        InstallerEngine.RemoveShortcuts(app, foreign.Desktop, foreign.Programs);
        Check(File.Exists(Path.Combine(foreign.Desktop, "ChatMCP Studio.lnk")) && Directory.GetFiles(Path.Combine(foreign.Programs, "ChatMCP")).Length == 2, "and leaves the shortcuts of another installation");
    }
    Console.WriteLine(JsonSerializer.Serialize(new { result = "PASS", checks = checks + kit.Count, scope = "real shared native classes; Windows filesystem" }));
}
finally { Directory.Delete(scratch, recursive: true); }
