using ChatMCP.Native;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ChatMCP.Installer;

/// <summary>What a repair found: there was no marker (nothing to repair), or the installation was put back as it was before the update that stopped halfway.</summary>
internal enum RecoveryResult { NothingToRepair, Repaired }

/// <summary>
/// A repair that did not finish. <see cref="Code"/> says why, in a closed list that belongs to the installer's window (it is not one of the reasons of the result file, which stays as it is);
/// <see cref="Touched"/> says whether a file had been changed by then: false means it was REFUSED and nothing was changed.
/// </summary>
internal sealed class RecoveryException : IOException
{
    internal string Code { get; }
    internal bool Touched { get; }
    internal RecoveryException(string code, string message, bool touched = false, Exception? inner = null) : base(message, inner) { Code = code; Touched = touched; }
}

// What the setup does for an installation that an update left behind its marker (.chatmcp-update-pending.json), when the rollback of the transaction could not put every file back or the setup died in the
// middle (a power cut, a killed process): it puts back, from the backup that the transaction kept, every file the update replaced or removed, removes every file it created, and then removes the marker and
// the backup, so that DatGold starts and the setup works again. It is the same decision as the rollback in InstallTransaction.Commit, for every state a file can be in, and the same as the block of
// docs/WINDOWS-SETUP.md (the way to do it by hand, which stays), with one difference that is the point: it does nothing unless it can PROVE that the installation is what the journal says.
//
//   * Phase 1 changes nothing. The marker and the journal are read as data (size, shape, hashes), every name goes through the rules of a payload and of a folder with no links, every backup must be a
//     plain file that hashes to what the journal says, and every file is looked at: the update's own result (the new bytes), the old bytes, or no file are all in order; anything else is somebody
//     else's change (the rollback calls it "concurrent changes") and the repair refuses. One thing that is wrong refuses all of it: it never puts back half of what it can.
//   * Phase 2 puts back, last change first, through a temporary file that is flushed and then moved over the target, and checks each file after it. A stop in the middle (a power cut, a file that is held
//     open) leaves the marker, and the next run classifies what was done as done and goes on. The marker goes only after every file is back, and the backup after the marker: a stop between the two leaves
//     a folder that nothing points to (disk space, nothing else).
//   * It touches nothing outside the installation folder, nothing below a link, and not the data folder of the Hub if that is inside the installation; the paths in the marker and the journal are never
//     followed (they are the spelling of the machine that wrote them, so only their last names are read and the folders are made from the root it was given); and it will not run from a program that lives in
//     the installation (the journal lists Uninstall.exe, which cannot be put back while it runs).
//
// The marker and the journal are the format of the setups of 3.9.0 to 3.10.2 and later: {"version":1,"backupDirectory":...} and a list of {Relative, Staged, NewHash, Backup, OldHash}. A setup of any later
// version repairs what an earlier one left, so the format is held to literal text by RecoverRefusalTests.
internal static class InstallRecovery
{
    /// <summary>The marker, the journal or a backup is missing, cannot be read, is damaged, or names something unsafe. Nothing was changed.</summary>
    internal const string NotRecoverable = "not_recoverable";
    /// <summary>A file is neither what the update left nor what it replaced: somebody else changed it. Nothing was changed.</summary>
    internal const string ForeignChanges = "foreign_changes";
    /// <summary>The program that runs the repair is a file of the installation. Nothing was changed.</summary>
    internal const string InsideInstallation = "inside_installation";
    /// <summary>A file could not be read or put back (it is held open, the disk refused). A repair that had begun can be run again.</summary>
    internal const string RestoreFailed = "restore_failed";

    private const long MarkerLimit = 4096;
    private const long JournalLimit = 128L * 1024 * 1024;
    private static readonly Regex UpdateFolder = new(@"^\.ChatMCP-update-[0-9a-f]{32}\z", RegexOptions.CultureInvariant); // exactly as the transaction names it (Guid "N" is lower case)
    private static readonly Regex BackupName = new(@"^[0-9]{6}\z", RegexOptions.CultureInvariant);
    private static readonly Regex Sha256 = new(@"^[0-9A-Fa-f]{64}\z", RegexOptions.CultureInvariant);

