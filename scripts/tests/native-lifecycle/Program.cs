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
    using var good = JsonDocument.Parse("{\"app\":\"chatmcp-local-hub\",\"version\":\"3.8.3\",\"uiBuild\":\"3.8.3-react-agent\"}");
    HubLifecycle.ValidateHealth(good.RootElement, "3.8.3"); Check(true, "exact application version and UI build accepted");
    using var old = JsonDocument.Parse("{\"app\":\"chatmcp-local-hub\",\"version\":\"3.8.2\",\"uiBuild\":\"3.8.2-react-agent\"}");
    Throws(() => HubLifecycle.ValidateHealth(old.RootElement, "3.8.3"), "old Hub refused even with HTTP 200");
    using var wrong = JsonDocument.Parse("{\"app\":\"foreign-service\",\"version\":\"3.8.3\"}");
    Throws(() => HubLifecycle.ValidateHealth(wrong.RootElement, "3.8.3"), "foreign service refused");
    using var noBuild = JsonDocument.Parse("{\"app\":\"chatmcp-local-hub\",\"version\":\"3.8.3\"}");
    Throws(() => HubLifecycle.ValidateHealth(noBuild.RootElement, "3.8.3"), "missing UI build refused");
    Check(InstallerEngine.AppVersion == "3.8.3", "installer display version derives from compiled assembly");
    var script = @"C:\Users\Native Test\ChatMCP\CHATMCP-HUB\hub.mjs";
    Check(HubLifecycle.IsHubCommand("node.exe \"" + script + "\" --port 3007 --no-open", script), "quoted Hub entrypoint with spaces is recognized");
    Check(!HubLifecycle.IsHubCommand("node.exe other.mjs \"" + script + "\" --port 3007", script), "Hub path supplied as an unrelated script argument is rejected");
    Check(!HubLifecycle.IsHubCommand("node.exe --eval \"" + script + "\"", script), "Node eval is not an owned Hub entrypoint");
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
