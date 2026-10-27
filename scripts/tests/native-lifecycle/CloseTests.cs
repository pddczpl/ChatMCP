using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using ChatMCP.Installer;
using ChatMCP.Native;

// Closing the installed app before files are replaced. Only a program that runs the ChatMCP.exe of THIS installation folder is asked to close. A program that the system will not let us look at (another user's,
// or a protected one: Process.MainModule throws Win32Exception "Access is denied") is not ours to close, and it must not stop the setup. Pretend programs record what is done to them, so nothing real is asked to
// close here, and no real program called ChatMCP is looked at (the installed app of the person who runs these tests is never touched). The one real check looks at a protected program of the system, which has
// no window to close. (Nothing in mutations.json changes which programs are asked to close, and nothing may: see docs/DEVELOPMENT.md.)
internal static class CloseTests
{
    private const int AccessDenied = 5;
    private const int PartialCopy = 299; // what an unreadable program that is not denied says: it has ended, or has only just started

    private sealed class Pretend : InstallerEngine.IRunningProgram
    {
        private readonly string name; private readonly List<string> log; private readonly string? image; private readonly Exception? imageError; private readonly bool closes; private readonly Exception? closeError;
        internal Pretend(string name, List<string> log, string? image = null, Exception? imageError = null, bool closes = true, Exception? closeError = null)
        { this.name = name; this.log = log; this.image = image; this.imageError = imageError; this.closes = closes; this.closeError = closeError; }
        public string? ImageFile() { log.Add("image " + name); if (imageError != null) throw imageError; return image; }
        public void RequestClose() { log.Add("close " + name); if (closeError != null) throw closeError; }
        public bool WaitForExit(int milliseconds) { log.Add("wait " + name); return closes; }
        public void Dispose() => log.Add("dispose " + name);
    }

