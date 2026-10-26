using ChatMCP.Native;
using System.Security.Cryptography;
using System.Text.Json;

namespace ChatMCP.Installer;

/// <summary>The upgrade failed and every file that it had changed was put back: the old version is in place. (A rollback that is not whole throws an AggregateException and leaves the marker.)</summary>
internal sealed class UpgradeRolledBackException : IOException
{
    internal UpgradeRolledBackException(string message, Exception inner) : base(message, inner) { }
}

// Stages and hashes all bytes, preflights every destination, then changes only
// owned application files. Failure rolls back touched files; power interruption
// leaves a marker + journal/backup and the launcher refuses a mixed installation.
internal sealed class InstallTransaction : IDisposable
{
    private sealed record Change(string Relative, string? Staged, string? NewHash,
        string? Backup, string? OldHash);
    private readonly string root;
    private readonly string workspace;
    private readonly string marker;
    private readonly Dictionary<string, Change> changes = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<Change> touched = new();
    private bool retain;
    private long stagedBytes;
    internal const string PendingName = ".chatmcp-update-pending.json";
    internal IReadOnlyDictionary<string, string> Files => changes.Values.Where(c => c.NewHash != null)
        .ToDictionary(c => c.Relative, c => c.NewHash!, StringComparer.OrdinalIgnoreCase);
    internal InstallTransaction(string directory)
    {
        root = Path.GetFullPath(directory).TrimEnd('\\', '/');
        marker = InstallerEngine.SafePath(root, PendingName);
        if (File.Exists(marker)) throw new InvalidOperationException("An interrupted update has a retained backup. Inspect .chatmcp-update-pending.json and the installer log before retrying; no files were changed.").Tag("pending_recovery");
        workspace = InstallerEngine.SafePath(root, ".ChatMCP-update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(workspace, "new"));
        Directory.CreateDirectory(Path.Combine(workspace, "old"));
    }
    internal static string Normalize(string relative)
    {
        var value = relative.Replace('\\', '/');
        if (value.Length == 0 || Path.IsPathRooted(value) || value.Split('/').Any(p =>
            p.Length == 0 || p is "." or ".." || p.EndsWith('.') || p.EndsWith(' ') || p.Any(c => c < 32 || ":*?\"<>|".Contains(c))))
            throw new IOException("Unsafe or non-canonical payload path.");
        return value;
    }
    private static string Hash(string path)
    {
        using var file = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(file));
    }
    internal void Add(string relative, Stream source)
    {
        relative = Normalize(relative);
        InstallerEngine.SafePath(root, relative);
        if (changes.Count >= 100000 || changes.ContainsKey(relative)) throw new IOException("Duplicate or oversized installer manifest.");
        var staged = Path.Combine(workspace, "new", changes.Count.ToString("D6"));
        using (var output = new FileStream(staged, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            var buffer = new byte[81920]; int count;
            while ((count = source.Read(buffer, 0, buffer.Length)) != 0)
            {
                stagedBytes += count;
                if (stagedBytes > 4L * 1024 * 1024 * 1024) throw new IOException("Installer payload exceeds the staging limit.");
                output.Write(buffer, 0, count);
            }
            output.Flush(true);
        }
        changes.Add(relative, new Change(relative, staged, Hash(staged), null, null));
    }
    internal string StagedPath(string relative) => changes[Normalize(relative)].Staged
        ?? throw new IOException("Missing required staged component.");
    internal void RemoveObsolete(string relative)
    {
        relative = Normalize(relative);
        if (!changes.ContainsKey(relative)) changes.Add(relative, new Change(relative, null, null, null, null));
    }
    internal void Commit(Action<int, string> progress)
    {
        Directory.CreateDirectory(root);
        // Preflight every target, including unchanged files. Keep exclusive
        // reads so locked files and reparse paths still fail before mutation.
        int backupIndex = 0;
        foreach (var item in changes.Values.ToArray())
        {
            var target = InstallerEngine.SafePath(root, item.Relative);
            if (Directory.Exists(target)) throw new IOException("A directory conflicts with an application file: " + item.Relative);
            if (!File.Exists(target)) continue;
            using var old = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.None);
            var oldHash = Convert.ToHexString(SHA256.HashData(old));
            if (item.NewHash != null && oldHash == item.NewHash)
            {
                // The bundled LSP/Python runtimes contain thousands of files.
                // Identical, verified bytes need neither replacement nor backup.
                // Recheck them during commit to catch intervening changes.
                changes[item.Relative] = item with { OldHash = oldHash };
                continue;
            }
            old.Position = 0;
            var backup = Path.Combine(workspace, "old", (backupIndex++).ToString("D6"));
            using (var output = new FileStream(backup, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            { old.CopyTo(output); output.Flush(true); }
            if (Hash(backup) != oldHash) throw new IOException("Upgrade backup checksum mismatch.");
            changes[item.Relative] = item with { Backup = backup, OldHash = oldHash };
        }
        File.WriteAllText(Path.Combine(workspace, "journal.json"), JsonSerializer.Serialize(changes.Values));
        using (var pending = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            JsonSerializer.Serialize(pending, new { version = 1, backupDirectory = workspace });
            pending.Flush(true);
        }
        retain = true;
        try
        {
            int completed = 0, lastProgress = -1;
            foreach (var change in changes.Values)
            {
                var target = InstallerEngine.SafePath(root, change.Relative);
                if (File.Exists(target) ? change.OldHash == null || Hash(target) != change.OldHash : change.OldHash != null)
                    throw new IOException("An application file changed during upgrade: " + change.Relative);
                if (change.OldHash != change.NewHash)
                {
                    touched.Add(change); // Includes a replacement that fails halfway.
                    if (change.Staged == null) File.Delete(target);
                    else
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                        InstallerEngine.ReplaceFile(target, output => { using var input = File.OpenRead(change.Staged); input.CopyTo(output); });
                        if (Hash(target) != change.NewHash) throw new IOException("Installed file hash mismatch: " + change.Relative);
                    }
                }
                completed++;
                int percent = 45 + (completed * 35 / changes.Count);
                // Bound log/UI updates by percentage, not by runtime file count.
                if (percent != lastProgress)
                {
                    progress(percent, "Installing verified application files...");
                    lastProgress = percent;
                }
            }
            File.Delete(marker);
            retain = false;
        }
        catch (Exception failure)
        {
            var rollbackFailures = new List<Exception>();
            foreach (var change in touched.AsEnumerable().Reverse())
            {
                try
                {
                    var target = InstallerEngine.SafePath(root, change.Relative);
                    var current = File.Exists(target) ? Hash(target) : null;
                    if (current == change.OldHash) continue;
                    if (current != null && current != change.NewHash)
                        throw new IOException("Concurrent changes prevented rollback: " + change.Relative);
                    if (change.Backup == null) File.Delete(target);
                    else
                    {
                        if (Hash(change.Backup) != change.OldHash) throw new IOException("Rollback backup checksum mismatch.");
                        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                        InstallerEngine.ReplaceFile(target, output => { using var input = File.OpenRead(change.Backup); input.CopyTo(output); });
                    }
                }
                catch (Exception error) { rollbackFailures.Add(error); }
            }
            if (rollbackFailures.Count == 0) { File.Delete(marker); retain = false; }
            if (retain) throw new AggregateException("Upgrade failed; keep the retained backup at " + workspace + ". The launcher is blocked until recovery.", new[] { failure }.Concat(rollbackFailures));
            throw new UpgradeRolledBackException("Upgrade failed; all changed application files were rolled back. " + failure.Message, failure);
        }
    }
    public void Dispose()
    {
        if (retain || !Directory.Exists(workspace)) return;
        // Only remove our random staging directory, never follow a link created
        // while an installer was running. Cleanup failure does not falsify commit.
        try { RemovePrivateDirectory(workspace); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
    private static void RemovePrivateDirectory(string directory)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked staging directory.");
        foreach (var file in Directory.EnumerateFiles(directory))
        {
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked staging file.");
            File.Delete(file);
        }
        foreach (var child in Directory.EnumerateDirectories(directory)) RemovePrivateDirectory(child);
        Directory.Delete(directory);
    }
}
