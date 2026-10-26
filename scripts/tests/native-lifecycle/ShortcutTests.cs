using ChatMCP.Installer;

// What an UPDATE does with shortcuts. Setup (the wizard and the quiet install) makes the shortcuts it is asked for and removes the ones under the old name; an update must not bring back a shortcut
// that the person has deleted. So before it replaces anything it looks at which of the three shortcuts (the Desktop link, the Start menu launcher, the Start menu uninstaller) THIS installation has, under
// either name (the first release that updates itself starts from 3.9.0 or 3.10.x, which used the old name), and makes exactly those under the new name. Real .lnk files in scratch folders.
internal static class ShortcutTests
{
    internal static void Run(TestKit kit)
    {
        var app = kit.Folder("update app");
        var launcher = Path.Combine(app, "ChatMCP.exe"); var uninstaller = Path.Combine(app, "Uninstall.exe"); var icon = Path.Combine(app, "chatmcp.ico");
        foreach (var file in new[] { launcher, uninstaller, icon }) File.WriteAllText(file, "fixture");
        var other = kit.Folder("update other app");
        foreach (var name in new[] { "ChatMCP.exe", "Uninstall.exe" }) File.WriteAllText(Path.Combine(other, name), "fixture");

        (string Desktop, string Programs) Machine(string label)
        {
            var folder = kit.Folder("update machine " + label);
            Directory.CreateDirectory(Path.Combine(folder, "Desktop")); Directory.CreateDirectory(Path.Combine(folder, "Programs"));
            return (Path.Combine(folder, "Desktop"), Path.Combine(folder, "Programs"));
        }
        void Make(string link, string target) => InstallerEngine.CreateShortcut(link, target, Path.GetDirectoryName(target)!, icon, "fixture");
        // the three shortcuts of one name set: the Desktop link, the Start menu launcher and the Start menu uninstaller
        void Set((string Desktop, string Programs) machine, string installDir, bool legacy, bool desktop = true, bool launcherLink = true, bool uninstallLink = true)
        {
            var app = legacy ? "ChatMCP Studio" : "DatGold Studio"; var folder = Path.Combine(machine.Programs, legacy ? "ChatMCP" : "DatGold");
            if (launcherLink || uninstallLink) Directory.CreateDirectory(folder);
            if (desktop) Make(Path.Combine(machine.Desktop, app + ".lnk"), Path.Combine(installDir, "ChatMCP.exe"));
            if (launcherLink) Make(Path.Combine(folder, app + ".lnk"), Path.Combine(installDir, "ChatMCP.exe"));
            if (uninstallLink) Make(Path.Combine(folder, "Uninstall " + app + ".lnk"), Path.Combine(installDir, "Uninstall.exe"));
        }
        string TargetOf(string link) { dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")!)!; dynamic shortcut = shell.CreateShortcut(link); return (string)shortcut.TargetPath; }
        bool Points(string link, string target) => File.Exists(link) && string.Equals(Path.GetFullPath(TargetOf(link)), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase);

        // ---- what the installation has
        var fresh = Machine("current names"); Set(fresh, app, legacy: false);
        kit.Check(InstallerEngine.DetectShortcuts(app, fresh.Desktop, fresh.Programs) == new ShortcutPlan(true, true, true), "an installation with all three shortcuts under the DatGold name has all three");
        var old = Machine("old names"); Set(old, app, legacy: true);
        kit.Check(InstallerEngine.DetectShortcuts(app, old.Desktop, old.Programs) == new ShortcutPlan(true, true, true), "and under the old names (3.9.0 and 3.10.x made those): they count as present, or the first update would drop every shortcut");
        var none = Machine("none");
        kit.Check(InstallerEngine.DetectShortcuts(app, none.Desktop, none.Programs) == new ShortcutPlan(false, false, false), "an installation whose shortcuts the person deleted has none");
        var desktopOnly = Machine("desktop only"); Set(desktopOnly, app, legacy: false, launcherLink: false, uninstallLink: false);
        kit.Check(InstallerEngine.DetectShortcuts(app, desktopOnly.Desktop, desktopOnly.Programs) == new ShortcutPlan(true, false, false), "only the Desktop link");
        var menuOnly = Machine("menu only"); Set(menuOnly, app, legacy: false, desktop: false);
        kit.Check(InstallerEngine.DetectShortcuts(app, menuOnly.Desktop, menuOnly.Programs) == new ShortcutPlan(false, true, true), "only the Start menu pair");
        var launcherOnly = Machine("launcher only"); Set(launcherOnly, app, legacy: false, desktop: false, uninstallLink: false);
        kit.Check(InstallerEngine.DetectShortcuts(app, launcherOnly.Desktop, launcherOnly.Programs) == new ShortcutPlan(false, true, false), "the Start menu launcher without its uninstaller (the person deleted only that one)");
        var mixed = Machine("mixed"); Set(mixed, app, legacy: true, launcherLink: false, uninstallLink: false); Set(mixed, app, legacy: false, desktop: false, uninstallLink: false);
        kit.Check(InstallerEngine.DetectShortcuts(app, mixed.Desktop, mixed.Programs) == new ShortcutPlan(true, true, false), "a Desktop link under the old name and a launcher under the new one are both found");
        var elsewhere = Machine("another installation"); Set(elsewhere, other, legacy: false); Set(elsewhere, other, legacy: true);
        kit.Check(InstallerEngine.DetectShortcuts(app, elsewhere.Desktop, elsewhere.Programs) == new ShortcutPlan(false, false, false), "shortcuts that point into another folder are not this installation's");
        var damaged = Machine("damaged"); File.WriteAllText(Path.Combine(damaged.Desktop, "DatGold Studio.lnk"), "this is not a shortcut");
        kit.Check(InstallerEngine.DetectShortcuts(app, damaged.Desktop, damaged.Programs).Desktop, "a shortcut that cannot be read is counted as present: a missing shortcut after an update looks like a broken update, an extra one does not");
        dynamic fso = Activator.CreateInstance(Type.GetTypeFromProgID("Scripting.FileSystemObject")!)!;
        var shortApp = (string)fso.GetFolder(app).ShortPath;
        kit.Check(InstallerEngine.DetectShortcuts(shortApp, fresh.Desktop, fresh.Programs) == new ShortcutPlan(true, true, true), "the installation folder may be spelled in its short (8.3) form: " + shortApp);

        // ---- making them: exactly what was found, under the new name, and the old ones go
        var upgraded = Machine("upgrade keeps the choice"); Set(upgraded, app, legacy: true, desktop: false);
        var keep = InstallerEngine.DetectShortcuts(app, upgraded.Desktop, upgraded.Programs);
        InstallerEngine.ReplaceShortcuts(app, icon, upgraded.Desktop, upgraded.Programs, keep);
        kit.Check(!File.Exists(Path.Combine(upgraded.Desktop, "DatGold Studio.lnk")) && Directory.GetFiles(upgraded.Desktop).Length == 0, "a Desktop link that the person deleted is not made again");
        kit.Check(Points(Path.Combine(upgraded.Programs, "DatGold", "DatGold Studio.lnk"), launcher) && Points(Path.Combine(upgraded.Programs, "DatGold", "Uninstall DatGold Studio.lnk"), uninstaller), "the Start menu pair is made under the new name");
        kit.Check(!Directory.Exists(Path.Combine(upgraded.Programs, "ChatMCP")), "and the old folder, left empty, is gone");

        var partial = Machine("upgrade keeps part"); Set(partial, app, legacy: false, launcherLink: true, uninstallLink: false);
        InstallerEngine.ReplaceShortcuts(app, icon, partial.Desktop, partial.Programs, InstallerEngine.DetectShortcuts(app, partial.Desktop, partial.Programs));
        kit.Check(Points(Path.Combine(partial.Desktop, "DatGold Studio.lnk"), launcher) && Points(Path.Combine(partial.Programs, "DatGold", "DatGold Studio.lnk"), launcher) && !File.Exists(Path.Combine(partial.Programs, "DatGold", "Uninstall DatGold Studio.lnk")),
            "an uninstaller shortcut that the person deleted is not made again, while the other two are kept");

        var nothing = Machine("upgrade with nothing");
        InstallerEngine.ReplaceShortcuts(app, icon, nothing.Desktop, nothing.Programs, InstallerEngine.DetectShortcuts(app, nothing.Desktop, nothing.Programs));
        kit.Check(Directory.GetFiles(nothing.Desktop).Length == 0 && Directory.GetDirectories(nothing.Programs).Length == 0, "an installation with no shortcuts gets none, and no Start menu folder");

        var legacyDesktop = Machine("old desktop link"); Set(legacyDesktop, app, legacy: true, launcherLink: false, uninstallLink: false);
        InstallerEngine.ReplaceShortcuts(app, icon, legacyDesktop.Desktop, legacyDesktop.Programs, InstallerEngine.DetectShortcuts(app, legacyDesktop.Desktop, legacyDesktop.Programs));
        kit.Check(Points(Path.Combine(legacyDesktop.Desktop, "DatGold Studio.lnk"), launcher) && !File.Exists(Path.Combine(legacyDesktop.Desktop, "ChatMCP Studio.lnk")), "a Desktop link under the old name is renamed: the new one is made and the old one goes");

        // the wizard and the quiet install still make what they are asked for, whatever is on the machine (the bool forms keep their meaning)
        var wizard = Machine("wizard"); InstallerEngine.ReplaceShortcuts(app, icon, wizard.Desktop, wizard.Programs, true, true);
        kit.Check(File.Exists(Path.Combine(wizard.Desktop, "DatGold Studio.lnk")) && File.Exists(Path.Combine(wizard.Programs, "DatGold", "Uninstall DatGold Studio.lnk")), "the wizard and the quiet install still make all of them when asked");

        // ---- the shortcuts are not worth failing an update for
        var blocked = Machine("blocked start menu");
        File.WriteAllText(Path.Combine(blocked.Programs, "DatGold"), "a file where the Start menu folder should be");
        var notes = new List<string>();
        InstallerEngine.ReplaceShortcutsBestEffort(app, icon, blocked.Desktop, blocked.Programs, ShortcutPlan.All, notes.Add);
        kit.Check(notes.Count >= 1 && notes[0].Contains("shortcut", StringComparison.OrdinalIgnoreCase) && !notes[0].Contains(app, StringComparison.OrdinalIgnoreCase), "a Start menu folder that cannot be made is reported (and the report holds no path), it does not throw");
        kit.Check(Points(Path.Combine(blocked.Desktop, "DatGold Studio.lnk"), launcher), "and the Desktop link was made before it");
    }
}
