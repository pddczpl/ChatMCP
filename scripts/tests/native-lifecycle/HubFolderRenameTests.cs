using System.Diagnostics;
using ChatMCP.Installer;
using ChatMCP.Native;

// An installation made up to 3.11.0 keeps its Hub in CHATMCP-HUB (thousands of files with the runtimes); this version calls the folder DATGOLD-HUB. Writing every file again under the new name and taking the old
// ones away did not finish in four minutes on a hosted runner, so the setup RENAMES the folder after it stopped the Hub (InstallerEngine.RenameLegacyHubFolder), reads the receipt of the old setup under the new name
// (RenameHubKeys) and gives the folder its old name back when the update fails with every file as it was (UndoRenameUnlessRetained). The glue in InstallFiles needs the embedded payload and is run by the
// lifecycle test of the CI (the upgrade from the published 3.9.0); these are the parts that can be judged here.
internal static class HubFolderRenameTests
{
    private const string Legacy = "CHATMCP-HUB";
    private const string Current = "DATGOLD-HUB";

    internal static void Run(TestKit kit)
    {
        var root = kit.Folder("hub folder rename");
        Exception? Caught(Action action) { try { action(); return null; } catch (Exception error) { return error; } }
        var digest = new string('a', 64);

        // 1. The receipt follows the folder.
        var receipt = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["CHATMCP-HUB/hub.mjs"] = digest,
            ["chatmcp-hub/lib/a.mjs"] = new string('b', 64),
            ["CHATMCP-HUBBY/x.txt"] = digest,
            ["ChatMCP.exe"] = digest,
            ["runtimes/node/node.exe"] = digest,
        };
        var renamed = InstallerEngine.RenameHubKeys(receipt);
        kit.Check(renamed.ContainsKey("DATGOLD-HUB/hub.mjs") && renamed.ContainsKey("DATGOLD-HUB/lib/a.mjs"), "the files of the Hub are named under DATGOLD-HUB/ in the receipt, whatever the case of the old name");
        kit.Check(!renamed.Keys.Any(key => key.StartsWith("CHATMCP-HUB/", StringComparison.OrdinalIgnoreCase)), "and no file is named under CHATMCP-HUB/ any more");
        kit.Check(renamed.ContainsKey("CHATMCP-HUBBY/x.txt") && renamed.ContainsKey("ChatMCP.exe") && renamed.ContainsKey("runtimes/node/node.exe") && renamed.Count == receipt.Count,
            "a name that only begins like the folder, and everything outside it, keep their names, and no entry is lost");
        kit.Check(renamed["DATGOLD-HUB/hub.mjs"] == digest && renamed["DATGOLD-HUB/lib/a.mjs"] == new string('b', 64), "each digest goes with its file");
        kit.Check(receipt.ContainsKey("CHATMCP-HUB/hub.mjs") && !receipt.ContainsKey("DATGOLD-HUB/hub.mjs"), "the receipt that was given is not changed");
        kit.Check(renamed.ContainsKey("datgold-hub/lib/a.mjs"), "the names of the new receipt are compared without regard to case, as the installer does everywhere");

        // An installation with a Hub folder of the old name: files at several depths, one that somebody put there, a folder with nothing in it.
        string Installation(string name, string hubFolder = Legacy)
        {
            var directory = Path.Combine(root, name);
            var hub = Path.Combine(directory, hubFolder);
            Directory.CreateDirectory(Path.Combine(hub, "lib", "deep"));
            Directory.CreateDirectory(Path.Combine(hub, "empty"));
            File.WriteAllText(Path.Combine(hub, "hub.mjs"), "hub");
            File.WriteAllText(Path.Combine(hub, "lib", "deep", "a.mjs"), "a");
            File.WriteAllText(Path.Combine(hub, "somebody.txt"), "somebody's file");
            return directory;
        }
        bool Whole(string directory, string hubFolder) =>
            File.ReadAllText(Path.Combine(directory, hubFolder, "hub.mjs")) == "hub"
            && File.ReadAllText(Path.Combine(directory, hubFolder, "lib", "deep", "a.mjs")) == "a"
            && File.ReadAllText(Path.Combine(directory, hubFolder, "somebody.txt")) == "somebody's file"
            && Directory.Exists(Path.Combine(directory, hubFolder, "empty"));
        var said = new List<(int Percent, string Status)>();
        void Say(int percent, string status) => said.Add((percent, status));

