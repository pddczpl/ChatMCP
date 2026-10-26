using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ChatMCP.Native;

// The checks of a downloaded update that the desktop shell makes with its OWN code before it runs an installer: step 3 of the in-app updater. The Hub downloaded the file and said "ready"
// (lib/update-download.mjs), but that is only the Hub's statement: a program that runs as the owner can write the folder the file is in. So the shell reads the same files again and
// asks, for itself, whether the owner's key signed the manifest, whether the manifest is the release it should be, and whether the file is the installer the manifest names.
//
// The rules are the Hub's (lib/release-signature.mjs, lib/update-check.mjs, lib/update-download.mjs) written a second time in this language, and the tests hold the two to ONE list of cases
// (CHATMCP-HUB/tests/fixtures/release-verify-vectors.json): what the Hub takes the shell takes, and the other way round. Where .NET reads something more loosely than JavaScript does, the rule is
// written out here and not left to the library: base64 must be canonical (Convert.FromBase64String skips white space and ignores spare bits), a byte order mark is stripped by hand (the byte
// overloads of JsonDocument refuse it), a regular expression ends with \z (a $ also matches before a final line break), a digit is 0 to 9 (\d is any Unicode digit). Pure BCL: no package.

/// <summary>The rule for the name of the installer that a signed manifest gives (it becomes a file name in a folder of ours): the Hub's installerNameProblem.</summary>
internal static class InstallerName
{
    private static readonly Regex Shape = new(@"^[A-Za-z0-9._-]{1,100}\.exe\z", RegexOptions.CultureInvariant);
    private static readonly Regex Device = new(@"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\z", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    /// <summary>
    /// Why a name cannot be the name of the installer, or null: 1 to 100 characters of A-Z a-z 0-9 . _ - and then ".exe" (in small letters); it starts with a letter or a digit, has no two
    /// dots in a row, and its first part (up to the first dot) is not the name of a device of Windows, which Windows opens whatever follows it.
    /// </summary>
    internal static string? Problem(string? name)
    {
        if (name == null) return "type";
        if (!Shape.IsMatch(name)) return "shape";
        if (!char.IsAsciiLetterOrDigit(name[0])) return "start";
        if (name.Contains("..", StringComparison.Ordinal)) return "dots";
        if (Device.IsMatch(name.Split('.')[0])) return "device";
        return null;
    }
}

/// <summary>One public key of the release key list, as the bytes of its SPKI (the key is made again from them when it is used).</summary>
internal sealed record ReleaseKey(string Kid, byte[] Spki);

/// <summary>An entry of the key list that was not taken, and why (for a log and for a test; it costs that entry and nothing else).</summary>
internal sealed record IgnoredKey(int Index, string? Kid, string Reason);

/// <summary>
/// The release key list (CHATMCP-HUB/lib/release-keys.json) as the shell reads it: only an entry that says use "release" is a key, and only when it is an EC P-256 key in its canonical SPKI form
/// (91 bytes, an uncompressed point that is on the curve) whose `kid` is the first 8 hex characters of the SHA-256 of those bytes; at most four, each once, in the order of the file. A
/// placeholder (what the file ships with until the owner has made a key) and a test key trust nothing.
/// </summary>
internal sealed class ReleaseKeys
{
    internal const int MaxKeys = 4;
    private const int SpkiBytes = 91;
    private static readonly byte[] SpkiHeader = Convert.FromHexString("3059301306072a8648ce3d020106082a8648ce3d030107034200");
    private static readonly BigInteger FieldPrime = BigInteger.Parse("0ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", NumberStyles.HexNumber, CultureInfo.InvariantCulture);
    private static readonly BigInteger CurveB = BigInteger.Parse("05ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", NumberStyles.HexNumber, CultureInfo.InvariantCulture);

    internal IReadOnlyList<ReleaseKey> Keys { get; }
    internal IReadOnlyList<IgnoredKey> Ignored { get; }
    /// <summary>How many entries say that they are a placeholder.</summary>
    internal int Placeholders { get; }

    private ReleaseKeys(List<ReleaseKey> keys, List<IgnoredKey> ignored, int placeholders) { Keys = keys; Ignored = ignored; Placeholders = placeholders; }

