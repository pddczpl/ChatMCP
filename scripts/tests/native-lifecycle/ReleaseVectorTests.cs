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
        LoneSurrogates(kit);
    }

    // JSON may write a lone surrogate (\ud800). JavaScript reads it, so the Hub does; .NET reads the document and then throws InvalidOperationException, not JsonException, when it is asked for the text of
    // such a string value or has to compare the name of such a property. A reader that expects only JsonException lets it out of the shell, so each of these is a refusal of its own kind. Where the Hub
    // takes the document the shell takes it too: a lone surrogate in a value that is not read is no reason to refuse. A lone surrogate in a NAME the shell refuses (stricter, like a repeated name).
    private static void LoneSurrogates(TestKit kit)
    {
        string Text(string version = "3.11.0", string commit = "", string name = "DatGoldSetup.exe", string sha = "", string extra = "") =>
            "{\"version\":\"" + version + "\",\"commit\":\"" + (commit == "" ? new string('0', 40) : commit) + "\",\"assets\":[{\"name\":\"" + name + "\",\"bytes\":5,\"sha256\":\"" + (sha == "" ? new string('a', 64) : sha) + "\"}]" + extra + "}";
        bool ManifestRefused(string text) { try { ReleaseManifest.Parse(Encoding.UTF8.GetBytes(text)); return false; } catch (ManifestRefused) { return true; } }
        kit.Check(!ManifestRefused(Text()), "premise: a manifest of this shape is read");
        kit.Check(!ManifestRefused(Text(extra: ",\"note\":\"\\ud800\"")), "a lone surrogate in a field of a manifest that is not read is not read: the manifest is taken (the Hub takes it)");
        foreach (var (why, text) in new[]
        {
            ("a version that is a lone surrogate", Text(version: "\\ud800")), ("a version that is a high surrogate before a digit", Text(version: "\\ud8003.11.0")), ("a commit that is a lone surrogate", Text(commit: "\\udc00")),
            ("the name of an asset that is a lone surrogate", Text(name: "\\ud800")), ("a digest that is a reversed pair", Text(sha: "\\udc00\\ud800")), ("a field named by a lone surrogate", Text(extra: ",\"\\ud800\":1")),
        })
            kit.Check(ManifestRefused(text), "a manifest with " + why + " is refused as a manifest, and does not throw out of the shell");
        // the bytes of a lone surrogate (ED A0 80) and a byte that is not UTF-8 (FF) inside a value that IS read are refused the same way
        foreach (var raw in new[] { new byte[] { 0xED, 0xA0, 0x80 }, new byte[] { 0xFF } })
        {
            var bytes = Encoding.UTF8.GetBytes(Text(version: "@@")).ToList(); var at = Encoding.UTF8.GetString(bytes.ToArray()).IndexOf("@@", StringComparison.Ordinal);
            bytes.RemoveRange(at, 2); bytes.InsertRange(at, raw);
            var refused = false; try { ReleaseManifest.Parse(bytes.ToArray()); } catch (ManifestRefused) { refused = true; }
            kit.Check(refused, "a manifest whose version holds the bytes " + Convert.ToHexString(raw) + " is refused as a manifest");
        }

        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var spki = key.ExportSubjectPublicKeyInfo();
        var kid = ReleaseKeys.IdOf(spki);
        var entry = "{\"kid\":\"" + kid + "\",\"use\":\"release\",\"spki\":\"" + Convert.ToBase64String(spki) + "\"}";
        var manifest = Encoding.UTF8.GetBytes(Text());
        var signature = Convert.ToBase64String(key.SignData(manifest, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
        var keys = ReleaseKeys.Parse("{\"version\":1,\"keys\":[" + entry + "]}");
        string SigFile(string alg = "ES256", string id = "", string sig = "", string extra = "") => "{\"alg\":\"" + alg + "\",\"kid\":\"" + (id == "" ? kid : id) + "\",\"sig\":\"" + (sig == "" ? signature : sig) + "\"" + extra + "}";
        bool SignatureRefused(string text) { try { ReleaseSignature.Verify(manifest, Encoding.UTF8.GetBytes(text), keys.Keys); return false; } catch (SignatureRefused) { return true; } }
        kit.Check(keys.Keys.Count == 1 && !SignatureRefused(SigFile()), "premise: a signature file of this shape checks");
        kit.Check(!SignatureRefused(SigFile(extra: ",\"note\":\"\\ud800\"")), "a lone surrogate in a field of the signature file that is not read is not read: the signature checks");
        foreach (var (why, text) in new[]
        {
            ("an alg that is a lone surrogate", SigFile(alg: "\\ud800")), ("a kid that is a lone surrogate", SigFile(id: "\\ud800")), ("a sig that is a lone surrogate", SigFile(sig: "\\ud800")),
            ("a sig that is a reversed pair", SigFile(sig: "\\udc00\\ud800")), ("a field named by a lone surrogate", SigFile(extra: ",\"\\ud800\":1")),
        })
            kit.Check(SignatureRefused(text), "a signature file with " + why + " is refused as a signature, and does not throw out of the shell");

        // the key list never throws: what it cannot read it does not trust
        ReleaseKeys List(string entries, string head = "\"version\":1") => ReleaseKeys.Parse("{" + head + ",\"keys\":[" + entries + "]}");
        using var second = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var secondSpki = second.ExportSubjectPublicKeyInfo(); var secondKid = ReleaseKeys.IdOf(secondSpki);
        string Entry(string kidText, string spkiText, string use = "release") => "{\"kid\":\"" + kidText + "\",\"use\":\"" + use + "\",\"spki\":\"" + spkiText + "\"}";
        var good = Entry(kid, Convert.ToBase64String(spki)); var other = Entry(secondKid, Convert.ToBase64String(secondSpki));
        kit.Check(List(good + "," + other).Keys.Count == 2, "premise: two release keys are two keys");
        kit.Check(List(good + "," + Entry(secondKid, Convert.ToBase64String(secondSpki), use: "\\ud800")).Keys.Count == 1, "an entry whose use is a lone surrogate is set aside, as any other entry that says something else than release (the Hub does the same), and the keys before it stay");
        kit.Check(List(Entry("\\ud800", Convert.ToBase64String(secondSpki)) + "," + good).Keys.Select(item => item.Kid).SequenceEqual(new[] { kid }), "so is an entry whose kid is a lone surrogate (it is not the key's id)");
        kit.Check(List(Entry(secondKid, "\\ud800") + "," + good).Keys.Select(item => item.Kid).SequenceEqual(new[] { kid }), "and one whose key is");
        kit.Check(List(good, head: "\"version\":1,\"algorithm\":\"\\ud800\"").Keys.Count == 0, "a list whose algorithm is a lone surrogate is not ES256 and trusts nothing");
        kit.Check(List(good + "," + other.Replace("\"use\"", "\"\\ud800\":0,\"use\"")).Keys.Count == 0, "a list with a field named by a lone surrogate cannot be read whole, and trusts nothing (stricter than the Hub, like a repeated name)");
        kit.Check(List(good, head: "\"version\":1,\"\\ud800\":0").Keys.Count == 0, "wherever that field is");
        kit.Check(List(good, head: "\"version\":1,\"note\":\"\\ud800\"").Keys.Count == 1, "while a lone surrogate in a value that is not read changes nothing");
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
