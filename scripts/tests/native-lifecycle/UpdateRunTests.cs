using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using ChatMCP.Installer;
using ChatMCP.Native;

// What the installer does when the shell starts it in update mode (UpdateRun): wait for the shell to go, refuse an installation that is not older, check the room, install with the shortcuts the
// installation had, say how it ended in a result file BEFORE it opens the app again, and open the right app: the new one after an update, the old one after a refusal or a clean rollback, none
// while the installation needs recovery. Every outside thing is a function handed in, so each path is run here with the outcome it is built for; nothing touches the registry, a state folder or the
// installation of the person who runs the tests.
internal static class UpdateRunTests
{
    private const string Dir = @"C:\Users\Test User\AppData\Local\Programs\ChatMCP";
    private const string Result = @"C:\Users\Test User\AppData\Local\ChatMCP\hub\update-result.json";
    private static ReleaseVersion V(string text) => ReleaseVersion.TryParse(text, out var version) ? version : throw new ArgumentException(text);

    /// <summary>A pretend machine: what it holds, what it is asked, and what happened, in order.</summary>
    private sealed class Machine
    {
        internal readonly List<string> Events = new();
        internal string Target = "3.11.0";
        internal string? Installed = "3.10.2";
        internal long? Free = 50L * 1024 * 1024 * 1024;
        internal long Payload = 700L * 1024 * 1024;
        internal bool ShellGone = true;
        internal bool Marker;
        internal bool WriteWorks = true;
        internal bool WriteThrows, MarkerThrows, DetectThrows;
        /// <summary>Whether a program listens on the port of the Hub when the result is about to be left, and whether asking fails.</summary>
        internal bool HubRunning, HubCheckThrows;
        internal ShortcutPlan Shortcuts = new(true, true, false);
        internal Action<ShortcutPlan, Action<int, string>>? Install;
        internal Action? OnRelaunch;
        internal int? WaitedPid; internal string? WaitedImage; internal TimeSpan? WaitedLimit; internal ShortcutPlan? InstalledWith; internal bool InstalledThrows;
        internal UpdateOutcome? Written; internal string? WrittenTo; internal string? Relaunched;
        internal List<string> Progress = new();

        internal UpdateEnvironment Environment() => new()
        {
            Target = V(Target),
            InstalledVersion = dir => { Events.Add("installed-version"); if (InstalledThrows) throw new IOException("locked"); return Installed == null ? null : V(Installed); },
            FreeBytes = dir => { Events.Add("free-bytes"); return Free; },
            PayloadBytes = () => Payload,
            WaitForShellExit = (pid, image, limit) => { Events.Add("wait"); WaitedPid = pid; WaitedImage = image; WaitedLimit = limit; return ShellGone; },
            DetectShortcuts = dir => { Events.Add("detect-shortcuts"); if (DetectThrows) throw new IOException("no shell"); return Shortcuts; },
            Install = (dir, plan, progress) => { Events.Add("install"); InstalledWith = plan; Install?.Invoke(plan, progress); },
            PendingMarkerExists = dir => MarkerThrows ? throw new IOException("locked") : Marker,
            Relaunch = exe => { Events.Add("relaunch"); Relaunched = exe; OnRelaunch?.Invoke(); },
            WriteResult = (path, outcome) => { Events.Add("write-result"); if (WriteThrows) throw new IOException("disk"); Written = outcome; WrittenTo = path; return WriteWorks; },
            HubIsRunning = () => { Events.Add("hub-running"); if (HubCheckThrows) throw new IOException("table"); return HubRunning; },
        };

        internal UpdateOutcome Run(InstallerCommand command) => UpdateRun.Run(command, Environment(), (percent, text) => Progress.Add(percent + " " + text));
        internal UpdateOutcome Run(InstallerCommand command, out bool relaunched) => UpdateRun.Run(command, Environment(), (percent, text) => Progress.Add(percent + " " + text), out relaunched);
    }

    private static InstallerCommand Command(bool wait = true, bool relaunch = true, bool result = true) =>
        new(InstallerMode.Update, Dir, wait ? 4242 : null, relaunch, result ? Result : null);

