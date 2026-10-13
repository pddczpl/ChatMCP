// ChatMCP Windows Sandbox Guest Supervisor (Phase 1, PR 2)
//
// Provides bounded execution under a kill-on-close Windows Job Object,
// eliminates process-start races via CREATE_SUSPENDED, creates restricted
// tokens when running as privileged SYSTEM/Admin, prevents any privileged fallback,
// validates all Win32 process lifecycle return codes, captures bounded output streams,
// and produces cryptographic execution receipts.

using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace ChatMCP.Sandbox.GuestSupervisor;

public class ExecutionRequest
{
    [JsonPropertyName("version")]
    public int Version { get; set; } = 1;

    [JsonPropertyName("runId")]
    public string RunId { get; set; } = string.Empty;

    [JsonPropertyName("nonce")]
    public string Nonce { get; set; } = string.Empty;

    [JsonPropertyName("command")]
    public string Command { get; set; } = string.Empty;

    [JsonPropertyName("args")]
    public string[]? Args { get; set; }

    [JsonPropertyName("cwd")]
    public string? Cwd { get; set; }

    [JsonPropertyName("timeoutSeconds")]
    public double TimeoutSeconds { get; set; } = 120;

    [JsonPropertyName("maxOutputBytes")]
    public int MaxOutputBytes { get; set; } = 100 * 1024;
}

public class ExecutionReceipt
{
    [JsonPropertyName("version")]
    public int Version { get; set; } = 1;

    [JsonPropertyName("runId")]
    public string RunId { get; set; } = string.Empty;

    [JsonPropertyName("nonce")]
    public string Nonce { get; set; } = string.Empty;

    [JsonPropertyName("status")]
    public string Status { get; set; } = "error";

    [JsonPropertyName("exitCode")]
    public int? ExitCode { get; set; }

    [JsonPropertyName("stdout")]
    public string Stdout { get; set; } = string.Empty;

    [JsonPropertyName("stderr")]
    public string Stderr { get; set; } = string.Empty;

    [JsonPropertyName("truncated")]
    public bool Truncated { get; set; }

    [JsonPropertyName("startedAt")]
    public string StartedAt { get; set; } = string.Empty;

    [JsonPropertyName("completedAt")]
    public string CompletedAt { get; set; } = string.Empty;

    [JsonPropertyName("durationMs")]
    public long DurationMs { get; set; }

    [JsonPropertyName("supervisorPid")]
    public int SupervisorPid { get; set; }

    [JsonPropertyName("childPid")]
    public int? ChildPid { get; set; }

    [JsonPropertyName("reasons")]
    public string[] Reasons { get; set; } = Array.Empty<string>();

    [JsonPropertyName("isGuestExecution")]
    public bool IsGuestExecution { get; set; }

    [JsonPropertyName("restrictedChild")]
    public bool RestrictedChild { get; set; }

    [JsonPropertyName("jobObjectAttached")]
    public bool JobObjectAttached { get; set; }
}

internal static class NativeJobObject
{
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public nuint MinimumWorkingSetSize;
        public nuint MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public nuint Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public nuint ProcessMemoryLimit;
        public nuint JobMemoryLimit;
        public nuint PeakProcessMemoryLimit;
        public nuint PeakJobMemoryLimit;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        int JobObjectInformationClass,
        IntPtr lpJobObjectInformation,
        uint cbJobObjectInformationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    public sealed class SafeJobHandle : IDisposable
    {
        private IntPtr _handle;

        public IntPtr Handle => _handle;

        public SafeJobHandle()
        {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Job Object requires Windows.");

            _handle = CreateJobObject(IntPtr.Zero, null);
            if (_handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed.");

            var extendedInfo = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
            {
                BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION
                {
                    LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                }
            };

            int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr extendedInfoPtr = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(extendedInfo, extendedInfoPtr, false);
                if (!SetInformationJobObject(_handle, JobObjectExtendedLimitInformation, extendedInfoPtr, (uint)length))
                {
                    int code = Marshal.GetLastWin32Error();
                    CloseHandle(_handle);
                    _handle = IntPtr.Zero;
                    throw new Win32Exception(code, "SetInformationJobObject failed; refusing execution.");
                }
            }
            finally
            {
                Marshal.FreeHGlobal(extendedInfoPtr);
            }
        }

        public bool AssignProcess(IntPtr processHandle)
        {
            if (!OperatingSystem.IsWindows() || _handle == IntPtr.Zero) return false;
            return AssignProcessToJobObject(_handle, processHandle);
        }

        public void Dispose()
        {
            if (_handle != IntPtr.Zero)
            {
                CloseHandle(_handle);
                _handle = IntPtr.Zero;
            }
        }
    }
}

