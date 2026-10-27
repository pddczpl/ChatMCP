using System.Text.Json;
using ChatMCP.Native;

// What the shell and the installer say to each other. It is a contract ACROSS VERSIONS: the shell of the version a person has installed starts the installer of a LATER one (people skip
// versions, so installer N+k meets shell N for any k), and the Hub of the version that is running reads the result file that the installer of another one wrote. So the vectors below are
// written out as literal text, one by one, and every form that has ever been sent stays accepted: the list only grows, and a change that breaks one is a change that breaks an installed copy.
internal static class ContractTests
{
    private const string Dir = @"C:\Users\Test User\AppData\Local\Programs\ChatMCP";
    private const string Result = @"C:\Users\Test User\AppData\Local\ChatMCP\hub\update-result.json";

    private static string Show(IEnumerable<string>? items) => items == null ? "(null)" : "[" + string.Join(" | ", items) + "]";

    private static InstallerCommand? Parsed(string[] args, string exe = "DatGoldSetup")
    {
        try { return InstallerCommandLine.Parse(args, exe); } catch (ArgumentException) { return null; }
    }

    /// <summary>How the runtime splits a command line: a child of this program (Program.cs, --echo-args) is started with exactly this text as its arguments and says what it received.</summary>
    private static string[] EchoedBy(string rawArguments)
    {
        var self = Environment.ProcessPath!;
        var host = string.Equals(Path.GetFileNameWithoutExtension(self), "dotnet", StringComparison.OrdinalIgnoreCase) ? "\"" + Path.Combine(AppContext.BaseDirectory, "NativeLifecycle.Tests.dll") + "\" " : "";
        var start = new System.Diagnostics.ProcessStartInfo(self) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, Arguments = host + "--echo-args " + rawArguments };
        using var child = System.Diagnostics.Process.Start(start)!;
        var output = child.StandardOutput.ReadToEnd();
        child.WaitForExit();
        return output.Split('\u0001');
    }

    internal static void Run(TestKit kit)
    {
        // ---- the vector the shell sends (shell N -> installer N+k). Literal. Never edited: when it has to change, a second vector is added and this one stays accepted.
        string[] vector1 = { "--quiet", "--update", "--install-dir", Dir, "--wait-pid", "4242", "--relaunch", "--result", Result };
        kit.Check(UpdateArguments.Build(Dir, 4242, Result).SequenceEqual(vector1), "the shell sends exactly: " + Show(vector1));
        var command = Parsed(vector1);
        kit.Check(command is { Mode: InstallerMode.Update, InstallDir: Dir, WaitPid: 4242, Relaunch: true, ResultFile: Result }, "and the installer reads every part of it");
        kit.Check(UpdateArguments.Build(Dir, int.MaxValue, Result).SequenceEqual(new[] { "--quiet", "--update", "--install-dir", Dir, "--wait-pid", "2147483647", "--relaunch", "--result", Result }), "the pid is written in plain digits, whatever the culture of the machine");
        kit.Check(UpdateArguments.Build(@"C:\a b\c", 1, @"C:\d e\f.json").All(argument => !argument.StartsWith('"')), "no argument is quoted by hand: ProcessStartInfo.ArgumentList does that");

        // ---- the forms that exist today and are used by the lifecycle scripts, by people and by older shells of the project: they keep working
        kit.Check(Parsed(new[] { "--quiet", "--install-dir", Dir }) is { Mode: InstallerMode.QuietInstall, InstallDir: Dir, WaitPid: null, Relaunch: false, ResultFile: null }, "legacy: --quiet --install-dir <absolute directory> installs quietly, with no wait, no relaunch and no result file");
        kit.Check(Parsed(new[] { "--install-dir", Dir, "--quiet" }) is { Mode: InstallerMode.QuietInstall, InstallDir: Dir }, "legacy: in either order");
        kit.Check(Parsed(new[] { "--quiet", "--uninstall" }, "Uninstall")?.Mode == InstallerMode.QuietUninstall, "legacy: Uninstall.exe --quiet --uninstall");
        kit.Check(Parsed(new[] { "--quiet", "--uninstall" })?.Mode == InstallerMode.QuietUninstall, "legacy: --uninstall names the mode whatever the file is called");
        kit.Check(Parsed(Array.Empty<string>())?.Mode == InstallerMode.Wizard, "legacy: no arguments is the setup wizard");
        kit.Check(Parsed(Array.Empty<string>(), "Uninstall")?.Mode == InstallerMode.WizardUninstall && Parsed(new[] { "--uninstall" })?.Mode == InstallerMode.WizardUninstall && Parsed(new[] { "/UNINSTALL" })?.Mode == InstallerMode.WizardUninstall && Parsed(new[] { "-uninstall" })?.Mode == InstallerMode.WizardUninstall,
            "legacy: the uninstall wizard, by the file name or by --uninstall in any spelling it takes");
        kit.Check(Parsed(new[] { "--quiet", "--install-dir", Dir, "--relaunch" }) == null, "legacy: --quiet --install-dir takes no other argument (a form that only an update may carry is refused without --update)");
        kit.Check(Parsed(new[] { "--quiet", "--install-dir", @"relative\dir" }) == null && Parsed(new[] { "--quiet" }) == null && Parsed(new[] { "--quiet", "--install-dir" }) == null, "legacy: a relative directory, no directory and a directory with no value are refused");
        kit.Check(Parsed(new[] { "--quiet", "--uninstall", "extra" }) == null, "legacy: Uninstall --quiet takes exactly --uninstall");
        foreach (var message in new[] { "Use DatGoldSetup.exe --quiet --install-dir <absolute directory>.", "Use Uninstall.exe --quiet --uninstall." })
        {
            string? text = null;
            try { InstallerCommandLine.Parse(message.StartsWith("Use Uninstall") ? new[] { "--quiet", "--uninstall", "x" } : new[] { "--quiet" }, "DatGoldSetup"); } catch (ArgumentException error) { text = error.Message; }
            kit.Check(text == message, "legacy: the refusal says what it said before: " + message);
        }

        // ---- the update form, in any order and with only what is needed
        kit.Check(Parsed(new[] { "--quiet", "--update", "--install-dir", Dir }) is { Mode: InstallerMode.Update, WaitPid: null, Relaunch: false, ResultFile: null }, "an update needs only --quiet --update --install-dir");
        kit.Check(Parsed(new[] { "--result", Result, "--relaunch", "--wait-pid", "7", "--install-dir", Dir, "--update", "--quiet" }) is { Mode: InstallerMode.Update, InstallDir: Dir, WaitPid: 7, Relaunch: true, ResultFile: Result }, "and the order of the parts does not matter");
        var refused = new (string Why, string[] Args)[]
        {
            ("no --quiet", new[] { "--update", "--install-dir", Dir }), ("no directory", new[] { "--quiet", "--update" }), ("a relative directory", new[] { "--quiet", "--update", "--install-dir", "ChatMCP" }),
            ("a directory with no value", new[] { "--quiet", "--update", "--install-dir" }), ("a directory whose value is another flag", new[] { "--quiet", "--update", "--install-dir", "--relaunch" }),
            ("a repeated --install-dir", new[] { "--quiet", "--update", "--install-dir", Dir, "--install-dir", Dir }), ("a repeated --relaunch", new[] { "--quiet", "--update", "--install-dir", Dir, "--relaunch", "--relaunch" }),
            ("a repeated --update", new[] { "--quiet", "--update", "--update", "--install-dir", Dir }), ("a repeated --quiet", new[] { "--quiet", "--quiet", "--update", "--install-dir", Dir }),
            ("a pid of 0", new[] { "--quiet", "--update", "--install-dir", Dir, "--wait-pid", "0" }), ("a negative pid", new[] { "--quiet", "--update", "--install-dir", Dir, "--wait-pid", "-4" }),
            ("a pid that is text", new[] { "--quiet", "--update", "--install-dir", Dir, "--wait-pid", "abc" }), ("a pid too large for an int", new[] { "--quiet", "--update", "--install-dir", Dir, "--wait-pid", "2147483648" }),
            ("a pid with a plus sign", new[] { "--quiet", "--update", "--install-dir", Dir, "--wait-pid", "+4" }), ("a pid with no value", new[] { "--quiet", "--update", "--install-dir", Dir, "--wait-pid" }),
            ("a relative result file", new[] { "--quiet", "--update", "--install-dir", Dir, "--result", "update-result.json" }), ("a result file with no value", new[] { "--quiet", "--update", "--install-dir", Dir, "--result" }),
            ("a result file that is not a .json file", new[] { "--quiet", "--update", "--install-dir", Dir, "--result", @"C:\Users\Test User\Documents\notes.txt" }),
            ("a flag it does not know", new[] { "--quiet", "--update", "--install-dir", Dir, "--force" }), ("a word that is not a flag", new[] { "--quiet", "--update", "--install-dir", Dir, "now" }),
            ("--uninstall together with --update", new[] { "--quiet", "--update", "--uninstall", "--install-dir", Dir }),
            ("a result file on a network share", new[] { "--quiet", "--update", "--install-dir", Dir, "--result", @"\\server\share\update-result.json" }),
            ("a result file at a device path", new[] { "--quiet", "--update", "--install-dir", Dir, "--result", @"\\?\C:\Users\Test User\update-result.json" }),
            ("a repeated --wait-pid", new[] { "--quiet", "--update", "--install-dir", Dir, "--wait-pid", "5", "--wait-pid", "6" }),
            ("a repeated --result", new[] { "--quiet", "--update", "--install-dir", Dir, "--result", Result, "--result", Result }),
        };
        foreach (var (why, args) in refused) kit.Check(Parsed(args) == null, "an update with " + why + " is refused");
        kit.Check(Parsed(new[] { "--quiet", "--update", "--install-dir", Dir }, "Uninstall") == null && Parsed(new[] { "--quiet", "--update", "--install-dir", Dir }, "uninstall-copy") == null, "an update asked of the uninstaller's own file (Uninstall.exe) is refused, whatever the arguments");
        kit.Check(Parsed(new[] { "--QUIET", "--UPDATE", "--INSTALL-DIR", Dir })?.Mode == InstallerMode.Wizard, "flags in capitals are not flags of the update: the wizard opens, as it does for any arguments it does not know");

        // ---- the repair: one explicit form, exactly these four arguments (vector 2, literal; when it has to change a third vector is added). It is for a person or a script that wants an installation put back after an
        // update that stopped halfway. It never falls through to the wizard, takes nothing an update takes, and is not run by the uninstaller's own file (that is a file of the installation, and the journal lists it).
        string[] vector2 = { "--quiet", "--recover", "--install-dir", Dir };
        kit.Check(Parsed(vector2) is { Mode: InstallerMode.Recover, InstallDir: Dir, WaitPid: null, Relaunch: false, ResultFile: null }, "the repair is asked for with exactly: " + Show(vector2));
        kit.Check(Parsed(new[] { "--install-dir", Dir, "--recover", "--quiet" }) is { Mode: InstallerMode.Recover, InstallDir: Dir }, "and the order of the parts does not matter");
        var refusedRepairs = new (string Why, string[] Args)[]
        {
            ("no --quiet", new[] { "--recover", "--install-dir", Dir }), ("--recover alone", new[] { "--recover" }), ("no directory", new[] { "--quiet", "--recover" }), ("a relative directory", new[] { "--quiet", "--recover", "--install-dir", "ChatMCP" }),
            ("a directory with no value", new[] { "--quiet", "--recover", "--install-dir" }), ("a directory whose value is another flag", new[] { "--quiet", "--recover", "--install-dir", "--quiet" }),
            ("a repeated --recover", new[] { "--quiet", "--recover", "--recover", "--install-dir", Dir }), ("a repeated --install-dir", new[] { "--quiet", "--recover", "--install-dir", Dir, "--install-dir", Dir }),
            ("--relaunch", new[] { "--quiet", "--recover", "--install-dir", Dir, "--relaunch" }), ("--wait-pid", new[] { "--quiet", "--recover", "--install-dir", Dir, "--wait-pid", "5" }),
            ("--result", new[] { "--quiet", "--recover", "--install-dir", Dir, "--result", Result }), ("--update", new[] { "--quiet", "--update", "--recover", "--install-dir", Dir }),
            ("--uninstall", new[] { "--quiet", "--recover", "--uninstall", "--install-dir", Dir }), ("a flag it does not know", new[] { "--quiet", "--recover", "--install-dir", Dir, "--force" }),
            ("a word that is not a flag", new[] { "--quiet", "--recover", "--install-dir", Dir, "now" }), ("the directory missing and a word in its place", new[] { "--quiet", "--recover", "--install-dir", "x", "y" }),
            ("four arguments but a word where --quiet should be", new[] { "--recover", "--install-dir", Dir, "now" }), ("four arguments and --install-dir last, with no value after it", new[] { "--quiet", "--recover", "extra", "--install-dir" }),
        };
        foreach (var (why, args) in refusedRepairs) kit.Check(Parsed(args) == null, "a repair with " + why + " is refused");
        kit.Check(Parsed(vector2, "Uninstall") == null && Parsed(vector2, "uninstall-copy") == null, "a repair asked of the uninstaller's own file (Uninstall.exe) is refused");
        kit.Check(Parsed(new[] { "--QUIET", "--RECOVER", "--INSTALL-DIR", Dir })?.Mode == InstallerMode.Wizard, "flags in capitals are not flags of the repair: the wizard opens, as it does for any arguments it does not know");
        {
            string? text = null;
            try { InstallerCommandLine.Parse(new[] { "--quiet", "--recover" }, "DatGoldSetup"); } catch (ArgumentException error) { text = error.Message; }
            kit.Check(text == "Use DatGoldSetup.exe --quiet --recover --install-dir <absolute directory>.", "and the refusal says what the form is");
        }
        kit.Check(Parsed(new[] { "--quiet", "--install-dir", Dir }) is { Mode: InstallerMode.QuietInstall } && Parsed(new[] { "--quiet", "--update", "--install-dir", Dir }) is { Mode: InstallerMode.Update }, "while the install and the update forms read the way they did");
        // a directory that cannot be a directory is not a directory to repair: a quote at its end is what a path that ends in a backslash becomes inside quotes (the command the launcher used to print), and a device path
        // is not a spelling the repair can read. Both used to be accepted and to end in 'there is nothing to repair'.
        foreach (var (why, bad) in new[]
        {
            ("a quote at its end", Dir + "\""), ("a quote inside it", @"C:\Users\Test ""User""\ChatMCP"), ("a less-than sign", @"C:\Users\a<b"), ("a pipe", @"C:\Users\a|b"), ("a line feed", "C:\\Users\\a\nb"),
            ("a device path with a question mark", @"\\?\C:\Users\Test User\ChatMCP"), ("a device path with a dot", @"\\.\C:\Users\Test User\ChatMCP"),
            ("a device path to a share", @"\\?\UNC\server\share\ChatMCP"), ("a device path to a share, the other spelling", @"\\.\UNC\server\share\ChatMCP"),
            ("a stream name", @"C:\Users\Test User\ChatMCP:stream"), ("a second colon", @"C:\Users\Test User:x\ChatMCP"), ("a wildcard", @"C:\Users\Test User\Chat*"), ("a question mark", @"C:\Users\Test User\Chat?"),
        })
            kit.Check(Parsed(new[] { "--quiet", "--recover", "--install-dir", bad }) == null, "a repair of a directory with " + why + " is refused");
        kit.Check(Parsed(new[] { "--quiet", "--recover", "--install-dir", @"\\server\share\ChatMCP" }) is { Mode: InstallerMode.Recover }, "while a folder on a network share is still a folder (the install form takes one too)");

        // ---- the command that the launcher tells a person to type. It is built here, by the same file that reads it, and held to the runtime's own rules for splitting a command line: the text it printed before ended in
        // a backslash before the closing quote, which the runtime reads as an escaped quote, so the folder arrived with a quote at its end.
        foreach (var typed in new[] { Dir + @"\", Dir, @"C:\Program Files\DatGold", @"C:\a b\c d\\", @"D:\x y\", @"C:\NoSpaces\", @"\\server\share\Dat Gold\" })
        {
            var echoed = EchoedBy(InstallerCommandLine.RecoverArgumentText(typed));
            var parsed = echoed.Length == 4 ? Parsed(echoed) : null;
            kit.Check(parsed is { Mode: InstallerMode.Recover } && string.Equals(Path.GetFullPath(parsed.InstallDir!).TrimEnd('\\'), Path.GetFullPath(typed).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase),
                "the command printed for " + typed + " reaches the repair as that folder (" + InstallerCommandLine.RecoverCommandText(typed) + " -> " + Show(echoed) + ")");
        }
        kit.Check(InstallerCommandLine.RecoverCommandText(Dir + @"\") == "DatGoldSetup.exe --quiet --recover --install-dir \"" + Dir + "\"", "and for the folder the launcher knows (it ends in a backslash) the text is the plain one, with the backslash left out: " + InstallerCommandLine.RecoverCommandText(Dir + @"\"));
        kit.Check(!InstallerCommandLine.RecoverCommandText(Dir + @"\").Contains(@"\""") && InstallerCommandLine.RecoverCommandText(@"D:\").EndsWith(@"\\""", StringComparison.Ordinal), "a backslash is never left to escape the closing quote (a root folder, which must keep one, doubles it)");

        // ---- the result file the installer leaves for the Hub of whichever version runs afterwards (format 1). Literal text, one line, in this order.
        var cases = new (string Name, UpdateOutcome Outcome, string Text)[]
        {
            ("installed", new UpdateOutcome(true, "3.11.0", "3.10.2", "installed", null), "{\"format\":1,\"ok\":true,\"version\":\"3.11.0\",\"previous\":\"3.10.2\",\"state\":\"installed\",\"reason\":null,\"rolledBack\":false}"),
            ("refused before anything changed", new UpdateOutcome(false, "3.11.0", "3.10.2", "unchanged", "tasks_running"), "{\"format\":1,\"ok\":false,\"version\":\"3.11.0\",\"previous\":\"3.10.2\",\"state\":\"unchanged\",\"reason\":\"tasks_running\",\"rolledBack\":false}"),
            ("failed and rolled back", new UpdateOutcome(false, "3.11.0", "3.10.2", "rolled_back", "install_failed"), "{\"format\":1,\"ok\":false,\"version\":\"3.11.0\",\"previous\":\"3.10.2\",\"state\":\"rolled_back\",\"reason\":\"install_failed\",\"rolledBack\":true}"),
            ("failed and needs recovery", new UpdateOutcome(false, "3.11.0", "3.10.2", "needs_recovery", "install_failed"), "{\"format\":1,\"ok\":false,\"version\":\"3.11.0\",\"previous\":\"3.10.2\",\"state\":\"needs_recovery\",\"reason\":\"install_failed\",\"rolledBack\":false}"),
            ("the old version could not be read", new UpdateOutcome(false, "3.11.0", null, "unchanged", "no_installation"), "{\"format\":1,\"ok\":false,\"version\":\"3.11.0\",\"previous\":null,\"state\":\"unchanged\",\"reason\":\"no_installation\",\"rolledBack\":false}"),
        };
        foreach (var (name, outcome, text) in cases) kit.Check(UpdateResultFile.Serialize(outcome) == text, "the result file, " + name + ", is exactly: " + text);
        kit.Check(cases[2].Outcome.RolledBack && !cases[1].Outcome.RolledBack && !cases[3].Outcome.RolledBack && !cases[0].Outcome.RolledBack, "rolledBack is true only where files were replaced and then put back (not when nothing was touched, not when the rollback was incomplete)");

        // the same literal texts are what the Hub is held to (CHATMCP-HUB/tests/verify-update-applied.mjs reads this file)
        var path = Path.Combine(AppContext.BaseDirectory, "update-result-vectors.json");
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        var written = document.RootElement.GetProperty("written").EnumerateArray().ToDictionary(item => item.GetProperty("name").GetString()!, item => item.GetProperty("text").GetString()!);
        kit.Check(written.Count == cases.Length && cases.All(item => written.TryGetValue(item.Name, out var text) && text == item.Text), "and the Hub's test file holds the same " + cases.Length + " texts, byte for byte");

        // ---- writing it: whole or not at all, never through a link, no stray file
        var folder = kit.Folder("result");
        var file = Path.Combine(folder, "update-result.json");
        UpdateResultFile.Write(file, cases[0].Outcome);
        kit.Check(File.ReadAllText(file) == cases[0].Text && Directory.GetFiles(folder).Length == 1, "written whole in one file (a temporary file is renamed over it, none is left)");
        UpdateResultFile.Write(file, cases[1].Outcome);
        kit.Check(File.ReadAllText(file) == cases[1].Text, "and written again over the old one");
        kit.Check(!UpdateResultFile.TryWrite(Path.Combine(folder, "no", "such", "folder", "update-result.json"), cases[0].Outcome) && !UpdateResultFile.TryWrite("relative.json", cases[0].Outcome), "a result that cannot be written is not an error of the update: TryWrite says it was not, and stops there");
        var linkTarget = Path.Combine(folder, "target.txt"); File.WriteAllText(linkTarget, "keep");
        var link = Path.Combine(folder, "linked-result.json");
        try
        {
            File.CreateSymbolicLink(link, linkTarget);
            kit.Check(!UpdateResultFile.TryWrite(link, cases[0].Outcome) && File.ReadAllText(linkTarget) == "keep", "a result file that is a link is not written through");
            File.Delete(link);
        }
        catch (Exception error) when (error is UnauthorizedAccessException or IOException) { kit.Check(true, "(a link cannot be made here without a privilege: the check is made on the runner)"); }

        // a result that cannot be put in place leaves nothing behind, not the temporary file, and what was there is untouched
        {
            var guarded = Path.Combine(folder, "read-only-result.json");
            File.WriteAllText(guarded, "keep"); File.SetAttributes(guarded, FileAttributes.ReadOnly);
            var before = Directory.GetFiles(folder).Length;
            kit.Check(!UpdateResultFile.TryWrite(guarded, cases[0].Outcome) && File.ReadAllText(guarded) == "keep" && Directory.GetFiles(folder).Length == before, "a result file that is read-only is not replaced: TryWrite says so, the file is as it was and no temporary file is left");
            File.SetAttributes(guarded, FileAttributes.Normal);
            var folderInTheWay = Path.Combine(folder, "a-folder.json"); Directory.CreateDirectory(folderInTheWay);
            var files = Directory.GetFiles(folder).Length;
            kit.Check(!UpdateResultFile.TryWrite(folderInTheWay, cases[0].Outcome) && Directory.GetFiles(folder).Length == files && Directory.Exists(folderInTheWay), "nor is a folder with that name, and no temporary file is left");
            // A name of its own for each run, removed afterwards: a file left in the working folder by an earlier run (or by a mutation that makes TryWrite accept the path) must not decide this one.
            var relativeName = "relative-result-" + Guid.NewGuid().ToString("N") + ".json";
            try { kit.Check(!UpdateResultFile.TryWrite(@".\" + relativeName, cases[0].Outcome) && !File.Exists(relativeName), "and a path that starts with a dot is relative too: nothing is written in the folder the setup was started from"); }
            finally { try { File.Delete(relativeName); } catch (Exception) { /* nothing to remove */ } }
        }
    }
}
