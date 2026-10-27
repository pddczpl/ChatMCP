using System.Text.Json.Nodes;
using ChatMCP.Installer;
using ChatMCP.Native;

// The other half of the repair's promises (see RecoverTests): whenever it cannot PROVE that the installation is what the journal says, it refuses, says why with a code of its own, and changes NOTHING (not a
// file, not the marker, not the backup). Every case starts from a real interrupted update (a commit killed after change 3: one file replaced, one created, the rest not reached yet) and breaks one thing.
// And the marker and the journal that it reads are the ones the setups of 3.9.0 to 3.10.2 wrote: the format is a contract across versions (a setup N+k repairs what a setup N left).
internal static partial class RecoverTests
{
    private static void RunRefusals(TestKit kit)
    {
        void Refuses(string label, string code, Action<Inst> corrupt, Func<Inst, string>? program = null)
        {
            var s = Copy(kit, 3, "refuse");
            corrupt(s);
            var before = Snapshot(s.Install);
            RecoveryException? error = null;
            try { InstallRecovery.Run(s.Install, (_, _) => { }, program?.Invoke(s) ?? s.Program); } catch (RecoveryException refusal) { error = refusal; }
            kit.Check(error != null && error.Code == code && !error.Touched, label + ": refused with " + code + (error == null ? " (it was NOT refused)" : " (got " + error.Code + ", touched " + error.Touched + ")"));
            kit.Check(Snapshot(s.Install) == before && SentinelIntact(s), label + ": and nothing was changed");
        }
        void Marker(Inst s, string text) => File.WriteAllText(s.Marker, text);
        void MarkerWith(Inst s, JsonObject fields) => File.WriteAllText(s.Marker, fields.ToJsonString());
        void Add(Inst s, JsonObject entry) { var journal = ReadJournal(s); journal.Add(entry); WriteJournal(s, journal); }
        JsonObject Created(string relative, string text) => new() { ["Relative"] = relative, ["Staged"] = null, ["NewHash"] = HashOf(text), ["Backup"] = null, ["OldHash"] = null };

        // ---- the marker
        Refuses("an empty marker", InstallRecovery.NotRecoverable, s => File.WriteAllBytes(s.Marker, Array.Empty<byte>()));
        Refuses("a marker of zeros (a power cut before the data reached the disk)", InstallRecovery.NotRecoverable, s => File.WriteAllBytes(s.Marker, new byte[64]));
        Refuses("a marker that is not JSON", InstallRecovery.NotRecoverable, s => Marker(s, "not json"));
        Refuses("a marker that is a list", InstallRecovery.NotRecoverable, s => Marker(s, "[1]"));
        Refuses("a marker of another version", InstallRecovery.NotRecoverable, s => MarkerWith(s, new JsonObject { ["version"] = 2, ["backupDirectory"] = s.Workspace }));
        Refuses("a version that is text", InstallRecovery.NotRecoverable, s => MarkerWith(s, new JsonObject { ["version"] = "1", ["backupDirectory"] = s.Workspace }));
        Refuses("a marker with no backup folder", InstallRecovery.NotRecoverable, s => MarkerWith(s, new JsonObject { ["version"] = 1 }));
        Refuses("a backup folder that is a number", InstallRecovery.NotRecoverable, s => MarkerWith(s, new JsonObject { ["version"] = 1, ["backupDirectory"] = 5 }));
        Refuses("a backup folder that is not an update folder at all", InstallRecovery.NotRecoverable, s => MarkerWith(s, new JsonObject { ["version"] = 1, ["backupDirectory"] = @"C:\Windows" }));
        Refuses("a backup folder named like an update folder but with the wrong letters", InstallRecovery.NotRecoverable, s => MarkerWith(s, new JsonObject { ["version"] = 1, ["backupDirectory"] = Path.Combine(s.Install, ".ChatMCP-update-" + new string('z', 32)) }));
        Refuses("an update folder that is not there", InstallRecovery.NotRecoverable, s => MarkerWith(s, new JsonObject { ["version"] = 1, ["backupDirectory"] = Path.Combine(s.Install, ".ChatMCP-update-" + new string('f', 32)) }));
        Refuses("a marker of more than 4 KiB", InstallRecovery.NotRecoverable, s => Marker(s, new JsonObject { ["version"] = 1, ["backupDirectory"] = s.Workspace }.ToJsonString() + new string(' ', 5000)));
        Refuses("an update folder that is a junction", InstallRecovery.NotRecoverable, s =>
        {
            var real = Path.Combine(s.Root, "moved-backup");
            var link = s.Workspace;
            Directory.Move(link, real);
            MakeJunction(link, real);
        });

        // ---- the journal
        Refuses("a journal that is missing", InstallRecovery.NotRecoverable, s => File.Delete(s.Journal));
        Refuses("an empty journal (setups up to 3.10.2 did not flush it)", InstallRecovery.NotRecoverable, s => File.WriteAllBytes(s.Journal, Array.Empty<byte>()));
        Refuses("a journal of zeros", InstallRecovery.NotRecoverable, s => File.WriteAllBytes(s.Journal, new byte[64]));
        Refuses("a journal that is not JSON", InstallRecovery.NotRecoverable, s => File.WriteAllText(s.Journal, "not json"));
        Refuses("a journal that is an object", InstallRecovery.NotRecoverable, s => File.WriteAllText(s.Journal, "{}"));
        Refuses("a journal with no entry at all (it proves nothing about a half-done update)", InstallRecovery.NotRecoverable, s => File.WriteAllText(s.Journal, "[]"));
        Refuses("a journal of numbers", InstallRecovery.NotRecoverable, s => File.WriteAllText(s.Journal, "[1]"));
        Refuses("an entry with no fields", InstallRecovery.NotRecoverable, s => { var journal = ReadJournal(s); journal.Add(new JsonObject()); WriteJournal(s, journal); });
        Refuses("a file name that is a number", InstallRecovery.NotRecoverable, s => EditEntry(s, "a.txt", entry => entry["Relative"] = 5));
        Refuses("a new hash that is not a hash", InstallRecovery.NotRecoverable, s => EditEntry(s, "a.txt", entry => entry["NewHash"] = "xyz"));
        Refuses("an old hash of 63 digits", InstallRecovery.NotRecoverable, s => EditEntry(s, "a.txt", entry => entry["OldHash"] = new string('A', 63)));
        Refuses("an old hash that is a number", InstallRecovery.NotRecoverable, s => EditEntry(s, "a.txt", entry => entry["OldHash"] = 7));
        Refuses("the same file twice, in two spellings", InstallRecovery.NotRecoverable, s => { var again = JsonNode.Parse(EntryOf(ReadJournal(s), "a.txt").ToJsonString())!.AsObject(); again["Relative"] = "A.TXT"; Add(s, again); });
        // (a journal that is good JSON followed by 129 MiB of spaces: the limit refuses it before it is read, and a limit that was raised would let it through)
        Refuses("a journal of more than 128 MiB", InstallRecovery.NotRecoverable, s =>
        {
            using var file = new FileStream(s.Journal, FileMode.Append, FileAccess.Write);
            var spaces = new byte[1024 * 1024]; Array.Fill(spaces, (byte)' ');
            for (var megabyte = 0; megabyte < 129; megabyte++) file.Write(spaces);
        });
        Refuses("a file name that is a lone surrogate", InstallRecovery.NotRecoverable, s => File.WriteAllText(s.Journal, "[{\"Relative\":\"\\ud800.txt\",\"Staged\":null,\"NewHash\":null,\"Backup\":null,\"OldHash\":null}]"));
        Refuses("a backup folder that is a lone surrogate", InstallRecovery.NotRecoverable, s => Marker(s, "{\"version\":1,\"backupDirectory\":\"\\ud800\"}"));
        Refuses("a hash that is a lone surrogate", InstallRecovery.NotRecoverable, s => File.WriteAllText(s.Journal, "[{\"Relative\":\"a.txt\",\"Staged\":null,\"NewHash\":\"\\ud800\",\"Backup\":null,\"OldHash\":null}]"));

        // ---- the backup folder is found by its last name, and that name is exactly what the transaction makes (the folder is moved and the marker made to name it)
        void RefusesRenamed(string label, string folderName)
        {
            Refuses("a backup folder called " + label, InstallRecovery.NotRecoverable, s =>
            {
                var moved = Path.Combine(s.Install, folderName);
                Directory.Move(s.Workspace, moved);
                MarkerWith(s, new JsonObject { ["version"] = 1, ["backupDirectory"] = moved });
            });
        }
        const string Digits = "0123456789abcdef0123456789abcdef";
        RefusesRenamed("something that is no update folder", "kept-backup");
        RefusesRenamed("an update folder with 31 digits", ".ChatMCP-update-" + Digits[..31]);
        RefusesRenamed("an update folder with 33 digits", ".ChatMCP-update-" + Digits + "0");
        RefusesRenamed("an update folder with a name before it", "x.ChatMCP-update-" + Digits);
        RefusesRenamed("an update folder with a name after it", ".ChatMCP-update-" + Digits + ".old");
        RefusesRenamed("an update folder with capitals", ".ChatMCP-update-" + Digits.ToUpperInvariant());
        RefusesRenamed("an update folder in the other spelling of the prefix", ".chatmcp-update-" + Digits);
        {
            var s = Copy(kit, 3, "renamed-ok");
            var moved = Path.Combine(s.Install, ".ChatMCP-update-" + Digits);
            Directory.Move(s.Workspace, moved);
            MarkerWith(s, new JsonObject { ["version"] = 1, ["backupDirectory"] = @"D:\Another Machine\ChatMCP\.ChatMCP-update-" + Digits + "\\" });
            kit.Check(InstallRecovery.Run(s.Install, (_, _) => { }, s.Program) == RecoveryResult.Repaired && IsBeforeTheUpdate(s), "while a backup folder with another name of the same kind, named by a marker that spells the path as another machine did and ends in a separator, is the one that is repaired from");
        }

        // ---- a backup is found by its last name too: six digits, in a folder called old (each file made to exist with the old bytes, so that only its name is wrong)
        void RefusesBackupAt(string label, string folder, string name)
        {
            Refuses("a backup called " + label, InstallRecovery.NotRecoverable, s =>
            {
                var target = Path.Combine(s.Workspace, folder, name);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                File.Copy(Path.Combine(s.Workspace, "old", "000000"), target, overwrite: true);
                EditEntry(s, "a.txt", entry => entry["Backup"] = target);
            });
        }
        RefusesBackupAt("abc", "old", "abc");
        RefusesBackupAt("a single digit", "old", "0");
        RefusesBackupAt("seven digits", "old", "0000000");
        RefusesBackupAt("five digits and a letter", "old", "00000a");
        RefusesBackupAt("six digits in the folder of the new files", "new", "000000");
        RefusesBackupAt("six digits in a folder that only starts like old", "olds", "000000");
        {
            var s = Copy(kit, 3, "backup-spelled-elsewhere");
            EditEntry(s, "a.txt", entry => entry["Backup"] = @"D:\Another Machine\ChatMCP\.ChatMCP-update-" + Digits + @"\old\000000");
            kit.Check(InstallRecovery.Run(s.Install, (_, _) => { }, s.Program) == RecoveryResult.Repaired && IsBeforeTheUpdate(s), "while a backup whose path is spelled as another machine did, with the right last names, is the one in this backup folder");
        }
        Refuses("a file the update replaced that is a folder on the disk", InstallRecovery.NotRecoverable, s => { File.Delete(s.At("a.txt")); Directory.CreateDirectory(s.At("a.txt")); });
        {
            var s = Copy(kit, 3, "linked-journal");
            var real = Path.Combine(s.Workspace, "journal-real.json");
            File.Move(s.Journal, real);
            var linked = true;
            try { File.CreateSymbolicLink(s.Journal, real); } catch (Exception error) when (error is UnauthorizedAccessException or IOException) { linked = false; }
            if (linked)
            {
                var before = Snapshot(s.Install);
                RecoveryException? refusal = null;
                try { InstallRecovery.Run(s.Install, (_, _) => { }, s.Program); } catch (RecoveryException error) { refusal = error; }
                kit.Check(refusal is { Code: InstallRecovery.NotRecoverable, Touched: false } && Snapshot(s.Install) == before, "a journal that is a link is not followed: refused with not_recoverable, nothing changed");
            }
            else kit.Check(true, "(a link to a file cannot be made here without a privilege: the check is made on the runner)");
        }

        // ---- the names in it: nothing outside the installation, nothing through a link, nothing that is not a file
        Refuses("a file name that leaves the installation", InstallRecovery.NotRecoverable, s => EditEntry(s, "sub/new.txt", entry => entry["Relative"] = "../escape.txt"));
        Refuses("a file name with a drive", InstallRecovery.NotRecoverable, s => EditEntry(s, "sub/new.txt", entry => entry["Relative"] = @"C:\Windows\x.txt"));
        Refuses("a file name with a stream", InstallRecovery.NotRecoverable, s => EditEntry(s, "sub/new.txt", entry => entry["Relative"] = "a.txt:stream"));
        Refuses("a file name that ends in a dot", InstallRecovery.NotRecoverable, s => EditEntry(s, "sub/new.txt", entry => entry["Relative"] = "x."));
        Refuses("a file below a junction inside the installation", InstallRecovery.NotRecoverable, s =>
        {
            var elsewhere = Path.Combine(s.Root, "elsewhere"); Directory.CreateDirectory(elsewhere);
            MakeJunction(Path.Combine(s.Install, "linked"), elsewhere);
            Add(s, Created("linked/x.txt", "x"));
        });
        Refuses("a file the update created that is a folder on the disk", InstallRecovery.NotRecoverable, s => EditEntry(s, "sub/new.txt", entry => entry["Relative"] = "sub"));
        Refuses("a file in the data folder of the Hub, when that folder is inside the installation", InstallRecovery.NotRecoverable, s =>
        {
            Directory.CreateDirectory(Path.Combine(s.Install, "data"));
            File.WriteAllText(Path.Combine(s.Install, "data", "x.json"), "x");
            Add(s, Created("data/x.json", "x"));
        }, s => { Environment.SetEnvironmentVariable("CHATMCP_STATE_DIR", Path.Combine(s.Install, "data")); return s.Program; });
        Environment.SetEnvironmentVariable("CHATMCP_STATE_DIR", null);

        // ---- the shapes that the transaction never writes
        Refuses("an old hash and no backup, with a new hash that differs", InstallRecovery.NotRecoverable, s => EditEntry(s, "a.txt", entry => entry["Backup"] = null));
        Refuses("a backup and no old hash", InstallRecovery.NotRecoverable, s => EditEntry(s, "a.txt", entry => entry["OldHash"] = null));
        Refuses("a backup of a file that the update was not to change", InstallRecovery.NotRecoverable, s => EditEntry(s, "a.txt", entry => entry["NewHash"] = entry["OldHash"]!.GetValue<string>()));
        Refuses("a backup whose name is not a number of six digits", InstallRecovery.NotRecoverable, s => EditEntry(s, "a.txt", entry => entry["Backup"] = Path.Combine(s.Workspace, "old", "abc")));
        Refuses("a backup that is not in the folder of backups", InstallRecovery.NotRecoverable, s => EditEntry(s, "a.txt", entry => entry["Backup"] = Path.Combine(s.Workspace, "new", "000000")));
        Refuses("a backup file that is missing", InstallRecovery.NotRecoverable, s => File.Delete(Path.Combine(s.Workspace, "old", "000000")));
        Refuses("a backup that is not the file it was made from", InstallRecovery.NotRecoverable, s => File.WriteAllText(Path.Combine(s.Workspace, "old", "000000"), "damaged"));
        Refuses("a backup that is a folder", InstallRecovery.NotRecoverable, s => { var backup = Path.Combine(s.Workspace, "old", "000000"); File.Delete(backup); Directory.CreateDirectory(backup); });

        // ---- the disk is not what the journal says: the rule of the rollback (a file that is neither the old one nor the new one is somebody else's)
        Refuses("a replaced file that somebody else changed", InstallRecovery.ForeignChanges, s => File.WriteAllText(s.At("a.txt"), "edited by somebody else"));
        Refuses("a file the update created that somebody else changed", InstallRecovery.ForeignChanges, s => File.WriteAllText(s.At("sub/new.txt"), "edited by somebody else"));
        Refuses("a file the update was to remove that somebody else changed", InstallRecovery.ForeignChanges, s => File.WriteAllText(s.At("b.txt"), "edited by somebody else"));
        Refuses("one file that somebody else changed, with others that could be put back (all or nothing)", InstallRecovery.ForeignChanges, s => File.WriteAllText(s.At("sub/c.txt"), "edited by somebody else"));

        // ---- the program that repairs must not be a file of the installation that it repairs
        Refuses("a repair run by a program inside the installation (Uninstall.exe is in every journal)", InstallRecovery.InsideInstallation, s => { }, s => Path.Combine(s.Install, "Uninstall.exe"));
        Refuses("a repair run by a setup copied into a folder of the installation", InstallRecovery.InsideInstallation, s => { }, s => Path.Combine(s.Install, "sub", "DatGoldSetup.exe"));
        {
            var s = Copy(kit, 3, "outside-program");
            var neighbour = Path.Combine(Path.GetDirectoryName(s.Install)!, "installed app extra", "DatGoldSetup.exe");
            kit.Check(InstallRecovery.Run(s.Install, (_, _) => { }, neighbour) == RecoveryResult.Repaired && IsBeforeTheUpdate(s), "while a program in a folder whose name only STARTS like the installation's is outside it, and the repair goes on");
        }

        // ---- a file that is held open by another program stops it before anything is changed, and the same call finishes once it is let go
        {
            var s = Copy(kit, 3, "held");
            var before = Snapshot(s.Install);
            RecoveryException? error = null;
            using (new FileStream(s.At("a.txt"), FileMode.Open, FileAccess.Read, FileShare.None))
            {
                try { InstallRecovery.Run(s.Install, (_, _) => { }, s.Program); } catch (RecoveryException refusal) { error = refusal; }
            }
            kit.Check(error is { Code: InstallRecovery.RestoreFailed, Touched: false } && Snapshot(s.Install) == before, "a file that another program holds open is found out before anything is changed (restore_failed, nothing touched)");
            kit.Check(InstallRecovery.Run(s.Install, (_, _) => { }, s.Program) == RecoveryResult.Repaired && IsBeforeTheUpdate(s), "and once it is let go the repair goes through");
        }

        Refuses("a repair run by a program inside the installation, spelled in capitals", InstallRecovery.InsideInstallation, s => { }, s => Path.Combine(s.Install.ToUpperInvariant(), "UNINSTALL.EXE"));
        Refuses("an entry with no field for the new hash", InstallRecovery.NotRecoverable, s => EditEntry(s, "a.txt", entry => entry.Remove("NewHash")));
        Refuses("a folder of backups that is a junction", InstallRecovery.NotRecoverable, s =>
        {
            var folder = Path.Combine(s.Workspace, "old");
            var moved = Path.Combine(s.Root, "moved-old");
            Directory.Move(folder, moved);
            MakeJunction(folder, moved);
        });
        {
            // an entry that changes nothing, for a file that is there, is nothing to do (and the file is not touched)
            var s = Copy(kit, 3, "entry-of-nothing");
            Add(s, new JsonObject { ["Relative"] = "keep.txt", ["Staged"] = null, ["NewHash"] = null, ["Backup"] = null, ["OldHash"] = null });
            kit.Check(InstallRecovery.Run(s.Install, (_, _) => { }, s.Program) == RecoveryResult.Repaired && IsBeforeTheUpdate(s) && File.ReadAllText(s.At("keep.txt")) == "the owner's own file", "an entry that changes nothing, for a file that is there, asks nothing of the repair: the file is as it was");
        }
        {
            // the folder of a file that was replaced is gone: it is made again
            var s = Copy(kit, 5, "folder-gone");
            Directory.Delete(s.At("sub"), recursive: true);
            kit.Check(InstallRecovery.Run(s.Install, (_, _) => { }, s.Program) == RecoveryResult.Repaired && IsBeforeTheUpdate(s) && File.ReadAllText(s.At("sub/c.txt")) == "old-c", "a file that is put back into a folder that is gone gets its folder made again");
        }
        {
            // a backup folder that cannot be removed (a read-only file in it) does not fail a repair that is over: the installation is whole, the marker is gone, the folder only takes up disk space
            var s = Copy(kit, 5, "backup-read-only");
            var kept = Path.Combine(s.Workspace, "old", "000000");
            var workspace = s.Workspace;
            File.SetAttributes(kept, FileAttributes.ReadOnly);
            try
            {
                kit.Check(InstallRecovery.Run(s.Install, (_, _) => { }, s.Program) == RecoveryResult.Repaired && IsBeforeTheUpdate(s) && !File.Exists(s.Marker) && Directory.Exists(workspace), "a backup folder that cannot be removed does not fail a repair that is over: the installation is whole, the marker is gone, the folder is left");
            }
            finally { File.SetAttributes(kept, FileAttributes.Normal); }
        }
        {
            // the journal is held open by another program: found out before anything is changed, and not said to be damaged
            var s = Copy(kit, 3, "journal-held");
            var before = Snapshot(s.Install);
            RecoveryException? refusal = null;
            using (new FileStream(s.Journal, FileMode.Open, FileAccess.Read, FileShare.None))
            {
                try { InstallRecovery.Run(s.Install, (_, _) => { }, s.Program); } catch (RecoveryException error) { refusal = error; }
            }
            kit.Check(refusal is { Code: InstallRecovery.RestoreFailed, Touched: false } && Snapshot(s.Install) == before, "a journal that another program holds open is not damaged: restore_failed, nothing touched, and the same call goes through once it is let go");
            kit.Check(InstallRecovery.Run(s.Install, (_, _) => { }, s.Program) == RecoveryResult.Repaired && IsBeforeTheUpdate(s), "(the second call)");
        }

        {
            // a link that is put where a folder was AFTER the first phase looked is not written through: every name is checked again right before its file is written (as the rollback of the transaction does)
            var s = Copy(kit, 5, "link-after-the-plan");
            var outside = Path.Combine(s.Root, "elsewhere"); Directory.CreateDirectory(outside);
            var swapped = false;
            RecoveryException? stopped = null;
            try
            {
                InstallRecovery.Run(s.Install, (percent, _) =>
                {
                    if (percent < 40 || swapped) return;
                    swapped = true;
                    Directory.Move(s.At("sub"), Path.Combine(s.Root, "sub-moved"));
                    MakeJunction(s.At("sub"), outside);
                }, s.Program);
            }
            catch (RecoveryException error) { stopped = error; }
            kit.Check(swapped && stopped is { Code: InstallRecovery.RestoreFailed, Touched: true } && stopped.InnerException is InvalidOperationException && stopped.InnerException.Message.Contains("junctions or symbolic links") && Directory.GetFileSystemEntries(outside).Length == 0 && File.Exists(s.Marker),
                "a junction put where a folder was after the plan was made is refused as a link when its file comes (not written through): the repair stops, nothing reaches the folder it points to, and the marker stays (got " + (stopped?.InnerException?.GetType().Name ?? "no inner error") + ")");
        }

        {
            // a backup that is changed after the first phase looked at it never reaches the installation: the bytes are hashed while they are copied and checked BEFORE they replace the file
            var s = Copy(kit, 5, "backup-changed-meanwhile");
            var changed = false;
            RecoveryException? stopped = null;
            try
            {
                InstallRecovery.Run(s.Install, (percent, _) =>
                {
                    if (percent < 40 || changed) return;
                    changed = true;
                    File.WriteAllText(Path.Combine(s.Workspace, "old", "000001"), "garbage that is not the file it was made from");
                }, s.Program);
            }
            catch (RecoveryException error) { stopped = error; }
            kit.Check(changed && stopped is { Code: InstallRecovery.RestoreFailed, Touched: true } && File.ReadAllText(s.At("sub/c.txt")) == "new-c" && File.Exists(s.Marker) && Directory.GetFiles(Path.Combine(s.Install, "sub"), "*.tmp").Length == 0,
                "a backup that changed after the first phase is caught while it is copied: the file it was to replace is as it was, no temporary file is left, the repair stops and the marker stays");
        }

        // ---- the check that does not act: the same refusals, nothing changed
        {
            var good = Copy(kit, 3, "check-good");
            var before = Snapshot(good.Install);
            InstallRecovery.Check(good.Install, good.Program);
            kit.Check(Snapshot(good.Install) == before && File.Exists(good.Marker), "a check of a state that can be repaired returns and changes nothing");
            var bad = Copy(kit, 3, "check-bad");
            File.WriteAllText(bad.At("a.txt"), "edited by somebody else");
            var badBefore = Snapshot(bad.Install);
            RecoveryException? error = null;
            try { InstallRecovery.Check(bad.Install, bad.Program); } catch (RecoveryException refusal) { error = refusal; }
            kit.Check(error is { Code: InstallRecovery.ForeignChanges, Touched: false } && Snapshot(bad.Install) == badBefore, "and a check of one that cannot refuses the way the repair does");
            var healthy = kit.Folder("check-healthy");
            InstallRecovery.Check(healthy, good.Program);
            kit.Check(true, "(a folder with no marker needs no check)");
        }

        // ---- the retained update that the LIFECYCLE SCRIPT makes (its function New-RetainedUpdate; the script itself runs only on a disposable machine) is the state this repair has to work on there. Its own function is
        // run here, in Windows PowerShell, and the real repair works on what it makes: a fixture whose hashes were made up would be refused on the runner, which costs a run. With -ForeignEdit it is refused, and the block
        // of the setup guide (the way out by hand) puts it back.
        {
            var script = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Test-NativeLifecycle.ps1"));
            var function = System.Text.RegularExpressions.Regex.Match(script, @"(?ms)^function New-RetainedUpdate.*?^\}").Value;
            kit.Check(function.Length > 500 && function.Contains("-ForeignEdit") == false && function.Contains("[switch]$ForeignEdit"), "the lifecycle script defines New-RetainedUpdate, with a switch for a file that somebody else changed");
            string Powershell(string command, string what)
            {
                var start = HubLifecycle.WindowsPowerShell(command);
                start.RedirectStandardOutput = true; start.RedirectStandardError = true;
                using var shell = System.Diagnostics.Process.Start(start)!;
                var output = shell.StandardOutput.ReadToEndAsync(); var errors = shell.StandardError.ReadToEndAsync();
                kit.Check(shell.WaitForExit(120000) && shell.ExitCode == 0, what + (shell.HasExited && shell.ExitCode != 0 ? ": " + errors.GetAwaiter().GetResult() : ""));
                return output.GetAwaiter().GetResult();
            }
            Inst Retained(bool foreign, string name)
            {
                var root = kit.Folder(name);
                var install = Path.Combine(root, "installed app"); Directory.CreateDirectory(install);
                File.WriteAllText(Path.Combine(install, "replaced.txt"), "REPLACED-ORIGINAL"); File.WriteAllText(Path.Combine(install, "removed.txt"), "REMOVED-ORIGINAL");
                Powershell("$ErrorActionPreference = 'Stop'; " + function + "; $null = New-RetainedUpdate -Install '" + install.Replace("'", "''") + "' -Replaced 'replaced.txt' -Removed 'removed.txt' -Created 'sub/created.txt'" + (foreign ? " -ForeignEdit" : ""), "premise: the function of the lifecycle script makes the retained update");
                return new Inst(root, install, Path.Combine(root, "setup", "DatGoldSetup.exe"));
            }
            bool Back(Inst s) => File.ReadAllText(s.At("replaced.txt")) == "REPLACED-ORIGINAL" && File.ReadAllText(s.At("removed.txt")) == "REMOVED-ORIGINAL" && !File.Exists(s.At("sub/created.txt")) && !File.Exists(s.Marker) && Directory.GetDirectories(s.Install, ".ChatMCP-update-*").Length == 0;
            var whole = Retained(false, "lifecycle-fixture");
            kit.Check(File.Exists(whole.Marker) && File.ReadAllText(whole.At("replaced.txt")) != "REPLACED-ORIGINAL" && !File.Exists(whole.At("removed.txt")) && File.Exists(whole.At("sub/created.txt")), "premise: it is left as a half-done update leaves an installation");
            kit.Check(InstallRecovery.Run(whole.Install, (_, _) => { }, whole.Program) == RecoveryResult.Repaired && Back(whole), "and the real repair puts it back: the file that was replaced and the one that was removed as they were, the one that was created gone, no marker, no backup");
            var foreign = Retained(true, "lifecycle-fixture-foreign");
            var before = Snapshot(foreign.Install);
            RecoveryException? refusal = null;
            try { InstallRecovery.Run(foreign.Install, (_, _) => { }, foreign.Program); } catch (RecoveryException error) { refusal = error; }
            kit.Check(refusal is { Code: InstallRecovery.ForeignChanges, Touched: false } && Snapshot(foreign.Install) == before, "with a file that somebody else changed it is refused (foreign_changes) and nothing is changed");
            var guide = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "WINDOWS-SETUP.md")).Replace("\r\n", "\n");
            var block = System.Text.RegularExpressions.Regex.Matches(guide, "~~~powershell\n(.*?)\n~~~", System.Text.RegularExpressions.RegexOptions.Singleline).Select(match => match.Groups[1].Value).First(text => text.Contains("# recovery-from-retained-backup"));
            Powershell(System.Text.RegularExpressions.Regex.Replace(block, @"^\$install = .*$", "$$install = '" + foreign.Install.Replace("'", "''") + "'", System.Text.RegularExpressions.RegexOptions.Multiline), "the block of the setup guide runs to its end on it");
            kit.Check(Back(foreign), "and the block of the guide, the way out by hand, puts it back over what somebody else wrote");
        }

        // ---- the marker and the journal are those of the setups that are out there. v3.9.0 and v3.10.2 write the journal with JsonSerializer.Serialize(changes.Values) of the record (Relative, Staged, NewHash,
        // Backup, OldHash) and the marker as {version: 1, backupDirectory}; they spell the folders as the machine they ran on did. A later setup repairs what an earlier one left, wherever the folder is now.
        {
            var root = kit.Folder("vector");
            var install = Path.Combine(root, "installed app");
            var workspace = Path.Combine(install, ".ChatMCP-update-0123456789abcdef0123456789abcdef");
            Directory.CreateDirectory(Path.Combine(workspace, "old")); Directory.CreateDirectory(Path.Combine(install, "sub"));
            File.WriteAllText(Path.Combine(workspace, "old", "000000"), "old-a"); File.WriteAllText(Path.Combine(workspace, "old", "000002"), "old-b");
            File.WriteAllText(Path.Combine(install, "a.txt"), "new-a"); File.WriteAllText(Path.Combine(install, "sub", "new.txt"), "created");
            const string journalText = """
                [{"Relative":"a.txt","Staged":"C:\\Users\\Test User\\AppData\\Local\\Programs\\ChatMCP\\.ChatMCP-update-0123456789abcdef0123456789abcdef\\new\\000000","NewHash":"EB087A81AD5B9B33E836750B8CA913107257AA6A4AD6C98B6B3806AD931C6F0D","Backup":"C:\\Users\\Test User\\AppData\\Local\\Programs\\ChatMCP\\.ChatMCP-update-0123456789abcdef0123456789abcdef\\old\\000000","OldHash":"CD522A413738BBDFF1C710858A0410C83BCF515195CE35F856EF8086AD6AF946"},{"Relative":"sub/new.txt","Staged":"C:\\Users\\Test User\\AppData\\Local\\Programs\\ChatMCP\\.ChatMCP-update-0123456789abcdef0123456789abcdef\\new\\000001","NewHash":"406EFFB1E9C59672C66A598C2B21E331B23B16C54024E96D6DF3E7C173549791","Backup":null,"OldHash":null},{"Relative":"b.txt","Staged":null,"NewHash":null,"Backup":"C:\\Users\\Test User\\AppData\\Local\\Programs\\ChatMCP\\.ChatMCP-update-0123456789abcdef0123456789abcdef\\old\\000002","OldHash":"65F9888097D2D0746F54532271B835204493508C31BCA1B12482CCE90163F5F9"}]
                """;
            const string markerText = """
                {"version":1,"backupDirectory":"C:\\Users\\Test User\\AppData\\Local\\Programs\\ChatMCP\\.ChatMCP-update-0123456789abcdef0123456789abcdef"}
                """;
            File.WriteAllText(Path.Combine(workspace, "journal.json"), journalText); File.WriteAllText(Path.Combine(install, InstallTransaction.PendingName), markerText);
            var result = InstallRecovery.Run(install, (_, _) => { }, Path.Combine(root, "setup.exe"));
            kit.Check(result == RecoveryResult.Repaired && File.ReadAllText(Path.Combine(install, "a.txt")) == "old-a" && File.ReadAllText(Path.Combine(install, "b.txt")) == "old-b" && !File.Exists(Path.Combine(install, "sub", "new.txt")) && !File.Exists(Path.Combine(install, InstallTransaction.PendingName)) && !Directory.Exists(workspace),
                "the marker and the journal as the setups of 3.9.0 to 3.10.2 write them (literal text, folders spelled as another machine did) are repaired in the folder they are in now");
        }
        {
            var s = Copy(kit, 3, "writer-shape");
            using var marker = System.Text.Json.JsonDocument.Parse(File.ReadAllText(s.Marker));
            kit.Check(string.Join(",", marker.RootElement.EnumerateObject().Select(property => property.Name)) == "version,backupDirectory" && marker.RootElement.GetProperty("version").GetInt32() == 1, "the marker that this setup writes has the fields of the vector, in its order");
            var first = ReadJournal(s)[0]!.AsObject();
            kit.Check(string.Join(",", first.Select(property => property.Key)) == "Relative,Staged,NewHash,Backup,OldHash", "and the journal's entries have the fields of the vector, in its order (a field that is renamed here breaks every repair of an update that an installed setup left)");
        }
    }
}
