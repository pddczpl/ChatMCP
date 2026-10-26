using System.Text.Json;
using ChatMCP.Native;

// The cases that the Hub's code (CHATMCP-HUB/tests/verify-release-vectors.mjs) and the shell's code must read the same way: CHATMCP-HUB/tests/fixtures/release-verify-vectors.json, whose
// `expect` of each case was written down when the case was made, not taken from either implementation. A release is checked by the Hub when it arrives and again by the shell before it runs
// the installer, so a manifest, a signature or a key list that one takes and the other refuses is a defect. This is the shell's half.
internal static class ReleaseVectorTests
{
    internal static void Run(TestKit kit)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "release-verify-vectors.json");
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        var root = document.RootElement;
        kit.Check(root.GetProperty("version").GetInt32() == 1, "the vector file is version 1");

        // the key file that ships is one the shell reads whole, as the Hub does: every entry is a release key or a placeholder, none is set aside
        var shipped = ReleaseKeys.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "release-keys.json")));
        kit.Check(shipped.Ignored.Count == 0 && shipped.Keys.Count + shipped.Placeholders >= 1, "the key file that ships (CHATMCP-HUB/lib/release-keys.json) is well formed for the shell too: " + shipped.Keys.Count + " release key(s), " + shipped.Placeholders + " placeholder(s), none set aside");

        // ---- signatures: the key list as the shell reads it, then the check over the exact bytes
        var valid = 0; var refused = 0;
        foreach (var item in root.GetProperty("signatures").EnumerateArray())
        {
            var name = item.GetProperty("name").GetString()!;
            var keys = ReleaseKeys.Parse(item.GetProperty("keys").GetString());
            var manifest = Convert.FromBase64String(item.GetProperty("manifest").GetString()!);
            var signature = Convert.FromBase64String(item.GetProperty("signature").GetString()!);
            var expect = item.GetProperty("expect");
            string? kid = null;
            try { kid = ReleaseSignature.Verify(manifest, signature, keys.Keys); } catch (SignatureRefused) { }
            if (expect.GetProperty("valid").GetBoolean()) { valid++; kit.Check(kid == expect.GetProperty("kid").GetString(), "signature: " + name + " is valid, made by " + expect.GetProperty("kid").GetString() + (kid == null ? " (the shell refused it)" : "")); }
            else { refused++; kit.Check(kid == null, "signature: " + name + " is refused" + (kid == null ? "" : " (the shell took it, from key " + kid + ")")); }
        }
        kit.Check(valid >= 12 && refused >= 40, "the signature cases are of both kinds (" + valid + " valid, " + refused + " refused)");

        // ---- manifests
        foreach (var item in root.GetProperty("manifests").EnumerateArray())
        {
            var name = item.GetProperty("name").GetString()!;
            var expect = item.GetProperty("expect");
            ReleaseManifest? manifest = null;
            try { manifest = ReleaseManifest.Parse(Convert.FromBase64String(item.GetProperty("text").GetString()!)); } catch (ManifestRefused) { }
            if (!expect.GetProperty("ok").GetBoolean()) { kit.Check(manifest == null, "manifest: " + name + " is refused"); continue; }
            var installer = expect.GetProperty("installer");
            var same = manifest != null && manifest.Version == expect.GetProperty("version").GetString() &&
                (installer.ValueKind == JsonValueKind.Null
                    ? manifest.Installer == null
                    : manifest.Installer != null && manifest.Installer.Name == installer.GetProperty("name").GetString() && manifest.Installer.Bytes == installer.GetProperty("bytes").GetInt64() &&
                      manifest.Installer.Sha256 == installer.GetProperty("sha256").GetString());
            kit.Check(same, "manifest: " + name + " is read as the case says");
        }

        // ---- versions and the name of the installer
        foreach (var item in root.GetProperty("releaseVersions").EnumerateArray())
        {
            var text = item.GetProperty("text").GetString();
            kit.Check(ReleaseVersion.TryParse(text, out _) == item.GetProperty("expect").GetBoolean(), "release version: " + Shorten(text) + " is " + item.GetProperty("expect").GetBoolean());
        }
        foreach (var item in root.GetProperty("compareVersions").EnumerateArray())
        {
            var a = item.GetProperty("a").GetString()!; var b = item.GetProperty("b").GetString()!;
            ReleaseVersion.TryParse(a, out var left); ReleaseVersion.TryParse(b, out var right);
            kit.Check(Math.Sign(left.CompareTo(right)) == item.GetProperty("expect").GetInt32(), "compare: " + a + " with " + b + " is " + item.GetProperty("expect").GetInt32());
        }
        foreach (var item in root.GetProperty("installerNames").EnumerateArray())
        {
            var name = item.GetProperty("name").GetString();
            var problem = item.GetProperty("problem").ValueKind == JsonValueKind.Null ? null : item.GetProperty("problem").GetString();
            kit.Check(InstallerName.Problem(name) == problem, "installer name: " + Shorten(name) + " is " + (problem ?? "accepted"));
        }
    }

    private static string Shorten(string? text) => text == null ? "(null)" : "\"" + (text.Length > 30 ? text[..30] + "..." : text).Replace("\n", "\\n") + "\"";
}