        // 2. The rename.
        var plain = Installation("plain");
        kit.Check(InstallerEngine.RenameLegacyHubFolder(plain, Say, 1, 0), "the folder of the old name is renamed");
        kit.Check(!Directory.Exists(Path.Combine(plain, Legacy)) && Whole(plain, Current), "every file is in the folder of the new name, as it was, the one that somebody put there and the empty folder included");
        kit.Check(said.Count == 1 && said[0].Percent == 36 && said[0].Status.Contains(Legacy) && said[0].Status.Contains(Current), "and the progress window and the log say so (in one line, under 45, where the commit begins)");

        said.Clear();
        var taken = Installation("name taken");
        Directory.CreateDirectory(Path.Combine(taken, Current));
        File.WriteAllText(Path.Combine(taken, Current, "already.txt"), "already here");
        kit.Check(!InstallerEngine.RenameLegacyHubFolder(taken, Say, 1, 0), "a folder that has the new name already is never merged with the old one");
        kit.Check(Whole(taken, Legacy) && File.ReadAllText(Path.Combine(taken, Current, "already.txt")) == "already here" && said.Count == 0, "and both folders are as they were, with nothing said (nothing was tried)");

        var takenByFile = Installation("name taken by a file");
        File.WriteAllText(Path.Combine(takenByFile, Current), "a file");
        kit.Check(!InstallerEngine.RenameLegacyHubFolder(takenByFile, Say, 1, 0) && Whole(takenByFile, Legacy) && File.ReadAllText(Path.Combine(takenByFile, Current)) == "a file" && said.Count == 0,
            "a file with the new name is not replaced either, and nothing is said (nothing was tried)");

        var none = Path.Combine(root, "no old folder");
        Directory.CreateDirectory(none);
        kit.Check(!InstallerEngine.RenameLegacyHubFolder(none, Say, 1, 0) && !Directory.Exists(Path.Combine(none, Current)) && said.Count == 0, "an installation without the old folder (3.11.1 and later) is left alone: nothing is created");

        var legacyIsFile = Path.Combine(root, "old name is a file");
        Directory.CreateDirectory(legacyIsFile);
        File.WriteAllText(Path.Combine(legacyIsFile, Legacy), "not a folder");
        kit.Check(!InstallerEngine.RenameLegacyHubFolder(legacyIsFile, Say, 1, 0) && File.ReadAllText(Path.Combine(legacyIsFile, Legacy)) == "not a folder" && !Directory.Exists(Path.Combine(legacyIsFile, Current)), "a file that has the old name is not renamed");

        // A link is never entered, let alone renamed: what it points to is not the setup's.
        var linked = Path.Combine(root, "linked");
        var outside = Path.Combine(root, "outside");
        Directory.CreateDirectory(linked);
        Directory.CreateDirectory(outside);
        File.WriteAllText(Path.Combine(outside, "hub.mjs"), "not ours");
        using (var link = Process.Start(new ProcessStartInfo("cmd.exe", "/c mklink /J \"" + Path.Combine(linked, Legacy) + "\" \"" + outside + "\"") { UseShellExecute = false, CreateNoWindow = true })!)
        {
            link.WaitForExit();
            kit.Check(link.ExitCode == 0 && Directory.Exists(Path.Combine(linked, Legacy)), "(a junction with the old name is made for the next check)");
        }
        kit.Check(!InstallerEngine.RenameLegacyHubFolder(linked, Say, 1, 0), "a link with the old name is not renamed");
        kit.Check(Directory.Exists(Path.Combine(linked, Legacy)) && !Directory.Exists(Path.Combine(linked, Current)) && File.ReadAllText(Path.Combine(outside, "hub.mjs")) == "not ours", "and it, and what it points to, are as they were");
        Directory.Delete(Path.Combine(linked, Legacy)); // takes the junction away, never what it points to (the cleanup of the whole run cannot remove a tree with a junction in it)

        // Windows refuses to rename a folder that has a file in it open: nothing is changed, the reason is said, and a later try (the program let go) goes through.
        said.Clear();
        var busy = Installation("busy");
        bool refused;
        using (new FileStream(Path.Combine(busy, Legacy, "lib", "deep", "a.mjs"), FileMode.Open, FileAccess.Read, FileShare.Read))
            refused = !InstallerEngine.RenameLegacyHubFolder(busy, Say, 3, 10);
        kit.Check(refused, "a folder that has a file in it open is not renamed (the setup goes file by file then)");
        kit.Check(Whole(busy, Legacy) && !Directory.Exists(Path.Combine(busy, Current)), "and it is as it was, under its old name");
        kit.Check(said.Count == 1 && said[0].Percent == 36 && said[0].Status.Contains("could not be renamed") && said[0].Status.Contains("file by file"), "and the progress window and the log say that, once, after the last try");
        kit.Check(InstallerEngine.RenameLegacyHubFolder(busy, Say, 1, 0) && Whole(busy, Current), "once the program lets go, the same call renames it");

