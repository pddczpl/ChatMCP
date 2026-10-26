using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ChatMCP.Native;

// What the shell does when the page asks it to install the update that the Hub downloaded (chatmcp.apply-update), in the three pieces the shell is made of: what a message from the page may be
// (PageMessage), what the shell asks the Hub before it exits (HubLifecycle.PreflightForUpdate) and the sequence itself (UpdateApplier), run with pretend things so that every refusal and the one
// way through are tried. The window and the real process are the shell's own and are exercised on the runner.
internal static class ApplyTests
{
    private static readonly ReleaseVersion Running = ReleaseVersion.TryParse("3.10.2", out var running) ? running : throw new InvalidOperationException();
    private const string Product = "DatGold Studio Setup";

    internal static void Run(TestKit kit)
    {
        PageMessages(kit);
        Preflight(kit);
        Applier(kit);
        Receipt(kit);
    }

    // ---------------------------------------------------------------------------------------------------------------------------------------------------- an installed copy
    private static void Receipt(TestKit kit)
    {
        // The installer leaves a receipt of the files it owns in the folder it installs to; a build run from a work tree, or a folder somebody copied the program into, has none and never replaces itself.
        kit.Check(InstalledCopy.ReceiptName == ".chatmcp-installed-files.json", "the receipt is the file the installer has always left (its manifest of owned files)");
        var folder = kit.Folder("receipt");
        kit.Check(!InstalledCopy.Is(folder), "a folder with no receipt is not an installed copy");
        File.WriteAllText(Path.Combine(folder, InstalledCopy.ReceiptName), "{}");
        kit.Check(InstalledCopy.Is(folder), "a folder with the receipt is");
        kit.Check(!InstalledCopy.Is(Path.Combine(kit.Scratch, "no-such-folder")) && !InstalledCopy.Is("") && !InstalledCopy.Is(null), "and a folder that is not there, or no folder, is not");
        var asFolder = kit.Folder("receipt-as-folder"); Directory.CreateDirectory(Path.Combine(asFolder, InstalledCopy.ReceiptName));
        kit.Check(!InstalledCopy.Is(asFolder), "a receipt that is a folder is not a receipt");
    }