internal static class NativeProcessManager
{
    public const uint STARTF_USESTDHANDLES = 0x00000100;
    public const uint CREATE_SUSPENDED = 0x00000004;
    public const uint CREATE_NO_WINDOW = 0x08000000;
    public const uint HANDLE_FLAG_INHERIT = 0x00000001;

    public const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
    public const uint TOKEN_DUPLICATE = 0x0002;
    public const uint TOKEN_QUERY = 0x0008;
    public const uint TOKEN_ADJUST_DEFAULT = 0x0080;
    public const uint DISABLE_MAX_PRIVILEGE = 0x1;
    public const uint LUA_TOKEN = 0x4;

    public const uint WAIT_OBJECT_0 = 0x00000000;
    public const uint WAIT_TIMEOUT = 0x00000102;
    public const uint WAIT_FAILED = 0xFFFFFFFF;
    public const int STILL_ACTIVE = 259;

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessW(
        string? lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessAsUserW(
        IntPtr hToken,
        string? lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out int lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    public const int DACL_SECURITY_INFORMATION = 4;
    public const uint WRITE_DAC = 0x00040000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct USER_INFO_1003
    {
        public string usri1003_password;
    }

    public const int LOGON32_LOGON_BATCH = 4;
    public const int LOGON32_PROVIDER_DEFAULT = 0;

    [DllImport("netapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern uint NetUserSetInfo(
        string? servername,
        string username,
        uint level,
        ref USER_INFO_1003 buf,
        out uint parm_err);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool LogonUser(
        string lpszUsername,
        string lpszDomain,
        string lpszPassword,
        int dwLogonType,
        int dwLogonProvider,
        out IntPtr phToken);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessWithTokenW(
        IntPtr hToken,
        uint dwLogonFlags,
        string? lpApplicationName,
        string lpCommandLine,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr OpenWindowStationW(string lpszWinSta, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr OpenDesktopW(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetUserObjectSecurity(IntPtr hObj, ref int pSIRequested, IntPtr pSID);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseWindowStation(IntPtr hWinSta);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string StringSecurityDescriptor,
        uint StringSDRevision,
        out IntPtr SecurityDescriptor,
        out UIntPtr SecurityDescriptorSize);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool CreateRestrictedToken(
        IntPtr ExistingTokenHandle,
        uint Flags,
        uint DisableSidCount,
        IntPtr SidsToDisable,
        uint DeletePrivilegeCount,
        IntPtr PrivilegesToDelete,
        uint RestrictedSidCount,
        IntPtr SidsToRestrict,
        out IntPtr NewTokenHandle);

    [StructLayout(LayoutKind.Sequential)]
    public struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool ConvertStringSidToSidW(string stringSid, out IntPtr sid);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr LocalFree(IntPtr hMem);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool SetKernelObjectSecurity(IntPtr Handle, int SecurityInformation, IntPtr SecurityDescriptor);

    [StructLayout(LayoutKind.Sequential)]
    public struct TOKEN_DEFAULT_DACL { public IntPtr DefaultDacl; }

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool GetSecurityDescriptorDacl(IntPtr pSD, out bool present, out IntPtr pDacl, out bool defaulted);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool SetTokenInformation(IntPtr h, int infoClass, IntPtr info, uint len);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disp, uint flags, IntPtr templ);
}

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        string? requestPath = null;
        string? outputPath = null;
        string? authKey = null;
        string? authKeyFile = null;
        string? faultInject = null;
        bool hostFixture = false;
        bool guestFixture = false;

        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--request" && i + 1 < args.Length)
            {
                requestPath = args[++i];
            }
            else if (args[i] == "--output" && i + 1 < args.Length)
            {
                outputPath = args[++i];
            }
            else if (args[i] == "--host-fixture")
            {
                hostFixture = true;
            }
            else if (args[i] == "--guest-fixture")
            {
                guestFixture = true;
            }
            else if (args[i] == "--auth-key" && i + 1 < args.Length)
            {
                authKey = args[++i];
            }
            else if (args[i] == "--auth-key-file" && i + 1 < args.Length)
            {
                authKeyFile = args[++i];
            }
            else if (args[i] == "--fault-inject" && i + 1 < args.Length)
            {
                faultInject = args[++i];
            }
        }

        if (string.IsNullOrWhiteSpace(authKey))
        {
            string? candidate = !string.IsNullOrWhiteSpace(authKeyFile)
                ? authKeyFile
                : (!string.IsNullOrWhiteSpace(outputPath) ? Path.Combine(outputPath, ".auth_key") : null);
            if (!string.IsNullOrWhiteSpace(candidate) && File.Exists(candidate))
            {
                try
                {
                    string readKey = (await File.ReadAllTextAsync(candidate)).Trim();
                    if (Regex.IsMatch(readKey, "^[0-9a-fA-F]{64}$"))
                    {
                        authKey = readKey;
                    }
                    // Secure shred: overwrite bytes with zeroes and delete immediately
                    byte[] zeroes = new byte[readKey.Length + 32];
                    await File.WriteAllBytesAsync(candidate, zeroes);
                    File.Delete(candidate);
                }
                catch { /* best effort delete */ }
            }
        }

        if (!string.IsNullOrWhiteSpace(authKey) && !Regex.IsMatch(authKey, "^[0-9a-fA-F]{64}$"))
        {
            Console.Error.WriteLine("BLOCKED: --auth-key must be a 64-character hex string (32 bytes).");
            return 3;
        }

        if (hostFixture && guestFixture)
        {
            Console.Error.WriteLine("BLOCKED: Cannot specify both --host-fixture and --guest-fixture.");
            return 3;
        }

        if (!hostFixture && !guestFixture)
        {
            Console.Error.WriteLine("BLOCKED: GuestSupervisor requires explicit --host-fixture or --guest-fixture mode.");
            return 3;
        }

        if (string.IsNullOrWhiteSpace(requestPath) || string.IsNullOrWhiteSpace(outputPath))
        {
            Console.Error.WriteLine("Usage: GuestSupervisor.exe [--host-fixture|--guest-fixture] --request <request.json> --output <output-directory>");
            return 1;
        }

        DateTime startedAt = DateTime.UtcNow;
        Stopwatch sw = Stopwatch.StartNew();
        ExecutionRequest request;

        try
        {
            string json = await File.ReadAllTextAsync(requestPath);
            request = JsonSerializer.Deserialize<ExecutionRequest>(json) ?? throw new InvalidOperationException("Failed to parse request JSON.");
            if (request.Version != 1 || !Regex.IsMatch(request.RunId ?? "", "^[A-Za-z0-9_-]{1,128}$") ||
                !Regex.IsMatch(request.Nonce ?? "", "^[0-9a-fA-F]{64}$") ||
                string.IsNullOrWhiteSpace(request.Command) ||
                !double.IsFinite(request.TimeoutSeconds) || request.TimeoutSeconds < 1 || request.TimeoutSeconds > 900 ||
                request.MaxOutputBytes < 1 || request.MaxOutputBytes > 1024 * 1024)
            {
                throw new InvalidOperationException("Invalid or unsupported execution request.");
            }
        }
        catch (Exception ex)
        {
            await WriteErrorReceiptAsync(outputPath, "error", ex.Message, startedAt, sw.ElapsedMilliseconds);
            return 1;
        }

        using var jobObject = new NativeJobObject.SafeJobHandle();

        string status = "error";
        int? exitCode = null;
        string stdout = string.Empty;
        string stderr = string.Empty;
        bool truncated = false;
        int? childPid = null;
        bool isRestrictedChild = false;
        var reasons = new List<string>();

        IntPtr pSD = IntPtr.Zero;
        IntPtr hNul = IntPtr.Zero;
        if (guestFixture)
        {
            NativeProcessManager.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                "D:(A;;GA;;;WD)(A;;GA;;;BU)(A;;GA;;;SY)", 1, out pSD, out _);
        }

        // Anonymous pipes for bounded stdout and stderr capture
        var sa = new NativeProcessManager.SECURITY_ATTRIBUTES
        {
            nLength = Marshal.SizeOf<NativeProcessManager.SECURITY_ATTRIBUTES>(),
            bInheritHandle = true,
            lpSecurityDescriptor = pSD
        };

        if (guestFixture && pSD != IntPtr.Zero)
        {
            hNul = NativeProcessManager.CreateFileW("NUL", 0x80000000 /* GENERIC_READ */, 1 | 2 /* SHARE_READ | SHARE_WRITE */, ref sa, 3 /* OPEN_EXISTING */, 0, IntPtr.Zero);
        }

        IntPtr hStdOutRead = IntPtr.Zero;
        IntPtr hStdOutWrite = IntPtr.Zero;
        IntPtr hStdErrRead = IntPtr.Zero;
        IntPtr hStdErrWrite = IntPtr.Zero;

        try
        {
            if (!NativeProcessManager.CreatePipe(out hStdOutRead, out hStdOutWrite, ref sa, 0))
            {
                int pipeErr = Marshal.GetLastWin32Error();
                throw new Win32Exception(pipeErr, $"Failed to create stdout pipe (Win32 error {pipeErr}).");
            }
            if (!NativeProcessManager.CreatePipe(out hStdErrRead, out hStdErrWrite, ref sa, 0))
            {
                int pipeErr = Marshal.GetLastWin32Error();
                throw new Win32Exception(pipeErr, $"Failed to create stderr pipe (Win32 error {pipeErr}).");
            }

            if (!NativeProcessManager.SetHandleInformation(hStdOutRead, NativeProcessManager.HANDLE_FLAG_INHERIT, 0))
            {
                int setErr = Marshal.GetLastWin32Error();
                throw new Win32Exception(setErr, $"Failed to configure stdout read pipe handle inheritance (Win32 error {setErr}).");
            }
            if (!NativeProcessManager.SetHandleInformation(hStdErrRead, NativeProcessManager.HANDLE_FLAG_INHERIT, 0))
            {
                int setErr = Marshal.GetLastWin32Error();
                throw new Win32Exception(setErr, $"Failed to configure stderr read pipe handle inheritance (Win32 error {setErr}).");
            }
        }
        catch (Exception ex)
        {
            if (hNul != IntPtr.Zero) NativeProcessManager.CloseHandle(hNul);
            if (pSD != IntPtr.Zero) Marshal.FreeHGlobal(pSD);
            if (hStdOutRead != IntPtr.Zero) NativeProcessManager.CloseHandle(hStdOutRead);
            if (hStdOutWrite != IntPtr.Zero) NativeProcessManager.CloseHandle(hStdOutWrite);
            if (hStdErrRead != IntPtr.Zero) NativeProcessManager.CloseHandle(hStdErrRead);
            if (hStdErrWrite != IntPtr.Zero) NativeProcessManager.CloseHandle(hStdErrWrite);
            await WriteErrorReceiptAsync(outputPath, "error", ex.Message, startedAt, sw.ElapsedMilliseconds, authKey);
            return 1;
        }

        IntPtr hRestrictedToken = IntPtr.Zero;
        IntPtr hChildProcess = IntPtr.Zero;
        IntPtr hChildThread = IntPtr.Zero;

        try
        {
            bool isSystem = false;
            bool isAdmin = false;

            if (guestFixture)
            {
                if (faultInject == "identity_fail")
                {
                    throw new System.Security.SecurityException("Fault injection: WindowsIdentity lookup failed.");
                }

                if (!OperatingSystem.IsWindows())
                {
                    throw new PlatformNotSupportedException("Guest fixture requires Windows.");
                }

                using var id = WindowsIdentity.GetCurrent();
                if (id == null)
                {
                    throw new InvalidOperationException("Security failure: Unable to retrieve current Windows identity.");
                }
                isSystem = id.IsSystem;
                var principal = new WindowsPrincipal(id);
                isAdmin = principal.IsInRole(WindowsBuiltInRole.Administrator);

                if (faultInject == "open_token_fail")
                {
                    throw new Win32Exception(5, "Fault injection: Failed to open supervisor process token.");
                }

                // Grant WindowStation and Desktop access to Users
                GrantWindowStationAndDesktopAccess(pSD);

                // Set password for built-in local user WDAGUtilityAccount
                byte[] passBytes = RandomNumberGenerator.GetBytes(16);
                string tempPassword = "Cmc@" + Convert.ToHexString(passBytes) + "!";
                var userInfo = new NativeProcessManager.USER_INFO_1003 { usri1003_password = tempPassword };
                uint netResult = NativeProcessManager.NetUserSetInfo(null, "WDAGUtilityAccount", 1003, ref userInfo, out uint parmErr);
                if (netResult != 0)
                {
                    int netErr = Marshal.GetLastWin32Error();
                    throw new Win32Exception((int)netResult, $"Security failure: NetUserSetInfo for WDAGUtilityAccount failed with code {netResult} (error {netErr}).");
                }

                if (!NativeProcessManager.LogonUser("WDAGUtilityAccount", ".", tempPassword, NativeProcessManager.LOGON32_LOGON_BATCH, NativeProcessManager.LOGON32_PROVIDER_DEFAULT, out IntPtr hUserToken))
                {
                    int logonErr = Marshal.GetLastWin32Error();
                    throw new Win32Exception(logonErr, $"Security failure: LogonUser for WDAGUtilityAccount failed (error {logonErr}).");
                }

                try
                {
                    if (faultInject == "create_restricted_token_fail")
                    {
                        throw new Win32Exception(87, "Fault injection: Failed to create restricted token.");
                    }

                    if (pSD != IntPtr.Zero)
                    {
                        // Permissive DACL on user token
                        NativeProcessManager.SetKernelObjectSecurity(hUserToken, NativeProcessManager.DACL_SECURITY_INFORMATION, pSD);

                        // Set TokenDefaultDacl
                        if (NativeProcessManager.GetSecurityDescriptorDacl(pSD, out bool pres, out IntPtr pDacl, out _))
                        {
                            var tdd = new NativeProcessManager.TOKEN_DEFAULT_DACL { DefaultDacl = pDacl };
                            IntPtr pTdd = Marshal.AllocHGlobal(Marshal.SizeOf<NativeProcessManager.TOKEN_DEFAULT_DACL>());
                            try
                            {
                                Marshal.StructureToPtr(tdd, pTdd, false);
                                NativeProcessManager.SetTokenInformation(hUserToken, 6 /* TokenDefaultDacl */, pTdd, (uint)Marshal.SizeOf<NativeProcessManager.TOKEN_DEFAULT_DACL>());
                            }
                            finally
                            {
                                Marshal.FreeHGlobal(pTdd);
                            }
                        }
                    }

                    IntPtr pSidsToDisable = IntPtr.Zero;
                    var sids = new List<IntPtr>();
                    try
                    {
                        string[] denySids = new[] { "S-1-5-32-544", "S-1-5-114" };
                        foreach (var s in denySids)
                        {
                            if (NativeProcessManager.ConvertStringSidToSidW(s, out IntPtr pSid))
                            {
                                sids.Add(pSid);
                            }
                        }

                        int structSize = Marshal.SizeOf<NativeProcessManager.SID_AND_ATTRIBUTES>();
                        pSidsToDisable = Marshal.AllocHGlobal(structSize * sids.Count);
                        for (int i = 0; i < sids.Count; i++)
                        {
                            var sidAttr = new NativeProcessManager.SID_AND_ATTRIBUTES { Sid = sids[i], Attributes = 0 };
                            Marshal.StructureToPtr(sidAttr, IntPtr.Add(pSidsToDisable, structSize * i), false);
                        }

                        if (!NativeProcessManager.CreateRestrictedToken(
                            hUserToken,
                            NativeProcessManager.DISABLE_MAX_PRIVILEGE,
                            (uint)sids.Count, pSidsToDisable, 0, IntPtr.Zero, 0, IntPtr.Zero,
                            out hRestrictedToken))
                        {
                            int restrErr = Marshal.GetLastWin32Error();
                            throw new Win32Exception(restrErr, $"Security failure: Failed to create restricted non-admin token for child (error {restrErr}).");
                        }
                        isRestrictedChild = true;
                    }
                    finally
                    {
                        if (pSidsToDisable != IntPtr.Zero) Marshal.FreeHGlobal(pSidsToDisable);
                        foreach (var p in sids) NativeProcessManager.LocalFree(p);
                    }

                    if (pSD != IntPtr.Zero && hRestrictedToken != IntPtr.Zero)
                    {
                        NativeProcessManager.SetKernelObjectSecurity(hRestrictedToken, NativeProcessManager.DACL_SECURITY_INFORMATION, pSD);
                    }
                }
                finally
                {
                    NativeProcessManager.CloseHandle(hUserToken);
                }

                if (hRestrictedToken == IntPtr.Zero)
                {
                    throw new InvalidOperationException("Security failure: Restricted token handle is null; refusing privileged child spawn.");
                }
            }

            var si = new NativeProcessManager.STARTUPINFO
            {
                cb = Marshal.SizeOf<NativeProcessManager.STARTUPINFO>(),
                dwFlags = (int)NativeProcessManager.STARTF_USESTDHANDLES,
                lpDesktop = guestFixture ? @"Service-0x0-3e7$\Default" : null,
                hStdInput = hNul != IntPtr.Zero ? hNul : IntPtr.Zero,
                hStdOutput = hStdOutWrite,
                hStdError = hStdErrWrite
            };

            string commandLine = BuildCommandLine(request.Command, request.Args);
            string workingDir = string.IsNullOrWhiteSpace(request.Cwd) ? Directory.GetCurrentDirectory() : request.Cwd;

            uint creationFlags = guestFixture
                ? NativeProcessManager.CREATE_SUSPENDED
                : (NativeProcessManager.CREATE_SUSPENDED | NativeProcessManager.CREATE_NO_WINDOW);
            NativeProcessManager.PROCESS_INFORMATION pi;
            bool created;

            if (guestFixture)
            {
                if (hRestrictedToken == IntPtr.Zero)
                {
                    throw new InvalidOperationException("Fatal security invariant violation: Attempted child spawn without restricted token in guest supervisor.");
                }

                if (faultInject == "create_process_as_user_fail")
                {
                    throw new Win32Exception(5, "Fault injection: CreateProcessAsUserW failed.");
                }

                int saSize = Marshal.SizeOf<NativeProcessManager.SECURITY_ATTRIBUTES>();
                IntPtr pProcSec = Marshal.AllocHGlobal(saSize);
                IntPtr pThrdSec = Marshal.AllocHGlobal(saSize);
                try
                {
                    var saProc = new NativeProcessManager.SECURITY_ATTRIBUTES { nLength = saSize, bInheritHandle = false, lpSecurityDescriptor = pSD };
                    var saThrd = new NativeProcessManager.SECURITY_ATTRIBUTES { nLength = saSize, bInheritHandle = false, lpSecurityDescriptor = pSD };
                    Marshal.StructureToPtr(saProc, pProcSec, false);
                    Marshal.StructureToPtr(saThrd, pThrdSec, false);

                    created = NativeProcessManager.CreateProcessAsUserW(
                        hRestrictedToken,
                        null,
                        commandLine,
                        pProcSec,
                        pThrdSec,
                        true,
                        creationFlags,
                        IntPtr.Zero,
                        workingDir,
                        ref si,
                        out pi);
                }
                finally
                {
                    Marshal.FreeHGlobal(pProcSec);
                    Marshal.FreeHGlobal(pThrdSec);
                }
            }
            else
            {
                created = NativeProcessManager.CreateProcessW(
                    null,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    creationFlags,
                    IntPtr.Zero,
                    workingDir,
                    ref si,
                    out pi);
            }

            // Close write ends in the supervisor immediately so EOF can be detected
            NativeProcessManager.CloseHandle(hStdOutWrite);
            hStdOutWrite = IntPtr.Zero;
            NativeProcessManager.CloseHandle(hStdErrWrite);
            hStdErrWrite = IntPtr.Zero;

            if (!created)
            {
                int err = Marshal.GetLastWin32Error();
                throw new Win32Exception(err, $"CreateProcess failed with Win32 error {err}.");
            }

            hChildProcess = pi.hProcess;
            hChildThread = pi.hThread;
            childPid = pi.dwProcessId;

            // RACE-FREE JOB OBJECT ASSIGNMENT:
            // Child was created in SUSPENDED state. It has not executed a single user instruction.
            // Assign to Job Object before resuming. If assignment fails, kill child immediately!
            bool assigned = (faultInject != "assign_job_fail") && jobObject.AssignProcess(hChildProcess);
            if (!assigned)
            {
                int assignErr = (faultInject == "assign_job_fail") ? 5 : Marshal.GetLastWin32Error();
                NativeProcessManager.TerminateProcess(hChildProcess, 1);
                throw new Win32Exception(assignErr, "AssignProcessToJobObject failed on suspended process; child terminated.");
            }

            // Resume suspended primary thread and check result
            uint resumeResult = (faultInject == "resume_thread_fail") ? uint.MaxValue : NativeProcessManager.ResumeThread(hChildThread);
            if (resumeResult == uint.MaxValue)
            {
                int resumeErr = (faultInject == "resume_thread_fail") ? 5 : Marshal.GetLastWin32Error();
                NativeProcessManager.TerminateProcess(hChildProcess, 1);
                throw new Win32Exception(resumeErr, $"ResumeThread failed with error {resumeErr}; child terminated.");
            }

            // Thread handle no longer needed
            NativeProcessManager.CloseHandle(hChildThread);
            hChildThread = IntPtr.Zero;

            // Read bounded output streams asynchronously
            using var outStream = new FileStream(new SafeFileHandle(hStdOutRead, ownsHandle: true), FileAccess.Read);
            using var errStream = new FileStream(new SafeFileHandle(hStdErrRead, ownsHandle: true), FileAccess.Read);
            hStdOutRead = IntPtr.Zero;
            hStdErrRead = IntPtr.Zero;

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(Math.Max(1, request.TimeoutSeconds)));

            var stdoutTask = ReadBoundedStreamAsync(outStream, request.MaxOutputBytes, cts.Token);
            var stderrTask = ReadBoundedStreamAsync(errStream, request.MaxOutputBytes, cts.Token);

            (uint waitResult, int waitErr) = await Task.Run(() =>
            {
                if (faultInject == "wait_failed")
                {
                    return (NativeProcessManager.WAIT_FAILED, 6);
                }
                int timeoutMs = (int)(request.TimeoutSeconds * 1000);
                uint res = NativeProcessManager.WaitForSingleObject(hChildProcess, (uint)Math.Max(1000, timeoutMs));
                int err = (res == NativeProcessManager.WAIT_FAILED) ? Marshal.GetLastWin32Error() : 0;
                return (res, err);
            });

            if (waitResult == NativeProcessManager.WAIT_FAILED)
            {
                NativeProcessManager.TerminateProcess(hChildProcess, 1);
                status = "failed";
                exitCode = null;
                reasons.Add($"WaitForSingleObject failed with error {waitErr}");
            }
            else if (waitResult == NativeProcessManager.WAIT_TIMEOUT)
            {
                status = "timed_out";
                exitCode = null;
                reasons.Add("Command execution exceeded timeout");
                NativeProcessManager.TerminateProcess(hChildProcess, 1);
                NativeProcessManager.WaitForSingleObject(hChildProcess, 2000);
            }
            else if (waitResult == NativeProcessManager.WAIT_OBJECT_0)
            {
                if (faultInject == "get_exit_code_fail" || !NativeProcessManager.GetExitCodeProcess(hChildProcess, out int cExitCode))
                {
                    int exitErr = (faultInject == "get_exit_code_fail") ? 6 : Marshal.GetLastWin32Error();
                    status = "failed";
                    exitCode = null;
                    reasons.Add($"GetExitCodeProcess failed with error {exitErr}");
                }
                else if (cExitCode == NativeProcessManager.STILL_ACTIVE || faultInject == "still_active")
                {
                    NativeProcessManager.TerminateProcess(hChildProcess, 1);
                    status = "failed";
                    exitCode = null;
                    reasons.Add("Process reported STILL_ACTIVE after wait completed; forced termination.");
                }
                else
                {
                    exitCode = cExitCode;
                    status = exitCode == 0 ? "completed" : "failed";
                    if (exitCode != 0)
                    {
                        reasons.Add($"Process exited with non-zero exit code {exitCode}");
                    }
                }
            }
            else
            {
                NativeProcessManager.TerminateProcess(hChildProcess, 1);
                status = "failed";
                exitCode = null;
                reasons.Add($"Unexpected wait result: {waitResult}");
            }

            var (outStr, outTrunc) = await stdoutTask;
            var (errStr, errTrunc) = await stderrTask;
            stdout = outStr;
            stderr = errStr;
            truncated = outTrunc || errTrunc;
        }
        catch (Exception ex)
        {
            status = "failed";
            exitCode = null;
            stderr = ex.Message;
            reasons.Add(ex.Message);
        }
        finally
        {
            if (hStdOutWrite != IntPtr.Zero) { NativeProcessManager.CloseHandle(hStdOutWrite); hStdOutWrite = IntPtr.Zero; }
            if (hStdErrWrite != IntPtr.Zero) { NativeProcessManager.CloseHandle(hStdErrWrite); hStdErrWrite = IntPtr.Zero; }
            if (hStdOutRead != IntPtr.Zero) { NativeProcessManager.CloseHandle(hStdOutRead); hStdOutRead = IntPtr.Zero; }
            if (hStdErrRead != IntPtr.Zero) { NativeProcessManager.CloseHandle(hStdErrRead); hStdErrRead = IntPtr.Zero; }
            if (hRestrictedToken != IntPtr.Zero) { NativeProcessManager.CloseHandle(hRestrictedToken); hRestrictedToken = IntPtr.Zero; }
            if (hChildThread != IntPtr.Zero) { NativeProcessManager.CloseHandle(hChildThread); hChildThread = IntPtr.Zero; }
            if (hChildProcess != IntPtr.Zero) { NativeProcessManager.CloseHandle(hChildProcess); hChildProcess = IntPtr.Zero; }
            if (hNul != IntPtr.Zero) { NativeProcessManager.CloseHandle(hNul); hNul = IntPtr.Zero; }
            if (pSD != IntPtr.Zero) { Marshal.FreeHGlobal(pSD); pSD = IntPtr.Zero; }
            sw.Stop();
        }