    /// <summary>The key list of its text (a byte order mark in front of it is dropped). Never throws: what is wrong with the file or with an entry is in <see cref="Ignored"/> (index -1 is the file).</summary>
    internal static ReleaseKeys Parse(string? text)
    {
        var keys = new List<ReleaseKey>(); var ignored = new List<IgnoredKey>(); var placeholders = 0;
        void Skip(int index, string reason, JsonElement? entry = null) =>
            ignored.Add(new IgnoredKey(index, entry is { ValueKind: JsonValueKind.Object } e && e.TryGetProperty("kid", out var kid) && kid.ValueKind == JsonValueKind.String ? kid.GetString() : null, reason));
        JsonDocument document;
        try { document = JsonDocument.Parse(Json.StripBom(text ?? ""), Json.Strict); } catch (JsonException) { Skip(-1, "not_json"); return new ReleaseKeys(keys, ignored, placeholders); }
        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) { Skip(-1, "shape"); return new ReleaseKeys(keys, ignored, placeholders); }
            if (!root.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number || !version.TryGetDouble(out var number) || number != 1) { Skip(-1, "version"); return new ReleaseKeys(keys, ignored, placeholders); }
            if (root.TryGetProperty("algorithm", out var algorithm) && (algorithm.ValueKind != JsonValueKind.String || algorithm.GetString() != "ES256")) { Skip(-1, "algorithm"); return new ReleaseKeys(keys, ignored, placeholders); }
            if (!root.TryGetProperty("keys", out var list) || list.ValueKind != JsonValueKind.Array) { Skip(-1, "shape"); return new ReleaseKeys(keys, ignored, placeholders); }
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var index = -1;
            foreach (var entry in list.EnumerateArray())
            {
                index++;
                if (entry.ValueKind != JsonValueKind.Object) { Skip(index, "entry"); continue; }
                var use = entry.TryGetProperty("use", out var usage) && usage.ValueKind == JsonValueKind.String ? usage.GetString() : null;
                if (use == "placeholder") { placeholders++; continue; }
                if (use != "release") { Skip(index, "use", entry); continue; }
                if (keys.Count >= MaxKeys) { Skip(index, "too_many", entry); continue; }
                var spki = entry.TryGetProperty("spki", out var encoded) && encoded.ValueKind == JsonValueKind.String ? Json.DecodeBase64(encoded.GetString()) : null;
                if (spki == null) { Skip(index, "key_encoding", entry); continue; }
                if (!IsCanonicalP256(spki)) { Skip(index, "key_der", entry); continue; }
                var kid = IdOf(spki);
                if (!entry.TryGetProperty("kid", out var claimed) || claimed.ValueKind != JsonValueKind.String || claimed.GetString() != kid) { Skip(index, "kid_mismatch", entry); continue; }
                if (!seen.Add(kid)) { Skip(index, "duplicate", entry); continue; }
                keys.Add(new ReleaseKey(kid, spki));
            }
        }
        return new ReleaseKeys(keys, ignored, placeholders);
    }

    /// <summary>The id of a key: the first 8 hex characters of the SHA-256 of its SPKI bytes (the bytes, not their base64 text).</summary>
    internal static string IdOf(byte[] spki) => Convert.ToHexString(SHA256.HashData(spki))[..8].ToLowerInvariant();

    /// <summary>An EC P-256 key in the one form the Hub accepts: 91 bytes, the fixed header, an uncompressed point, on the curve, and one that the operating system reads as a public key.</summary>
    private static bool IsCanonicalP256(byte[] spki)
    {
        if (spki.Length != SpkiBytes || !spki.AsSpan(0, SpkiHeader.Length).SequenceEqual(SpkiHeader) || spki[SpkiHeader.Length] != 0x04) return false;
        var x = new BigInteger(spki.AsSpan(SpkiHeader.Length + 1, 32), isUnsigned: true, isBigEndian: true);
        var y = new BigInteger(spki.AsSpan(SpkiHeader.Length + 33, 32), isUnsigned: true, isBigEndian: true);
        if (x >= FieldPrime || y >= FieldPrime) return false;
        // y^2 = x^3 - 3x + b (mod p): a point that is not on the curve is not a key, whatever the library does with it
        var onCurve = BigInteger.ModPow(y, 2, FieldPrime) == (((BigInteger.ModPow(x, 3, FieldPrime) - 3 * x + CurveB) % FieldPrime) + FieldPrime) % FieldPrime;
        if (!onCurve) return false;
        try { using var probe = ECDsa.Create(); probe.ImportSubjectPublicKeyInfo(spki, out _); return true; } catch (CryptographicException) { return false; }
    }
}