    // ---------------------------------------------------------------------------------------------------------------------------------------------------- the page's messages
    private static void PageMessages(TestKit kit)
    {
        const string id = "0123456789abcdef-0123";
        foreach (var source in new[] { "http://127.0.0.1:3007/", "http://127.0.0.1:3007/#chatmcp-boot=abc", "http://127.0.0.1:3007/?x=1", "HTTP://127.0.0.1:3007" })
            kit.Check(PageMessage.IsDashboard(source, 3007), "a message from the dashboard is read: " + source);
        foreach (var source in new[]
        {
            "http://127.0.0.1:3007/index.html", "http://127.0.0.1:3007/a/", "https://127.0.0.1:3007/", "http://localhost:3007/", "http://127.0.0.2:3007/", "http://127.0.0.1:3008/", "http://127.0.0.1/", "http://127.0.0.1:30070/",
            "http://127.0.0.1:3007.evil.example/", "http://evil@127.0.0.1:3007/", "http://user:pw@127.0.0.1:3007/", "http://[::1]:3007/", "http://127.0.0.1.:3007/", "file:///C:/x.html", "about:blank", "data:text/html,x", "javascript:1", "relative/path", "", " ",
        })
            kit.Check(!PageMessage.IsDashboard(source, 3007), "a message from anywhere else is ignored: " + (source == "" ? "(empty)" : source));
        kit.Check(!PageMessage.IsDashboard(null, 3007), "and one with no origin");
        kit.Check(PageMessage.IsDashboard("http://127.0.0.1:3010/", 3010) && !PageMessage.IsDashboard("http://127.0.0.1:3007/", 3010), "the port is the one the shell was given");

        bool Parses(string json, out string type, out string requestId) => PageMessage.TryParse(json, out type, out requestId);
        kit.Check(Parses("{\"type\":\"chatmcp.apply-update\",\"id\":\"" + id + "\"}", out var t1, out var i1) && t1 == "chatmcp.apply-update" && i1 == id, "an apply-update message has a type and an id and nothing else is read");
        kit.Check(Parses("{\"type\":\"chatmcp.pick-folder\",\"id\":\"" + id + "\",\"initialPath\":\"C:\\\\x\"}", out var t2, out _) && t2 == "chatmcp.pick-folder", "a pick-folder message keeps working (its folder is read by the folder code, not here)");
        kit.Check(Parses("{\"type\":\"chatmcp.pick-folder\",\"id\":\"" + id + "\",\"initialPath\":\"" + string.Concat(Enumerable.Repeat("\\\\", 4096)) + "\"}", out _, out _), "even with the longest path the folder picker takes (4096 characters, every one a backslash that JSON writes as two: over 8 KiB of text)");
        // the one field of a pick-folder message that is read (the folder the picker starts in) is read here, with the same care: a value .NET cannot give as text is a message that is dropped, never an exception
        bool Suggests(string json, out string? path) => PageMessage.TryReadInitialPath(json, out path);
        string Pick(string fields) => "{\"type\":\"chatmcp.pick-folder\",\"id\":\"" + id + "\"" + fields + "}";
        kit.Check(Suggests(Pick(",\"initialPath\":\"C:\\\\Work\\\\App\""), out var suggested) && suggested == @"C:\Work\App", "the folder the picker starts in is the string of the field initialPath");
        kit.Check(Suggests(Pick(",\"initialPath\":\"C:\\\\caf\\u00e9 \\ud83d\\ude00\""), out suggested) && suggested == "C:\\caf\u00e9 \U0001F600", "also with letters that are not ASCII, and a surrogate PAIR (which is text)");
        kit.Check(Suggests(Pick(""), out suggested) && suggested == null, "a message with no suggestion has none");
        kit.Check(Suggests(Pick(",\"initialPath\":5"), out suggested) && suggested == null && Suggests(Pick(",\"initialPath\":null"), out suggested) && suggested == null && Suggests(Pick(",\"initialPath\":[\"C:\\\\x\"]"), out suggested) && suggested == null, "and so does one whose field is not a string");
        foreach (var (why, json) in new (string, string)[] { ("a lone surrogate in it", Pick(",\"initialPath\":\"\\ud800\"")), ("a lone low surrogate in it", Pick(",\"initialPath\":\"C:\\\\x\\udc00\"")), ("a reversed pair in it", Pick(",\"initialPath\":\"\\udc00\\ud800\"")),
                     ("a field named by a lone surrogate", Pick(",\"\\ud800\":1")),
                     // .NET compares a name that is written with an escape only when it can be as long as the name it looks for (initialPath, 11 characters): this one can, and then it throws
                     ("a field named by a lone surrogate and as long as the field looked for", Pick(",\"\\ud800abcdefghijklmnop\":1")), ("a message that is not JSON", "not json"), ("a message that is an array", "[1]"), ("nothing", ""), ("a message over 32 KiB", Pick(",\"initialPath\":\"" + new string('x', 40000) + "\"")) })
        {
            kit.Check(SafeSuggests(json) == "dropped" || SafeSuggests(json) == "read", "a pick-folder message with " + why + " never throws");
            if (!why.StartsWith("a field named by a lone surrogate", StringComparison.Ordinal)) kit.Check(SafeSuggests(json) == "dropped", "and is dropped: " + why);
        }
        string SafeSuggests(string json) { try { return Suggests(json, out _) ? "read" : "dropped"; } catch (Exception error) { return "threw " + error.GetType().Name; } }
        kit.Check(Parses("{\"type\":\"chatmcp.apply-update\",\"id\":\"" + id + "\",\"path\":\"C:\\\\evil\\\\setup.exe\",\"version\":\"9.9.9\",\"name\":\"x.exe\",\"args\":[\"--x\"],\"url\":\"https://evil.example/\"}", out var t3, out var i3) && t3 == "chatmcp.apply-update" && i3 == id,
            "a path, a version, a name, arguments or an address in the message are not an error and are not read: the shell computes everything itself");
        var refused = new (string Why, string Json)[]
        {
            ("an unknown type", "{\"type\":\"chatmcp.format-disk\",\"id\":\"" + id + "\"}"), ("a type that is not a string", "{\"type\":7,\"id\":\"" + id + "\"}"), ("no type", "{\"id\":\"" + id + "\"}"),
            ("no id", "{\"type\":\"chatmcp.apply-update\"}"), ("an id that is not a string", "{\"type\":\"chatmcp.apply-update\",\"id\":1234567890123456}"), ("an id that is too short", "{\"type\":\"chatmcp.apply-update\",\"id\":\"abc\"}"),
            ("an id that is too long", "{\"type\":\"chatmcp.apply-update\",\"id\":\"" + new string('a', 65) + "\"}"), ("an id with characters of a path", "{\"type\":\"chatmcp.apply-update\",\"id\":\"..\\\\..\\\\0123456789abcdef\"}"),
            ("an id with a quote", "{\"type\":\"chatmcp.apply-update\",\"id\":\"0123456789abcdef\\\"}\"}"), ("a type in other letter case", "{\"type\":\"CHATMCP.APPLY-UPDATE\",\"id\":\"" + id + "\"}"),
            ("an id that ends with a line break", "{\"type\":\"chatmcp.apply-update\",\"id\":\"" + id + "\\n\"}"),
            ("an array", "[{\"type\":\"chatmcp.apply-update\",\"id\":\"" + id + "\"}]"), ("a string", "\"chatmcp.apply-update\""), ("null", "null"), ("a number", "7"), ("not JSON", "chatmcp.apply-update"), ("nothing", ""),
            ("a message over 32 KiB", "{\"type\":\"chatmcp.apply-update\",\"id\":\"" + id + "\",\"padding\":\"" + new string('x', 40000) + "\"}"),
            // JSON may write a lone surrogate (\ud800): JavaScript reads it, and .NET throws InvalidOperationException (not JsonException) when it is asked for that text or has to compare the name of such a
            // property. A page that sent one crashed the window's message handler, so each is a message that is dropped.
            ("a type that is a lone surrogate", "{\"type\":\"\\ud800\",\"id\":\"" + id + "\"}"), ("a type that is a lone surrogate before a letter", "{\"type\":\"\\ud800x\",\"id\":\"" + id + "\"}"),
            ("an id that is a lone surrogate", "{\"type\":\"chatmcp.apply-update\",\"id\":\"\\ud800\"}"), ("an id that is a reversed pair", "{\"type\":\"chatmcp.apply-update\",\"id\":\"\\udc00\\ud800\"}"),
        };
        foreach (var (why, json) in refused) kit.Check(!Parses(json, out _, out _), "a message with " + why + " is dropped");
        kit.Check(Parses("{\"type\":\"chatmcp.apply-update\",\"id\":\"" + id + "\",\"note\":\"\\ud800\"}", out var t4, out var i4) && t4 == "chatmcp.apply-update" && i4 == id, "while a lone surrogate in a value that is not read is no error: nothing in it is looked at");
        // A field NAMED by a lone surrogate: .NET throws when it has to compare that name with the one it looks for, and it looks from the last field to the first, so whether the message is dropped or read right depends
        // on where the field stands and on the library. That is the library's business; that nothing is thrown, and that what is read is right, is ours.
        foreach (var json in new[]
        {
            "{\"type\":\"chatmcp.apply-update\",\"id\":\"" + id + "\",\"\\ud800\":1}", "{\"type\":\"chatmcp.apply-update\",\"\\ud800\":1,\"id\":\"" + id + "\"}", "{\"\\ud800\":1,\"type\":\"chatmcp.apply-update\",\"id\":\"" + id + "\"}",
        })
            kit.Check(!Parses(json, out var t5, out var i5) || (t5 == "chatmcp.apply-update" && i5 == id), "a message with a field named by a lone surrogate is either dropped or read right, and never throws: " + json.Replace(id, "<id>"));

        // the answer to the page: a JSON string value, never script text, and a code of the closed list
        using (var reply = JsonDocument.Parse(PageMessage.UpdateResultJson(id, false, "tasks_running")))
            kit.Check(reply.RootElement.GetProperty("type").GetString() == "chatmcp.update-result" && reply.RootElement.GetProperty("id").GetString() == id && !reply.RootElement.GetProperty("ok").GetBoolean() && reply.RootElement.GetProperty("code").GetString() == "tasks_running", "the answer carries the id, ok and a code");
        using (var reply = JsonDocument.Parse(PageMessage.UpdateResultJson(id, false, "C:\\Users\\Test User\\secret</script>")))
            kit.Check(reply.RootElement.GetProperty("code").GetString() == "launch_failed", "a code that is not on the closed list is never passed on: whatever it holds, the page is told launch_failed");
        kit.Check(UpdateCodes.Known.SetEquals(new[] { "busy", "tasks_running", "hub_unreachable", "not_installed", "no_update", "ambiguous", "staging_unsafe", "no_trusted_key", "bad_signature", "bad_manifest", "not_newer", "bad_installer", "stale", "launch_failed", "launched" }), "the codes the page can be told are these 15, and the page has words for each");

        kit.Check(PageMessage.Types.SetEquals(new[] { "chatmcp.pick-folder", "chatmcp.apply-update" }), "and the shell answers to two kinds of message from the page, no more");
    }