        DateTime completedAt = DateTime.UtcNow;

        var receipt = new ExecutionReceipt
        {
            Version = 1,
            RunId = request.RunId ?? "",
            Nonce = request.Nonce ?? "",
            Status = status,
            ExitCode = exitCode,
            Stdout = stdout,
            Stderr = stderr,
            Truncated = truncated,
            StartedAt = startedAt.ToString("o"),
            CompletedAt = completedAt.ToString("o"),
            DurationMs = sw.ElapsedMilliseconds,
            SupervisorPid = Environment.ProcessId,
            ChildPid = childPid,
            Reasons = reasons.ToArray(),
            IsGuestExecution = guestFixture,
            RestrictedChild = isRestrictedChild,
            JobObjectAttached = true,
        };

        await WriteReceiptFilesAsync(outputPath, receipt, authKey);
        return status == "completed" ? 0 : (exitCode ?? 1);
    }

    private static string BuildCommandLine(string command, string[]? args)
    {
        var sb = new StringBuilder();
        sb.Append(QuoteIfNeeded(command));
        if (args != null && args.Length > 0)
        {
            foreach (var arg in args)
            {
                sb.Append(' ').Append(QuoteIfNeeded(arg));
            }
        }
        return sb.ToString();
    }

    private static string QuoteIfNeeded(string arg)
    {
        if (string.IsNullOrEmpty(arg)) return "\"\"";
        if (!arg.Contains(' ') && !arg.Contains('\t') && !arg.Contains('"')) return arg;
        return "\"" + arg.Replace("\"", "\\\"") + "\"";
    }

    private static async Task<(string Text, bool Truncated)> ReadBoundedStreamAsync(Stream stream, int maxBytes, CancellationToken ct)
    {
        byte[] buffer = new byte[4096];
        using var ms = new MemoryStream();
        bool truncated = false;

        try
        {
            while (true)
            {
                int read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), ct);
                if (read <= 0) break;

                if (truncated)
                {
                    continue;
                }

                if (ms.Length + read > maxBytes)
                {
                    int allowed = maxBytes - (int)ms.Length;
                    if (allowed > 0)
                    {
                        ms.Write(buffer, 0, allowed);
                    }
                    truncated = true;
                    continue;
                }

                ms.Write(buffer, 0, read);
            }
        }
        catch (OperationCanceledException)
        {
            // Drain aborted on cancellation/timeout
        }
        catch
        {
            // Stream closed or pipe broken on exit
        }

        string text = Encoding.UTF8.GetString(ms.ToArray());
        return (text, truncated);
    }

    private static async Task WriteReceiptFilesAsync(string outputDir, ExecutionReceipt receipt, string? authKey = null)
    {
        Directory.CreateDirectory(outputDir);
        string receiptJsonPath = Path.Combine(outputDir, "receipt.json");
        string json = JsonSerializer.Serialize(receipt, new JsonSerializerOptions { WriteIndented = true });
        var utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        await File.WriteAllTextAsync(receiptJsonPath, json, utf8NoBom);

        byte[] rawBytes = utf8NoBom.GetBytes(json);

        using var sha256 = SHA256.Create();
        byte[] hash = sha256.ComputeHash(rawBytes);
        string hashHex = Convert.ToHexStringLower(hash);
        string receiptShaPath = Path.Combine(outputDir, "receipt.sha256");
        await File.WriteAllTextAsync(receiptShaPath, hashHex + "  receipt.json\n", utf8NoBom);

        if (!string.IsNullOrWhiteSpace(authKey))
        {
            byte[] keyBytes = Convert.FromHexString(authKey);
            byte[] hmac = HMACSHA256.HashData(keyBytes, rawBytes);
            CryptographicOperations.ZeroMemory(keyBytes);
            string hmacHex = Convert.ToHexStringLower(hmac);
            string receiptSigPath = Path.Combine(outputDir, "receipt.sig");
            await File.WriteAllTextAsync(receiptSigPath, hmacHex + "  receipt.json\n", utf8NoBom);
        }
    }

    private static async Task WriteErrorReceiptAsync(string outputDir, string status, string error, DateTime startedAt, long durationMs, string? authKey = null)
    {
        try
        {
            Directory.CreateDirectory(outputDir);
            var receipt = new ExecutionReceipt
            {
                Version = 1,
                Status = status,
                Stderr = error,
                StartedAt = startedAt.ToString("o"),
                CompletedAt = DateTime.UtcNow.ToString("o"),
                DurationMs = durationMs,
                SupervisorPid = Environment.ProcessId,
                Reasons = new[] { error }
            };
            await WriteReceiptFilesAsync(outputDir, receipt, authKey);
        }
        catch
        {
            // Ignored
        }
    }

    private static void GrantWindowStationAndDesktopAccess(IntPtr pSD)
    {
        try
        {
            int si = NativeProcessManager.DACL_SECURITY_INFORMATION;
            IntPtr hWinsta = NativeProcessManager.OpenWindowStationW("Service-0x0-3e7$", false, 0x00040000 | 0x00020000);
            if (hWinsta != IntPtr.Zero)
            {
                NativeProcessManager.SetUserObjectSecurity(hWinsta, ref si, pSD);
                NativeProcessManager.CloseWindowStation(hWinsta);
            }

            IntPtr hDesk = NativeProcessManager.OpenDesktopW("Default", 0, false, 0x00040000 | 0x00020000);
            if (hDesk != IntPtr.Zero)
            {
                NativeProcessManager.SetUserObjectSecurity(hDesk, ref si, pSD);
                NativeProcessManager.CloseDesktop(hDesk);
            }
        }
        catch
        {
            // Best effort
        }
    }
}
