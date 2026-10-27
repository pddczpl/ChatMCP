using System.Text.Json.Nodes;
using ChatMCP.Installer;
using ChatMCP.Native;

// What an independent read of the repair found that its first tests did not hold (see RecoverTests and RecoverRefusalTests for the rest):
//   * "there is no marker" is said only when the marker is provably not there; a folder that is not there, or cannot be looked at, is a REFUSAL, never a repair that "worked";
//   * a file is looked at again right before it is written or removed, as the rollback of the transaction does: what somebody else wrote in the minutes between the first phase and its turn is kept;
//   * the journal cannot name the update's own marker or backup, and a folder that is a file on the disk is found out before anything is changed;
//   * whatever goes wrong in the first phase comes out as a RecoveryException (a path in the form \\?\ used to come out as a bare IOException).
internal static partial class RecoverTests
{
    private static Exception? Thrown(Action action)
    {
        try { action(); return null; } catch (Exception error) { return error; }
    }

    private static void RunHardening(TestKit kit)
    {
        // ---- "no marker" is said only when it is true
        {
            var s = Copy(kit, 3, "provably-absent");
            var setup = s.Program;
            var absent = kit.Folder("no-marker-here"); Prepare(absent);
            kit.Check(InstallRecovery.Run(absent, (_, _) => { }, setup) == RecoveryResult.NothingToRepair, "a folder that is there and holds no marker has nothing to repair");

            var missing = Path.Combine(kit.Scratch, "no", "such", "folder");
            var gone = Thrown(() => InstallRecovery.Run(missing, (_, _) => { }, setup));
            kit.Check(gone is RecoveryException { Code: InstallRecovery.NotRecoverable, Touched: false }, "a folder that is not there is not an installation that needs nothing: the repair refuses it (not_recoverable) instead of saying all is well (got " + (gone?.GetType().Name ?? "no error") + ")");
            gone = Thrown(() => InstallRecovery.Check(missing, setup));
            kit.Check(gone is RecoveryException { Code: InstallRecovery.NotRecoverable }, "and so does a check");
            gone = Thrown(() => InstallerEngine.Recover(missing, (_, _) => { }));
            kit.Check(gone is RecoveryException { Code: InstallRecovery.NotRecoverable, Touched: false }, "and so does the engine's call, before it asks about a Hub (got " + (gone?.GetType().Name ?? "no error") + ")");

            // the command the launcher used to print ended in a backslash before the closing quote, so the folder arrived with a quote at its end: a folder that is not there
            var quoted = s.Install + "\"";
            var before = Snapshot(s.Install);
            gone = Thrown(() => InstallerEngine.Recover(quoted, (_, _) => { }));
            kit.Check(gone is RecoveryException { Code: InstallRecovery.NotRecoverable, Touched: false } && File.Exists(s.Marker) && Snapshot(s.Install) == before, "a folder spelled with a quote at its end (what a path ending in a backslash becomes inside quotes) is refused, not 'nothing to repair', while the marker is on the disk");

            // the installation is reached through a junction: the names cannot be trusted, so the answer is a refusal and not 'no marker'
            var link = MakeJunction(Path.Combine(kit.Scratch, "reached-through-a-link"), s.Root);
            var viaLink = Path.Combine(link, "installed app");
            kit.Check(File.Exists(Path.Combine(viaLink, InstallTransaction.PendingName)), "premise: the marker is there when the folder is reached through the junction");
            gone = Thrown(() => InstallRecovery.Run(viaLink, (_, _) => { }, setup));
            kit.Check(gone is RecoveryException { Code: InstallRecovery.NotRecoverable, Touched: false } && File.Exists(s.Marker) && Snapshot(s.Install) == before, "a folder reached through a junction is refused (not_recoverable): it is not reported as having nothing to repair (got " + (gone?.GetType().Name ?? "no error") + ")");

            // something with the marker's name that is not a file: not 'no marker' either
            File.Delete(s.Marker); Directory.CreateDirectory(s.Marker);
            var folderBefore = Snapshot(s.Install);
            gone = Thrown(() => InstallRecovery.Run(s.Install, (_, _) => { }, setup));
            kit.Check(gone is RecoveryException { Code: InstallRecovery.NotRecoverable, Touched: false } && Snapshot(s.Install) == folderBefore, "a folder where the marker should be is not 'no marker': it is refused and nothing is changed (got " + (gone?.GetType().Name ?? "no error") + ")");
            kit.Check(!InstallRecovery.MarkerExists(Path.Combine(kit.Scratch, "no", "such", "folder")), "(the wizard's own question stays gentle: a folder that is not there has no marker)");
        }

        // ---- a file is looked at again right before it is written or removed. The first phase proves what each file was; the rollback of the transaction hashes a file again when its turn comes, and so does this.
        // The change is made after the first file is back (the progress call), to a file whose turn has not come.
        foreach (var (kind, relative, note) in new[] { ("replaced", "a.txt", "the last one to be put back"), ("replaced", "sub/c.txt", "one in the middle"), ("created", "sub/new.txt", "a file the update created") })
        {
            var s = Copy(kit, 5, "changed-meanwhile-" + kind + "-" + relative.Replace('/', '-'));
            var edited = false;
            var thrown = Thrown(() => InstallRecovery.Run(s.Install, (percent, _) =>
            {
                if (percent < 40 || edited) return;
                edited = true;
                File.WriteAllText(s.At(relative), "written by the owner while the repair ran");
            }, s.Program));
            kit.Check(edited && thrown is RecoveryException { Code: InstallRecovery.ForeignChanges, Touched: true } && Content(s, relative) == "written by the owner while the repair ran" && File.Exists(s.Marker),
                "a file the update " + kind + " (" + note + ") that somebody changes after the first phase and before its turn is NOT written over or removed: foreign_changes, files already put back stay, the marker stays (got " + (thrown?.GetType().Name ?? "no error") + ")");
            var again = Thrown(() => InstallRecovery.Run(s.Install, (_, _) => { }, s.Program));
            kit.Check(again is RecoveryException { Code: InstallRecovery.ForeignChanges, Touched: false } && Content(s, relative) == "written by the owner while the repair ran", "and run again it refuses at once and changes nothing");
        }
        // all or nothing: a file that somebody changed BEFORE the repair began is found out by the first phase, before a single file is put back, wherever its turn would have come in the order of putting back
        // (the second look at a file is for what changes in the meantime, and refuses only when its turn comes)
        foreach (var (kind, relative) in new[] { ("created", "sub/new.txt"), ("replaced", "a.txt"), ("replaced", "sub/c.txt") })
        {
            var s = Copy(kit, 5, "all-or-nothing-" + kind + "-" + relative.Replace('/', '-'));
            File.WriteAllText(s.At(relative), "edited by somebody else");
            var before = Snapshot(s.Install);
            var thrown = Thrown(() => InstallRecovery.Run(s.Install, (_, _) => { }, s.Program));
            kit.Check(thrown is RecoveryException { Code: InstallRecovery.ForeignChanges, Touched: false } && Snapshot(s.Install) == before,
                "a file the update " + kind + " (" + relative + ") that somebody changed before the repair began is refused by the first phase, before ANY file is put back: nothing is touched (got " + (thrown is RecoveryException refusal ? refusal.Code + ", touched " + refusal.Touched : thrown?.GetType().Name ?? "no error") + ")");
        }
        {
            // the other states a file can come to in those minutes are not somebody else's change: already back is let be, gone is put back, and a file the update created that is already gone needs no removal
            var s = Copy(kit, 5, "meanwhile-benign");
            var done = false;
            var result = InstallRecovery.Run(s.Install, (percent, _) =>
            {
                if (percent < 40 || done) return;
                done = true;
                File.WriteAllText(s.At("a.txt"), "old-a");            // put back by somebody else already
                File.Delete(s.At("sub/c.txt"));                         // gone
                File.Delete(s.At("sub/new.txt"));                       // the created file is gone already
            }, s.Program);
            kit.Check(done && result == RecoveryResult.Repaired && IsBeforeTheUpdate(s) && !File.Exists(s.Marker), "a file that is already back, one that is gone and a created file that is gone are no foreign change: the repair finishes and the installation is as it was before the update");
        }
        {
            // a folder where a file was put back by the owner's hand, in those minutes
            var s = Copy(kit, 5, "meanwhile-folder");
            var done = false;
            var thrown = Thrown(() => InstallRecovery.Run(s.Install, (percent, _) =>
            {
                if (percent < 40 || done) return;
                done = true;
                File.Delete(s.At("a.txt")); Directory.CreateDirectory(s.At("a.txt"));
            }, s.Program));
            kit.Check(done && thrown is RecoveryException { Code: InstallRecovery.ForeignChanges, Touched: true } && Directory.Exists(s.At("a.txt")) && File.Exists(s.Marker), "a folder that takes the place of a file in those minutes is refused (foreign_changes) and left as it is");
        }
        {
            // a file that is held open when its turn comes is not 'damaged': restore_failed, and the files already put back are counted as touched
            var s = Copy(kit, 5, "meanwhile-held");
            FileStream? held = null;
            RecoveryException? stopped = null;
            try
            {
                try { InstallRecovery.Run(s.Install, (percent, _) => { if (percent >= 40 && held == null) held = new FileStream(s.At("a.txt"), FileMode.Open, FileAccess.Read, FileShare.None); }, s.Program); }
                catch (RecoveryException error) { stopped = error; }
                kit.Check(stopped is { Code: InstallRecovery.RestoreFailed, Touched: true } && File.Exists(s.Marker), "a file that another program holds open when its turn comes stops the repair there (restore_failed), and what was put back before it is said to have been touched");
            }
            finally { held?.Dispose(); }
            kit.Check(InstallRecovery.Run(s.Install, (_, _) => { }, s.Program) == RecoveryResult.Repaired && IsBeforeTheUpdate(s), "and the repair is run again and finishes once it is let go");
        }

        // ---- the journal does not get to name the update's own bookkeeping, and a folder that is a file is found out before anything is changed
        {
            void Refuses(string label, string code, Action<Inst> corrupt)
            {
                var s = Copy(kit, 3, "hardening-refuses");
                corrupt(s);
                var before = Snapshot(s.Install);
                RecoveryException? error = null;
                try { InstallRecovery.Run(s.Install, (_, _) => { }, s.Program); } catch (RecoveryException refusal) { error = refusal; }
                kit.Check(error != null && error.Code == code && !error.Touched && Snapshot(s.Install) == before, label + ": refused with " + code + " and nothing was changed" + (error == null ? " (it was NOT refused)" : " (got " + error.Code + ", touched " + error.Touched + ")"));
            }
            JsonObject Created(string relative) => new() { ["Relative"] = relative, ["Staged"] = null, ["NewHash"] = HashOf("x"), ["Backup"] = null, ["OldHash"] = null };
            void Add(Inst s, JsonObject entry) { var journal = ReadJournal(s); journal.Add(entry); WriteJournal(s, journal); }
            Refuses("an entry that names the marker of the update", InstallRecovery.NotRecoverable, s => Add(s, Created(InstallTransaction.PendingName)));
            Refuses("an entry that names the marker in capitals", InstallRecovery.NotRecoverable, s => Add(s, Created(InstallTransaction.PendingName.ToUpperInvariant())));
            Refuses("an entry that names a backup of the update", InstallRecovery.NotRecoverable, s => Add(s, Created(Path.GetFileName(s.Workspace) + "/old/000000")));
            Refuses("an entry that names the journal", InstallRecovery.NotRecoverable, s => Add(s, Created(Path.GetFileName(s.Workspace) + "/journal.json")));
            Refuses("an entry that names a folder of another update", InstallRecovery.NotRecoverable, s => Add(s, Created(".ChatMCP-update-" + new string('a', 32) + "/x.txt")));
            Refuses("an entry that names a folder of an update in other capitals", InstallRecovery.NotRecoverable, s => Add(s, Created(".CHATMCP-UPDATE-" + new string('a', 32) + "/x.txt")));
            Refuses("an entry that names the backup folder through the other separator", InstallRecovery.NotRecoverable, s => Add(s, Created(Path.GetFileName(s.Workspace) + "\\old\\000001")));
        }
        {
            // a folder of the installation that has been replaced by a file: the file inside it is 'missing', and the repair would put the others back and then fail at that one. It is found out first.
            var s = Copy(kit, 5, "folder-is-a-file");
            Directory.Delete(s.At("sub"), recursive: true); File.WriteAllText(s.At("sub"), "a file where the folder was");
            var before = Snapshot(s.Install);
            var thrown = Thrown(() => InstallRecovery.Run(s.Install, (_, _) => { }, s.Program));
            kit.Check(thrown is RecoveryException { Code: InstallRecovery.ForeignChanges, Touched: false } && Snapshot(s.Install) == before && File.Exists(s.Marker), "a folder of the installation that is a file on the disk is found out before anything is changed (foreign_changes, nothing touched; got " + (thrown?.GetType().Name ?? "no error") + ")");
        }

        // ---- cleaning up after a repair never goes below a link. The first phase does not look at the staged copies (the journal's Staged field is ignored), so a junction can sit in the backup folder; it points at a
        // folder of the owner's, and whatever is in it stays: the repair is done, the cleanup stops at the link and leaves what is left of the backup folder
        {
            var s = Copy(kit, 5, "link-inside-the-backup");
            var outside = Path.Combine(s.Root, "owners-files"); Directory.CreateDirectory(outside);
            File.WriteAllText(Path.Combine(outside, "precious.txt"), "not part of any update");
            var staged = Path.Combine(s.Workspace, "new");
            if (Directory.Exists(staged)) Directory.Delete(staged, recursive: true);
            MakeJunction(staged, outside);
            var result = InstallRecovery.Run(s.Install, (_, _) => { }, s.Program);
            kit.Check(result == RecoveryResult.Repaired && IsBeforeTheUpdate(s) && !File.Exists(s.Marker) && File.Exists(Path.Combine(outside, "precious.txt")) && File.ReadAllText(Path.Combine(outside, "precious.txt")) == "not part of any update",
                "a junction inside the backup folder is not followed when the backup is cleaned away: the installation is repaired, and the folder the junction points at keeps its files");
        }

        // ---- whatever goes wrong in the first phase is a RecoveryException, never a bare exception that the window would call 'another program has it open'
        {
            var s = Copy(kit, 3, "device-path");
            var before = Snapshot(s.Install);
            foreach (var spelling in new[] { @"\\?\" + s.Install, @"\\.\" + s.Install })
            {
                var thrown = Thrown(() => InstallRecovery.Run(spelling, (_, _) => { }, s.Program));
                kit.Check(thrown is RecoveryException { Touched: false } && Snapshot(s.Install) == before && File.Exists(s.Marker), "the folder spelled as a device path (" + spelling[..4] + ") is refused as a RecoveryException and nothing is changed (got " + (thrown?.GetType().Name ?? "no error") + ")");
            }
            var unreadable = Thrown(() => InstallRecovery.Run(s.Install + "|", (_, _) => { }, s.Program));
            kit.Check(unreadable is RecoveryException { Touched: false }, "and a folder whose name holds a character no folder can have is too (got " + (unreadable?.GetType().Name ?? "no error") + ")");
        }
    }
}