/// <summary>The signature does not check; <see cref="Reason"/> says why (unknown_kid, mismatch, or what is wrong with the signature file).</summary>
internal sealed class SignatureRefused : Exception
{
    internal string Reason { get; }
    internal SignatureRefused(string reason) : base("The signature of the release does not check (" + reason + ").") { Reason = reason; }
}

/// <summary>
/// The signature on RELEASE-MANIFEST.json: ECDSA over P-256 with SHA-256, the 64 bytes r||s of IEEE P1363, in a small JSON file {"alg": "ES256", "kid": "&lt;8 hex&gt;", "sig": "&lt;base64&gt;"}, made over the
/// EXACT BYTES of the manifest as published: nothing is read again, re-serialized or trimmed before it is checked (a byte order mark, a line ending and a space are part of what was signed).
/// </summary>
internal static class ReleaseSignature
{
    internal const int MaxFileBytes = 4096;
    private const int SignatureBytes = 64;
    private static readonly Regex KeyId = new(@"^[0-9a-f]{8}\z", RegexOptions.CultureInvariant);

    /// <summary>The id of the key that signed <paramref name="manifestBytes"/>, or a <see cref="SignatureRefused"/>.</summary>
    internal static string Verify(byte[] manifestBytes, byte[] signatureBytes, IReadOnlyList<ReleaseKey> keys)
    {
        var (kid, signature) = ParseFile(signatureBytes);
        var key = keys.FirstOrDefault(candidate => candidate.Kid == kid) ?? throw new SignatureRefused("unknown_kid");
        bool good;
        try
        {
            using var ecdsa = ECDsa.Create();
            ecdsa.ImportSubjectPublicKeyInfo(key.Spki, out _);
            good = ecdsa.VerifyData(manifestBytes, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        }
        catch (CryptographicException) { good = false; }
        if (!good) throw new SignatureRefused("mismatch");
        return kid;
    }

    /// <summary>The signature file, read strictly: at most 4096 bytes of UTF-8 (a byte order mark is dropped), a JSON object whose `alg` is ES256, whose `kid` is 8 lower-case hex characters and whose `sig` is canonical base64 of exactly 64 bytes. Fields it does not know are ignored.</summary>
    private static (string Kid, byte[] Signature) ParseFile(byte[] bytes)
    {
        if (bytes.Length == 0) throw new SignatureRefused("empty");
        if (bytes.Length > MaxFileBytes) throw new SignatureRefused("size");
        string text;
        try { text = new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(bytes); } catch (DecoderFallbackException) { throw new SignatureRefused("encoding"); }
        JsonDocument document;
        try { document = JsonDocument.Parse(Json.StripBom(text), Json.Strict); } catch (JsonException) { throw new SignatureRefused("json"); }
        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new SignatureRefused("shape");
            if (!root.TryGetProperty("alg", out var alg) || alg.ValueKind != JsonValueKind.String || alg.GetString() != "ES256") throw new SignatureRefused("alg");
            if (!root.TryGetProperty("kid", out var kid) || kid.ValueKind != JsonValueKind.String || !KeyId.IsMatch(kid.GetString()!)) throw new SignatureRefused("kid");
            var signature = root.TryGetProperty("sig", out var encoded) && encoded.ValueKind == JsonValueKind.String ? Json.DecodeBase64(encoded.GetString()) : null;
            if (signature == null) throw new SignatureRefused("sig_encoding");
            if (signature.Length != SignatureBytes) throw new SignatureRefused("sig_length");
            return (kid.GetString()!, signature);
        }
    }
}

/// <summary>The manifest is not a release description of the shape the publish workflow writes; <see cref="Reason"/> says what is wrong.</summary>
internal sealed class ManifestRefused : Exception
{
    internal string Reason { get; }
    internal ManifestRefused(string reason) : base("The release description is not valid: " + reason + ".") { Reason = reason; }
}

internal sealed record ReleaseAsset(string Name, long Bytes, string Sha256);

/// <summary>
/// RELEASE-MANIFEST.json as the publish workflow writes it: {version, commit, assets: [{name, bytes, sha256}], ...}. Required parts are checked strictly and keys that are not known are ignored (a later
/// release adds some). <see cref="Installer"/> is the one asset whose name ends in .exe (in any letter case), or null when there is none or more than one.
/// </summary>
internal sealed record ReleaseManifest(string Version, string Commit, IReadOnlyList<ReleaseAsset> Assets, ReleaseAsset? Installer)
{
    internal const int MaxAssets = 32;
    private const long MaxSafe = 9007199254740991;
    private static readonly Regex Commit40 = new(@"^[0-9a-fA-F]{40}\z", RegexOptions.CultureInvariant);
    private static readonly Regex Digest = new(@"^[0-9a-fA-F]{64}\z", RegexOptions.CultureInvariant);
    private static readonly Regex AssetName = new(@"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\z", RegexOptions.CultureInvariant);

