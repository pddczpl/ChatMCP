using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using ChatMCP.Installer;
using ChatMCP.Native;

// Recover: an update that stopped halfway puts the installation back by itself (installer/InstallRecovery.cs). The states it works on are made the way a real failure makes them: a child process of this
// test program runs a real InstallTransaction.Commit and kills itself in the middle (CrashChild, Process.Kill: no finally, no rollback, as a power cut), so the marker, the journal, the backups and the
// half-replaced files are exactly what the transaction leaves. Each crash point is made ONCE (a template) and every case works on a copy of it.
//
// What is held here: the repair puts every file back and leaves nothing of the update behind; it makes the same decision as the rollback of the transaction for every file the commit changed (it is stricter for an entry the commit never reached: a file that is neither the old nor the new bytes is refused); it refuses, and
// changes NOTHING, whenever it cannot prove that the installation is what the journal says; it can be run again after a stop in the middle; it never touches anything outside the installation folder; and
// the marker and the journal it reads are the ones the setups of 3.9.0 to 3.10.2 wrote.
internal static partial class RecoverTests
{
    private const string Unchanged = "{\"keep\":true}";
    private static readonly List<string> Junctions = new();
    private static readonly Dictionary<int, string> Templates = new();

    /// <summary>The installation of one case: a folder that holds the installation, a sentinel in the data folder beside it (nothing may touch that), and the path of a program outside the installation.</summary>
    private sealed record Inst(string Root, string Install, string Program)
    {
        internal string Marker => Path.Combine(Install, InstallTransaction.PendingName);
        internal string Workspace => Directory.GetDirectories(Install, ".ChatMCP-update-*").Single();
        internal string Journal => Path.Combine(Workspace, "journal.json");
        internal string Sentinel => Path.Combine(Root, "data", "hub", "sentinel.json");
        internal string At(string relative) => Path.Combine(Install, relative.Replace('/', '\\'));
    }

    private static Stream Bytes(string text) => new MemoryStream(Encoding.UTF8.GetBytes(text));

    // ---- the installation that the interrupted update works on. The child and the parent make it the same way, in the same order of change: a.txt (replaced), sub/new.txt (created), same.txt (identical in
    // the payload: never touched), sub/c.txt (replaced), b.txt (removed as obsolete). A file of the owner's is not in the payload.
    internal static void Prepare(string folder)
    {
        Directory.CreateDirectory(Path.Combine(folder, "sub"));
        File.WriteAllText(Path.Combine(folder, "a.txt"), "old-a");
        File.WriteAllText(Path.Combine(folder, "b.txt"), "old-b");
        File.WriteAllText(Path.Combine(folder, "same.txt"), "same");
        File.WriteAllText(Path.Combine(folder, "sub", "c.txt"), "old-c");
        File.WriteAllText(Path.Combine(folder, "keep.txt"), "the owner's own file");
    }

    internal static void Stage(InstallTransaction transaction)
    {
        transaction.Add("a.txt", Bytes("new-a")); transaction.Add("sub/new.txt", Bytes("created by the update")); transaction.Add("same.txt", Bytes("same"));
        transaction.Add("sub/c.txt", Bytes("new-c")); transaction.RemoveObsolete("b.txt");
    }

    private static readonly (string Relative, string Text)[] BeforeTheUpdate =
    {
        ("a.txt", "old-a"), ("b.txt", "old-b"), ("same.txt", "same"), ("sub/c.txt", "old-c"), ("keep.txt", "the owner's own file"),
    };

    private static bool IsBeforeTheUpdate(Inst s) =>
        BeforeTheUpdate.All(file => File.Exists(s.At(file.Relative)) && File.ReadAllText(s.At(file.Relative)) == file.Text) && !File.Exists(s.At("sub/new.txt"));

    private static string? Content(Inst s, string relative) => File.Exists(s.At(relative)) ? File.ReadAllText(s.At(relative)) : null;

