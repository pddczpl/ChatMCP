using System.Globalization;
using System.Text;
using System.Text.Json;

namespace ChatMCP.Native;

// What the desktop shell, the installer and the Hub say to each other when an update is applied. It is a contract ACROSS VERSIONS, not inside one: the shell of the version a person has installed
// starts the installer of a LATER one (people skip versions, so installer N+k meets shell N for any k), and the Hub that runs afterwards reads the result file that the installer of another
// version wrote. Both halves live in this one file, compiled into the shell and the installer, and scripts/tests/native-lifecycle/ContractTests.cs holds them to literal text: every vector a shell
// has sent stays accepted (the list only grows), and a change that breaks one breaks an installed copy.

internal enum InstallerMode { Wizard, WizardUninstall, QuietInstall, QuietUninstall, Update, Recover }

/// <summary>What the command line of the installer asks for. Only <see cref="InstallerMode.Update"/> has a wait, a relaunch and a result file; <see cref="InstallerMode.Recover"/> takes the installation directory and nothing else.</summary>
internal sealed record InstallerCommand(InstallerMode Mode, string? InstallDir = null, int? WaitPid = null, bool Relaunch = false, string? ResultFile = null);

/// <summary>The arguments that the shell gives the installer of the update it has verified.</summary>
internal static class UpdateArguments
{
    /// <summary>
    /// <c>--quiet --update --install-dir &lt;dir&gt; --wait-pid &lt;pid&gt; --relaunch --result &lt;file&gt;</c>, as a list for ProcessStartInfo.ArgumentList (nothing is quoted by hand). This is vector 1 of the contract:
    /// when it has to change, a second vector is ADDED and this one stays, because shells that send it stay installed.
    /// </summary>
    internal static string[] Build(string installDir, int waitPid, string resultFile) =>
        new[] { "--quiet", "--update", "--install-dir", installDir, "--wait-pid", waitPid.ToString(CultureInfo.InvariantCulture), "--relaunch", "--result", resultFile };
}

/// <summary>The command line of the installer, in every form it has: the setup wizard, the uninstall wizard, the quiet install and uninstall of the lifecycle scripts, and the update the shell starts.</summary>
internal static class InstallerCommandLine
{
    private const string QuietUsage = "Use DatGoldSetup.exe --quiet --install-dir <absolute directory>.";
    private const string UninstallUsage = "Use Uninstall.exe --quiet --uninstall.";
    private const string UpdateUsage = "Use DatGoldSetup.exe --quiet --update --install-dir <absolute directory> [--wait-pid <process id>] [--relaunch] [--result <absolute path of a .json file>].";
    private const string RecoverUsage = "Use DatGoldSetup.exe --quiet --recover --install-dir <absolute directory>.";

    /// <summary>
    /// The command for <paramref name="args"/> given the name of the running file (without its extension). The quiet forms take EXACTLY what they took before the update existed, and an update takes
    /// exactly its own parts; anything else is an ArgumentException with the usage text. Arguments that name no quiet mode open the wizard, as they always did.
    /// </summary>
    internal static InstallerCommand Parse(string[] args, string exeName)
    {
        var uninstall = exeName.Contains("uninstall", StringComparison.OrdinalIgnoreCase) ||
            args.Any(arg => arg.Equals("--uninstall", StringComparison.OrdinalIgnoreCase) || arg.Equals("/uninstall", StringComparison.OrdinalIgnoreCase) || arg.Equals("-uninstall", StringComparison.OrdinalIgnoreCase));
        if (Array.Exists(args, arg => arg == "--update"))
        {
            if (uninstall) throw new ArgumentException(UpdateUsage);
            return ParseUpdate(args);
        }
        // the repair of an installation behind the marker of an update that stopped halfway: exactly --quiet --recover --install-dir <directory>, in any order, never from the uninstaller's own file
        if (Array.Exists(args, arg => arg == "--recover"))
        {
            var directory = Array.IndexOf(args, "--install-dir");
            if (uninstall || args.Length != 4 || !Array.Exists(args, arg => arg == "--quiet") || directory < 0 || directory + 1 >= args.Length || !IsRepairableDirectory(args[directory + 1])) throw new ArgumentException(RecoverUsage);
            return new InstallerCommand(InstallerMode.Recover, args[directory + 1]);
        }
        if (Array.Exists(args, arg => arg == "--quiet"))
        {
            if (uninstall)
            {
                if (args.Length != 2 || !Array.Exists(args, arg => arg == "--uninstall")) throw new ArgumentException(UninstallUsage);
                return new InstallerCommand(InstallerMode.QuietUninstall);
            }
            var index = Array.IndexOf(args, "--install-dir");
            if (args.Length != 3 || index < 0 || index + 1 >= args.Length || !Path.IsPathFullyQualified(args[index + 1])) throw new ArgumentException(QuietUsage);
            return new InstallerCommand(InstallerMode.QuietInstall, args[index + 1]);
        }
        return new InstallerCommand(uninstall ? InstallerMode.WizardUninstall : InstallerMode.Wizard);
    }

    /// <summary>The characters no folder name has. (Path.GetInvalidPathChars() lists only the pipe and the control characters on this runtime: a quote, which a path that ends in a backslash becomes inside quotes, passes it.)</summary>
    private static readonly char[] NotInAFolder = { '"', '<', '>', '|', '*', '?' };

