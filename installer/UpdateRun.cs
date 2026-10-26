using ChatMCP.Native;
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

namespace ChatMCP.Installer;

// What the installer does when the shell starts it in update mode (--quiet --update ...): the shell has verified the file and exited, and from here on nobody is watching but the progress window.
// The order is the point. Wait for the shell to go (a bounded wait, and only for the shell: a pid that has been handed on to another program is not waited for). Refuse an installation that is not
// older, and one that has not the room. Look at the shortcuts the installation has, BEFORE anything is replaced. Install. Say how it ended in the result file BEFORE the app is opened, because the Hub
// that starts reads it. Open the right app: the new one after an update, the old one after a refusal or a clean rollback (it is intact), none while the installation needs recovery (the launcher would
// refuse to start). Whatever goes wrong is turned into an outcome; nothing here throws.

/// <summary>Everything that <see cref="UpdateRun"/> touches outside itself, as functions: the installer hands in the real ones (<see cref="UpdateRun.Real"/>), a test hands in a pretend machine.</summary>
internal sealed class UpdateEnvironment
{
    /// <summary>The version of this setup: what the installation becomes.</summary>
    internal required ReleaseVersion Target { get; init; }
    /// <summary>The version of the installed ChatMCP.exe in a folder, or null when there is none or it says no release version.</summary>
    internal required Func<string, ReleaseVersion?> InstalledVersion { get; init; }
    /// <summary>The free room on the drive of a folder, or null when it cannot be told (a network path).</summary>
    internal required Func<string, long?> FreeBytes { get; init; }
    /// <summary>The size of everything this setup installs, unpacked.</summary>
    internal required Func<long> PayloadBytes { get; init; }
    /// <summary>Waits for the shell with this pid (whose program must be the given file) for at most this long: true when it is gone or is not the shell.</summary>
    internal required Func<int, string, TimeSpan, bool> WaitForShellExit { get; init; }
    internal required Func<string, ShortcutPlan> DetectShortcuts { get; init; }
    /// <summary>The engine: replaces the files of the installation in a folder, with the shortcuts of the plan, reporting progress.</summary>
    internal required Action<string, ShortcutPlan, Action<int, string>> Install { get; init; }
    /// <summary>Whether the marker of an update that did not finish is in the folder.</summary>
    internal required Func<string, bool> PendingMarkerExists { get; init; }
    /// <summary>Opens the app: the installed ChatMCP.exe at this path.</summary>
    internal required Action<string> Relaunch { get; init; }
    /// <summary>Leaves the result file; false when it could not.</summary>
    internal required Func<string, UpdateOutcome, bool> WriteResult { get; init; }
}

/// <summary>Waiting for the shell that started the installer.</summary>
internal static class ShellProcess
{
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
    private const uint QueryLimitedInformation = 0x1000;
    private const int InvalidParameter = 87; // OpenProcess says this for an identifier that no process has

    /// <summary>The program a process runs, asked of the operating system (Process.MainModule reads the module list of the process, which is not there yet for a process that has just started). Null when it cannot be told; `gone` when no process has this identifier.</summary>
    private static string? ImageOf(int pid, out bool gone)
    {
        gone = false;
        var handle = OpenProcess(QueryLimitedInformation, false, pid);
        if (handle == IntPtr.Zero) { gone = Marshal.GetLastWin32Error() == InvalidParameter; return null; }
        try
        {
            var name = new StringBuilder(1024); var size = name.Capacity;
            return QueryFullProcessImageName(handle, 0, name, ref size) ? name.ToString(0, size) : null;
        }
        finally { CloseHandle(handle); }
    }

    /// <summary>
    /// True when the process <paramref name="pid"/> is gone, or is not the program <paramref name="expectedImage"/> (an identifier that was handed on to another program is not the shell and is not waited for);
    /// false when it is still there after <paramref name="limit"/>, or when it cannot be looked at (then it is treated as the shell and never as gone).
    /// </summary>
    internal static bool WaitForExit(int pid, string expectedImage, TimeSpan limit)
    {
        var image = ImageOf(pid, out var gone);
        if (gone) return true;
        if (image != null && !string.Equals(Path.GetFullPath(image), Path.GetFullPath(expectedImage), StringComparison.OrdinalIgnoreCase)) return true;
        Process process;
        try { process = Process.GetProcessById(pid); } catch (ArgumentException) { return true; }
        using (process)
        {
            try { return process.WaitForExit((int)Math.Min(limit.TotalMilliseconds, int.MaxValue)); }
            catch (Exception) { return false; }
        }
    }
}

internal static class UpdateRun
{
    /// <summary>The shell closes itself within a second or two; a window that is still open after this has not been told to close, or is stuck.</summary>
    internal static readonly TimeSpan ShellExitLimit = TimeSpan.FromSeconds(30);
    private const long MinimumRoom = 128L * 1024 * 1024;

    /// <summary>
    /// The room to ask for before anything is stopped: the payload (the setup stages the whole of it inside the installation folder) and 128 MiB, or a quarter of it when that is more, for the files that change and their backups.
    /// A guess that is made to refuse early, in words, an update that would certainly run out of disk; the transaction still rolls back if the disk fills later.
    /// </summary>
    internal static long RequiredBytes(long payloadBytes) => payloadBytes + Math.Max(MinimumRoom, payloadBytes / 4);

    /// <summary>A version resource as x.y.z (anything after a plus sign dropped), or null when it is not a release version.</summary>
    internal static ReleaseVersion? ReadVersion(string? text) =>
        !string.IsNullOrEmpty(text) && ReleaseVersion.TryParse(text.Split('+')[0], out var version) ? version : null;

