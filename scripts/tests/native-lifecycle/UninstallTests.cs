using System.Security.Cryptography;
using System.Text.Json;
using ChatMCP.Installer;
using ChatMCP.Native;

// What an UNINSTALL removes, in which order, and what it says when a step fails. The uninstaller used to remove the shortcuts and the Apps entry first and the files last: a file that a program held open
// then stopped it halfway, with files still on the disk and nothing left in Windows to start the uninstaller again with. It now removes the files first, the receipt after them, the shortcuts next and the
// Apps entry LAST, and a run that could not remove a file keeps the receipt, the shortcuts and the entry, so that it can be run again. A failure that is not worth stopping for (a shortcut, the entry) is
// returned as a sentence instead of being swallowed. The same for setup: a shortcut that cannot be saved and an entry that cannot be written reach the code that reports them.
//
// InstallerEngine.Uninstall itself is not run here: it stops the Hub of the machine and works on the Desktop, the Start menu and the registry of the person who runs the tests. What it does after those
// steps is RemoveInstallation, which takes the folders and the registry step as arguments; real files and real .lnk files in scratch folders, and a stand-in for the registry step.
internal static class UninstallTests
{
    internal static void Run(TestKit kit)
    {
        Exception? Caught(Action action) { try { action(); return null; } catch (Exception error) { return error; } }
        string Digest(string file) { using var stream = File.OpenRead(file); return Convert.ToHexString(SHA256.HashData(stream)); }
        (string Desktop, string Programs) Machine(string label)
        {
            var folder = kit.Folder("uninstall machine " + label);
            Directory.CreateDirectory(Path.Combine(folder, "Desktop")); Directory.CreateDirectory(Path.Combine(folder, "Programs"));
            return (Path.Combine(folder, "Desktop"), Path.Combine(folder, "Programs"));
        }
        string[] Links((string Desktop, string Programs) machine) => new[]
        {
            Path.Combine(machine.Desktop, "DatGold Studio.lnk"), Path.Combine(machine.Programs, "DatGold", "DatGold Studio.lnk"), Path.Combine(machine.Programs, "DatGold", "Uninstall DatGold Studio.lnk"),
        };
        // An installation as setup leaves it: its files, the receipt that lists them with their digests, and the three shortcuts.
        (string Dir, Dictionary<string, string> Files, string Receipt) Installation(string label, (string Desktop, string Programs) machine)
        {
            var dir = kit.Folder("uninstall app " + label);
            var files = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var relative in new[] { "ChatMCP.exe", "Uninstall.exe", "assets/icons/chatmcp.ico", "DATGOLD-HUB/hub.mjs", "DATGOLD-HUB/lib/manager.mjs" })
            {
                var file = Path.Combine(dir, relative.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                File.WriteAllText(file, "fixture " + relative);
                files[relative] = Digest(file);
            }
            var receipt = Path.Combine(dir, InstalledCopy.ReceiptName);
            File.WriteAllText(receipt, JsonSerializer.Serialize(files));
            InstallerEngine.CreateShortcuts(dir, Path.Combine(dir, "assets", "icons", "chatmcp.ico"), machine.Desktop, machine.Programs, ShortcutPlan.All);
            return (dir, files, receipt);
        }
        int FilesLeft(string dir) => Directory.GetFiles(dir, "*", SearchOption.AllDirectories).Length;
        bool NoShortcuts((string Desktop, string Programs) machine) => !Directory.EnumerateFileSystemEntries(machine.Desktop).Any() && !Directory.EnumerateFileSystemEntries(machine.Programs).Any();

        // ---- a file that a program holds open: the run stops, and everything that starts the uninstaller again is still there
        {
            var machine = Machine("held file"); var app = Installation("held file", machine);
            kit.Check(Links(machine).All(File.Exists) && FilesLeft(app.Dir) == 6, "premise: the installation has its five files, its receipt and its three shortcuts");
            var unregistered = 0;
            var held = Path.Combine(app.Dir, "DATGOLD-HUB", "hub.mjs");
            Exception? stopped;
            using (new FileStream(held, FileMode.Open, FileAccess.Read, FileShare.Read)) // readable, but it cannot be deleted while it is open
                stopped = Caught(() => InstallerEngine.RemoveInstallation(app.Dir, app.Files, machine.Desktop, machine.Programs, () => unregistered++, (_, _) => { }));
            kit.Check(stopped is IOException && stopped.Message.Contains("DATGOLD-HUB/hub.mjs", StringComparison.Ordinal) && stopped.Message.Contains("again", StringComparison.OrdinalIgnoreCase),
                "a file that a program holds open stops the uninstall with a sentence that names the file and says to run it again: " + stopped?.Message);
            kit.Check(unregistered == 0, "the Apps entry is not removed by a run that did not finish");
            kit.Check(Links(machine).All(File.Exists), "and neither are the shortcuts: the uninstaller can still be started from the Start menu");
            kit.Check(File.Exists(app.Receipt), "the receipt stays, so the next run still knows which files are the installation's");
            kit.Check(File.Exists(held) && !File.Exists(Path.Combine(app.Dir, "ChatMCP.exe")) && !File.Exists(Path.Combine(app.Dir, "DATGOLD-HUB", "lib", "manager.mjs")), "the files that could be removed were removed (the next run has only the held one left)");

            // the same uninstall again, with the file released
            (bool Files, bool Receipt, bool Shortcuts)? seen = null;
            var steps = new List<int>();
            var notes = InstallerEngine.RemoveInstallation(app.Dir, app.Files, machine.Desktop, machine.Programs,
                () => { unregistered++; seen = (FilesLeft(app.Dir) == 0, !File.Exists(app.Receipt), NoShortcuts(machine)); }, (percent, _) => steps.Add(percent));
            kit.Check(notes.Count == 0 && unregistered == 1 && FilesLeft(app.Dir) == 0 && NoShortcuts(machine), "run again, the uninstall finishes: no file, no receipt, no shortcut, the entry removed once, nothing to report");
            kit.Check(seen == (true, true, true), "the Apps entry goes LAST: the files, the receipt and the shortcuts are already gone when it is removed");
            kit.Check(steps.Count >= 3 && steps.SequenceEqual(steps.OrderBy(step => step)), "the progress it reports only goes forward: " + string.Join(",", steps));
        }

        // ---- a file that somebody changed stays, as it always did, and is not a failure
        {
            var machine = Machine("changed file"); var app = Installation("changed file", machine);
            var changed = Path.Combine(app.Dir, "DATGOLD-HUB", "lib", "manager.mjs");
            File.WriteAllText(changed, "changed by the person");
            File.WriteAllText(Path.Combine(app.Dir, "notes.txt"), "never the setup's");
            var notes = InstallerEngine.RemoveInstallation(app.Dir, app.Files, machine.Desktop, machine.Programs, () => { }, (_, _) => { });
            kit.Check(notes.Count == 0 && File.ReadAllText(changed) == "changed by the person" && File.Exists(Path.Combine(app.Dir, "notes.txt")) && FilesLeft(app.Dir) == 2,
                "a file that was changed after the installation and a file the setup never made both stay; everything else goes and nothing is reported");
        }

        // ---- the registry refuses: reported, not fatal
        {
            var machine = Machine("registry refuses"); var app = Installation("registry refuses", machine);
            var notes = InstallerEngine.RemoveInstallation(app.Dir, app.Files, machine.Desktop, machine.Programs,
                () => throw new UnauthorizedAccessException(@"Access to the registry key 'HKEY_CURRENT_USER\Software\Secret' is denied."), (_, _) => { });
            kit.Check(notes.Count == 1 && notes[0].Contains("Installed apps", StringComparison.OrdinalIgnoreCase) && notes[0].Contains("UnauthorizedAccessException", StringComparison.Ordinal) && !notes[0].Contains("Secret", StringComparison.Ordinal),
                "an Apps entry that cannot be removed is reported in one sentence (the kind of failure, not its text) and does not fail the uninstall: " + string.Join(" | ", notes));
            kit.Check(FilesLeft(app.Dir) == 0 && NoShortcuts(machine), "the files and the shortcuts are removed all the same");
        }

        // ---- a shortcut that cannot be removed: reported, not fatal (it was reported to the progress line only, which the next line replaced)
        {
            var machine = Machine("held shortcut"); var app = Installation("held shortcut", machine);
            var unregistered = 0;
            IReadOnlyList<string> notes;
            using (new FileStream(Links(machine)[0], FileMode.Open, FileAccess.Read, FileShare.Read))
                notes = InstallerEngine.RemoveInstallation(app.Dir, app.Files, machine.Desktop, machine.Programs, () => unregistered++, (_, _) => { });
            kit.Check(notes.Count == 1 && notes[0].Contains("DatGold Studio.lnk", StringComparison.Ordinal), "a shortcut that cannot be removed is in what the uninstall returns: " + string.Join(" | ", notes));
            kit.Check(unregistered == 1 && FilesLeft(app.Dir) == 0 && !Directory.Exists(Path.Combine(machine.Programs, "DatGold")), "and the rest of the uninstall is done");
        }

        // ---- setup: a shortcut that cannot be saved and an entry that cannot be written reach the code that reports them
        {
            var dir = kit.Folder("report app");
            var launcher = Path.Combine(dir, "ChatMCP.exe"); var icon = Path.Combine(dir, "chatmcp.ico");
            foreach (var file in new[] { launcher, Path.Combine(dir, "Uninstall.exe"), icon }) File.WriteAllText(file, "fixture");
            var machine = Machine("no desktop folder");
            Directory.Delete(machine.Desktop);
            kit.Throws(() => InstallerEngine.CreateShortcut(Path.Combine(machine.Desktop, "x.lnk"), launcher, dir, icon, "fixture"), "a shortcut that cannot be saved is an error, not silence");
            var made = new List<string>();
            InstallerEngine.ReplaceShortcutsBestEffort(dir, icon, machine.Desktop, machine.Programs, ShortcutPlan.All, made.Add);
            kit.Check(made.Count == 1 && made[0].Contains("shortcut", StringComparison.OrdinalIgnoreCase) && !made[0].Contains(machine.Desktop, StringComparison.OrdinalIgnoreCase),
                "setup reports a Desktop shortcut that cannot be saved, once and without a path (notes: " + made.Count + ")");
            kit.Check(File.Exists(Path.Combine(machine.Programs, "DatGold", "DatGold Studio.lnk")) && File.Exists(Path.Combine(machine.Programs, "DatGold", "Uninstall DatGold Studio.lnk")),
                "and the two Start menu shortcuts are made all the same: one shortcut that fails does not cost the others");

            var said = new List<string>();
            InstallerEngine.RegisterUninstallBestEffort(() => throw new UnauthorizedAccessException(@"Access to the registry key 'HKEY_CURRENT_USER\Software\Secret' is denied."), said.Add);
            kit.Check(said.Count == 1 && said[0].Contains("Installed apps", StringComparison.OrdinalIgnoreCase) && said[0].Contains("UnauthorizedAccessException", StringComparison.Ordinal) && !said[0].Contains("Secret", StringComparison.Ordinal),
                "setup reports an Apps entry that cannot be written (the kind of failure, not its text) and does not fail for it: " + string.Join(" | ", said));
            InstallerEngine.RegisterUninstallBestEffort(() => { }, said.Add);
            kit.Check(said.Count == 1, "and says nothing when the entry was written");
        }
    }
}