        // A try that is refused at first and goes through at the second try: the delay is a wait, not a give-up.
        said.Clear();
        var late = Installation("late");
        var holder = new FileStream(Path.Combine(late, Legacy, "hub.mjs"), FileMode.Open, FileAccess.Read, FileShare.Read);
        var letGo = Task.Run(() => { Thread.Sleep(150); holder.Dispose(); });
        var lateResult = InstallerEngine.RenameLegacyHubFolder(late, Say, 40, 50);
        letGo.Wait();
        kit.Check(lateResult && Whole(late, Current) && said.Count == 1 && said[0].Status.Contains("Renamed"), "a program that lets go within the tries does not cost the rename");

        // 3. The old name comes back when the update fails and every file is as it was.
        var failure = new IOException("a file is in use");
        var back = Installation("failed, whole");
        InstallerEngine.RenameLegacyHubFolder(back, Say, 1, 0);
        kit.Check(ReferenceEquals(Caught(() => InstallerEngine.UndoRenameUnlessRetained(back, true, () => throw failure)), failure), "the failure of the update reaches the caller as it was");
        kit.Check(Whole(back, Legacy) && !Directory.Exists(Path.Combine(back, Current)), "and the folder has its old name back: the version in place looks for its Hub there");

        var rolledBack = Installation("rolled back");
        InstallerEngine.RenameLegacyHubFolder(rolledBack, Say, 1, 0);
        var rolled = new UpgradeRolledBackException("rolled back", failure);
        kit.Check(ReferenceEquals(Caught(() => InstallerEngine.UndoRenameUnlessRetained(rolledBack, true, () => throw rolled)), rolled) && Whole(rolledBack, Legacy) && !Directory.Exists(Path.Combine(rolledBack, Current)),
            "an update that was rolled back is the same: the old name comes back");

        var retained = Installation("retained");
        InstallerEngine.RenameLegacyHubFolder(retained, Say, 1, 0);
        var halfway = new AggregateException("the rollback was not whole", failure);
        kit.Check(ReferenceEquals(Caught(() => InstallerEngine.UndoRenameUnlessRetained(retained, true, () => throw halfway)), halfway), "a rollback that was not whole reaches the caller as it was");
        kit.Check(Whole(retained, Current) && !Directory.Exists(Path.Combine(retained, Legacy)), "and the folder keeps the new name: the backup that stays names DATGOLD-HUB, and recovery and the next try work on that name");

        var done = Installation("done");
        InstallerEngine.RenameLegacyHubFolder(done, Say, 1, 0);
        InstallerEngine.UndoRenameUnlessRetained(done, true, () => { });
        kit.Check(Whole(done, Current) && !Directory.Exists(Path.Combine(done, Legacy)), "an update that went through keeps the new name");

        var notRenamed = Installation("not renamed by the setup", Current);
        kit.Check(Caught(() => InstallerEngine.UndoRenameUnlessRetained(notRenamed, false, () => throw failure)) == failure && Whole(notRenamed, Current) && !Directory.Exists(Path.Combine(notRenamed, Legacy)),
            "a folder that the setup did not rename is not renamed back: a 3.11.1 installation keeps its name when an update fails");

        var recreated = Installation("old name made again");
        InstallerEngine.RenameLegacyHubFolder(recreated, Say, 1, 0);
        Directory.CreateDirectory(Path.Combine(recreated, Legacy));
        File.WriteAllText(Path.Combine(recreated, Legacy, "new.txt"), "somebody made this folder again");
        kit.Check(Caught(() => InstallerEngine.UndoRenameUnlessRetained(recreated, true, () => throw failure)) == failure, "when somebody made the old folder again, the failure still reaches the caller");
        kit.Check(Whole(recreated, Current) && File.ReadAllText(Path.Combine(recreated, Legacy, "new.txt")) == "somebody made this folder again", "and neither folder is merged into the other or replaced");

        // A folder that cannot be given its name back does not hide why the update failed.
        var stuck = Installation("cannot go back");
        InstallerEngine.RenameLegacyHubFolder(stuck, Say, 1, 0);
        Exception? stuckError;
        using (new FileStream(Path.Combine(stuck, Current, "hub.mjs"), FileMode.Open, FileAccess.Read, FileShare.Read))
            stuckError = Caught(() => InstallerEngine.UndoRenameUnlessRetained(stuck, true, () => throw failure));
        kit.Check(ReferenceEquals(stuckError, failure), "when the folder cannot be renamed back (a file in it is open) the error of the update is the one that reaches the caller");
        kit.Check(Whole(stuck, Current) && !Directory.Exists(Path.Combine(stuck, Legacy)), "and the folder keeps the new name, whole");