    /// <summary>One file to put back (a copy of the backup, which hashes to <see cref="Hash"/>) or, with no backup, a file the update created that is to be removed. It is named by its path inside the installation.</summary>
    private sealed record Step(string Relative, string? Backup, string? Hash);
    private sealed record Plan(string Root, string Workspace, string Marker, IReadOnlyList<Step> Steps);

    private static RecoveryException Refuse(string code, string message, Exception? inner = null) => new(code, message, touched: false, inner);

    private static string RootOf(string directory) => Path.GetFullPath(directory).TrimEnd('\\', '/');

    /// <summary>Whether the folder holds the marker of an update that did not finish. A folder that is not there, or cannot be looked at, holds none.</summary>
    internal static bool MarkerExists(string directory)
    {
        try { return File.Exists(InstallerEngine.SafePath(RootOf(directory), InstallTransaction.PendingName)); }
        catch (Exception error) when (error is ArgumentException or IOException or InvalidOperationException or NotSupportedException or UnauthorizedAccessException) { return false; }
    }

    /// <summary>Phase 1 alone: throws <see cref="RecoveryException"/> when the repair would be refused, returns when it would go ahead (or when there is no marker). Changes nothing.</summary>
    internal static void Check(string directory, string? runningProgram = null) => MakePlan(directory, runningProgram ?? Environment.ProcessPath);

    /// <summary>
    /// Repairs the installation in <paramref name="directory"/>. <paramref name="runningProgram"/> is the program that runs the repair (the running setup unless a test says another), which must not be
    /// a file of the installation. Throws <see cref="RecoveryException"/> only; <paramref name="progress"/> is told how far it is (10 while it checks, 40 to 90 for the files, 95, 97 and 100 at the end).
    /// </summary>
    internal static RecoveryResult Run(string directory, Action<int, string> progress, string? runningProgram = null)
    {
        progress(10, "Checking the backup of the update...");
        var plan = MakePlan(directory, runningProgram ?? Environment.ProcessPath);
        if (plan == null) return RecoveryResult.NothingToRepair;
        try
        {
            var done = 0;
            foreach (var step in plan.Steps.Reverse())
            {
                // the name is checked again right before the file is written: a link that was put in its way since the first phase looked is refused, not written through (the rollback of the transaction does the same)
                var target = InstallerEngine.SafePath(plan.Root, step.Relative);
                if (step.Backup == null) File.Delete(target);
                else
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    InstallerEngine.ReplaceFile(target, output =>
                    {
                        // hashed while it is copied and checked before the copy replaces the file: a backup that changed since the first phase looked at it never reaches the installation
                        using var input = File.OpenRead(step.Backup);
                        using var copied = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                        var buffer = new byte[81920];
                        int count;
                        while ((count = input.Read(buffer, 0, buffer.Length)) != 0) { copied.AppendData(buffer, 0, count); output.Write(buffer, 0, count); }
                        if (!Same(Convert.ToHexString(copied.GetHashAndReset()), step.Hash)) throw new IOException("A backup changed while the repair ran.");
                        if (output is FileStream file) file.Flush(true); // on the disk before the marker goes: a power cut must not leave a file that was never written and no marker to say so
                    });
                    if (!Same(HashOf(target), step.Hash)) throw new IOException("A file was not put back as it was.");
                }
                progress(40 + ++done * 50 / plan.Steps.Count, "Putting back the files of the update that stopped halfway...");
            }
            progress(95, "Removing the marker of the update...");
            File.Delete(plan.Marker);
            progress(97, "Removing the backup of the update...");
            try { RemoveWorkspace(plan.Workspace); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { /* the folder only takes up disk space; nothing points to it any more */ }
            progress(100, "DatGold was put back as it was before the update.");
        }
        catch (RecoveryException) { throw; }
        catch (Exception error) { throw new RecoveryException(RestoreFailed, "A file of the update could not be put back.", touched: true, inner: error); }
        return RecoveryResult.Repaired;
    }

    private static bool Same(string? one, string? other) => string.Equals(one, other, StringComparison.OrdinalIgnoreCase);

    private static string HashOf(string file)
    {
        using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    /// <summary>The hash of a file that must be read now: one that is held open by another program is a repair that has to wait (restore_failed), not a file that is damaged.</summary>
    private static string ReadHash(string file, string what)
    {
        try { return HashOf(file); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw Refuse(RestoreFailed, "A file is held open by another program: " + what + ".", error); }
    }

    private static bool Inside(string folder, string path)
    {
        try { return Path.GetFullPath(path).StartsWith(folder + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase); }
        catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException) { return false; }
    }