    // ---------------------------------------------------------------------------------------------------------------------------------------------------- what the shell asks the Hub
    /// <summary>A Hub on a free loopback port that answers a few GETs, and refuses what has no bearer; every request it saw is kept.</summary>
    private sealed class FakeHub : IDisposable
    {
        internal readonly string Origin;
        internal readonly List<string> Requests = new();
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        private readonly Dictionary<string, string> routes;
        private readonly string secret;
        private readonly CancellationTokenSource stop = new();
        private readonly Task loop;

        internal FakeHub(string secret, Dictionary<string, string> routes)
        {
            this.secret = secret; this.routes = routes;
            listener.Start();
            Origin = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port;
            loop = Task.Run(async () =>
            {
                while (!stop.IsCancellationRequested)
                {
                    try
                    {
                        using var peer = await listener.AcceptTcpClientAsync(stop.Token);
                        using var stream = peer.GetStream();
                        var seen = new StringBuilder(); var buffer = new byte[4096];
                        while (!seen.ToString().Contains("\r\n\r\n")) { var read = await stream.ReadAsync(buffer, stop.Token); if (read == 0) break; seen.Append(Encoding.ASCII.GetString(buffer, 0, read)); }
                        var head = seen.ToString().Split("\r\n");
                        var path = head[0].Split(' ')[1];
                        lock (Requests) Requests.Add(path + (head.Any(line => line.Equals("Authorization: Bearer " + this.secret, StringComparison.OrdinalIgnoreCase)) ? " (bearer)" : " (no bearer)"));
                        var allowed = head.Any(line => line.Equals("Authorization: Bearer " + this.secret, StringComparison.OrdinalIgnoreCase));
                        var status = !allowed ? "401 Unauthorized" : this.routes.ContainsKey(path) ? "200 OK" : "404 Not Found";
                        var body = Encoding.UTF8.GetBytes(allowed && this.routes.TryGetValue(path, out var json) ? json : "{}");
                        await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n"), stop.Token);
                        await stream.WriteAsync(body, stop.Token);
                    }
                    catch (Exception) when (stop.IsCancellationRequested) { }
                    catch (IOException) { }
                    catch (SocketException) { }
                }
            });
        }
        public void Dispose() { stop.Cancel(); listener.Stop(); try { loop.Wait(2000); } catch (AggregateException) { } }
    }

