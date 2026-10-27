using System.Diagnostics;
using System.Text.Json;
using ChatMCP.Native;

// The Hub ownership query. Before the installer stops the program that listens on port 3007 it asks Windows PowerShell (WMI) for that program's command line, and it takes the program for the installed Hub only
// when the answer names the installed hub.mjs. One try took more than ten seconds once on a hosted runner (run 40364322519: the same commit answered in 4.5 s on another machine) and the setup refused with
// "Hub ownership query timed out". So a try gets longer and there is a second one; an answer that never comes is an error and never an owner. The tries are real programs: a copy of ping.exe under a name of its
// own that does not answer within the limit, and cmd.exe printing a file. The paths that have to finish get a limit of seconds, so that how fast a program starts on a slow machine cannot fail them.
internal static class OwnerQueryTests
{
    internal static void Run(TestKit kit)
    {
        var cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        var folder = kit.Folder("owner query");
        var pingName = "owner-query-" + Guid.NewGuid().ToString("N")[..8];
        var ping = Path.Combine(folder, pingName + ".exe");
        File.Copy(Path.Combine(Environment.SystemDirectory, "ping.exe"), ping);
        Exception? Caught(Action action) { try { action(); return null; } catch (Exception error) { return error; } }
        string Said(Exception? error) => error == null ? "no error" : error.GetType().Name + ": " + error.Message;

        ProcessStartInfo Plain(string program, params string[] arguments)
        {
            var start = new ProcessStartInfo(program) { UseShellExecute = false, CreateNoWindow = true };
            foreach (var argument in arguments) start.ArgumentList.Add(argument);
            return start;
        }
        ProcessStartInfo Hangs() => Plain(cmd, "/c", ping, "-n", "30", "127.0.0.1"); // cmd, with a ping of half a minute as its child: the probe never answers in time, and ending it means ending its child too
        ProcessStartInfo Exits(int code) => Plain(cmd, "/c", "exit", code.ToString());
        ProcessStartInfo Prints(string text)
        {
            var file = Path.Combine(folder, Guid.NewGuid().ToString("N")[..8] + ".txt");
            File.WriteAllText(file, text);
            return Plain(cmd, "/c", "type", file);
        }
        ProcessStartInfo PrintsThenFails(string text, int code) // prints the file, then ends with an error: cmd runs both halves of the line
        {
            var start = Prints(text);
            start.ArgumentList.Add("&"); start.ArgumentList.Add("exit"); start.ArgumentList.Add(code.ToString());
            return start;
        }
        ProcessStartInfo Leaves() => Plain(cmd, "/c", "start", "", "/b", ping, "-n", "20", "127.0.0.1"); // ends at once, and the ping that it started goes on holding the pipe that the answer is read from
        string Answer(string commandLine) => JsonSerializer.Serialize(commandLine); // what the real query prints: one JSON string
        bool Gone(string name)
        {
            for (var i = 0; i < 40; i++)
            {
                var left = Process.GetProcessesByName(name);
                foreach (var one in left) one.Dispose();
                if (left.Length == 0) return true;
                Thread.Sleep(50);
            }
            return false;
        }
        void Reap(string name)
        {
            foreach (var left in Process.GetProcessesByName(name)) { using (left) { try { left.Kill(true); left.WaitForExit(10000); } catch (InvalidOperationException) { /* already gone */ } } }
        }

        try
        {
            var hub = @"C:\Installed\runtimes\node\node.exe C:\Installed\CHATMCP-HUB\hub.mjs --port 3007";

            // ---- the defaults of the real query
            kit.Check(HubLifecycle.OwnerQueryLimit >= TimeSpan.FromSeconds(20) && HubLifecycle.OwnerQueryLimit <= TimeSpan.FromSeconds(60),
                "a try of the real query gets between 20 and 60 seconds, not the ten that ran out once (" + HubLifecycle.OwnerQueryLimit.TotalSeconds + " s)");
            kit.Check(HubLifecycle.OwnerQueryAttempts >= 2 && HubLifecycle.OwnerQueryAttempts <= 3 && HubLifecycle.OwnerQueryLimit * HubLifecycle.OwnerQueryAttempts <= TimeSpan.FromMinutes(2),
                "and there is a second try, and the worst case is bounded (" + HubLifecycle.OwnerQueryAttempts + " tries)");

            // ---- an answer
            var tries = 0;
            string? text = null;
            var error = Caught(() => text = HubLifecycle.AskForCommandLine(attempt => { tries++; return Prints(Answer(hub)); }, TimeSpan.FromSeconds(30), 2));
            kit.Check(error == null && text == hub, "a program that prints the command line gives it back unchanged (" + Said(error) + ")");
            kit.Check(tries == 1, "and an answer is not asked for twice (" + tries + " tries)");
            tries = 0; text = null;
            error = Caught(() => text = HubLifecycle.AskForCommandLine(attempt => { tries++; return Prints("null"); }, TimeSpan.FromSeconds(30), 2));
            kit.Check(error == null && text == "" && tries == 1, "a JSON null is an answer, and an empty one: nobody's command line (the real query prints nothing for a program that has gone, which is a try that says nothing readable: the case below) (" + Said(error) + ", " + tries + " tries)");
            kit.Check(!HubLifecycle.IsHubCommand("", hub.Split(' ')[1]) && !HubLifecycle.IsHubCommand("   ", hub.Split(' ')[1]), "and an empty command line is not the installed Hub's");

            // ---- a try that does not answer in time
            tries = 0; text = null;
            var clock = Stopwatch.StartNew();
            error = Caught(() => text = HubLifecycle.AskForCommandLine(attempt => { tries++; return attempt == 0 ? Hangs() : Prints(Answer(hub)); }, TimeSpan.FromSeconds(3), 2));
            clock.Stop();
            kit.Check(error == null && text == hub, "a try that does not answer in time is followed by a second, and the second one's answer is the answer (" + Said(error) + ")");
            kit.Check(tries == 2 && clock.ElapsedMilliseconds >= 2900 && clock.ElapsedMilliseconds < 20000, "after the whole limit of the first, and not after more than it (" + tries + " tries, " + clock.ElapsedMilliseconds + " ms)");
            kit.Check(Gone(pingName), "and the try that was given up on is ended, not left running");

            // ---- a try that fails or says nothing readable
            tries = 0; text = null;
            error = Caught(() => text = HubLifecycle.AskForCommandLine(attempt => { tries++; return attempt == 0 ? Exits(1) : Prints(Answer(hub)); }, TimeSpan.FromSeconds(30), 2));
            kit.Check(error == null && text == hub && tries == 2, "a try that ends with an error is followed by a second (" + Said(error) + ", " + tries + " tries)");
            foreach (var (what, unreadable) in new[] { ("not JSON", "this is not json"), ("a JSON value that is not a string", "42"), ("nothing at all", "") })
            {
                tries = 0; text = null;
                error = Caught(() => text = HubLifecycle.AskForCommandLine(attempt => { tries++; return attempt == 0 ? Prints(unreadable) : Prints(Answer(hub)); }, TimeSpan.FromSeconds(30), 2));
                kit.Check(error == null && text == hub && tries == 2, "a try that prints " + what + " is followed by a second (" + Said(error) + ", " + tries + " tries)");
            }

            // ---- no answer at all is an error, and is never an owner
            tries = 0; text = null;
            clock.Restart();
            error = Caught(() => text = HubLifecycle.AskForCommandLine(attempt => { tries++; return Hangs(); }, TimeSpan.FromMilliseconds(1000), 2));
            clock.Stop();
            kit.Check(error is IOException && StepCode.Of(error) == "hub_stop_failed" && text == null && error.Message.Contains("timed out"), "two tries that do not answer end in hub_stop_failed and give no text, so no program is taken for the Hub (" + Said(error) + ")");
            kit.Check(tries == 2 && clock.ElapsedMilliseconds >= 1900 && clock.ElapsedMilliseconds < 20000, "after both tries had their whole limit, and the wait was bounded (" + tries + " tries, " + clock.ElapsedMilliseconds + " ms)");
            kit.Check(Gone(pingName), "and neither is left running");
            tries = 0;
            error = Caught(() => text = HubLifecycle.AskForCommandLine(attempt => { tries++; return Exits(3); }, TimeSpan.FromSeconds(30), 2));
            kit.Check(error is IOException && StepCode.Of(error) == "hub_stop_failed" && text == null && tries == 2 && error.Message.Contains("failed"), "two tries that end with an error end in hub_stop_failed (" + Said(error) + ", " + tries + " tries)");
            tries = 0;
            error = Caught(() => text = HubLifecycle.AskForCommandLine(attempt => { tries++; return Prints("this is not json"); }, TimeSpan.FromSeconds(30), 2));
            kit.Check(error is IOException && StepCode.Of(error) == "hub_stop_failed" && text == null && tries == 2, "and so do two tries that print nothing readable (" + Said(error) + ", " + tries + " tries)");
            tries = 0;
            error = Caught(() => text = HubLifecycle.AskForCommandLine(attempt => { tries++; return PrintsThenFails(Answer(hub), 1); }, TimeSpan.FromSeconds(30), 2));
            kit.Check(error is IOException && StepCode.Of(error) == "hub_stop_failed" && text == null && tries == 2 && error.Message.Contains("failed"), "and a try that ends with an error is not believed even when it printed a good answer (" + Said(error) + ", " + tries + " tries)");
            tries = 0;
            error = Caught(() => text = HubLifecycle.AskForCommandLine(attempt => { tries++; return Hangs(); }, TimeSpan.FromMilliseconds(1000), 1));
            kit.Check(error is IOException && StepCode.Of(error) == "hub_stop_failed" && tries == 1, "the number of tries is the number asked for: one try is not repeated (" + Said(error) + ", " + tries + " tries)");
            kit.Check(Gone(pingName), "and it is not left running either");

            // ---- every wait is bounded: a program that the probe started can hold the pipe open after the probe has ended
            tries = 0;
            clock.Restart();
            error = Caught(() => text = HubLifecycle.AskForCommandLine(attempt => { tries++; return Leaves(); }, TimeSpan.FromMilliseconds(500), 1));
            clock.Stop();
            Reap(pingName); // the ping that the probe left (twenty seconds long) is not this test's business after the check
            kit.Check(error is IOException && StepCode.Of(error) == "hub_stop_failed" && text == null && error.Message.Contains("timed out"), "a pipe that a program of the probe holds open ends the try at the limit, as no answer (" + Said(error) + ")");
            kit.Check(clock.ElapsedMilliseconds < 10000, "and the wait for it was bounded, not the twenty seconds that the program holds it (" + clock.ElapsedMilliseconds + " ms)");

            // ---- the real query, against a program of this test
            using var target = Process.Start(Plain(ping, "-n", "60", "127.0.0.1"))!;
            try
            {
                var found = "";
                error = Caught(() => found = HubLifecycle.CommandLineOf(target.Id));
                kit.Check(error == null && found.Contains(pingName, StringComparison.OrdinalIgnoreCase) && found.Contains("127.0.0.1"), "the real query gives the command line of a program that is running (" + Said(error) + ": " + found + ")");
                kit.Check(!HubLifecycle.IsHubCommand(found, Path.Combine(folder, "CHATMCP-HUB", "hub.mjs")), "and that program is not taken for the installed Hub");
            }
            finally { try { if (!target.HasExited) target.Kill(true); target.WaitForExit(10000); } catch (InvalidOperationException) { /* already gone */ } }

            // ---- the letters that the console's code page cannot hold: Windows PowerShell writes a redirected answer in the OEM code page and turned every one of them into "?", so a program under a Windows profile
            // named with such letters (a Vietnamese one, say) was never taken for the installed Hub, and the installer, the uninstaller and the updater refused with foreign_listener
            var accented = Path.Combine(folder, "thử-nghiệm-Đạt-ã-😀"); // a Latin-1 letter that the code page 437 lacks (the mutation that escapes only above 0xFF), and a letter of two UTF-16 units (each is escaped alone and the reader joins them)
            Directory.CreateDirectory(accented);
            var accentedPing = Path.Combine(accented, "ping-đạt-" + Guid.NewGuid().ToString("N")[..8] + ".exe");
            File.Copy(Path.Combine(Environment.SystemDirectory, "ping.exe"), accentedPing);
            using var accentedTarget = Process.Start(Plain(accentedPing, "-n", "60", "127.0.0.1"))!;
            try
            {
                var found = "";
                error = Caught(() => found = HubLifecycle.CommandLineOf(accentedTarget.Id));
                kit.Check(error == null && found.Contains(accentedPing, StringComparison.OrdinalIgnoreCase), "the real query gives the letters of a path unchanged, not as question marks (" + Said(error) + ": " + found + ")");
            }
            finally { try { if (!accentedTarget.HasExited) accentedTarget.Kill(true); accentedTarget.WaitForExit(10000); } catch (InvalidOperationException) { /* already gone */ } }

            // the consequence itself, with the shape of the installed Hub: a node.exe that runs a hub.mjs, both under a folder with such letters
            var node = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Select(directory => { try { return Path.Combine(directory.Trim('"'), "node.exe"); } catch (ArgumentException) { return ""; } }).FirstOrDefault(File.Exists);
            if (node == null) kit.Check(Environment.GetEnvironmentVariable("CI") == null, "node.exe is on the PATH (it is not here, which a hosted runner must not allow): the stand-in Hub is not started");
            else
            {
                var installation = Path.Combine(accented, "install");
                Directory.CreateDirectory(Path.Combine(installation, "runtimes", "node")); Directory.CreateDirectory(Path.Combine(installation, "CHATMCP-HUB"));
                var standIn = Path.Combine(installation, "runtimes", "node", "node.exe");
                File.Copy(node, standIn);
                var script = Path.Combine(installation, "CHATMCP-HUB", "hub.mjs");
                File.WriteAllText(script, "setInterval(() => {}, 1000);\n");
                using var hubLike = Process.Start(Plain(standIn, script, "--port", "3007"))!; // the port is only an argument: nothing listens
                try
                {
                    var found = "";
                    error = Caught(() => found = HubLifecycle.CommandLineOf(hubLike.Id));
                    kit.Check(error == null && HubLifecycle.IsHubCommand(found, script), "a node.exe that runs the hub.mjs of an installation under such a folder is taken for the installed Hub (" + Said(error) + ": " + found + ")");
                    kit.Check(!HubLifecycle.IsHubCommand(found, Path.Combine(folder, "other", "CHATMCP-HUB", "hub.mjs")), "and not for the hub.mjs of another installation");
                }
                finally { try { if (!hubLike.HasExited) hubLike.Kill(true); hubLike.WaitForExit(10000); } catch (InvalidOperationException) { /* already gone */ } }
            }
        }
        finally { Reap(pingName); }
    }
}