    /// <summary>A directory the repair can be asked about: fully qualified, none of the characters no folder name has, a colon only after the drive letter (no stream), and not a device path.</summary>
    private static bool IsRepairableDirectory(string value)
    {
        if (!Path.IsPathFullyQualified(value) || value.IndexOfAny(NotInAFolder) >= 0 || value.Any(char.IsControl)) return false;
        if (value.StartsWith(@"\\?\", StringComparison.Ordinal) || value.StartsWith(@"\\.\", StringComparison.Ordinal)) return false;
        var colon = value.IndexOf(':');
        return colon < 0 || (colon == 1 && value.IndexOf(':', 2) < 0);
    }

    /// <summary>The arguments of the repair as a person types them after DatGoldSetup.exe: the folder in quotes, with no backslash left to escape the closing quote. Read back by <see cref="Parse"/> as the same folder.</summary>
    internal static string RecoverArgumentText(string installDir) => "--quiet --recover --install-dir " + Quote(Path.TrimEndingDirectorySeparator(installDir));

    /// <summary>The whole command, for the words the launcher shows when an update stopped halfway.</summary>
    internal static string RecoverCommandText(string installDir) => "DatGoldSetup.exe " + RecoverArgumentText(installDir);

    /// <summary>One argument as the runtime splits a command line: in quotes, a quote inside it escaped, and the backslashes before a quote (or before the closing one) doubled.</summary>
    private static string Quote(string argument)
    {
        var quoted = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var letter in argument)
        {
            if (letter == '\\') { backslashes++; continue; }
            if (letter == '"') { quoted.Append('\\', backslashes * 2 + 1).Append('"'); backslashes = 0; continue; }
            quoted.Append('\\', backslashes).Append(letter);
            backslashes = 0;
        }
        return quoted.Append('\\', backslashes * 2).Append('"').ToString();
    }

    private static InstallerCommand ParseUpdate(string[] args)
    {
        bool quiet = false, update = false, relaunch = false;
        string? dir = null, result = null;
        int? pid = null;
        string Value(ref int index)
        {
            if (index + 1 >= args.Length) throw new ArgumentException(UpdateUsage);
            return args[++index];
        }
        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--quiet": if (quiet) throw new ArgumentException(UpdateUsage); quiet = true; break;
                case "--update": if (update) throw new ArgumentException(UpdateUsage); update = true; break;
                case "--relaunch": if (relaunch) throw new ArgumentException(UpdateUsage); relaunch = true; break;
                case "--install-dir":
                    {
                        var value = Value(ref index);
                        if (dir != null || !Path.IsPathFullyQualified(value)) throw new ArgumentException(UpdateUsage);
                        dir = value;
                        break;
                    }
                case "--wait-pid":
                    {
                        var value = Value(ref index);
                        if (pid != null || value.Length == 0 || !value.All(char.IsAsciiDigit) || !int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var number) || number < 1) throw new ArgumentException(UpdateUsage);
                        pid = number;
                        break;
                    }
                case "--result":
                    {
                        var value = Value(ref index);
                        // a file on a drive of this machine, never a UNC or device path, and a .json file: the one thing the installer writes is a small JSON note
                        var onDrive = value.Length > 3 && char.IsAsciiLetter(value[0]) && value[1] == ':' && value[2] == '\\';
                        if (result != null || !onDrive || !Path.IsPathFullyQualified(value) || !value.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException(UpdateUsage);
                        result = value;
                        break;
                    }
                default: throw new ArgumentException(UpdateUsage);
            }
        }
        if (!quiet || dir == null) throw new ArgumentException(UpdateUsage);
        return new InstallerCommand(InstallerMode.Update, dir, pid, relaunch, result);
    }
}

/// <summary>
/// How an update ended, for the Hub that runs next (format 1). `state` says what is on disk: `installed` (the new files are in place), `unchanged` (it stopped before a file was replaced: the old
/// version is as it was), `rolled_back` (files were replaced and all of them were put back, by the rollback or by the repair that followed it) or `needs_recovery` (the rollback is incomplete and no repair
/// has finished: the retained backup and the marker are still there and the launcher refuses to start). `reason` is a short code, never text of an exception, because that can hold a path.
/// </summary>
internal sealed record UpdateOutcome(bool Ok, string Version, string? Previous, string State, string? Reason)
{
    /// <summary>True only where files were replaced and then put back; not when nothing was touched, and not when the rollback was incomplete.</summary>
    internal bool RolledBack => State == "rolled_back";
}

/// <summary>The result file: one line of JSON in a fixed order, written whole (a temporary file renamed over it), never through a link.</summary>
internal static class UpdateResultFile
{
    internal const int Format = 1;

    internal static string Serialize(UpdateOutcome outcome) => JsonSerializer.Serialize(new
    {
        format = Format, ok = outcome.Ok, version = outcome.Version, previous = outcome.Previous, state = outcome.State, reason = outcome.Reason, rolledBack = outcome.RolledBack,
    });

    /// <summary>Writes <paramref name="outcome"/> to <paramref name="path"/> (a full path in a folder that exists). Throws when it cannot: the caller decides that this is not worth stopping for.</summary>
    internal static void Write(string path, UpdateOutcome outcome)
    {
        if (!Path.IsPathFullyQualified(path)) throw new ArgumentException("The result file must be given as a full path.");
        var folder = Path.GetDirectoryName(path) ?? throw new ArgumentException("The result file has no folder.");
        if (!Directory.Exists(folder)) throw new DirectoryNotFoundException("The folder of the result file does not exist.");
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("The result file is a link.");
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                var bytes = new UTF8Encoding(false).GetBytes(Serialize(outcome));
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    /// <summary>Whether the result was written. A result that cannot be left is no reason to fail an update that otherwise went through.</summary>
    internal static bool TryWrite(string path, UpdateOutcome outcome)
    {
        try { Write(path, outcome); return true; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return false; }
    }
}
