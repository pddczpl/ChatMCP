using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace ChatMCP.Sandbox.GuestSupervisor;

public sealed class BlackBoxExecutionSpec
{
    [JsonPropertyName("version")] public int Version { get; set; }
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("manifestPath")] public string ManifestPath { get; set; } = "";
    [JsonPropertyName("manifestSha256")] public string ManifestSha256 { get; set; } = "";
}

public sealed class NativeBlackBoxEvidence
{
    [JsonPropertyName("version")] public int Version { get; set; } = 1;
    [JsonPropertyName("kind")] public string Kind { get; set; } = "native-blackbox";
    [JsonPropertyName("manifestSha256")] public string ManifestSha256 { get; set; } = "";
    [JsonPropertyName("cases")] public int Cases { get; set; }
    [JsonPropertyName("passed")] public int Passed { get; set; }
    [JsonPropertyName("failed")] public int Failed { get; set; }
    [JsonPropertyName("valid")] public bool Valid { get; set; }
}

// Assertion authority stays in this native process. The restricted adapter may
// supply values, never test events, counts or verdicts. Cases are public approved
// examples, so passing them is deliberately not a claim of general correctness.
internal sealed class NativeBlackBoxGrader
{
    internal const int MaxDocumentBytes = 64 * 1024;
    private readonly (string Id, JsonElement Expected)[] cases;
    internal string AdapterPath { get; }
    internal string ManifestSha256 { get; }
    internal byte[] InputBytes { get; }

    internal NativeBlackBoxGrader(byte[] manifestBytes, string manifestSha256)
    {
        using var manifest = ParseStrict(manifestBytes);
        var root = manifest.RootElement;
        RequireKeys(root, "version", "kind", "adapter", "cases");
        RequireVersion(root);
        if (root.GetProperty("kind").GetString() != "node-json-blackbox")
            throw new InvalidDataException("Unsupported black-box manifest kind.");
        string adapter = root.GetProperty("adapter").GetString() ?? "";
        SealedReceiptChannel.ValidateRelativePath(adapter);
        if (!new[] { ".js", ".mjs", ".cjs" }.Contains(Path.GetExtension(adapter), StringComparer.Ordinal))
            throw new InvalidDataException("The black-box adapter must be a JavaScript file.");
        AdapterPath = SealedReceiptChannel.Input + @"\project\" + adapter.Replace('/', '\\');
        ManifestSha256 = manifestSha256;
        var approvedCases = root.GetProperty("cases");
        if (approvedCases.ValueKind != JsonValueKind.Array || approvedCases.GetArrayLength() is < 1 or > 64)
            throw new InvalidDataException("Black-box checks require between 1 and 64 cases.");
        cases = new (string, JsonElement)[approvedCases.GetArrayLength()];
        var ids = new HashSet<string>(StringComparer.Ordinal);
        using var input = new MemoryStream();
        using (var writer = new Utf8JsonWriter(input))
        {
            writer.WriteStartObject();
            writer.WriteNumber("version", 1);
            writer.WriteStartArray("cases");
            int index = 0;
            foreach (var item in approvedCases.EnumerateArray())
            {
                RequireKeys(item, "id", "input", "expected");
                string id = item.GetProperty("id").GetString() ?? "";
                if (!Regex.IsMatch(id, "^[A-Za-z0-9_-]{1,64}$", RegexOptions.CultureInvariant) || !ids.Add(id))
                    throw new InvalidDataException("Black-box case identifiers must be valid and unique.");
                cases[index++] = (id, item.GetProperty("expected").Clone());
                writer.WriteStartObject();
                writer.WriteString("id", id);
                writer.WritePropertyName("input");
                item.GetProperty("input").WriteTo(writer);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        InputBytes = input.ToArray();
        if (InputBytes.Length > MaxDocumentBytes)
            throw new InvalidDataException("Encoded black-box input exceeds the limit.");
    }

    internal NativeBlackBoxEvidence Grade(string stdout, bool eligible, List<string> reasons)
    {
        var evidence = new NativeBlackBoxEvidence { ManifestSha256 = ManifestSha256, Cases = cases.Length, Failed = cases.Length };
        if (!eligible)
        {
            reasons.Add("Black-box grading requires successful bounded execution and confirmed cleanup.");
            return evidence;
        }
        try
        {
            using var output = ParseStrict(new UTF8Encoding(false, true).GetBytes(stdout));
            var root = output.RootElement;
            RequireKeys(root, "version", "results");
            RequireVersion(root);
            var results = root.GetProperty("results");
            if (results.ValueKind != JsonValueKind.Array || results.GetArrayLength() != cases.Length)
                throw new InvalidDataException("Black-box result count differs from the approved case count.");
            int index = 0;
            foreach (var item in results.EnumerateArray())
            {
                RequireKeys(item, "id", "value");
                if (item.GetProperty("id").GetString() != cases[index].Id)
                    throw new InvalidDataException("Black-box result identifiers/order differ from the approved cases.");
                if (JsonEqual(cases[index].Expected, item.GetProperty("value"))) evidence.Passed++;
                else reasons.Add("Black-box case did not match: " + cases[index].Id);
                index++;
            }
            evidence.Failed = evidence.Cases - evidence.Passed;
            evidence.Valid = evidence.Failed == 0;
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException or InvalidOperationException or FormatException or EncoderFallbackException)
        {
            // A malformed late result must not retain partial passing counts.
            evidence.Passed = 0;
            evidence.Failed = evidence.Cases;
            reasons.Add("Invalid black-box output: " + ex.Message);
        }
        return evidence;
    }

    private static JsonDocument ParseStrict(byte[] bytes)
    {
        if (bytes.Length is < 1 or > MaxDocumentBytes)
            throw new InvalidDataException("Black-box JSON exceeds its byte limit or is empty.");
        // JsonDocument is UTF-8 based; decode strictly first to forbid replacement
        // characters concealing an invalid byte sequence from comparison.
        _ = new UTF8Encoding(false, true).GetString(bytes);
        var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 16 });
        try
        {
            int nodes = 0;
            ValidateValue(document.RootElement, ref nodes);
            return document;
        }
        catch { document.Dispose(); throw; }
    }