    internal static void Run(TestKit kit)
    {
        // ---- the way it goes
        var m = new Machine();
        var outcome = m.Run(Command());
        kit.Check(outcome == new UpdateOutcome(true, "3.11.0", "3.10.2", "installed", null), "an update: installed, from 3.10.2 to 3.11.0");
        kit.Check(string.Join(",", m.Events) == "installed-version,wait,free-bytes,detect-shortcuts,install,hub-running,write-result,relaunch", "the old version is read, the shell is waited for, the machine is looked at (room, shortcuts), the files are replaced, the port of the Hub is looked at, the result is written and the app is opened, in that order (got " + string.Join(",", m.Events) + ")");
        kit.Check(m.Events.IndexOf("install") < m.Events.IndexOf("write-result") && m.Events.IndexOf("write-result") < m.Events.IndexOf("relaunch"), "the result is written after the install and BEFORE the app is opened (the Hub that starts reads it)");
        kit.Check(m.WaitedPid == 4242 && m.WaitedImage == Path.Combine(Dir, "ChatMCP.exe") && m.WaitedLimit == TimeSpan.FromSeconds(30), "the wait is for the pid it was given, whose program must be the installed ChatMCP.exe, for at most 30 seconds");
        kit.Check(m.WrittenTo == Result && m.Relaunched == Path.Combine(Dir, "ChatMCP.exe"), "the result goes where the shell said, and it is the installed ChatMCP.exe that is opened");
        kit.Check(m.InstalledWith == new ShortcutPlan(true, true, false), "the engine is given the shortcuts that were found before anything was changed");
        kit.Check(m.Progress.Count > 0 && m.Progress[0].Contains("Waiting for DatGold to close", StringComparison.Ordinal), "the window is told that it is waiting for the app to close, first");

        m = new Machine(); outcome = m.Run(Command(wait: false));
        kit.Check(outcome.Ok && !m.Events.Contains("wait"), "with no pid to wait for there is no wait");
        m = new Machine(); m.Run(Command(relaunch: false));
        kit.Check(!m.Events.Contains("relaunch") && m.Events.Contains("write-result"), "without --relaunch the app is not opened");
        m = new Machine(); m.Run(Command(result: false));
        kit.Check(!m.Events.Contains("write-result") && m.Events.Contains("relaunch"), "without --result nothing is written");

        // ---- a seam that fails is no reason to fail the update, or to let it go on blind
        m = new Machine { DetectThrows = true }; outcome = m.Run(Command());
        kit.Check(outcome.Ok && m.InstalledWith == ShortcutPlan.All, "when the shortcuts cannot be looked at the update still goes through and makes all of them (a shortcut that is missing after an update looks like a broken update)");
        m = new Machine { WriteThrows = true }; outcome = m.Run(Command());
        kit.Check(outcome.Ok && m.Events.Contains("relaunch"), "a result file that throws when it is written does not fail an update that went through, and the app is still opened");
        m = new Machine { MarkerThrows = true }; outcome = m.Run(Command());
        kit.Check(!outcome.Ok && outcome.State == "needs_recovery" && outcome.Reason == "pending_recovery" && !m.Events.Contains("install") && !m.Events.Contains("relaunch"), "when the marker of an unfinished update cannot be looked for it is taken as there: nothing is installed and the app is not opened (the launcher refuses to start behind it)");

        // ---- refusals before anything is changed: the old app is intact, so it is opened again
        void Refused(string label, Action<Machine> arrange, string reason, string state = "unchanged", bool installs = false, bool relaunches = true)
        {
            var machine = new Machine(); arrange(machine);
            var result = machine.Run(Command());
            kit.Check(result == new UpdateOutcome(false, machine.Target, machine.Installed, state, reason), label + ": " + state + ", " + reason + " (got " + result.State + ", " + result.Reason + ")");
            kit.Check(machine.Events.Contains("install") == installs, label + (installs ? ": the engine ran" : ": the engine did not run, so no file was touched"));
            kit.Check(machine.Events.Contains("relaunch") == relaunches, label + (relaunches ? ": the old app is opened again" : ": no app is opened"));
            kit.Check(machine.Written == result, label + ": and the result file says the same");
        }
        Refused("the shell does not go", machine => machine.ShellGone = false, "shell_not_exited");
        Refused("no installation is there", machine => machine.Installed = null, "no_installation");
        Refused("the same version", machine => machine.Target = "3.10.2", "not_newer");
        Refused("an older version", machine => machine.Target = "3.9.0", "not_newer");
        Refused("a patch release that is older", machine => { machine.Target = "3.10.1"; }, "not_newer");
        Refused("not enough room", machine => { machine.Payload = 1000; machine.Free = 128L * 1024 * 1024 + 999; }, "disk_full");
        Refused("a retained backup from an update that did not finish", machine => machine.Marker = true, "pending_recovery", state: "needs_recovery", relaunches: false);
        {
            var machine = new Machine { Installed = "3.10.2" }; machine.Payload = 1000; machine.Free = 128L * 1024 * 1024 + 1000;
            kit.Check(machine.Run(Command()).Ok, "room for exactly what is needed is enough (the payload and 128 MiB, or a quarter of it for a big one)");
            machine = new Machine(); machine.Payload = 4L * 1024 * 1024 * 1024; machine.Free = 5L * 1024 * 1024 * 1024 - 1;
            kit.Check(machine.Run(Command()).Reason == "disk_full", "for a big payload a quarter of it is added: 4 GiB needs 5 GiB");
            machine = new Machine(); machine.Free = null;
            kit.Check(machine.Run(Command()).Ok && machine.Events.Contains("install"), "room that cannot be measured (a network drive) does not stop an update");
            machine = new Machine(); machine.Payload = 0; machine.Free = 128L * 1024 * 1024 - 1;
            kit.Check(machine.Run(Command()).Reason == "disk_full", "a payload whose size cannot be read still needs 128 MiB");
        }

        // ---- the engine fails: what is on disk decides what is said
        Exception Wrapped(Exception inner) => new IOException(inner.Message + " Installer log: x", inner); // what InstallerEngine.Install does with whatever the core throws
        void Failed(string label, Exception error, Action<Machine>? arrange, string state, string reason, bool relaunches, bool ok = false)
        {
            var machine = new Machine(); arrange?.Invoke(machine);
            machine.Install = (plan, progress) => throw error;
            var result = machine.Run(Command());
            kit.Check(result == new UpdateOutcome(ok, machine.Target, machine.Installed, state, reason == "" ? null : reason) && result.RolledBack == (state == "rolled_back"), label + ": " + state + (reason == "" ? "" : ", " + reason) + " (got " + result.State + ", " + result.Reason + ")");
            kit.Check(machine.Events.Contains("relaunch") == relaunches, label + (relaunches ? ": the app is opened" : ": no app is opened"));
            kit.Check(machine.Written == result, label + ": the result file says the same");
        }
        Failed("running tasks refuse the stop of the Hub", Wrapped(new InvalidOperationException("Stop active DatGold tasks").Tag("tasks_running")), null, "unchanged", "tasks_running", true);
        Failed("a foreign process on the port", Wrapped(new InvalidOperationException("Port 3007").Tag("foreign_listener")), null, "unchanged", "foreign_listener", true);
        Failed("the window did not close", Wrapped(new IOException("Close the installed DatGold window").Tag("window_open")), null, "unchanged", "window_open", true);
        Failed("a failure that has no code", Wrapped(new InvalidOperationException("something that holds C:\\Users\\Test User\\secret")), null, "unchanged", "install_failed", true);
        Failed("a code that is not on the list is not passed on", Wrapped(new InvalidOperationException("x").Tag("C:\\Users\\Test User\\secret")), null, "unchanged", "install_failed", true);
        Failed("an upgrade that was rolled back whole", Wrapped(new UpgradeRolledBackException("Upgrade failed; all changed application files were rolled back. x", new IOException("disk"))), null, "rolled_back", "install_failed", true);
        {
            var machine = new Machine();
            machine.Install = (plan, progress) => { machine.Marker = true; throw new IOException("Install failed", new AggregateException("Upgrade failed; keep the retained backup", new IOException("a"), new IOException("b"))); };
            var result = machine.Run(Command());
            kit.Check(result.State == "needs_recovery" && !result.RolledBack && !result.Ok && !machine.Events.Contains("relaunch"), "when the marker of an unfinished update is on disk after a failure the app is not opened (it would refuse to start) and rolledBack is false");
        }
        {
            var machine = new Machine();
            machine.Install = (plan, progress) => { machine.Installed = "3.11.0"; throw new IOException("a step after the commit"); };
            var result = machine.Run(Command());
            kit.Check(result == new UpdateOutcome(true, "3.11.0", "3.10.2", "installed", null) && machine.Events.Contains("relaunch"), "an exception after the new files were committed does not make a failed update of it: the new version is in place");
        }
        {
            var machine = new Machine(); machine.WriteWorks = false;
            var result = machine.Run(Command());
            kit.Check(result.Ok && machine.Events.Contains("relaunch"), "a result that cannot be written does not stop the app from being opened, nor change what the update was");
            machine = new Machine(); machine.OnRelaunch = () => throw new IOException("cannot start");
            kit.Check(machine.Run(Command()).Ok, "and an app that cannot be opened does not change it either");
            machine = new Machine(); machine.InstalledThrows = true;
            kit.Check(machine.Run(Command()).Reason == "no_installation" && !machine.Events.Contains("install"), "an installed version that cannot be read is no installation");
        }
        kit.Check(UpdateRun.RequiredBytes(0) == 128L * 1024 * 1024 && UpdateRun.RequiredBytes(100L * 1024 * 1024) == 228L * 1024 * 1024 && UpdateRun.RequiredBytes(1L << 30) == (1L << 30) + (1L << 28), "the room needed is the payload and 128 MiB, or a quarter of it when that is more");

        // ---- the result file is for the Hub that starts NEXT. The Hub reads the file once, when it starts, so a note left while a Hub is already up (a refusal that stopped nothing, a program on the port) would
        // sit there until some later start and tell the person, days on, about an update they had forgotten. So it is left only when no program listens on the port of the Hub: every Hub that starts after it reads it.
        {
            var machine = new Machine { HubRunning = true };
            var result = machine.Run(Command());
            kit.Check(result.Ok && machine.Written == null && !machine.Events.Contains("write-result") && machine.Events.Contains("hub-running"), "while a program listens on the port of the Hub no result file is left (nobody would read it until some later start)");
            kit.Check(machine.Events.Contains("relaunch"), "and the app is still opened");
            machine = new Machine { HubRunning = true };
            machine.Install = (plan, progress) => throw Wrapped(new InvalidOperationException("Stop active DatGold tasks").Tag("tasks_running"));
            result = machine.Run(Command());
            kit.Check(result.Reason == "tasks_running" && machine.Written == null && machine.Events.Contains("relaunch"), "a refusal because tasks are running (the Hub is still up and was not stopped) leaves no result: the window said why, and the old app is opened again");
            machine = new Machine { HubRunning = true, Target = "3.10.2" };
            result = machine.Run(Command());
            kit.Check(result.Reason == "not_newer" && machine.Written == null, "nor does a refusal that stopped nothing, such as an installer that is not newer");
            machine = new Machine { HubCheckThrows = true };
            result = machine.Run(Command());
            kit.Check(result.Ok && machine.Written == result, "when the port cannot be looked at the result is left: a note that nobody reads is better than a failure nobody hears of");
            machine = new Machine { HubRunning = false };
            kit.Check(machine.Run(Command()).Ok && machine.Written != null, "with no Hub up the result is left, as always");
        }

        // ---- "opened again" is said only when the app really was opened
        {
            var machine = new Machine();
            machine.Run(Command(), out var relaunched);
            kit.Check(relaunched, "after an update that went through, with the app opened, relaunched is true");
            machine = new Machine { OnRelaunch = () => throw new IOException("cannot start") };
            machine.Run(Command(), out relaunched);
            kit.Check(!relaunched, "an app that could not be opened is not said to have been");
            machine = new Machine(); machine.Run(Command(relaunch: false), out relaunched);
            kit.Check(!relaunched, "nor is one that was not asked for");
            machine = new Machine { Marker = true }; machine.Run(Command(), out relaunched);
            kit.Check(!relaunched, "nor one that is not opened because the installation needs recovery");
            machine = new Machine { Target = "3.9.0" }; machine.Run(Command(), out relaunched);
            kit.Check(relaunched, "after a refusal the OLD app is opened and that is said too");
        }
        kit.Throws(() => UpdateRun.Real().Relaunch(Path.Combine(kit.Folder("no app here"), "ChatMCP.exe")), "the real way to open the app fails when there is no ChatMCP.exe to open (the window must not say it was opened)");
        // the port of the Hub as the real machine answers: a port that nothing listens on, then the same port with a listener of this test on it
        {
            var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start(); var port = ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
            var onPort = UpdateRun.Real(port);
            kit.Check(!onPort.HubIsRunning(), "nothing listens on a free port: no Hub is running there");
            var listener = new TcpListener(IPAddress.Loopback, port); listener.Start();
            try { kit.Check(onPort.HubIsRunning(), "and a program that listens on it is a Hub that is up (whatever it is: the port is taken)"); }
            finally { listener.Stop(); }
        }

        // ---- the written result is the contract text
        {
            var machine = new Machine(); machine.Install = (plan, progress) => throw Wrapped(new InvalidOperationException("Stop active DatGold tasks").Tag("tasks_running"));
            machine.Run(Command());
            kit.Check(UpdateResultFile.Serialize(machine.Written!) == "{\"format\":1,\"ok\":false,\"version\":\"3.11.0\",\"previous\":\"3.10.2\",\"state\":\"unchanged\",\"reason\":\"tasks_running\",\"rolledBack\":false}", "and what is written for a refusal is the literal text of the contract");
        }

        // ---- the shell: a real process, waited for
        var cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        Process Ping(int count)
        {
            var start = new ProcessStartInfo(cmd) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
            start.ArgumentList.Add("/c"); start.ArgumentList.Add("ping"); start.ArgumentList.Add("-n"); start.ArgumentList.Add(count.ToString()); start.ArgumentList.Add("127.0.0.1");
            var process = Process.Start(start)!; _ = process.StandardOutput.ReadToEndAsync(); return process;
        }
        {
            using var child = Ping(3);
            var clock = Stopwatch.StartNew();
            var gone = ShellProcess.WaitForExit(child.Id, cmd, TimeSpan.FromSeconds(30));
            kit.Check(gone && child.HasExited && clock.ElapsedMilliseconds >= 500, "a shell that exits while it is waited for: the wait returns when it has (after " + clock.ElapsedMilliseconds + " ms)");
        }
        {
            using var child = Ping(30);
            var clock = Stopwatch.StartNew();
            var gone = ShellProcess.WaitForExit(child.Id, cmd, TimeSpan.FromMilliseconds(1200));
            var waited = clock.ElapsedMilliseconds;
            var stillRunning = !child.HasExited;
            child.Kill(entireProcessTree: true);
            kit.Check(!gone && stillRunning && waited >= 1000 && waited < 10000, "a shell that does not exit: the wait gives up at its limit and says so (gone=" + gone + ", still running=" + stillRunning + ", after " + waited + " ms)");
        }
        {
            using var child = Ping(30);
            var clock = Stopwatch.StartNew();
            var gone = ShellProcess.WaitForExit(child.Id, Path.Combine(Dir, "ChatMCP.exe"), TimeSpan.FromSeconds(20));
            var waited = clock.ElapsedMilliseconds; var stillRunning = !child.HasExited;
            child.Kill(entireProcessTree: true);
            kit.Check(gone && stillRunning && waited < 5000, "a process that is not the installed ChatMCP.exe (the pid was handed on to another program) is not waited for: it is not the shell (after " + waited + " ms)");
        }
        {
            using var child = Ping(1); child.WaitForExit();
            var clock = Stopwatch.StartNew();
            kit.Check(ShellProcess.WaitForExit(child.Id, cmd, TimeSpan.FromSeconds(20)) && clock.ElapsedMilliseconds < 3000, "a pid whose process has already gone needs no wait");
            kit.Check(ShellProcess.WaitForExit(int.MaxValue, cmd, TimeSpan.FromSeconds(20)), "and neither does one that no process ever had");
        }
        kit.Check(!ShellProcess.WaitForExit(4, Path.Combine(Dir, "ChatMCP.exe"), TimeSpan.FromMilliseconds(1000)), "a process that cannot be looked at (the System process) is waited for like the shell, never taken for gone");

        // ---- the room and the version, as the real machine answers
        var real = UpdateRun.Real();
        kit.Check(real.FreeBytes(Path.GetTempPath()) is > 0, "the room on the drive of a folder of this machine is read");
        kit.Check(real.FreeBytes(@"\\no-such-server\share\folder") == null, "and for a network path it is unknown, not zero");
        var scratch = kit.Folder("installed version");
        kit.Check(real.InstalledVersion(scratch) == null, "a folder with no ChatMCP.exe in it has no installed version");
        var markerBefore = real.PendingMarkerExists(scratch);
        File.WriteAllText(Path.Combine(scratch, InstallTransaction.PendingName), "{}");
        kit.Check(!markerBefore && real.PendingMarkerExists(scratch), "the marker of an update that did not finish is the file the transaction leaves");
        kit.Check(UpdateRun.ReadVersion("3.10.2+0123abcd") == V("3.10.2") && UpdateRun.ReadVersion("3.10.2") == V("3.10.2") && UpdateRun.ReadVersion("3.10.2.0") == null && UpdateRun.ReadVersion("") == null && UpdateRun.ReadVersion(null) == null, "a version resource is read as x.y.z with build metadata after a plus sign dropped, and as nothing when it is not a release version");
    }
}