    private static void Preflight(TestKit kit)
    {
        const string secret = "S3cretS3cretS3cretS3cretS3cretS3cret";
        static string State(string agent, string? download = null, string studio = "null") =>
            "{\"agent\":" + agent + ",\"studio\":" + studio + ",\"csrfToken\":\"x\",\"update\":{\"current\":\"3.10.2\"" + (download == null ? "" : ",\"download\":" + download) + "}}";
        const string Idle = "{\"activeTaskId\":null,\"tasks\":[]}";
        const string CodingIdle = "{\"activeRunId\":null,\"jobs\":[]}";
        UpdatePreflight Ask(Dictionary<string, string> routes, string? withSecret = secret)
        {
            using var hub = new FakeHub(secret, routes);
            using var client = HubLifecycle.Client();
            return HubLifecycle.PreflightForUpdate(client, hub.Origin, withSecret).GetAwaiter().GetResult();
        }

        var ready = Ask(new() { ["/api/state"] = State(Idle, "{\"state\":\"ready\",\"version\":\"3.11.0\",\"bytes\":5}"), ["/api/studio/coding"] = CodingIdle });
        kit.Check(ready.BlockingWork == null && ready.OfferedVersion == "3.11.0", "an idle Hub with an update ready: nothing blocks, and the version on offer is the one the Hub says is ready");
        kit.Check(Ask(new() { ["/api/state"] = State(Idle, "{\"state\":\"downloading\",\"version\":\"3.11.0\",\"received\":1,\"total\":5}"), ["/api/studio/coding"] = CodingIdle }).OfferedVersion == null, "a download that is still running is nothing on offer");
        kit.Check(Ask(new() { ["/api/state"] = State(Idle, "{\"state\":\"failed\",\"version\":\"3.11.0\",\"code\":\"update_download_hash\"}"), ["/api/studio/coding"] = CodingIdle }).OfferedVersion == null, "nor is a failed one");
        kit.Check(Ask(new() { ["/api/state"] = State(Idle), ["/api/studio/coding"] = CodingIdle }).OfferedVersion == null, "nor is a state with no download in it");
        kit.Check(Ask(new() { ["/api/state"] = State(Idle, "{\"state\":\"ready\",\"version\":7}"), ["/api/studio/coding"] = CodingIdle }).OfferedVersion == null, "nor a version that is not text");
        var busy = Ask(new() { ["/api/state"] = State("{\"activeTaskId\":\"t1\"}", "{\"state\":\"ready\",\"version\":\"3.11.0\"}"), ["/api/studio/coding"] = CodingIdle });
        kit.Check(busy.BlockingWork == "Stop active DatGold tasks before installing or uninstalling. Nothing was cancelled." && busy.OfferedVersion == "3.11.0", "a running task blocks, in the installer's words");
        var worker = Ask(new() { ["/api/state"] = State(Idle, null, "{\"terminals\":[{\"running\":true}]}"), ["/api/studio/coding"] = CodingIdle });
        kit.Check(worker.BlockingWork == "Stop DatGold terminals and background workers before upgrading.", "so does a running terminal");
        var coding = Ask(new() { ["/api/state"] = State(Idle), ["/api/studio/coding"] = "{\"activeRunId\":\"r1\",\"jobs\":[]}" });
        kit.Check(coding.BlockingWork == "Stop background coding jobs before upgrading.", "and a coding run, which the state does not show: the second request is made");
        using (var hub = new FakeHub(secret, new() { ["/api/state"] = State("{\"activeTaskId\":\"t1\"}"), ["/api/studio/coding"] = CodingIdle }))
        {
            using var client = HubLifecycle.Client();
            HubLifecycle.PreflightForUpdate(client, hub.Origin, secret).GetAwaiter().GetResult();
            kit.Check(hub.Requests.SequenceEqual(new[] { "/api/state (bearer)" }), "when the state already shows work the coding answer is not asked for; every request carries the session secret");
        }
        using (var hub = new FakeHub(secret, new() { ["/api/state"] = State(Idle), ["/api/studio/coding"] = CodingIdle }))
        {
            using var client = HubLifecycle.Client();
            HubLifecycle.PreflightForUpdate(client, hub.Origin, secret).GetAwaiter().GetResult();
            kit.Check(hub.Requests.SequenceEqual(new[] { "/api/state (bearer)", "/api/studio/coding (bearer)" }), "an idle Hub is asked exactly these two things, with the bearer, and nothing else");
        }
        bool Throws(Func<UpdatePreflight> ask) { try { ask(); return false; } catch (Exception) { return true; } }
        kit.Check(Throws(() => Ask(new() { ["/api/state"] = State(Idle), ["/api/studio/coding"] = CodingIdle }, withSecret: "not-the-secret")), "a Hub that answers 401 is not idle, it is unreachable: the question fails and the shell stays open");
        kit.Check(Throws(() => Ask(new() { ["/api/state"] = State(Idle) })), "and so is one that has no coding route");
        kit.Check(Throws(() => Ask(new() { ["/api/state"] = "this is not json", ["/api/studio/coding"] = CodingIdle })), "and one that answers with something that is not JSON");
        kit.Check(Ask(new() { ["/api/state"] = "{\"csrfToken\":\"x\"}", ["/api/studio/coding"] = CodingIdle }).BlockingWork != null, "a state with no agent is work: the Hub is not fully loaded");
    }

