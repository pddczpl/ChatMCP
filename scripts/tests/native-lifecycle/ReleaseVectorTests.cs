using System.Security.Cryptography;
using System.Text;
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

        StricterThanTheHub(kit);
    }

    // Where the shell is STRICTER than the Hub, on purpose, so that these are not in the shared list (the Hub must read what is in it the same way): the Hub reads JSON with JSON.parse, where the last of two equal
    // names wins and any depth is read; the shell refuses both, so that a document that two readers could read in two ways, or one that is built to exhaust a stack, is never read at all.
    private static void StricterThanTheHub(TestKit kit)
    {
        var asset = "{\"name\":\"DatGoldSetup.exe\",\"bytes\":5,\"sha256\":\"" + new string('a', 64) + "\"}";
        byte[] Manifest(string extra) => Encoding.UTF8.GetBytes("{\"version\":\"3.11.0\",\"commit\":\"" + new string('0', 40) + "\",\"assets\":[" + asset + "]" + extra + "}");
        kit.Check(ReleaseManifest.Parse(Manifest("")).Version == "3.11.0", "premise: a manifest of this shape is read");
        kit.Throws(() => ReleaseManifest.Parse(Manifest(",\"version\":\"9.9.9\"")), "a manifest that names its version twice is refused (the Hub would take the last, another reader the first)");
        kit.Throws(() => ReleaseManifest.Parse(Manifest(",\"commit\":\"" + new string('1', 40) + "\"")), "and one that names its commit twice");
        kit.Check(ReleaseManifest.Parse(Manifest(",\"x\":" + new string('[', 20) + new string(']', 20))).Version == "3.11.0", "20 levels of nesting in a field it does not read are read");
        kit.Throws(() => ReleaseManifest.Parse(Manifest(",\"x\":" + new string('[', 40) + new string(']', 40))), "40 levels are not (the shell reads at most 32)");

        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var spki = key.ExportSubjectPublicKeyInfo();
        var kid = ReleaseKeys.IdOf(spki);
        var entry = "{\"kid\":\"" + kid + "\",\"use\":\"release\",\"spki\":\"" + Convert.ToBase64String(spki) + "\"}";
        var manifest = Manifest("");
        var signature = Convert.ToBase64String(key.SignData(manifest, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
        var keys = ReleaseKeys.Parse("{\"version\":1,\"keys\":[" + entry + "]}");
        kit.Check(keys.Keys.Count == 1 && ReleaseSignature.Verify(manifest, Encoding.UTF8.GetBytes("{\"alg\":\"ES256\",\"kid\":\"" + kid + "\",\"sig\":\"" + signature + "\"}"), keys.Keys) == kid, "premise: a key list and a signature file of this shape are read, and the signature checks");
        kit.Throws(() => ReleaseSignature.Verify(manifest, Encoding.UTF8.GetBytes("{\"alg\":\"ES256\",\"kid\":\"" + kid + "\",\"sig\":\"" + signature + "\",\"alg\":\"ES256\"}"), keys.Keys), "a signature file that names a field twice is refused, though both say the same");
        kit.Check(ReleaseKeys.Parse("{\"version\":1,\"version\":1,\"keys\":[" + entry + "]}").Keys.Count == 0, "and a key list that does, trusts nothing");
        kit.Check(ReleaseKeys.Parse("{\"version\":1,\"keys\":[" + entry.Replace("\"use\":\"release\"", "\"use\":\"release\",\"use\":\"release\"") + "]}").Keys.Count == 0, "even when the repeat is inside an entry");
    }

    private static string Shorten(string? text) => text == null ? "(null)" : "\"" + (text.Length > 30 ? text[..30] + "..." : text).Replace("\n", "\\n") + "\"";
}