    internal static void Run(TestKit kit)
    {
        var installation = kit.Folder("close pretend");
        var ours = Path.Combine(installation, "ChatMCP.exe");
        var elsewhere = Path.Combine(kit.Folder("close another"), "ChatMCP.exe");
        Exception? Caught(Action action) { try { action(); return null; } catch (Exception error) { return error; } }
        string Said(Exception? error) => error == null ? "no error" : error.GetType().Name + ": " + error.Message;
        (Exception? Error, List<string> Log) Try(Func<List<string>, IEnumerable<InstallerEngine.IRunningProgram>> make)
        {
            var log = new List<string>();
            var error = Caught(() => InstallerEngine.CloseRunningProcesses(installation, 300, () => make(log).ToList()));
            return (error, log);
        }
        bool Closed(List<string> log, string name) => log.Contains("close " + name) || log.Contains("wait " + name);

        // ---- a program that the system will not let us look at
        var (denied, deniedLog) = Try(log => new[] { new Pretend("denied", log, imageError: new Win32Exception(AccessDenied)) });
        kit.Check(denied == null, "a program that the system will not let us look at (access denied) does not stop the setup (" + Said(denied) + ")");
        kit.Check(!Closed(deniedLog, "denied") && deniedLog.Contains("dispose denied"), "it is not asked to close, and it is let go of");

        var (mixed, mixedLog) = Try(log => new InstallerEngine.IRunningProgram[]
        {
            new Pretend("denied", log, imageError: new Win32Exception(AccessDenied)),
            new Pretend("ours", log, image: ours),
            new Pretend("elsewhere", log, image: elsewhere),
        });
        kit.Check(mixed == null && mixedLog.Contains("close ours") && mixedLog.Contains("wait ours"), "the installed app that is looked at after a denied program is still asked to close, and the setup goes on (" + Said(mixed) + ")");
        kit.Check(!Closed(mixedLog, "denied") && !Closed(mixedLog, "elsewhere"), "and neither the denied program nor the ChatMCP.exe of another folder is asked to close");
        kit.Check(new[] { "dispose denied", "dispose ours", "dispose elsewhere" }.All(mixedLog.Contains), "and every program is let go of");

        // ---- only "access denied" is forgiven: a program that is unreadable for another reason, or a failure to close the installed app, still stops the setup
        var (unreadableError, _) = Try(log => new[] { new Pretend("unreadable", log, imageError: new Win32Exception(PartialCopy)) });
        kit.Check(unreadableError is Win32Exception unreadable && unreadable.NativeErrorCode == PartialCopy, "a program that cannot be read for another reason (code " + PartialCopy + ") is not passed over as if it were someone else's (" + Said(unreadableError) + ")");
        var (cannotClose, _) = Try(log => new[] { new Pretend("ours", log, image: ours, closeError: new Win32Exception(AccessDenied)) });
        kit.Check(cannotClose is Win32Exception, "and an installed app that cannot be asked to close is not hidden either (" + Said(cannotClose) + ")");
        var (stays, staysLog) = Try(log => new[] { new Pretend("ours", log, image: ours, closes: false) });
        kit.Check(stays is IOException && StepCode.Of(stays) == "window_open" && staysLog.Contains("close ours"), "an installed app that does not close in time is refused with window_open, as before (" + Said(stays) + ")");

        // ---- what was always so
        var (gone, goneLog) = Try(log => new[] { new Pretend("gone", log, imageError: new InvalidOperationException("Process has exited.")) });
        kit.Check(gone == null && !Closed(goneLog, "gone"), "a program that has ended is passed over (" + Said(gone) + ")");
        var (strangers, strangersLog) = Try(log => new[] { new Pretend("other folder", log, image: elsewhere), new Pretend("no image", log, image: null) });
        kit.Check(strangers == null && !Closed(strangersLog, "other folder") && !Closed(strangersLog, "no image"), "a ChatMCP.exe of another folder, and a program with no file to speak of, are left alone (" + Said(strangers) + ")");
        var (nothing, _) = Try(log => Array.Empty<InstallerEngine.IRunningProgram>());
        kit.Check(nothing == null, "no program, no error");

        // ---- the real thing: a program of another account that really is running, through the real wrapper of a process
        string? protectedName = null;
        foreach (var name in new[] { "csrss", "wininit", "services", "lsass", "winlogon" })
        {
            using var probe = InstallerEngine.Programs(Process.GetProcessesByName(name)).FirstOrDefault();
            if (probe == null) continue;
            var said = Caught(() => probe.ImageFile());
            if (said is Win32Exception win32 && win32.NativeErrorCode == AccessDenied) { protectedName = name; break; }
        }
        if (protectedName == null)
            kit.Check(true, "no program of another account says access denied on this machine (an elevated session may read them all): the real check was not made");
        else
        {
            var real = Caught(() => InstallerEngine.CloseRunningProcesses(installation, 300, () => InstallerEngine.Programs(Process.GetProcessesByName(protectedName))));
            kit.Check(real == null, "premise and result: " + protectedName + ".exe says access denied (Win32Exception, code " + AccessDenied + "), and a setup that meets it goes on (" + Said(real) + ")");
        }

        // ---- the installed app itself, when the system will not let us read its module list but still tells the name of its file (an app that runs elevated is such a program for a setup that does not). It is
        // made here for real: a copy of ping.exe called ChatMCP.exe in a folder of its own, started by this test, whose process is then given a security descriptor that leaves this user only the right
        // to ask for its name and to wait for it. It is still the installed app of that folder, and a setup that cannot get it to close must refuse (window_open), not pass it over as someone else's.
        // .NET switches SeDebugPrivilege on by itself the first time it works with processes, on a token that holds the privilege (an administrator's does: a hosted runner's), and with it on OpenProcess
        // ignores the security descriptor of the process, so the stand-in below would be readable there. It is switched off for the length of this block and back on after it.
        _ = Process.GetProcessesByName("no program has this name"); // the first use of Process is where .NET switches it on: let that have happened
        var heldDebugPrivilege = SetPrivilege("SeDebugPrivilege", false);
        var home = kit.Folder("close denied app");
        File.Copy(Path.Combine(Environment.SystemDirectory, "ping.exe"), Path.Combine(home, "ChatMCP.exe"));
        using var app = Process.Start(new ProcessStartInfo(Path.Combine(home, "ChatMCP.exe"), "-n 120 127.0.0.1") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true })!;
        try
        {
            var set = LeaveOnlyNameAndWait(app);
            kit.Check(set == 0, "premise: the rights to read the memory of the stand-in for the installed app were taken away from this user (error " + set + ")");
            var read = Caught(() => { _ = Process.GetProcessById(app.Id).MainModule; });
            kit.Check(read is Win32Exception refused && refused.NativeErrorCode == AccessDenied, "premise: its module list now says access denied (" + Said(read) + ")");
            var stayed = Caught(() => InstallerEngine.CloseRunningProcesses(home, 300));
            kit.Check(stayed is IOException && StepCode.Of(stayed) == "window_open" && !app.HasExited, "it is still taken for the installed app of its folder, and refused with window_open because it does not close (" + Said(stayed) + ")");
            var other = Caught(() => InstallerEngine.CloseRunningProcesses(kit.Folder("close another installation"), 300));
            kit.Check(other == null && !app.HasExited, "while the setup of another installation folder passes it over: it is not that folder's program (" + Said(other) + ")");
        }
        finally
        {
            try { if (!app.HasExited) app.Kill(true); app.WaitForExit(10000); } catch (InvalidOperationException) { /* already gone */ }
            if (heldDebugPrivilege) SetPrivilege("SeDebugPrivilege", true);
        }
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)] private struct TokenPrivileges { public uint Count; public long Luid; public uint Attributes; }
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool LookupPrivilegeValue(string? system, string name, out long luid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges state, uint length, IntPtr previous, IntPtr returnLength);

    /// <summary>Switches a privilege of the token of this process on or off. True when the token holds the privilege and it was set (an administrator's holds SeDebugPrivilege, a user's does not).</summary>
    internal static bool SetPrivilege(string name, bool enabled)
    {
        if (!OpenProcessToken(GetCurrentProcess(), 0x0020 /* TOKEN_ADJUST_PRIVILEGES */ | 0x0008 /* TOKEN_QUERY */, out var token)) return false;
        try
        {
            if (!LookupPrivilegeValue(null, name, out var luid)) return false;
            var state = new TokenPrivileges { Count = 1, Luid = luid, Attributes = enabled ? 2u /* SE_PRIVILEGE_ENABLED */ : 0u };
            AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero);
            return Marshal.GetLastWin32Error() == 0; // 1300 (ERROR_NOT_ALL_ASSIGNED) when the token does not hold the privilege
        }
        finally { CloseHandle(token); }
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr acl, out bool defaulted);
    [DllImport("advapi32.dll")] private static extern uint SetSecurityInfo(IntPtr handle, int objectType, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);

    /// <summary>Gives the process, which this test started and holds a handle to, a security descriptor that leaves this user PROCESS_QUERY_LIMITED_INFORMATION and SYNCHRONIZE only. 0 when it was set, else the Windows error.</summary>
    private static uint LeaveOnlyNameAndWait(Process process)
    {
        var sddl = "D:P(A;;0x101000;;;" + WindowsIdentity.GetCurrent().User!.Value + ")";
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out var descriptor, out _)) return (uint)Marshal.GetLastWin32Error();
        try
        {
            if (!GetSecurityDescriptorDacl(descriptor, out _, out var acl, out _)) return (uint)Marshal.GetLastWin32Error();
            return SetSecurityInfo(process.Handle, 6 /* SE_KERNEL_OBJECT */, 0x80000004 /* DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION */, IntPtr.Zero, IntPtr.Zero, acl, IntPtr.Zero);
        }
        finally { LocalFree(descriptor); }
    }
}