    // ---------------------------------------------------------------------------------------------------------------------------------------------------- the sequence
    private sealed class Owner : IDisposable
    {
        internal readonly ECDsa Key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        internal string Kid => ReleaseKeys.IdOf(Key.ExportSubjectPublicKeyInfo());
        internal ReleaseKeys Keys => ReleaseKeys.Parse(JsonSerializer.Serialize(new { version = 1, keys = new[] { new { kid = Kid, use = "release", spki = Convert.ToBase64String(Key.ExportSubjectPublicKeyInfo()) } } }));
        internal byte[] SignatureFile(byte[] manifest) => Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { alg = "ES256", kid = Kid, sig = Convert.ToBase64String(Key.SignData(manifest, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) }));
        public void Dispose() => Key.Dispose();
    }

    private static void Applier(TestKit kit)
    {
        using var owner = new Owner();
        var installer = Encoding.UTF8.GetBytes("MZ pretend installer " + new string('y', 3000));
        string MakeState(string name, string version = "3.11.0", bool write = true)
        {
            var state = kit.Folder(name);
            if (!write) return state;
            var folder = Path.Combine(state, "updates", version); Directory.CreateDirectory(folder);
            var manifest = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { version, commit = new string('0', 40), assets = new[] { new { name = "DatGoldSetup.exe", bytes = installer.Length, sha256 = Convert.ToHexString(SHA256.HashData(installer)).ToLowerInvariant() } } }));
            File.WriteAllBytes(Path.Combine(folder, UpdateStaging.ManifestName), manifest);
            File.WriteAllBytes(Path.Combine(folder, UpdateStaging.SignatureName), owner.SignatureFile(manifest));
            File.WriteAllBytes(Path.Combine(folder, "DatGoldSetup.exe"), installer);
            return state;
        }
        var app = kit.Folder("applier app");

        // what the pretend shell saw, in order
        ApplyEnvironment Shell(string state, List<string> events, Func<UpdatePreflight>? preflight = null, Func<ProcessStartInfo, int>? start = null, bool installed = true, List<UpdatePreflight>? answers = null) => new()
        {
            InstalledDirectory = app, StateDirectory = state, ShellPid = 4242, Running = Running, Keys = owner.Keys,
            IsInstalledCopy = directory => { events.Add("installed-copy?"); return installed; },
            Preflight = () => { events.Add("preflight"); if (answers != null && answers.Count > 0) { var next = answers[0]; answers.RemoveAt(0); return Task.FromResult(next); } return Task.FromResult((preflight ?? (() => new UpdatePreflight(null, "3.11.0")))()); },
            Verify = (root, running, keys) => { events.Add("verify"); return UpdateStaging.Verify(root, running, keys, _ => new InstallerIdentity(Product, Product, "3.11.0"), Product, Product); },
            Start = info => { events.Add("start"); return (start ?? (_ => 777))(info); },
        };
        string? CodeOf(Func<Task<int>> action) { try { action().GetAwaiter().GetResult(); return null; } catch (UpdateRefused refused) { return refused.Code; } }

        // A junction (a link to a folder, which needs no privilege): the Hub's data folder can be reached through one, and then the path the shell walks and the real place of the file part ways.
        var junctions = new List<string>();
        string Junction(string target)
        {
            var link = Path.Combine(kit.Scratch, "applier-link-" + Guid.NewGuid().ToString("N")[..8]);
            var make = new ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            make.ArgumentList.Add("/c"); make.ArgumentList.Add("mklink"); make.ArgumentList.Add("/J"); make.ArgumentList.Add(link); make.ArgumentList.Add(target);
            using var process = Process.Start(make)!; process.StandardOutput.ReadToEnd(); process.StandardError.ReadToEnd(); process.WaitForExit();
            if (process.ExitCode != 0) throw new IOException("mklink /J failed");
            junctions.Add(link);
            return link;
        }

        // ---- the one way through, with the Hub's data folder reached through a link
        try
        {
            var state = Junction(MakeState("applier ok")); var events = new List<string>();
            ProcessStartInfo? seen = null; bool heldAtStart = false, writeFailedAtStart = false, deleteFailedAtStart = false;
            var installerPath = Path.Combine(state, "updates", "3.11.0", "DatGoldSetup.exe");
            var pid = UpdateApplier.ApplyAsync(Shell(state, events, start: info =>
            {
                seen = info;
                try { File.WriteAllBytes(installerPath, installer); } catch (Exception) { writeFailedAtStart = true; }
                try { File.Delete(installerPath); } catch (Exception) { deleteFailedAtStart = true; }
                heldAtStart = writeFailedAtStart && deleteFailedAtStart;
                return 777;
            }), () => events.Add("before-start")).GetAwaiter().GetResult();
            kit.Check(pid == 777, "the answer is the pid of the installer that was started");
            kit.Check(string.Join(",", events) == "installed-copy?,preflight,verify,preflight,before-start,start", "the sequence: is this an installed copy, are tasks running, verify, are tasks running NOW, stop the monitor, start (got " + string.Join(",", events) + ")");
            kit.Check(heldAtStart, "at the moment the installer is started it can be neither written nor deleted: the shell holds it until Process.Start has returned");
            string Final(string file) { using var open = File.OpenHandle(file, FileMode.Open, FileAccess.Read, FileShare.Read); return UpdateStaging.FinalPathOf(open); }
            kit.Check(seen != null && seen.FileName == Final(installerPath) && seen.WorkingDirectory == Path.GetDirectoryName(Final(installerPath)) && !seen.UseShellExecute, "it is started from the real place of the file that was verified (its final path), in its own folder, without the shell");
            kit.Check(!seen!.FileName.StartsWith(state, StringComparison.OrdinalIgnoreCase) && !seen.WorkingDirectory.StartsWith(state, StringComparison.OrdinalIgnoreCase), "and that place does not go through the link the file was found by");
            kit.Check(seen!.ArgumentList.SequenceEqual(UpdateArguments.Build(app, 4242, Path.Combine(state, "update-result.json"))), "with exactly the arguments of the contract, the result in the state folder, and the pid of this shell");
            kit.Check(File.Exists(installerPath), "(the installer is still there: only a refused write and delete were tried)");
            File.WriteAllBytes(installerPath, installer); // released by now, so this works
            kit.Check(true, "and the file is free again once the program has started");
        }
        finally { foreach (var link in junctions) try { Directory.Delete(link); } catch (Exception) { /* already gone */ } junctions.Clear(); }

        // ---- every way it stops, and what was not done
        void Stops(string label, string code, Func<(string State, ApplyEnvironment Environment, List<string> Events)> arrange, bool beforeStartIsCalled = false)
        {
            var (state, environment, events) = arrange();
            var started = false; var before = false;
            environment.Start = info => { started = true; return 1; };
            var got = CodeOf(() => UpdateApplier.ApplyAsync(environment, () => before = true));
            kit.Check(got == code, label + ": " + code + " (got " + got + ")");
            kit.Check(!started && before == beforeStartIsCalled, label + (beforeStartIsCalled ? ": the monitor was stopped, nothing was started" : ": nothing was started and the monitor was not touched"));
        }
        Stops("a copy that was not installed (a build from a work tree)", "not_installed", () => { var s = MakeState("not installed"); var e = new List<string>(); return (s, Shell(s, e, installed: false), e); });
        Stops("running tasks", "tasks_running", () => { var s = MakeState("tasks"); var e = new List<string>(); return (s, Shell(s, e, preflight: () => new UpdatePreflight("Stop active DatGold tasks before installing or uninstalling. Nothing was cancelled.", "3.11.0")), e); });
        Stops("a Hub that cannot be asked", "hub_unreachable", () => { var s = MakeState("unreachable"); var e = new List<string>(); return (s, Shell(s, e, preflight: () => throw new HttpRequestException("refused")), e); });
        Stops("nothing on offer by the Hub", "stale", () => { var s = MakeState("nothing offered"); var e = new List<string>(); return (s, Shell(s, e, preflight: () => new UpdatePreflight(null, null)), e); });
        Stops("another version on offer than the folder holds", "stale", () => { var s = MakeState("another offered"); var e = new List<string>(); return (s, Shell(s, e, preflight: () => new UpdatePreflight(null, "3.12.0")), e); });
        Stops("no update downloaded", "no_update", () => { var s = MakeState("empty state", write: false); var e = new List<string>(); return (s, Shell(s, e), e); });
        Stops("tasks that start while the file is being checked", "tasks_running", () =>
        {
            var s = MakeState("tasks start meanwhile"); var e = new List<string>();
            return (s, Shell(s, e, answers: new List<UpdatePreflight> { new(null, "3.11.0"), new("Stop active DatGold tasks before installing or uninstalling. Nothing was cancelled.", "3.11.0") }), e);
        });
        {
            var s = MakeState("a bad signature"); var path = Path.Combine(s, "updates", "3.11.0", UpdateStaging.SignatureName);
            File.WriteAllBytes(path, new byte[] { 1 }); var e = new List<string>();
            var started = false; var environment = Shell(s, e); environment.Start = info => { started = true; return 1; };
            kit.Check(CodeOf(() => UpdateApplier.ApplyAsync(environment, () => { })) == "bad_signature" && !started, "a release whose signature does not check is refused with its own code, and nothing is started");
        }
        {
            var s = MakeState("start fails"); var e = new List<string>();
            var installerPath = Path.Combine(s, "updates", "3.11.0", "DatGoldSetup.exe");
            var environment = Shell(s, e, start: info => throw new System.ComponentModel.Win32Exception(5, "Access is denied"));
            var got = CodeOf(() => UpdateApplier.ApplyAsync(environment, () => e.Add("before-start")));
            kit.Check(got == "launch_failed" && e.Contains("before-start"), "an installer that cannot be started is launch_failed (the monitor was stopped before, and the window restarts it)");
            File.WriteAllBytes(installerPath, installer);
            kit.Check(true, "and the file is released: a failed start holds nothing");
        }
        {
            var s = MakeState("verify always for each call"); var e = new List<string>();
            var environment = Shell(s, e);
            UpdateApplier.ApplyAsync(environment, () => { }).GetAwaiter().GetResult();
            e.Clear();
            UpdateApplier.ApplyAsync(environment, () => { }).GetAwaiter().GetResult();
            kit.Check(e.Count(item => item == "verify") == 1, "a second click verifies again: nothing is remembered from the first");
        }

        // ---- the installer reads the arguments the shell gives it (InstallerCommandLine) and exits AT ONCE when it cannot, after this window has gone and with nothing on the screen: so the shell reads them the way
        // the installer will, before anything is stopped or started. A result file that is not on a drive (a state folder under a device path or a share) or a folder that is not a full path is such a case.
        void CannotBeRead(string label, Action<ApplyEnvironment> bend)
        {
            var s = MakeState("unreadable " + Guid.NewGuid().ToString("N")[..6]); var e = new List<string>();
            var environment = Shell(s, e); bend(environment);
            var started = false; var before = false; environment.Start = info => { started = true; return 1; };
            var got = CodeOf(() => UpdateApplier.ApplyAsync(environment, () => before = true));
            kit.Check(got == "launch_failed" && !started && !before, label + ": launch_failed, the monitor was not stopped and nothing was started (got " + (got ?? "no refusal") + ")");
        }
        CannotBeRead("a result file the installer would refuse (the state folder is under a device path)", environment => environment.StateDirectory = @"\\?\" + environment.StateDirectory);
        CannotBeRead("an installation folder that is not a full path", environment => environment.InstalledDirectory = @"app\relative");
        {
            // the name of the file that is started is part of what the installer reads (a name with "uninstall" in it makes it an uninstaller): the check uses the real name
            var s = MakeState("named like an uninstaller", write: false); var folder = Path.Combine(s, "updates", "3.11.0"); Directory.CreateDirectory(folder);
            var manifest = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { version = "3.11.0", commit = new string('0', 40), assets = new[] { new { name = "Uninstall-DatGold.exe", bytes = installer.Length, sha256 = Convert.ToHexString(SHA256.HashData(installer)).ToLowerInvariant() } } }));
            File.WriteAllBytes(Path.Combine(folder, UpdateStaging.ManifestName), manifest); File.WriteAllBytes(Path.Combine(folder, UpdateStaging.SignatureName), owner.SignatureFile(manifest)); File.WriteAllBytes(Path.Combine(folder, "Uninstall-DatGold.exe"), installer);
            var e = new List<string>(); var started = false;
            var environment = Shell(s, e); environment.Start = info => { started = true; return 1; };
            kit.Check(CodeOf(() => UpdateApplier.ApplyAsync(environment, () => { })) == "launch_failed" && !started, "an installer whose file name makes it read its arguments as an uninstall is not started: launch_failed (the check uses the name of the file, not a name of its own)");
        }

        // ---- the installer is started off the thread that draws the window: Process.Start of a file of 230 MB can wait for a virus scan, and the window must keep answering. A thread with its own queue stands in for the one
        // that draws the window (a continuation of an await goes back to it); where Start runs is read from the context it sees there.
        {
            var s = MakeState("start off the ui thread"); var e = new List<string>();
            var contexts = new List<SynchronizationContext?>();
            var environment = Shell(s, e, start: info => { contexts.Add(SynchronizationContext.Current); return 777; });
            var pid = OnWindowThread(() => UpdateApplier.ApplyAsync(environment, () => { }));
            kit.Check(pid == 777 && contexts.Count == 1 && contexts[0] == null, "the installer is started on a thread of the pool, not on the thread of the window (the context it saw: " + (contexts.Count == 1 && contexts[0] != null ? "the window's" : "none") + ")");
            kit.Check(OnWindowThread(() => Task.FromResult(SynchronizationContext.Current != null)), "premise: what the thread of the window runs from an await goes back to the window's context");
            var held = MakeState("start off the ui thread, held"); var heldEvents = new List<string>();
            var installerFile = Path.Combine(held, "updates", "3.11.0", "DatGoldSetup.exe"); var heldAtStart = false;
            var heldEnvironment = Shell(held, heldEvents, start: info => { try { File.Delete(installerFile); } catch (Exception) { heldAtStart = true; } return 5; });
            OnWindowThread(() => UpdateApplier.ApplyAsync(heldEnvironment, () => { }));
            kit.Check(heldAtStart, "and the file is still held while it starts there");
        }

        // ---- the installer is given a few seconds to put its window on the screen; one that has ended by then did not start well, and the window that started it stays
        {
            var delays = new List<TimeSpan>();
            Task Delay(TimeSpan time) { delays.Add(time); return Task.CompletedTask; }
            InstallerSighting Wait(Func<InstallerSighting?> look) { delays.Clear(); return UpdateApplier.WaitForInstaller(look, TimeSpan.FromSeconds(5), TimeSpan.FromMilliseconds(100), Delay).GetAwaiter().GetResult(); }
            var sightings = new Queue<InstallerSighting?>(new InstallerSighting?[] { null, null, InstallerSighting.Window });
            kit.Check(Wait(() => sightings.Dequeue()) == InstallerSighting.Window && delays.Count == 2 && delays.All(time => time == TimeSpan.FromMilliseconds(100)), "an installer that shows its window after two looks is seen with it, after waiting 100 ms twice");
            kit.Check(Wait(() => InstallerSighting.Exited) == InstallerSighting.Exited && delays.Count == 0, "one that has already ended is reported at once: nothing was replaced, the shell stays open and says so");
            var gone = new Queue<InstallerSighting?>(new InstallerSighting?[] { null, InstallerSighting.Exited });
            kit.Check(Wait(() => gone.Dequeue()) == InstallerSighting.Exited && delays.Count == 1, "one that ends while it is waited for is reported as ended");
            var looks = 0;
            kit.Check(Wait(() => { looks++; return null; }) == InstallerSighting.Silent && delays.Count == 50 && looks == 51, "one that shows nothing for the whole time is Silent after 5 seconds (50 waits of 100 ms and a last look): the window closes as it did before");
            var late = 0;
            kit.Check(Wait(() => ++late == 51 ? InstallerSighting.Window : null) == InstallerSighting.Window, "and one whose window comes in the last 100 ms is seen with it by the last look");
        }
    }

    /// <summary>Runs <paramref name="start"/> on a thread with its own queue and its own SynchronizationContext, the way the window's thread has one, and pumps that queue until the task is done.</summary>
    private static T OnWindowThread<T>(Func<Task<T>> start)
    {
        T result = default!; Exception? failure = null;
        var thread = new Thread(() =>
        {
            var queue = new System.Collections.Concurrent.BlockingCollection<(SendOrPostCallback Run, object? State)>();
            SynchronizationContext.SetSynchronizationContext(new QueueContext(queue));
            var task = start();
            while (!task.IsCompleted) if (queue.TryTake(out var item, 20)) item.Run(item.State);
            try { result = task.GetAwaiter().GetResult(); } catch (Exception error) { failure = error; }
        });
        thread.Start(); thread.Join();
        if (failure != null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
        return result;
    }

    private sealed class QueueContext : SynchronizationContext
    {
        private readonly System.Collections.Concurrent.BlockingCollection<(SendOrPostCallback Run, object? State)> queue;
        internal QueueContext(System.Collections.Concurrent.BlockingCollection<(SendOrPostCallback Run, object? State)> queue) { this.queue = queue; }
        public override void Post(SendOrPostCallback d, object? state) => queue.Add((d, state));
    }
}