    private static void ValidateValue(JsonElement value, ref int nodes)
    {
        if (++nodes > 10000) throw new InvalidDataException("Black-box JSON has too many values.");
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                var names = new HashSet<string>(StringComparer.Ordinal);
                foreach (var property in value.EnumerateObject())
                {
                    if (!names.Add(property.Name)) throw new InvalidDataException("Duplicate JSON property.");
                    ValidateValue(property.Value, ref nodes);
                }
                break;
            case JsonValueKind.Array:
                foreach (var item in value.EnumerateArray()) ValidateValue(item, ref nodes);
                break;
            case JsonValueKind.Number:
                if (!value.TryGetDouble(out double number) || !double.IsFinite(number))
                    throw new InvalidDataException("Black-box numbers must be finite binary64 values.");
                break;
            case JsonValueKind.String:
                _ = value.GetString();
                break;
            case JsonValueKind.True:
            case JsonValueKind.False:
            case JsonValueKind.Null:
                break;
            default: throw new InvalidDataException("Unsupported JSON value.");
        }
    }

    private static void RequireKeys(JsonElement element, params string[] names)
    {
        if (element.ValueKind != JsonValueKind.Object || element.EnumerateObject().Count() != names.Length ||
            names.Any(name => !element.TryGetProperty(name, out _)))
            throw new InvalidDataException("Unexpected black-box JSON schema.");
    }

    private static void RequireVersion(JsonElement root)
    {
        if (!root.GetProperty("version").TryGetInt32(out int version) || version != 1)
            throw new InvalidDataException("Unsupported black-box version.");
    }

    private static bool JsonEqual(JsonElement expected, JsonElement actual)
    {
        if (expected.ValueKind != actual.ValueKind) return false;
        return expected.ValueKind switch
        {
            JsonValueKind.Object => expected.EnumerateObject().Count() == actual.EnumerateObject().Count() &&
                expected.EnumerateObject().All(property => actual.TryGetProperty(property.Name, out var value) && JsonEqual(property.Value, value)),
            JsonValueKind.Array => expected.GetArrayLength() == actual.GetArrayLength() &&
                expected.EnumerateArray().Zip(actual.EnumerateArray()).All(pair => JsonEqual(pair.First, pair.Second)),
            JsonValueKind.Number => expected.GetDouble() == actual.GetDouble(),
            JsonValueKind.String => expected.GetString() == actual.GetString(),
            JsonValueKind.True or JsonValueKind.False or JsonValueKind.Null => true,
            _ => false
        };
    }

    // Pure inert parser/comparison fixture. It does not run project code, inspect
    // a guest, create a receipt or participate in the attestation channel.
    internal static int RunDiagnosticSelfTest()
    {
        int passed = 0;
        var failures = new List<string>();
        static byte[] Bytes(string json) => Encoding.UTF8.GetBytes(json);
        static string Manifest(string expected) => "{\"version\":1,\"kind\":\"node-json-blackbox\",\"adapter\":\"adapter.mjs\",\"cases\":[{\"id\":\"one\",\"input\":null,\"expected\":" + expected + "}]}";
        static string Output(string value) => "{\"version\":1,\"results\":[{\"id\":\"one\",\"value\":" + value + "}]}";
        void Check(string name, Action action)
        {
            try { action(); passed++; }
            catch (Exception ex) { failures.Add(name + ": " + ex.Message); }
        }
        void Compare(string name, string expected, string actual, bool valid)
        {
            Check(name, () =>
            {
                var grader = new NativeBlackBoxGrader(Bytes(Manifest(expected)), new string('a', 64));
                var evidence = grader.Grade(Output(actual), true, []);
                if (evidence.Valid != valid || evidence.Cases != 1 || evidence.Passed != (valid ? 1 : 0) || evidence.Failed != (valid ? 0 : 1))
                    throw new InvalidOperationException("Unexpected native comparison result.");
            });
        }
        void RejectOutput(string name, string output)
        {
            Check(name, () =>
            {
                var grader = new NativeBlackBoxGrader(Bytes(Manifest("1")), new string('a', 64));
                var evidence = grader.Grade(output, true, []);
                if (evidence.Valid || evidence.Passed != 0 || evidence.Failed != 1)
                    throw new InvalidOperationException("Malformed output was accepted.");
            });
        }
        void RejectManifest(string name, byte[] manifest)
        {
            Check(name, () =>
            {
                try { _ = new NativeBlackBoxGrader(manifest, new string('a', 64)); }
                catch (Exception ex) when (ex is JsonException or InvalidDataException or InvalidOperationException or DecoderFallbackException) { return; }
                throw new Exception("Invalid manifest was accepted.");
            });
        }
        Compare("number", "42", "42.0", true);
        Compare("string", "\"hello\"", "\"hello\"", true);
        Compare("boolean", "true", "true", true);
        Compare("null", "null", "null", true);
        Compare("array", "[1,\"a\",false,null]", "[1,\"a\",false,null]", true);
        Compare("object order", "{\"a\":1,\"b\":[true]}", "{\"b\":[true],\"a\":1}", true);
        Compare("number/string mismatch", "1", "\"1\"", false);
        Compare("boolean mismatch", "true", "false", false);
        Compare("missing/null mismatch", "{\"a\":null}", "{}", false);
        Compare("array order", "[1,2]", "[2,1]", false);
        Compare("object extra property", "{\"a\":1}", "{\"a\":1,\"b\":2}", false);
        Compare("negative zero", "-0", "0", true);
        // The contract intentionally uses Node-compatible finite binary64
        // semantics, including rounding and subnormal underflow, not decimals.
        Compare("binary64 rounding", "9007199254740993", "9007199254740992", true);
        Compare("binary64 underflow", "1e-999", "0", true);
        RejectOutput("empty output", "");
        RejectOutput("zero results", "{\"version\":1,\"results\":[]}");
        RejectOutput("wrong id", Output("1").Replace("one", "two"));
        RejectOutput("missing value", "{\"version\":1,\"results\":[{\"id\":\"one\"}]}");
        RejectOutput("child verdict", Output("1").Replace("\"value\":1", "\"value\":1,\"passed\":true"));
        RejectOutput("duplicate property", Output("{\"a\":1,\"a\":1}"));
        RejectOutput("escaped duplicate property", Output("{\"a\":1,\"\\u0061\":1}"));
        RejectOutput("duplicate root", "{\"version\":1,\"version\":1,\"results\":[]}");
        RejectOutput("trailing JSON", Output("1") + "{}");
        RejectOutput("reporter marker", "CHATMCP_NODE_TEST_SUMMARY:{\"valid\":true}");
        RejectOutput("infinite number", Output("1e999"));
        RejectOutput("oversized output", Output("\"" + new string('x', MaxDocumentBytes) + "\""));
        RejectOutput("deep output", Output(new string('[', 17) + "1" + new string(']', 17)));
        RejectOutput("many values", Output("[" + string.Join(',', Enumerable.Repeat("0", 10001)) + "]"));
        RejectManifest("zero cases", Bytes("{\"version\":1,\"kind\":\"node-json-blackbox\",\"adapter\":\"a.mjs\",\"cases\":[]}"));
        RejectManifest("unsafe adapter", Bytes(Manifest("1").Replace("adapter.mjs", "../adapter.mjs")));
        RejectManifest("non-JavaScript adapter", Bytes(Manifest("1").Replace("adapter.mjs", "adapter.exe")));
        RejectManifest("invalid UTF8", [0x7b, 0xff, 0x7d]);
        RejectManifest("infinite expected", Bytes(Manifest("1e999")));
        RejectManifest("duplicate case ids", Bytes(Manifest("1").Replace("\"expected\":1}]", "\"expected\":1},{\"id\":\"one\",\"input\":null,\"expected\":1}]")));
        Check("execution ineligible", () =>
        {
            var evidence = new NativeBlackBoxGrader(Bytes(Manifest("1")), new string('a', 64)).Grade(Output("1"), false, []);
            if (evidence.Valid || evidence.Passed != 0 || evidence.Failed != 1) throw new Exception("Ineligible execution accepted.");
        });
        Console.WriteLine("HOST-DIAGNOSTIC ONLY; no guest execution, receipt or attestation.");
        Console.WriteLine($"BLACKBOX_NATIVE_SELF_TEST passed={passed} failed={failures.Count}");
        foreach (string failure in failures) Console.Error.WriteLine(failure);
        return failures.Count == 0 ? 0 : 1;
    }
}

[JsonSourceGenerationOptions(WriteIndented = true)]
[JsonSerializable(typeof(ExecutionRequest))]
[JsonSerializable(typeof(ExecutionReceipt))]
[JsonSerializable(typeof(NativeSecurityEvidence))]
internal partial class SupervisorJsonContext : JsonSerializerContext { }
