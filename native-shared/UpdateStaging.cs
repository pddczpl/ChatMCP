using System.Diagnostics;
using System.Security.Cryptography;

namespace ChatMCP.Native;

/// <summary>
/// The shell will not apply the update. <see cref="Code"/> is what the page is told, from a closed set (no_update, ambiguous, staging_unsafe, no_trusted_key, bad_signature, bad_manifest, not_newer,
/// bad_installer; the shell adds busy, tasks_running, hub_unreachable, not_installed, stale and launch_failed). <see cref="Detail"/> is for a log and for a test: it never reaches the page.
/// </summary>
internal sealed class UpdateRefused : Exception
{
    internal string Code { get; }
    internal string Detail { get; }
    internal UpdateRefused(string code, string detail = "") : base("The update was not applied (" + code + (detail == "" ? "" : ": " + detail) + ").") { Code = code; Detail = detail; }
}

/// <summary>The fields of the version information of a program that the shell looks at to see that a file is the DatGold setup.</summary>
internal sealed record InstallerIdentity(string? ProductName, string? FileDescription, string? ProductVersion);

/// <summary>
/// An update that proved itself, with its installer held open: nobody can write to, delete or rename the file (and so not the folder it is in, or the folder of updates above it) until
/// <see cref="Release"/>. The shell lets go only after it has started the installer: the program is started from the path, so the file has to be the one that was checked until then.
/// </summary>
internal sealed class VerifiedUpdate : IDisposable
{
    private FileStream? held;
    internal ReleaseVersion Version { get; }
    internal string Folder { get; }
    internal string InstallerPath { get; }
    /// <summary>The id of the key that signed the manifest.</summary>
    internal string Kid { get; }
    internal long Bytes { get; }
    internal bool IsHeld => held != null;

    internal VerifiedUpdate(ReleaseVersion version, string folder, string installerPath, string kid, long bytes, FileStream held)
    { Version = version; Folder = folder; InstallerPath = installerPath; Kid = kid; Bytes = bytes; this.held = held; }

    internal void Release() { var handle = held; held = null; handle?.Dispose(); }
    public void Dispose() => Release();
}

/// <summary>
/// The folder the Hub left (<c>&lt;state&gt;\updates\&lt;version&gt;\</c>: the installer, the signed manifest and its signature, a state file) as the shell checks it, with its own code. "Ready" is only the Hub's
/// statement: a program that runs as the owner can write that folder. So the shell trusts nothing in it that it has not proved itself: the signature of the kept manifest against the key list it was
/// built with, the manifest's version (the folder's name, and newer than the one that runs), and the installer's name, size and SHA-256 FROM THE SIGNED MANIFEST (never from the state file, never from
/// the page). The installer is hashed through the handle that then stays open. The page sends no path, no name and no version.
/// </summary>
internal static class UpdateStaging
{
    internal const string ManifestName = "RELEASE-MANIFEST.json";
    internal const string SignatureName = "RELEASE-MANIFEST.json.sig";
    internal const int MaxManifestBytes = 64 * 1024;
    internal const long MaxInstallerBytes = 2L * 1024 * 1024 * 1024;
    /// <summary>What Windows shows for the setup: Product and File description, both set by installer/ChatMCP.Installer.csproj. A new name for the setup would stop every installed shell from updating, so it is pinned (tests/verify-update-apply.mjs).</summary>
    internal const string ExpectedProduct = "DatGold Studio Setup";
    internal const string ExpectedDescription = "DatGold Studio Setup";
    private const int MaxCandidates = 16;

    /// <summary>Where the Hub keeps what it downloaded: the folder of updates in the Hub's data folder (HubSession.DefaultStateDirectory). Computed by the shell, never taken from the page or from the Hub.</summary>
    internal static string RootFor(string stateDirectory) => Path.Combine(stateDirectory, "updates");

    internal static VerifiedUpdate Verify(string root, ReleaseVersion running, ReleaseKeys keys) => Verify(root, running, keys, ReadIdentity, ExpectedProduct, ExpectedDescription);