    internal static ReleaseManifest Parse(byte[] bytes)
    {
        JsonDocument document;
        try { document = JsonDocument.Parse(Json.StripBom(bytes), Json.Strict); } catch (JsonException) { throw new ManifestRefused("the file is not JSON"); }
        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new ManifestRefused("the file is not an object");
            if (!root.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.String) throw new ManifestRefused("no version");
            var versionText = version.GetString()!;
            if (!ReleaseVersion.TryParse(versionText, out _)) throw new ManifestRefused("the version is not a release x.y.z");
            if (!root.TryGetProperty("commit", out var commit) || commit.ValueKind != JsonValueKind.String || !Commit40.IsMatch(commit.GetString()!)) throw new ManifestRefused("the commit is not 40 hexadecimal characters");
            if (!root.TryGetProperty("assets", out var list) || list.ValueKind != JsonValueKind.Array || list.GetArrayLength() > MaxAssets) throw new ManifestRefused("the assets are not a short list");
            var assets = new List<ReleaseAsset>(); var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var asset in list.EnumerateArray())
            {
                if (asset.ValueKind != JsonValueKind.Object) throw new ManifestRefused("an asset is not an object");
                if (!asset.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.String || !AssetName.IsMatch(name.GetString()!)) throw new ManifestRefused("an asset has a name that is not a file name");
                if (!asset.TryGetProperty("bytes", out var size) || size.ValueKind != JsonValueKind.Number || !size.TryGetInt64(out var count) || count < 0 || count > MaxSafe) throw new ManifestRefused("an asset has a size that is not a count of bytes");
                if (!asset.TryGetProperty("sha256", out var digest) || digest.ValueKind != JsonValueKind.String || !Digest.IsMatch(digest.GetString()!)) throw new ManifestRefused("an asset has a digest that is not SHA-256");
                if (!names.Add(name.GetString()!.ToLowerInvariant())) throw new ManifestRefused("two assets have one name");
                assets.Add(new ReleaseAsset(name.GetString()!, count, digest.GetString()!.ToLowerInvariant()));
            }
            var programs = assets.Where(asset => asset.Name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)).ToList();
            return new ReleaseManifest(versionText, commit.GetString()!.ToLowerInvariant(), assets, programs.Count == 1 ? programs[0] : null);
        }
    }
}

/// <summary>What the checks above share about reading JSON and base64 the way the Hub's JavaScript reads them.</summary>
internal static class Json
{
    /// <summary>Strict: no comment, no trailing comma, no repeated name in an object (JavaScript would take the last one and .NET another), and no more than 32 levels.</summary>
    internal static readonly JsonDocumentOptions Strict = new() { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow, MaxDepth = 32, AllowDuplicateProperties = false };

    /// <summary>The text without a byte order mark in front of it.</summary>
    internal static string StripBom(string text) => text.Length > 0 && text[0] == '﻿' ? text[1..] : text;

    /// <summary>The bytes without a UTF-8 byte order mark in front of them (the byte overloads of JsonDocument refuse one); the same memory when there is none.</summary>
    internal static ReadOnlyMemory<byte> StripBom(byte[] bytes) => bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF ? bytes.AsMemory(3) : bytes.AsMemory();

    private static readonly Regex Base64Alphabet = new(@"^[A-Za-z0-9+/]*={0,2}\z", RegexOptions.CultureInvariant);

    /// <summary>
    /// The bytes of canonical base64 and nothing else: not empty, at most 16,384 characters, a multiple of 4, the standard alphabet, padding as it is written, no white space (Convert.FromBase64String
    /// skips it) and no spare bits set (it ignores them); null for anything that is not.
    /// </summary>
    internal static byte[]? DecodeBase64(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 16384 || value.Length % 4 != 0 || !Base64Alphabet.IsMatch(value)) return null;
        try
        {
            var bytes = Convert.FromBase64String(value);
            return Convert.ToBase64String(bytes) == value ? bytes : null;
        }
        catch (FormatException) { return null; }
    }
}