    /// <summary>Runs a real commit in a child process of this program that kills itself after the <paramref name="step"/>th change. Returns its exit code (never 0 when it died).</summary>
    private static int Crash(string install, int step)
    {
        var self = Environment.ProcessPath!;
        var start = new ProcessStartInfo(self) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        if (string.Equals(Path.GetFileNameWithoutExtension(self), "dotnet", StringComparison.OrdinalIgnoreCase)) start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "NativeLifecycle.Tests.dll"));
        start.ArgumentList.Add("--crash-commit"); start.ArgumentList.Add(install); start.ArgumentList.Add(step.ToString());
        using var child = Process.Start(start)!;
        var output = child.StandardOutput.ReadToEndAsync(); var errors = child.StandardError.ReadToEndAsync();
        if (!child.WaitForExit(120000)) { child.Kill(true); throw new TimeoutException("the child that kills itself in the middle of a commit did not end"); }
        return child.ExitCode;
    }

    private static string Template(TestKit kit, int step)
    {
        if (Templates.TryGetValue(step, out var found)) return found;
        var root = kit.Folder("crash-after-" + step);
        var install = Path.Combine(root, "installed app");
        Prepare(install);
        var exit = Crash(install, step);
        kit.Check(exit != 0 && File.Exists(Path.Combine(install, InstallTransaction.PendingName)) && Directory.GetDirectories(install, ".ChatMCP-update-*").Length == 1,
            "premise: a commit that is killed after change " + step + " (exit " + exit + ") leaves the marker and the retained backup, as a power cut does");
        Templates[step] = root;
        return root;
    }

    private static void CopyTree(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var file in Directory.GetFiles(from)) File.Copy(file, Path.Combine(to, Path.GetFileName(file)));
        foreach (var directory in Directory.GetDirectories(from)) CopyTree(directory, Path.Combine(to, Path.GetFileName(directory)));
    }

    /// <summary>A copy of the state that a crash after change <paramref name="step"/> leaves, with a sentinel file in a data folder beside the installation.</summary>
    private static Inst Copy(TestKit kit, int step, string name)
    {
        var template = Template(kit, step);
        var root = kit.Folder(name);
        CopyTree(template, root);
        var inst = new Inst(root, Path.Combine(root, "installed app"), Path.Combine(root, "setup", "DatGoldSetup.exe"));
        Directory.CreateDirectory(Path.GetDirectoryName(inst.Sentinel)!);
        File.WriteAllText(inst.Sentinel, Unchanged);
        return inst;
    }

    private static bool SentinelIntact(Inst s) => File.Exists(s.Sentinel) && File.ReadAllText(s.Sentinel) == Unchanged;

    /// <summary>Every entry of the installation folder with the hash of each file, without following a link: what a refusal must leave exactly as it was.</summary>
    private static string Snapshot(string folder)
    {
        var lines = new List<string>();
        void Visit(string directory)
        {
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory).OrderBy(path => path, StringComparer.Ordinal))
            {
                var relative = Path.GetRelativePath(folder, entry);
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0) lines.Add(relative + "|link");
                else if ((attributes & FileAttributes.Directory) != 0) { lines.Add(relative + "/"); Visit(entry); }
                else
                {
                    using var stream = new FileStream(entry, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    lines.Add(relative + "|" + Convert.ToHexString(SHA256.HashData(stream)));
                }
            }
        }
        Visit(folder);
        return string.Join("\n", lines);
    }

    private static string MakeJunction(string link, string target)
    {
        Junctions.Add(link);
        var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe")) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
        start.ArgumentList.Add("/c"); start.ArgumentList.Add("mklink"); start.ArgumentList.Add("/J"); start.ArgumentList.Add(link); start.ArgumentList.Add(target);
        using var process = Process.Start(start)!;
        _ = process.StandardOutput.ReadToEndAsync();
        process.WaitForExit();
        if (process.ExitCode != 0) throw new IOException("mklink /J failed");
        return link;
    }

    private static JsonArray ReadJournal(Inst s) => JsonNode.Parse(File.ReadAllText(s.Journal))!.AsArray();
    private static void WriteJournal(Inst s, JsonArray journal) => File.WriteAllText(s.Journal, journal.ToJsonString());
    private static JsonObject EntryOf(JsonArray journal, string relative) => journal.Select(node => node!.AsObject()).Single(entry => entry["Relative"]!.GetValue<string>() == relative);
    private static void EditEntry(Inst s, string relative, Action<JsonObject> edit)
    {
        var journal = ReadJournal(s);
        edit(EntryOf(journal, relative));
        WriteJournal(s, journal);
    }
    private static string HashOf(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    internal static void Run(TestKit kit)
    {
        try { RunAll(kit); }
        finally { foreach (var link in Junctions) try { Directory.Delete(link); } catch (Exception) { /* already gone */ } }
    }

    private static void RunAll(TestKit kit)
    {
        // ---- a real interrupted update, at every point it can stop, is put back by itself
        for (var step = 1; step <= 5; step++)
        {
            var s = Copy(kit, step, "repair-after-" + step);
            kit.Check(!IsBeforeTheUpdate(s), "premise: after change " + step + " the installation is a mix of the old and the new version");
            var result = InstallRecovery.Run(s.Install, (_, _) => { }, s.Program);
            kit.Check(result == RecoveryResult.Repaired && IsBeforeTheUpdate(s), "stopped after change " + step + ": every file the update changed is back as it was and the one it created is gone (the file of the owner's and the identical one are as they were)");
            kit.Check(!File.Exists(s.Marker) && Directory.GetDirectories(s.Install, ".ChatMCP-update-*").Length == 0, "and the marker and the backup are gone: nothing of the update is left");
            using (new InstallTransaction(s.Install)) kit.Check(true, "so the setup accepts the folder again");
            kit.Check(InstallRecovery.Run(s.Install, (_, _) => { }, s.Program) == RecoveryResult.NothingToRepair && IsBeforeTheUpdate(s), "and a second repair finds nothing to repair and changes nothing");
            kit.Check(SentinelIntact(s), "while the data folder beside the installation was never touched");
        }

        // ---- a repair that stops in the middle is run again: whatever point it stopped at, the second run ends where an uninterrupted one would
        {
            var counted = Copy(kit, 5, "count-the-steps");
            var calls = new List<int>();
            InstallRecovery.Run(counted.Install, (percent, _) => calls.Add(percent), counted.Program);
            kit.Check(calls.Count(percent => percent >= 40) >= 6 && calls.SequenceEqual(calls.OrderBy(percent => percent)) && calls[0] == 10 && calls[^1] == 100, "the repair reports its progress in order, a step for each file it puts back and a last one at 100 (" + string.Join(",", calls) + ")");
            var acting = calls.Count(percent => percent >= 40);
            for (var stop = 1; stop <= acting; stop++)
            {
                var s = Copy(kit, 5, "stopped-at-" + stop);
                var seen = 0;
                Exception? thrown = null;
                try { InstallRecovery.Run(s.Install, (percent, _) => { if (percent >= 40 && ++seen == stop) throw new IOException("the power goes"); }, s.Program); } catch (Exception error) { thrown = error; }
                var markerLeft = File.Exists(s.Marker);
                var again = InstallRecovery.Run(s.Install, (_, _) => { }, s.Program);
                kit.Check(thrown is RecoveryException { Touched: true } && (markerLeft ? again == RecoveryResult.Repaired : again == RecoveryResult.NothingToRepair) && IsBeforeTheUpdate(s) && !File.Exists(s.Marker) && SentinelIntact(s),
                    "a repair that stops at step " + stop + " of " + acting + " (marker " + (markerLeft ? "still there" : "already gone") + ") is run again and the installation ends as it was before the update");
            }
        }
        {
            // a stop between the removal of the marker and the removal of the backup leaves a folder that nothing points to: it is not a thing to repair and it is not touched
            var s = Copy(kit, 5, "orphan");
            try { InstallRecovery.Run(s.Install, (percent, _) => { if (percent == 97) throw new IOException("the power goes"); }, s.Program); } catch (Exception) { /* the stop */ }
            var orphan = Directory.GetDirectories(s.Install, ".ChatMCP-update-*");
            kit.Check(!File.Exists(s.Marker) && orphan.Length == 1 && IsBeforeTheUpdate(s), "premise: the repair stopped after the marker went and before the backup did");
            var before = Snapshot(s.Install);
            kit.Check(InstallRecovery.Run(s.Install, (_, _) => { }, s.Program) == RecoveryResult.NothingToRepair && Snapshot(s.Install) == before, "no marker means nothing to repair: the leftover backup folder is left alone");
            using (new InstallTransaction(s.Install)) kit.Check(true, "and the setup works with it there");
        }
        {
            // a file that is held open stops the repair at that file; the rest that was done stays done, the marker stays, and once the file is let go the same call finishes
            var s = Copy(kit, 5, "file-in-use");
            FileStream? held = null;
            Exception? thrown = null;
            try
            {
                try
                {
                    InstallRecovery.Run(s.Install, (percent, _) => { if (percent >= 40 && held == null) held = new FileStream(s.At("sub/c.txt"), FileMode.Open, FileAccess.Read, FileShare.None); }, s.Program);
                }
                catch (Exception error) { thrown = error; }
                kit.Check(thrown is RecoveryException { Code: InstallRecovery.RestoreFailed, Touched: true } && File.Exists(s.Marker) && Content(s, "b.txt") == "old-b", "a file that is held open stops the repair there (restore_failed, files already changed), keeps the marker, and what came before it stays put back");
            }
            finally { held?.Dispose(); }
            kit.Check(InstallRecovery.Run(s.Install, (_, _) => { }, s.Program) == RecoveryResult.Repaired && IsBeforeTheUpdate(s), "and once the file is let go the repair is run again and finishes");
        }

        // ---- no marker, nothing to repair: nothing is touched, not even a backup folder that is lying there
        {
            var folder = kit.Folder("healthy");
            Prepare(folder);
            Directory.CreateDirectory(Path.Combine(folder, ".ChatMCP-update-0123456789abcdef0123456789abcdef", "old"));
            var before = Snapshot(folder);
            kit.Check(!InstallRecovery.MarkerExists(folder) && InstallRecovery.Run(folder, (_, _) => { }, Path.Combine(kit.Scratch, "setup.exe")) == RecoveryResult.NothingToRepair && Snapshot(folder) == before, "an installation with no marker has nothing to repair and is left exactly as it is");
            kit.Check(InstallerEngine.Recover(folder, (_, _) => { }) == RecoveryResult.NothingToRepair && Snapshot(folder) == before, "and so does the engine's call (it looks for the marker before it asks about a Hub, so a healthy installation never has its Hub stopped)");
            kit.Check(!InstallRecovery.MarkerExists(Path.Combine(folder, "no", "such", "folder")), "a folder that is not there has no marker either");
            File.WriteAllText(Path.Combine(folder, InstallTransaction.PendingName), "{}");
            kit.Check(InstallRecovery.MarkerExists(folder), "the marker is the file the transaction leaves");
            using var held = HubLifecycle.AcquireUpdateLock(folder);
            var refusal = Task.Run(() => { try { InstallerEngine.Recover(folder, (_, _) => { }); return null; } catch (Exception error) { return error; } }).GetAwaiter().GetResult();
            held.ReleaseMutex();
            kit.Check(refusal != null && StepCode.Of(refusal) == "another_update", "while another installation or update works on the folder the repair refuses (another_update) like the setup does");
        }

        RunRefusals(kit);
        RunHardening(kit);

        // ---- the same decisions as the rollback of the transaction. One table of states a file can be in, run through the real rollback (a commit that fails) and through the repair of a commit that was
        // killed at the same point: a file that the rollback leaves because somebody else changed it is a state the repair refuses, and anything else ends the same way in both.
        foreach (var (kind, relative, step) in new[] { ("replaced", "a.txt", 1), ("created", "sub/new.txt", 2), ("removed", "b.txt", 5) })
        {
            foreach (var disk in new[] { "as the update left it", "already put back", "missing", "changed by somebody else" })
            {
                void Tweak(Inst s)
                {
                    var file = s.At(relative);
                    switch (disk)
                    {
                        case "already put back":
                            if (kind == "created") { if (File.Exists(file)) File.Delete(file); } else File.WriteAllText(file, kind == "replaced" ? "old-a" : "old-b");
                            break;
                        case "missing": if (File.Exists(file)) File.Delete(file); break;
                        case "changed by somebody else": File.WriteAllText(file, "edited by somebody else"); break;
                    }
                }
                var rollbackRoot = kit.Folder("rollback");
                var rolled = new Inst(rollbackRoot, Path.Combine(rollbackRoot, "installed app"), Path.Combine(rollbackRoot, "setup.exe"));
                Prepare(rolled.Install);
                using (var transaction = new InstallTransaction(rolled.Install))
                {
                    Stage(transaction);
                    var changed = 0;
                    try { transaction.Commit((_, _) => { if (++changed == step) { Tweak(rolled); throw new IOException("the commit fails here"); } }); } catch (Exception) { /* the rollback has run (an IOException when it was whole, an AggregateException when it kept the marker) */ }
                }
                var rollbackKept = File.Exists(rolled.Marker);
                var rollbackContent = Content(rolled, relative);

                var repaired = Copy(kit, step, "repair-" + kind);
                Tweak(repaired);
                var before = Snapshot(repaired.Install);
                RecoveryException? refused = null; RecoveryResult? result = null;
                try { result = InstallRecovery.Run(repaired.Install, (_, _) => { }, repaired.Program); } catch (RecoveryException error) { refused = error; }
                var label = "a file " + kind + " by the update, " + disk;
                if (disk == "changed by somebody else")
                    kit.Check(rollbackKept && rollbackContent == "edited by somebody else" && refused is { Code: InstallRecovery.ForeignChanges, Touched: false } && Snapshot(repaired.Install) == before,
                        label + ": the rollback leaves it as it is and keeps the marker, and the repair refuses (foreign_changes) and changes nothing");
                else
                    kit.Check(!rollbackKept && result == RecoveryResult.Repaired && Content(repaired, relative) == rollbackContent && Content(repaired, relative) == (kind == "created" ? null : kind == "replaced" ? "old-a" : "old-b") && IsBeforeTheUpdate(repaired),
                        label + ": the rollback and the repair end the same way, with the file back as it was before the update (" + (rollbackContent ?? "absent") + ")");
            }
        }
    }
}
