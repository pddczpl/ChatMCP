using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ChatMCP.Native;

// What the shell does with the folder the Hub left (UpdateStaging.Verify): find the ONE update that proves itself, with its own code, and keep the installer from being changed until it runs.
// The releases here are made in a scratch folder with a key made for the run; nothing touches the state folder of an installed app.
internal static class StagingTests
{
    private static readonly ReleaseVersion Running = ReleaseVersion.TryParse("3.10.2", out var running) ? running : throw new InvalidOperationException();
    private const string Product = "DatGold Studio Setup";

    /// <summary>A key pair made for the run, the key list that trusts it and what signs a manifest with it, the way the owner's tool does (IEEE P1363).</summary>
    private sealed class Owner : IDisposable
    {
        internal readonly ECDsa Key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        internal string Kid => ReleaseKeys.IdOf(Key.ExportSubjectPublicKeyInfo());
        internal string ListText => JsonSerializer.Serialize(new { version = 1, algorithm = "ES256", keys = new[] { new { kid = Kid, use = "release", spki = Convert.ToBase64String(Key.ExportSubjectPublicKeyInfo()) } } });
        internal ReleaseKeys Keys => ReleaseKeys.Parse(ListText);
        internal byte[] SignatureFile(byte[] manifest) => Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { alg = "ES256", kid = Kid, sig = Convert.ToBase64String(Key.SignData(manifest, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) }));
        public void Dispose() => Key.Dispose();
    }

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    /// <summary>Writes updates/&lt;folder&gt; with a signed manifest for <paramref name="version"/> and the installer, and returns the installer's path. Each argument can be bent to make a release that is wrong in one way.</summary>
    private static string Release(string root, Owner owner, string version, byte[] installer, string folder = "", string name = "DatGoldSetup.exe", long? declaredBytes = null, string? declaredSha = null, bool second = false,
        byte[]? manifestOverride = null, byte[]? signatureOverride = null, bool writeInstaller = true)
    {
        var directory = Path.Combine(root, folder == "" ? version : folder);
        Directory.CreateDirectory(directory);
        var assets = new List<object> { new { name, bytes = declaredBytes ?? installer.Length, sha256 = declaredSha ?? Sha(installer) } };
        if (second) assets.Add(new { name = "Other.exe", bytes = 1, sha256 = new string('b', 64) });
        var manifest = manifestOverride ?? Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { version, commit = new string('0', 40), assets }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
        File.WriteAllBytes(Path.Combine(directory, UpdateStaging.ManifestName), manifest);
        File.WriteAllBytes(Path.Combine(directory, UpdateStaging.SignatureName), signatureOverride ?? owner.SignatureFile(manifest));
        var path = Path.Combine(directory, name);
        if (writeInstaller) File.WriteAllBytes(path, installer);
        File.WriteAllText(Path.Combine(directory, "state.json"), "{\"version\":1}"); // the Hub's own file: the shell does not read it
        return path;
    }

    private static InstallerIdentity Genuine(string version) => new(Product, Product, version);

    private static string? CodeOf(Action action)
    {
        try { action(); return null; } catch (UpdateRefused refused) { return refused.Code; }
    }

    // A junction whose target was deleted first cannot be removed by Directory.Delete(recursive) of the folder above it, so each one made here is unlinked when the tests end.
    private static readonly List<string> Junctions = new();

    private static string MakeJunction(string link, string target)
    {
        Junctions.Add(link);
        var start = new ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add("/c"); start.ArgumentList.Add("mklink"); start.ArgumentList.Add("/J"); start.ArgumentList.Add(link); start.ArgumentList.Add(target);
        using var process = Process.Start(start)!; process.StandardOutput.ReadToEnd(); process.StandardError.ReadToEnd(); process.WaitForExit();
        if (process.ExitCode != 0) throw new IOException("mklink /J failed");
        return link;
    }

    internal static void Run(TestKit kit)
    {
        try { RunAll(kit); }
        finally { foreach (var link in Junctions) try { Directory.Delete(link); } catch (Exception) { /* already gone */ } }
    }

    private static void RunAll(TestKit kit)
    {
        using var owner = new Owner();
        var keys = owner.Keys;
        var installer = Encoding.UTF8.GetBytes("MZ pretend installer " + new string('x', 5000));
        InstallerIdentity Identity(string path) => Genuine("3.11.0");
        VerifiedUpdate Verify(string root, ReleaseKeys? list = null, ReleaseVersion? running = null, Func<string, InstallerIdentity>? identity = null) =>
            UpdateStaging.Verify(root, running ?? Running, list ?? keys, identity ?? Identity, Product, Product);

        // ---- the one update that proves itself
        var root = kit.Folder("updates");
        var path = Release(root, owner, "3.11.0", installer);
        using (var update = Verify(root))
        {
            kit.Check(update.Version.ToString() == "3.11.0" && update.Kid == owner.Kid && update.InstallerPath == path && update.Bytes == installer.Length, "a folder that proves itself is the update: its version, the key that signed it, the installer and its size");
            kit.Check(update.Folder == Path.GetDirectoryName(path) && update.IsHeld, "and its installer is held open by the shell");

            // ---- what holding it means. Nothing here is assumed about Windows: each thing is tried.
            kit.Throws(() => File.WriteAllBytes(path, installer), "the held installer cannot be written");
            kit.Throws(() => File.Delete(path), "or deleted");
            kit.Throws(() => File.Move(path, path + ".moved"), "or renamed");
            kit.Throws(() => File.WriteAllBytes(path, Array.Empty<byte>()), "or emptied");
            kit.Throws(() => Directory.Move(update.Folder, update.Folder + ".moved"), "and the folder it is in cannot be renamed (the path is looked at again when the program starts)");
            kit.Throws(() => Directory.Move(root, root + ".moved"), "nor the folder of updates above it");
            kit.Throws(() => Directory.Delete(update.Folder, recursive: true), "nor deleted");
            kit.Check(File.ReadAllBytes(path).Length == installer.Length, "while anyone can still read it (the program that starts it reads it)");
        }
        File.WriteAllBytes(path, installer);
        kit.Check(true, "released, the installer can be written again");

        // the premise that makes holding enough: a program starts from a file that is held open for reading, and the shell can let go once it has started
        {
            var system = Path.Combine(Environment.SystemDirectory, "hostname.exe");
            var real = File.ReadAllBytes(system);
            var proving = kit.Folder("updates-real");
            var program = Release(proving, owner, "3.11.0", real);
            using var update = Verify(proving);
            using var child = Process.Start(new ProcessStartInfo(program) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, WorkingDirectory = update.Folder })!;
            kit.Check(update.IsHeld, "premise: the installer is still held when the process is being made");
            child.StandardOutput.ReadToEnd();
            kit.Check(child.WaitForExit(30000) && child.ExitCode == 0, "premise: a program starts from a file that the shell holds open for reading");
            update.Release();
            kit.Check(!update.IsHeld, "and the shell lets go of it once it has started");
        }

        // ---- the places where it is not there
        kit.Check(CodeOf(() => Verify(Path.Combine(kit.Scratch, "no-such-folder"))) == "no_update", "no folder of updates: nothing to apply");
        var empty = kit.Folder("updates-empty");
        kit.Check(CodeOf(() => Verify(empty)) == "no_update", "an empty folder of updates: nothing to apply");
        var junk = kit.Folder("updates-junk");
        foreach (var name in new[] { "notes", "3.11", "v3.11.0", "03.11.0", "3.11.0.1", "3.11.0.part", "3.11.0-rc.1", "latest" }) Directory.CreateDirectory(Path.Combine(junk, name));
        File.WriteAllText(Path.Combine(junk, "3.12.0"), "a file, not a folder");
        kit.Check(CodeOf(() => Verify(junk)) == "no_update", "folders and files that are not named like a release are not candidates (and a file named like one is not a folder)");
        var aFile = Path.Combine(kit.Scratch, "updates-is-a-file"); File.WriteAllText(aFile, "x");
        kit.Check(CodeOf(() => Verify(aFile)) == "staging_unsafe", "a folder of updates that is a file is refused");
        var target = kit.Folder("updates-target"); Release(target, owner, "3.11.0", installer);
        var linked = MakeJunction(Path.Combine(kit.Scratch, "updates-link-" + Guid.NewGuid().ToString("N")[..8]), target);
        kit.Check(CodeOf(() => Verify(linked)) == "staging_unsafe", "a folder of updates that is a junction is not followed, even to a release that proves itself");
        var linkedRelease = kit.Folder("updates-link-release"); var outside = kit.Folder("elsewhere"); Release(outside, owner, "3.11.0", installer);
        MakeJunction(Path.Combine(linkedRelease, "3.11.0"), Path.Combine(outside, "3.11.0"));
        kit.Check(CodeOf(() => Verify(linkedRelease)) == "staging_unsafe", "and a release folder that is a junction is not entered");

        // ---- no key to trust
        {
            var placeholder = ReleaseKeys.Parse("{\"version\":1,\"keys\":[{\"kid\":\"00000000\",\"use\":\"placeholder\",\"spki\":null}]}");
            var good = kit.Folder("updates-placeholder"); Release(good, owner, "3.11.0", installer);
            kit.Check(CodeOf(() => Verify(good, placeholder)) == "no_trusted_key", "the key file that ships until the owner has made a key trusts nothing: the shell says so and looks at nothing");
            kit.Check(CodeOf(() => Verify(good, ReleaseKeys.Parse(""))) == "no_trusted_key", "and neither does a key file that cannot be read");
        }

        // ---- the signature, the manifest and the version
        string Case(Action<string> make, string label)
        {
            var folder = kit.Folder("updates-" + label);
            make(folder);
            return CodeOf(() => { using var update = Verify(folder); }) ?? "accepted";
        }
        kit.Check(Case(folder => Release(folder, owner, "3.11.0", installer, signatureOverride: new byte[] { 1 }), "garbage-signature") == "bad_signature", "a signature file that is not one is refused");
        kit.Check(Case(folder => Release(folder, owner, "3.11.0", installer, signatureOverride: owner.SignatureFile(Encoding.UTF8.GetBytes("the signature of another manifest"))), "other-manifest") == "bad_signature", "a manifest that its signature is not for is refused as a bad signature, before it is read as a manifest");
        kit.Check(Case(folder => Release(folder, owner, "3.11.0", installer, manifestOverride: Encoding.UTF8.GetBytes("{\"version\":\"3.11.0\"}")), "signed-but-not-a-release") == "bad_manifest", "a manifest that is signed but does not describe a release (no commit, no assets) is refused as a manifest");
        {
            var folder = kit.Folder("updates-one-bit");
            var program = Release(folder, owner, "3.11.0", installer);
            var manifestFile = Path.Combine(Path.GetDirectoryName(program)!, UpdateStaging.ManifestName);
            var bytes = File.ReadAllBytes(manifestFile); bytes[bytes.Length / 2] ^= 1; File.WriteAllBytes(manifestFile, bytes);
            kit.Check(CodeOf(() => { using var update = Verify(folder); }) == "bad_signature", "one bit of the manifest on disk, and the signature does not check");
        }
        {
            var folder = kit.Folder("updates-other-key");
            Release(folder, owner, "3.11.0", installer);
            using var stranger = new Owner();
            kit.Check(CodeOf(() => { using var update = Verify(folder, stranger.Keys); }) == "bad_signature", "a release signed by a key that is not in the list is refused");
        }
        kit.Check(Case(folder =>
        {
            var directory = Path.Combine(folder, "3.11.0"); Directory.CreateDirectory(directory);
            File.WriteAllBytes(Path.Combine(directory, UpdateStaging.SignatureName), owner.SignatureFile(Array.Empty<byte>())); File.WriteAllBytes(Path.Combine(directory, "DatGoldSetup.exe"), installer);
        }, "no-manifest") == "bad_manifest", "no manifest in the folder: refused");
        kit.Check(Case(folder =>
        {
            var path = Release(folder, owner, "3.11.0", installer); File.Delete(Path.Combine(Path.GetDirectoryName(path)!, UpdateStaging.SignatureName));
        }, "no-signature") == "bad_signature", "no signature in the folder: refused");
        kit.Check(Case(folder => Release(folder, owner, "3.11.0", installer, manifestOverride: new byte[UpdateStaging.MaxManifestBytes + 1]), "manifest-too-big") == "bad_manifest", "a manifest over 64 KiB is refused without being read whole");
        kit.Check(Case(folder => Release(folder, owner, "3.11.0", installer, signatureOverride: new byte[ReleaseSignature.MaxFileBytes + 1]), "signature-too-big") == "bad_signature", "and a signature file over 4 KiB");
        kit.Check(Case(folder => Release(folder, owner, "3.12.0", installer, folder: "3.11.0"), "version-differs-from-folder") == "bad_manifest", "a signed manifest of another release than the folder says (an old release under a new name) is refused");
        {
            var folder = kit.Folder("updates-same-version"); Release(folder, owner, "3.10.2", installer);
            kit.Check(CodeOf(() => { using var update = Verify(folder); }) == "not_newer", "the version that is running is not an update");
            var older = kit.Folder("updates-older"); Release(older, owner, "3.9.0", installer);
            kit.Check(CodeOf(() => { using var update = Verify(older); }) == "not_newer", "nor is an older one: the installer has no downgrade check, so this is where it is made");
            var next = kit.Folder("updates-patch"); Release(next, owner, "3.10.3", installer);
            using (var update = Verify(next, identity: path => Genuine("3.10.3"))) kit.Check(update.Version.ToString() == "3.10.3", "the next patch release is newer");
            var tens = kit.Folder("updates-ten"); Release(tens, owner, "3.10.10", installer);
            using (var update = Verify(tens, running: ReleaseVersion.TryParse("3.10.9", out var nine) ? nine : default, identity: path => Genuine("3.10.10"))) kit.Check(update.Version.ToString() == "3.10.10", "versions are numbers, not text: 3.10.10 is newer than 3.10.9");
        }

        // ---- the installer
        kit.Check(Case(folder => Release(folder, owner, "3.11.0", installer, second: true, name: "DatGoldSetup.exe"), "two-programs") == "bad_installer", "a manifest that names two programs names no installer");
        kit.Check(Case(folder => Release(folder, owner, "3.11.0", installer, name: "CON.exe", writeInstaller: false), "device-name") == "bad_installer", "an installer called CON.exe is refused before any file is looked for");
        kit.Check(Case(folder => Release(folder, owner, "3.11.0", installer, name: "a..b.exe"), "dots-name") == "bad_installer", "so is one with two dots in its name");
        kit.Check(Case(folder => Release(folder, owner, "3.11.0", installer, declaredBytes: 0, writeInstaller: false), "zero-size") == "bad_installer", "an installer of no bytes");
        kit.Check(Case(folder => Release(folder, owner, "3.11.0", installer, declaredBytes: UpdateStaging.MaxInstallerBytes + 1, writeInstaller: false), "huge") == "bad_installer", "and one over 2 GiB are refused before the file is looked at");
        kit.Check(Case(folder => Release(folder, owner, "3.11.0", installer, writeInstaller: false), "no-installer-file") == "bad_installer", "an installer that is not in the folder");
        kit.Check(Case(folder => Release(folder, owner, "3.11.0", installer, declaredBytes: installer.Length + 1), "short-file") == "bad_installer", "a file whose size is not the signed one (shorter)");
        kit.Check(Case(folder => Release(folder, owner, "3.11.0", installer, declaredBytes: installer.Length - 1), "long-file") == "bad_installer", "(longer)");
        {
            var flipped = (byte[])installer.Clone(); flipped[100] ^= 1;
            kit.Check(Case(folder => Release(folder, owner, "3.11.0", flipped, declaredSha: Sha(installer)), "one-bit") == "bad_installer", "the same size and one bit different: the hash of the signed manifest is what decides");
        }
        kit.Check(Case(folder => Release(folder, owner, "3.11.0", installer, declaredSha: new string('0', 64)), "wrong-digest") == "bad_installer", "and a digest that is not the file's");
        {
            var folder = kit.Folder("updates-installer-link"); var elsewhere = kit.Folder("elsewhere-file");
            File.WriteAllBytes(Path.Combine(elsewhere, "DatGoldSetup.exe"), installer);
            var program = Release(folder, owner, "3.11.0", installer); File.Delete(program);
            MakeJunction(program, elsewhere); // a junction named like the installer: it is a folder, never a file
            kit.Check(CodeOf(() => { using var update = Verify(folder); }) is "staging_unsafe" or "bad_installer", "an installer that is a junction to somewhere else is not run");
        }
        {
            var folder = kit.Folder("updates-identity"); var program = Release(folder, owner, "3.11.0", installer);
            kit.Check(CodeOf(() => { using var update = Verify(folder, identity: _ => new InstallerIdentity("Contoso Tools", Product, "3.11.0")); }) == "bad_installer", "a file whose product is not the DatGold setup is refused");
            kit.Check(CodeOf(() => { using var update = Verify(folder, identity: _ => new InstallerIdentity(Product, "Contoso installer", "3.11.0")); }) == "bad_installer", "and one whose description is not");
            kit.Check(CodeOf(() => { using var update = Verify(folder, identity: _ => new InstallerIdentity("DatGold Studio Setup Pro", Product, "3.11.0")); }) == "bad_installer", "the name must be exactly it, not something that contains it");
            kit.Check(CodeOf(() => { using var update = Verify(folder, identity: _ => new InstallerIdentity(Product, Product, "3.10.9")); }) == "bad_installer", "a file that says it is another version than the signed manifest is refused");
            kit.Check(CodeOf(() => { using var update = Verify(folder, identity: _ => new InstallerIdentity(null, null, null)); }) == "bad_installer", "and one with no version information at all");
            using (var update = Verify(folder, identity: _ => new InstallerIdentity(Product, Product, "3.11.0+0123abc"))) kit.Check(update.Version.ToString() == "3.11.0", "a version with build metadata after a plus sign counts as the version before it");
            File.Delete(program);
            kit.Check(true, "(a refused release does not hold its installer: it can be deleted)");
        }
        {
            var system = Path.Combine(Environment.SystemDirectory, "hostname.exe");
            var identity = UpdateStaging.ReadIdentity(system);
            var info = FileVersionInfo.GetVersionInfo(system);
            kit.Check(identity.ProductName == info.ProductName && identity.FileDescription == info.FileDescription && !string.IsNullOrEmpty(identity.ProductName), "the identity of a real program is read from its version resource");
            kit.Check(UpdateStaging.ExpectedProduct == "DatGold Studio Setup" && UpdateStaging.ExpectedDescription == "DatGold Studio Setup", "the names a setup must carry are the ones its project file gives (installer/ChatMCP.Installer.csproj)");
            kit.Check(UpdateStaging.ReadIdentity(Path.Combine(kit.Scratch, "no-such-file.exe")).ProductName == null, "and the identity of a file that is not there is nothing");
        }

        // ---- more than one folder
        {
            var both = kit.Folder("updates-two"); Release(both, owner, "3.11.0", installer); Release(both, owner, "3.12.0", installer);
            kit.Check(CodeOf(() => { using var update = Verify(both, identity: path => Genuine(path.Contains("3.12.0") ? "3.12.0" : "3.11.0")); }) == "ambiguous", "two folders that both prove themselves: the shell does not choose, because the page showed one of them");
            foreach (var release in Directory.GetDirectories(both)) File.Delete(Path.Combine(release, "DatGoldSetup.exe"));
            kit.Check(true, "and it holds neither of them: both installers can be deleted at once (an installer that stays held is a folder nobody can clean)");
            var one = kit.Folder("updates-one-good"); Release(one, owner, "3.11.0", installer); Release(one, owner, "3.9.0", installer);
            using (var update = Verify(one)) kit.Check(update.Version.ToString() == "3.11.0", "one that proves itself and an old one that is not newer: the first is the update");
            var tampered = kit.Folder("updates-one-tampered"); Release(tampered, owner, "3.11.0", installer); var bad = Release(tampered, owner, "3.12.0", (byte[])installer.Clone(), declaredSha: new string('0', 64));
            using (var update = Verify(tampered)) kit.Check(update.Version.ToString() == "3.11.0", "and so is one next to a folder that does not prove itself");
            var failing = kit.Folder("updates-two-failing"); Release(failing, owner, "3.11.0", installer, declaredSha: new string('0', 64)); Release(failing, owner, "3.12.0", installer, signatureOverride: new byte[] { 1 });
            kit.Check(CodeOf(() => { using var update = Verify(failing); }) == "bad_signature", "when none proves itself the page is told why the NEWEST one does not");
        }
        // at most 16 folders are looked at, the newest first: the cost of a look is bounded, and a good older release behind 16 newer folders is not found
        {
            var many = kit.Folder("updates-many");
            Release(many, owner, "3.11.0", installer);
            for (var minor = 12; minor < 28; minor++) Directory.CreateDirectory(Path.Combine(many, "3." + minor + ".0"));
            kit.Check(CodeOf(() => { using var update = Verify(many); }) == "bad_manifest", "sixteen newer folders (empty) hide a good older one: only the newest 16 are looked at, and the reason given is the newest one's");
            Directory.Delete(Path.Combine(many, "3.27.0"));
            using var found = Verify(many);
            kit.Check(found.Version.ToString() == "3.11.0", "with one of them gone the good one is the 16th and is found");
        }
        // a manifest or an installer that is a LINK is not read or run: the Hub's folder is where a link would make the shell take another file (a link to a file needs a privilege to be made, so it is tried, and said when it cannot be)
        {
            var linkRoot = kit.Folder("updates-file-links");
            var program = Release(linkRoot, owner, "3.11.0", installer);
            var directory = Path.GetDirectoryName(program)!;
            var elsewhere = kit.Folder("elsewhere-files");
            var manifestCopy = Path.Combine(elsewhere, UpdateStaging.ManifestName); File.Copy(Path.Combine(directory, UpdateStaging.ManifestName), manifestCopy);
            var installerCopy = Path.Combine(elsewhere, "DatGoldSetup.exe"); File.Copy(program, installerCopy);
            var canLink = true;
            try { File.CreateSymbolicLink(Path.Combine(elsewhere, "probe"), manifestCopy); } catch (Exception error) when (error is UnauthorizedAccessException or IOException) { canLink = false; }
            if (!canLink) kit.Check(true, "(a link to a file cannot be made here without a privilege: checked on the runner)");
            else
            {
                File.Delete(Path.Combine(directory, UpdateStaging.ManifestName));
                File.CreateSymbolicLink(Path.Combine(directory, UpdateStaging.ManifestName), manifestCopy);
                kit.Check(CodeOf(() => { using var update = Verify(linkRoot); }) == "staging_unsafe", "a manifest that is a link is refused, even to a manifest that proves itself");
                File.Delete(Path.Combine(directory, UpdateStaging.ManifestName));
                File.Copy(manifestCopy, Path.Combine(directory, UpdateStaging.ManifestName));
                File.Delete(program);
                File.CreateSymbolicLink(program, installerCopy);
                kit.Check(CodeOf(() => { using var update = Verify(linkRoot); }) == "staging_unsafe", "and so is an installer that is a link, even to one that proves itself");
            }
        }
        // nothing is left held by a refusal
        {
            var folder = kit.Folder("updates-nothing-held"); var program = Release(folder, owner, "3.11.0", installer, declaredSha: new string('0', 64));
            kit.Check(CodeOf(() => { using var update = Verify(folder); }) == "bad_installer", "premise: a wrong digest is refused");
            File.Delete(program);
            Directory.Delete(Path.GetDirectoryName(program)!, recursive: true);
            kit.Check(true, "and nothing of a refused release is held open: the folder can be removed");
        }
    }
}