        // 4. What InstallFiles does with them. The receipt is the one of the setup that made the installation: it names the Hub under CHATMCP-HUB/ up to 3.11.0.
        Dictionary<string, string> Receipt() => new(StringComparer.OrdinalIgnoreCase) { ["CHATMCP-HUB/hub.mjs"] = digest, ["ChatMCP.exe"] = digest };
        bool Named(Dictionary<string, string>? files, string key) => files != null && files.ContainsKey(key);

        // 4a. The receipt follows the folders. A try that renamed the folder and then stopped leaves the old folder gone and the new one there.
        var interrupted = Installation("interrupted", Current);
        var followed = InstallerEngine.ReceiptForFolders(interrupted, Receipt(), false);
        kit.Check(Named(followed, "DATGOLD-HUB/hub.mjs") && !Named(followed, "CHATMCP-HUB/hub.mjs") && Named(followed, "ChatMCP.exe"), "when the old folder is gone and the new one is there, the receipt names the Hub under the new name");
        var oldFolder = Installation("old folder present");
        var asIs = InstallerEngine.ReceiptForFolders(oldFolder, Receipt(), false);
        kit.Check(Named(asIs, "CHATMCP-HUB/hub.mjs") && !Named(asIs, "DATGOLD-HUB/hub.mjs"), "while the old folder is there, the receipt is read as it is");
        var both = Installation("both folders");
        Directory.CreateDirectory(Path.Combine(both, Current));
        kit.Check(Named(InstallerEngine.ReceiptForFolders(both, Receipt(), false), "CHATMCP-HUB/hub.mjs"), "and when both folders are there");
        var neither = Path.Combine(root, "neither folder");
        Directory.CreateDirectory(neither);
        kit.Check(Named(InstallerEngine.ReceiptForFolders(neither, Receipt(), false), "CHATMCP-HUB/hub.mjs"), "and when neither is");
        kit.Check(Named(InstallerEngine.ReceiptForFolders(interrupted, Receipt(), true), "CHATMCP-HUB/hub.mjs"), "an upgrade from before there were receipts (the installation has none of its own) reads what it was given as it is");
        kit.Check(InstallerEngine.ReceiptForFolders(interrupted, null, false) == null, "and no receipt stays no receipt");

        // 4b. The rename of an update.
        said.Clear();
        var update = Installation("update");
        Dictionary<string, string>? held = Receipt();
        var did = InstallerEngine.RenameHubFolderForUpdate(update, ref held, false, Say, 1, 0);
        kit.Check(did && Whole(update, Current) && !Directory.Exists(Path.Combine(update, Legacy)) && said.Count == 1, "an update renames the folder of an installation that has a receipt");
        kit.Check(Named(held, "DATGOLD-HUB/hub.mjs") && !Named(held, "CHATMCP-HUB/hub.mjs") && Named(held, "ChatMCP.exe"), "and from then on reads the receipt of the old setup under the new name");

        said.Clear();
        var refusedUpdate = Installation("update refused");
        Dictionary<string, string>? kept = Receipt();
        bool didRefused;
        using (new FileStream(Path.Combine(refusedUpdate, Legacy, "hub.mjs"), FileMode.Open, FileAccess.Read, FileShare.Read))
            didRefused = InstallerEngine.RenameHubFolderForUpdate(refusedUpdate, ref kept, false, Say, 2, 10);
        kit.Check(!didRefused && Whole(refusedUpdate, Legacy) && !Directory.Exists(Path.Combine(refusedUpdate, Current)), "an update whose rename is refused leaves the folder as it was");
        kit.Check(Named(kept, "CHATMCP-HUB/hub.mjs") && !Named(kept, "DATGOLD-HUB/hub.mjs"), "and reads the receipt as it is: the files are still under the old name");

        var noReceipt = Installation("update without a receipt");
        Dictionary<string, string>? nothing = null;
        kit.Check(!InstallerEngine.RenameHubFolderForUpdate(noReceipt, ref nothing, false, Say, 1, 0) && nothing == null && Whole(noReceipt, Legacy), "a folder that no receipt says is the setup's is left alone");
        kit.Check(!InstallerEngine.RenameHubFolderForUpdate(noReceipt, ref nothing, true, Say, 1, 0) && nothing == null && Whole(noReceipt, Legacy), "also in an upgrade from before there were receipts");
        Dictionary<string, string>? beforeReceipts = Receipt();
        kit.Check(!InstallerEngine.RenameHubFolderForUpdate(noReceipt, ref beforeReceipts, true, Say, 1, 0) && Named(beforeReceipts, "CHATMCP-HUB/hub.mjs") && Whole(noReceipt, Legacy), "and when the receipt that it was given is that of an upgrade from before there were receipts");
    }
}