    /// <summary>
    /// The ONE update under <paramref name="root"/> that proves itself, installer held; or an <see cref="UpdateRefused"/>. With none that proves itself the reason is that of the newest folder; with more than
    /// one the shell does not choose (the page showed the owner one of them): `ambiguous`.
    /// </summary>
    internal static VerifiedUpdate Verify(string root, ReleaseVersion running, ReleaseKeys keys, Func<string, InstallerIdentity> identityOf, string expectedProduct, string expectedDescription)
    {
        if (keys.Keys.Count == 0) throw new UpdateRefused("no_trusted_key", "the key list this shell was built with holds no release key");
        FileAttributes attributes;
        try { attributes = File.GetAttributes(root); }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException) { throw new UpdateRefused("no_update", "there is no folder of updates"); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw new UpdateRefused("staging_unsafe", "the folder of updates cannot be looked at"); }
        if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0) throw new UpdateRefused("staging_unsafe", "the folder of updates is a link or a file");

        var candidates = new List<(ReleaseVersion Version, string Name)>();
        try
        {
            foreach (var entry in new DirectoryInfo(root).EnumerateDirectories())
                if (ReleaseVersion.TryParse(entry.Name, out var version)) candidates.Add((version, entry.Name));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw new UpdateRefused("staging_unsafe", "the folder of updates cannot be listed"); }
        if (candidates.Count == 0) throw new UpdateRefused("no_update", "no folder of the updates is named like a release");
        candidates.Sort((a, b) => b.Version.CompareTo(a.Version));

        var proven = new List<VerifiedUpdate>();
        UpdateRefused? newestFailure = null;
        try
        {
            foreach (var (version, name) in candidates.Take(MaxCandidates))
            {
                try { proven.Add(VerifyFolder(Path.Combine(root, name), name, running, keys, identityOf, expectedProduct, expectedDescription)); }
                catch (UpdateRefused refused) { newestFailure ??= refused; }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException) { newestFailure ??= new UpdateRefused("staging_unsafe", "the release folder " + name + " cannot be read"); }
                // a folder that fails in a way nobody foresaw is a folder that is not trusted; it neither stops another folder from proving itself nor lets an exception of any type out of the shell
                catch (Exception error) when (error is not OutOfMemoryException) { newestFailure ??= new UpdateRefused("staging_unsafe", "the release folder " + name + " could not be checked (" + error.GetType().Name + ")"); }
            }
        }
        catch
        {
            // whatever else ends the loop, an installer that proved itself earlier is not left held for the rest of the life of the shell
            foreach (var update in proven) update.Dispose();
            throw;
        }
        if (proven.Count == 1) return proven[0];
        foreach (var update in proven) update.Dispose();
        throw proven.Count > 1 ? new UpdateRefused("ambiguous", proven.Count + " folders prove themselves") : newestFailure!;
    }

    /// <summary>The file at <paramref name="folder"/>\<paramref name="name"/>, whole, when it is a plain file of at most <paramref name="limit"/> bytes; otherwise a refusal with <paramref name="code"/>.</summary>
    private static byte[] ReadSmall(string folder, string name, int limit, string code)
    {
        var path = Path.Combine(folder, name);
        var info = new FileInfo(path);
        if (!info.Exists) throw new UpdateRefused(code, name + " is not in the folder");
        if ((info.Attributes & FileAttributes.ReparsePoint) != 0) throw new UpdateRefused("staging_unsafe", name + " is a link");
        if (info.Length > limit) throw new UpdateRefused(code, name + " is larger than " + limit + " bytes");
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            var buffer = new byte[limit + 1];
            var count = 0;
            for (int read; count < buffer.Length && (read = stream.Read(buffer, count, buffer.Length - count)) > 0;) count += read;
            if (count > limit) throw new UpdateRefused(code, name + " is larger than " + limit + " bytes");
            return buffer.AsSpan(0, count).ToArray();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw new UpdateRefused(code, name + " cannot be read"); }
    }

    private static VerifiedUpdate VerifyFolder(string folder, string name, ReleaseVersion running, ReleaseKeys keys, Func<string, InstallerIdentity> identityOf, string expectedProduct, string expectedDescription)
    {
        if ((File.GetAttributes(folder) & FileAttributes.ReparsePoint) != 0) throw new UpdateRefused("staging_unsafe", "the release folder " + name + " is a link");
        var manifestBytes = ReadSmall(folder, ManifestName, MaxManifestBytes, "bad_manifest");
        var signatureBytes = ReadSmall(folder, SignatureName, ReleaseSignature.MaxFileBytes, "bad_signature");

        // 1. the signature, over the exact bytes that were read: nothing of the manifest is looked at before it has checked
        string kid;
        try { kid = ReleaseSignature.Verify(manifestBytes, signatureBytes, keys.Keys); } catch (SignatureRefused refused) { throw new UpdateRefused("bad_signature", refused.Reason); }

        // 2. the manifest, and that it is the release this folder says it is, and a newer one than the one that runs
        ReleaseManifest manifest;
        try { manifest = ReleaseManifest.Parse(manifestBytes); } catch (ManifestRefused refused) { throw new UpdateRefused("bad_manifest", refused.Reason); }
        if (manifest.Version != name) throw new UpdateRefused("bad_manifest", "the manifest in " + name + " is the release " + manifest.Version);
        ReleaseVersion.TryParse(manifest.Version, out var version);
        if (version.CompareTo(running) <= 0) throw new UpdateRefused("not_newer", manifest.Version + " is not newer than " + running);

        // 3. the installer the SIGNED manifest names: its name, size and digest come from nowhere else
        var installer = manifest.Installer ?? throw new UpdateRefused("bad_installer", "the manifest does not name exactly one installer");
        var problem = InstallerName.Problem(installer.Name);
        if (problem != null) throw new UpdateRefused("bad_installer", "the name of the installer is not accepted (" + problem + ")");
        if (installer.Bytes < 1 || installer.Bytes > MaxInstallerBytes) throw new UpdateRefused("bad_installer", "the size of the installer is out of range");
        var path = Path.Combine(folder, installer.Name);
        var file = new FileInfo(path);
        if (!file.Exists) throw new UpdateRefused("bad_installer", "the installer is not in the folder");
        if ((file.Attributes & FileAttributes.ReparsePoint) != 0) throw new UpdateRefused("staging_unsafe", "the installer is a link");
        if (file.Length != installer.Bytes) throw new UpdateRefused("bad_installer", "the size of the file is not the signed size");
        FileStream? stream = null;
        try
        {
            // Held for reading and for nothing else, from before the hash until the program has been started (VerifiedUpdate.Release): the file cannot be written, deleted or renamed in between.
            stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16, FileOptions.SequentialScan);
            if (stream.Length != installer.Bytes) throw new UpdateRefused("bad_installer", "the size of the file is not the signed size");
            if (Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant() != installer.Sha256) throw new UpdateRefused("bad_installer", "the SHA-256 of the file is not the signed one");
            var identity = identityOf(path);
            if (identity.ProductName != expectedProduct || identity.FileDescription != expectedDescription) throw new UpdateRefused("bad_installer", "the file is not the DatGold setup");
            if (identity.ProductVersion?.Split('+')[0] != manifest.Version) throw new UpdateRefused("bad_installer", "the file says it is another version than the signed manifest");
            var update = new VerifiedUpdate(version, folder, path, kid, installer.Bytes, stream);
            stream = null; // the update owns it now
            return update;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw new UpdateRefused("bad_installer", "the installer cannot be read"); }
        finally { stream?.Dispose(); }
    }

    /// <summary>The product, the file description and the version a program says it is (its version resource); nothing for a file that is not there or says nothing.</summary>
    internal static InstallerIdentity ReadIdentity(string path)
    {
        try
        {
            var info = FileVersionInfo.GetVersionInfo(path);
            return new InstallerIdentity(info.ProductName, info.FileDescription, info.ProductVersion);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException) { return new InstallerIdentity(null, null, null); }
    }
}