    /// <summary>The bytes of a small file of the repair's own, read without following a link; a file that is not there, is a link or is over the limit is not a thing to repair from.</summary>
    private static byte[] ReadSmall(string path, long limit, string what)
    {
        if (!File.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw Refuse(NotRecoverable, "The " + what + " is missing.");
        if (new FileInfo(path).Length > limit) throw Refuse(NotRecoverable, "The " + what + " is too large to be one.");
        try { return File.ReadAllBytes(path); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw Refuse(RestoreFailed, "The " + what + " cannot be read.", error); }
    }

    private static JsonDocument Parse(byte[] bytes, string what)
    {
        try { return JsonDocument.Parse(bytes); }
        catch (JsonException error) { throw Refuse(NotRecoverable, "The " + what + " is not JSON.", error); }
    }

    /// <summary>A text, or null for JSON null, or an exception for anything else (a property that is not there is an exception too when it is <paramref name="required"/>).</summary>
    private static string? TextOf(JsonElement entry, string name, bool required)
    {
        if (!entry.TryGetProperty(name, out var value)) return required ? throw Refuse(NotRecoverable, "A field of the journal is missing.") : null;
        if (value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.String) throw Refuse(NotRecoverable, "A field of the journal is not text.");
        try { return value.GetString(); }
        catch (InvalidOperationException error) { throw Refuse(NotRecoverable, "A field of the journal is not text.", error); } // a lone surrogate is legal JSON and is not text
    }

    private static string? HashField(JsonElement entry, string name)
    {
        var text = TextOf(entry, name, required: true);
        if (text != null && !Sha256.IsMatch(text)) throw Refuse(NotRecoverable, "A hash in the journal is not a SHA-256.");
        return text;
    }

    /// <summary>Phase 1. Null when there is no marker. Throws <see cref="RecoveryException"/> for everything that is not in order. Changes nothing.</summary>
    private static Plan? MakePlan(string directory, string? runningProgram)
    {
        if (!MarkerExists(directory)) return null;
        var root = RootOf(directory);
        if (runningProgram != null && Inside(root, runningProgram))
            throw Refuse(InsideInstallation, "The repair cannot be run by a program that is a file of the installation. Run a DatGoldSetup.exe from another folder.");
        string marker, workspace, journalPath;
        byte[] journalBytes;
        using (var pending = Parse(ReadSmall(InstallerEngine.SafePath(root, InstallTransaction.PendingName), MarkerLimit, "marker of the update"), "marker of the update"))
        {
            // the paths in the marker are those of the machine that wrote it: only the name of the backup folder is read, and the folder is made from the root that this repair was given
            string? named;
            try
            {
                var top = pending.RootElement;
                if (top.ValueKind != JsonValueKind.Object || !top.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var format) || format != 1)
                    throw Refuse(NotRecoverable, "The marker of the update is not of a kind this setup knows.");
                named = TextOf(top, "backupDirectory", required: true);
            }
            catch (InvalidOperationException error) { throw Refuse(NotRecoverable, "The marker of the update is damaged.", error); }
            var leaf = Path.GetFileName((named ?? "").TrimEnd('\\', '/'));
            if (!UpdateFolder.IsMatch(leaf)) throw Refuse(NotRecoverable, "The marker of the update does not name a backup folder of an update.");
            try
            {
                marker = InstallerEngine.SafePath(root, InstallTransaction.PendingName);
                workspace = InstallerEngine.SafePath(root, leaf);
                journalPath = InstallerEngine.SafePath(root, leaf + "/journal.json");
            }
            catch (InvalidOperationException error) { throw Refuse(NotRecoverable, "The backup folder of the update is not a plain folder of the installation.", error); }
            if (!Directory.Exists(workspace)) throw Refuse(NotRecoverable, "The backup folder of the update is missing.");
            journalBytes = ReadSmall(journalPath, JournalLimit, "journal of the update");
        }

        var stateFolder = StateFolder();
        var steps = new List<Step>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using var journal = Parse(journalBytes, "journal of the update");
        if (journal.RootElement.ValueKind != JsonValueKind.Array || journal.RootElement.GetArrayLength() == 0) throw Refuse(NotRecoverable, "The journal of the update lists nothing.");
        foreach (var entry in journal.RootElement.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object) throw Refuse(NotRecoverable, "An entry of the journal is not an object.");
            var named = TextOf(entry, "Relative", required: true) ?? throw Refuse(NotRecoverable, "An entry of the journal names no file.");
            var newHash = HashField(entry, "NewHash"); var oldHash = HashField(entry, "OldHash"); var backup = TextOf(entry, "Backup", required: true);
            string relative, target;
            try
            {
                relative = InstallTransaction.Normalize(named);
                target = InstallerEngine.SafePath(root, relative);
            }
            catch (Exception error) when (error is IOException or InvalidOperationException) { throw Refuse(NotRecoverable, "An entry of the journal names a file that is not in the installation.", error); }
            if (!seen.Add(relative)) throw Refuse(NotRecoverable, "The journal names a file twice.");
            if (stateFolder != null && (string.Equals(target, stateFolder, StringComparison.OrdinalIgnoreCase) || Inside(stateFolder, target)))
                throw Refuse(NotRecoverable, "The journal names a file in the data folder of the Hub, which is never touched.");

            if (backup == null)
            {
                if (oldHash != null)
                {
                    // the file was there and the update would have written the same bytes: the transaction never touched it
                    if (!Same(oldHash, newHash)) throw Refuse(NotRecoverable, "An entry of the journal has no backup of a file that changed.");
                    continue;
                }
                if (newHash == null) continue; // an entry that changes nothing
                if (Directory.Exists(target)) throw Refuse(NotRecoverable, "A file the update created is a folder on the disk.");
                if (!File.Exists(target)) continue; // already gone
                if (!Same(ReadHash(target, "a file the update created"), newHash)) throw Refuse(ForeignChanges, "A file the update created was changed after the update began.");
                steps.Add(new Step(relative, null, null));
                continue;
            }

            // a file that the update replaced or removed: its old bytes are in the backup
            if (oldHash == null || Same(oldHash, newHash)) throw Refuse(NotRecoverable, "An entry of the journal has a backup it cannot have.");
            var backupName = Path.GetFileName(backup.TrimEnd('\\', '/'));
            var backupFolder = Path.GetFileName((Path.GetDirectoryName(backup.TrimEnd('\\', '/')) ?? "").TrimEnd('\\', '/'));
            if (!BackupName.IsMatch(backupName) || !string.Equals(backupFolder, "old", StringComparison.OrdinalIgnoreCase)) throw Refuse(NotRecoverable, "An entry of the journal names a backup that is not one of the update.");
            string backupPath;
            try { backupPath = InstallerEngine.SafePath(root, Path.GetFileName(workspace) + "/old/" + backupName); }
            catch (InvalidOperationException error) { throw Refuse(NotRecoverable, "A backup of the update is not a plain file of the installation.", error); }
            if (!File.Exists(backupPath)) throw Refuse(NotRecoverable, "A backup of the update is missing.");
            if (!Same(ReadHash(backupPath, "a backup of the update"), oldHash)) throw Refuse(NotRecoverable, "A backup of the update is not the file it was made from.");
            if (Directory.Exists(target)) throw Refuse(NotRecoverable, "A file the update replaced is a folder on the disk.");
            if (File.Exists(target))
            {
                var current = ReadHash(target, "a file of the installation");
                if (Same(current, oldHash)) continue; // already back
                if (!Same(current, newHash)) throw Refuse(ForeignChanges, "A file of the installation was changed after the update began.");
            }
            steps.Add(new Step(relative, backupPath, oldHash));
        }
        return new Plan(root, workspace, marker, steps);
    }

    /// <summary>The data folder of the Hub, if it can be told: nothing the journal names may be inside it.</summary>
    private static string? StateFolder()
    {
        try { return RootOf(HubSession.DefaultStateDirectory()); }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or NotSupportedException or PathTooLongException) { return null; }
    }

    private static void RemoveWorkspace(string directory)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked backup folder.");
        foreach (var file in Directory.EnumerateFiles(directory))
        {
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked backup file.");
            File.Delete(file);
        }
        foreach (var child in Directory.EnumerateDirectories(directory)) RemoveWorkspace(child);
        Directory.Delete(directory);
    }
}