    internal static UpdateEnvironment Real() => new()
    {
        Target = ReadVersion(InstallerEngine.AppVersion) ?? throw new InvalidOperationException("The version of this setup is not a release version."),
        InstalledVersion = directory =>
        {
            var program = Path.Combine(directory, "ChatMCP.exe");
            return File.Exists(program) ? ReadVersion(FileVersionInfo.GetVersionInfo(program).ProductVersion) : null;
        },
        FreeBytes = FreeBytesOf,
        PayloadBytes = PayloadBytesOfThisSetup,
        WaitForShellExit = ShellProcess.WaitForExit,
        DetectShortcuts = directory => InstallerEngine.DetectShortcuts(directory, Environment.GetFolderPath(Environment.SpecialFolder.Desktop), Environment.GetFolderPath(Environment.SpecialFolder.Programs)),
        Install = (directory, plan, progress) => InstallerEngine.Install(directory, plan, progress),
        PendingMarkerExists = directory => File.Exists(Path.Combine(directory, InstallTransaction.PendingName)),
        Relaunch = OpenApp,
        WriteResult = (path, outcome) => UpdateResultFile.TryWrite(path, outcome),
    };

    private static long? FreeBytesOf(string directory)
    {
        try
        {
            var root = Path.GetPathRoot(Path.GetFullPath(directory));
            return string.IsNullOrEmpty(root) ? null : new DriveInfo(root).AvailableFreeSpace;
        }
        catch (Exception error) when (error is ArgumentException or IOException or UnauthorizedAccessException or NotSupportedException) { return null; }
    }

    private static long PayloadBytesOfThisSetup()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("ChatMCP.Installer.payload.zip");
        if (stream == null) return 0;
        using var archive = new ZipArchive(stream, ZipArchiveMode.Read);
        long total = 0;
        foreach (var entry in archive.Entries) total += entry.Length;
        return total;
    }

    private static void OpenApp(string program)
    {
        if (!File.Exists(program)) return;
        using var started = Process.Start(new ProcessStartInfo(program) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(program)! });
    }

    /// <summary>Runs the update and says how it ended. Never throws.</summary>
    internal static UpdateOutcome Run(InstallerCommand command, UpdateEnvironment environment, Action<int, string> progress)
    {
        var directory = command.InstallDir ?? throw new ArgumentException("An update needs the installation directory.");
        var program = Path.Combine(directory, "ChatMCP.exe");
        ReleaseVersion? previous = null;
        try { previous = environment.InstalledVersion(directory); } catch (Exception) { /* no installation that can be read */ }
        var outcome = Execute(command, environment, progress, directory, program, previous);
        if (command.ResultFile != null)
        {
            try { environment.WriteResult(command.ResultFile, outcome); } catch (Exception) { /* a result that cannot be left is not worth failing for */ }
        }
        if (command.Relaunch && outcome.State != "needs_recovery" && !MarkerExists(environment, directory))
        {
            try { environment.Relaunch(program); } catch (Exception) { /* the person can open the app themselves */ }
        }
        return outcome;
    }

    /// <summary>Whether the marker is there; where that cannot be told it is taken as there, because the launcher refuses to start behind it.</summary>
    private static bool MarkerExists(UpdateEnvironment environment, string directory)
    {
        try { return environment.PendingMarkerExists(directory); } catch (Exception) { return true; }
    }

    private static UpdateOutcome Execute(InstallerCommand command, UpdateEnvironment environment, Action<int, string> progress, string directory, string program, ReleaseVersion? previous)
    {
        var target = environment.Target;
        UpdateOutcome End(bool ok, string state, string? reason) => new(ok, target.ToString(), previous?.ToString(), state, reason);

        if (command.WaitPid is { } pid)
        {
            progress(2, "Waiting for DatGold to close...");
            if (!environment.WaitForShellExit(pid, program, ShellExitLimit)) return End(false, "unchanged", "shell_not_exited");
        }
        if (previous == null) return End(false, "unchanged", "no_installation");
        if (target.CompareTo(previous.Value) <= 0) return End(false, "unchanged", "not_newer");
        if (MarkerExists(environment, directory)) return End(false, "needs_recovery", "pending_recovery");

        progress(4, "Checking this computer...");
        long? free = null;
        try { free = environment.FreeBytes(directory); } catch (Exception) { /* unknown */ }
        long payload = 0;
        try { payload = environment.PayloadBytes(); } catch (Exception) { /* unknown */ }
        if (free != null && free.Value < RequiredBytes(payload)) return End(false, "unchanged", "disk_full");

        ShortcutPlan plan;
        try { plan = environment.DetectShortcuts(directory); } catch (Exception) { plan = ShortcutPlan.All; }
        try
        {
            environment.Install(directory, plan, progress);
            return End(true, "installed", null);
        }
        catch (Exception error)
        {
            var code = StepCode.Of(error) is { } tagged && StepCode.IsKnown(tagged) ? tagged : "install_failed";
            // what is on disk decides what is said: a marker that is still there means an unfinished update (the app would refuse to start); the new version in place means the update did go through
            // (a step after the commit failed); a rollback that was whole means the old version is back; anything else stopped before a file was replaced
            if (MarkerExists(environment, directory)) return End(false, "needs_recovery", code);
            ReleaseVersion? now = null;
            try { now = environment.InstalledVersion(directory); } catch (Exception) { /* unknown */ }
            if (now != null && now.Value.CompareTo(target) == 0) return End(true, "installed", null);
            return End(false, WasRolledBack(error) ? "rolled_back" : "unchanged", code);
        }
    }

    private static bool WasRolledBack(Exception error)
    {
        for (var current = error; current != null; current = current.InnerException) if (current is UpgradeRolledBackException) return true;
        return false;
    }
}
