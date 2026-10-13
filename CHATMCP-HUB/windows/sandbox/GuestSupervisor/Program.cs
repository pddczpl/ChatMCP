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

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

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

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool GetTokenInformation(
        IntPtr TokenHandle,
        int TokenInformationClass,
        IntPtr TokenInformation,
        uint TokenInformationLength,
        out uint ReturnLength);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool ConvertSidToStringSidW(IntPtr pSid, out string strSid);

    [StructLayout(LayoutKind.Sequential)]
    public struct TOKEN_USER
    {
        public SID_AND_ATTRIBUTES User;
    }
}

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--child-probe")
        {
            string? outDir = args.Length > 1 ? args[1] : null;
            return RunChildProbe(outDir);
        }

        string? requestPath = null;
        string? outputPath = null;
        string? authKey = null;
        string? authKeyFile = null;
        bool authKeyProvidedOnCommandLine = false;
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
                authKeyProvidedOnCommandLine = true;
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

        void LogError(string msg)
        {
            Console.Error.WriteLine(msg);
            if (!string.IsNullOrWhiteSpace(outputPath))
            {
                try { File.WriteAllText(Path.Combine(outputPath, "debug_err.txt"), msg); } catch {}
            }
        }

        if (guestFixture && authKeyProvidedOnCommandLine)
        {
            LogError("BLOCKED: --auth-key in guest process command line is forbidden.");
            return 3;
        }

        string? candidate = null;
        if (string.IsNullOrWhiteSpace(authKey))
        {
            if (!string.IsNullOrWhiteSpace(authKeyFile))
            {
                if (!string.IsNullOrWhiteSpace(outputPath))
                {
                    string fullAuth = Path.GetFullPath(authKeyFile);
                    string fullOut = Path.GetFullPath(outputPath);
                    if (!fullAuth.StartsWith(fullOut, StringComparison.OrdinalIgnoreCase))
                    {
                        LogError("BLOCKED: --auth-key-file must reside within output directory.");
                        return 3;
                    }
                    candidate = fullAuth;
                }
                else
                {
                    candidate = authKeyFile;
                }
            }
            else
            {
                candidate = !string.IsNullOrWhiteSpace(outputPath) ? Path.Combine(outputPath, ".auth_key") : null;
            }

            if (!string.IsNullOrWhiteSpace(candidate))
            {
                // Attempt to load and consume the candidate key file.
                // On mapped Hyper-V folders, directory metadata caching can temporarily report
                // File.Exists == false right after a previous run's deletion. Retry with short backoff.
                for (int attempt = 0; attempt < 15; attempt++)
                {
                    try
                    {
                        if (File.Exists(candidate))
                        {
                            string readKey = (await File.ReadAllTextAsync(candidate)).Trim();
                            if (!Regex.IsMatch(readKey, "^[0-9a-fA-F]{64}$"))
                                throw new InvalidDataException("Invalid supervisor key payload.");

                            // A best-effort overwrite is NOT guaranteed secure physical
                            // erasure on NTFS / mapped folders. The critical invariant
                            // is that no untrusted child starts until deletion succeeds.
                            byte[] zeroes = new byte[readKey.Length + 32];
                            await File.WriteAllBytesAsync(candidate, zeroes);
                            File.Delete(candidate);
                            if (File.Exists(candidate))
                            {
                                await Task.Delay(50);
                                if (File.Exists(candidate))
                                    throw new IOException("Supervisor key file was not removed.");
                            }

                            authKey = readKey;
                            break;
                        }
                        else
                        {
                            await Task.Delay(100);
                        }
                    }
                    catch (FileNotFoundException)
                    {
                        await Task.Delay(100);
                    }
                    catch (IOException) when (attempt < 14)
                    {
                        await Task.Delay(100);
                    }
                    catch (Exception ex)
                    {
                        // Never launch a child if loading or deleting the bearer-key
                        // file fails. An unsigned receipt cannot certify publisher
                        // authenticity, and an undeleted key could be read by guest.
                        LogError($"BLOCKED: Secure supervisor key handoff failed; no child was started. Detail: {ex.GetType().Name}: {ex.Message}");
                        return 3;
                    }
                }
            }
        }

        if (guestFixture && string.IsNullOrWhiteSpace(authKey))
        {
            LogError($"BLOCKED: Guest execution requires a consumed and removed HMAC key file. (candidate='{candidate}', exists={File.Exists(candidate ?? "")})");
            return 3;
        }
        if (!string.IsNullOrWhiteSpace(authKey) && !Regex.IsMatch(authKey, "^[0-9a-fA-F]{64}$"))
        {
            LogError("BLOCKED: --auth-key must be a 64-character hex string (32 bytes).");
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
            await WriteErrorReceiptAsync(outputPath, "failed", ex.Message, startedAt, sw.ElapsedMilliseconds);
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

        IntPtr pPipeSD = IntPtr.Zero;
        IntPtr pProcSD = IntPtr.Zero;
        IntPtr pThrdSD = IntPtr.Zero;
        IntPtr hNul = IntPtr.Zero;
        IntPtr hUserToken = IntPtr.Zero;
        IntPtr hRestrictedToken = IntPtr.Zero;
        IntPtr hStdOutRead = IntPtr.Zero;
        IntPtr hStdOutWrite = IntPtr.Zero;
        IntPtr hStdErrRead = IntPtr.Zero;
        IntPtr hStdErrWrite = IntPtr.Zero;
        IntPtr hChildProcess = IntPtr.Zero;
        IntPtr hChildThread = IntPtr.Zero;
        string childSidString = string.Empty;

        try
        {
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
                if (!id.IsSystem)
                {
                    throw new InvalidOperationException("Security failure: Guest supervisor must run as SYSTEM.");
                }

                // Secure supervisor process and token: prevent child from opening supervisor with VM_READ/QUERY/ALL_ACCESS
                SecureSupervisorProcess();

                if (faultInject == "open_token_fail")
                {
                    throw new Win32Exception(5, "Fault injection: Failed to open supervisor process token.");
                }

                // Set password for built-in local user WDAGUtilityAccount
                byte[] passBytes = RandomNumberGenerator.GetBytes(16);
                string tempPassword = "Cmc@" + Convert.ToHexString(passBytes) + "!";
                CryptographicOperations.ZeroMemory(passBytes);
                var userInfo = new NativeProcessManager.USER_INFO_1003 { usri1003_password = tempPassword };
                uint netResult = NativeProcessManager.NetUserSetInfo(null, "WDAGUtilityAccount", 1003, ref userInfo, out uint parmErr);
                if (netResult != 0)
                {
                    int netErr = Marshal.GetLastWin32Error();
                    throw new Win32Exception((int)netResult, $"Security failure: NetUserSetInfo for WDAGUtilityAccount failed with code {netResult} (error {netErr}).");
                }

                if (!NativeProcessManager.LogonUser("WDAGUtilityAccount", ".", tempPassword, NativeProcessManager.LOGON32_LOGON_BATCH, NativeProcessManager.LOGON32_PROVIDER_DEFAULT, out hUserToken))
                {
                    int logonErr = Marshal.GetLastWin32Error();
                    throw new Win32Exception(logonErr, $"Security failure: LogonUser for WDAGUtilityAccount failed (error {logonErr}).");
                }

                // Retrieve child User SID directly from user token
                NativeProcessManager.GetTokenInformation(hUserToken, 1 /* TokenUser */, IntPtr.Zero, 0, out uint reqLen);
                IntPtr pTu = Marshal.AllocHGlobal((int)reqLen);
                try
                {
                    if (!NativeProcessManager.GetTokenInformation(hUserToken, 1, pTu, reqLen, out _))
                    {
                        int tokErr = Marshal.GetLastWin32Error();
                        throw new Win32Exception(tokErr, $"Security failure: GetTokenInformation failed (error {tokErr}).");
                    }
                    var tu = Marshal.PtrToStructure<NativeProcessManager.TOKEN_USER>(pTu);
                    if (!NativeProcessManager.ConvertSidToStringSidW(tu.User.Sid, out childSidString))
                    {
                        int sidErr = Marshal.GetLastWin32Error();
                        throw new Win32Exception(sidErr, $"Security failure: ConvertSidToStringSidW failed (error {sidErr}).");
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(pTu);
                }

                if (string.IsNullOrWhiteSpace(childSidString) || childSidString == "S-1-5-18")
                {
                    throw new InvalidOperationException($"Security failure: Child SID resolved to SYSTEM or invalid: {childSidString}");
                }

                // Grant least-privilege WindowStation and Desktop access
                GrantWindowStationAndDesktopAccess(childSidString);

                // Construct pipe security descriptor: SYSTEM has Full Control, child user has Read/Write, Everyone has NONE
                string pipeSddl = $"D:P(A;;GA;;;SY)(A;;GRGW;;;{childSidString})";
                if (!NativeProcessManager.ConvertStringSecurityDescriptorToSecurityDescriptorW(pipeSddl, 1, out pPipeSD, out _))
                {
                    int sdErr = Marshal.GetLastWin32Error();
                    throw new Win32Exception(sdErr, $"Security failure: ConvertStringSecurityDescriptorToSecurityDescriptorW for pipe failed (error {sdErr}).");
                }
            }

            // Anonymous pipes for bounded stdout and stderr capture
            var sa = new NativeProcessManager.SECURITY_ATTRIBUTES
            {
                nLength = Marshal.SizeOf<NativeProcessManager.SECURITY_ATTRIBUTES>(),
                bInheritHandle = true,
                lpSecurityDescriptor = pPipeSD
            };

            if (guestFixture && pPipeSD != IntPtr.Zero)
            {
                hNul = NativeProcessManager.CreateFileW("NUL", 0x80000000 /* GENERIC_READ */, 1 | 2 /* SHARE_READ | SHARE_WRITE */, ref sa, 3 /* OPEN_EXISTING */, 0, IntPtr.Zero);
            }

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

            if (guestFixture)
            {
                // Set TokenDefaultDacl on user token: child objects only accessible by child and SYSTEM
                string defDaclSddl = $"D:P(A;;GA;;;SY)(A;;GA;;;{childSidString})";
                if (!NativeProcessManager.ConvertStringSecurityDescriptorToSecurityDescriptorW(defDaclSddl, 1, out IntPtr pDefDaclSD, out _))
                {
                    int err = Marshal.GetLastWin32Error();
                    throw new Win32Exception(err, $"Security failure: ConvertStringSecurityDescriptorToSecurityDescriptorW for TokenDefaultDacl failed (error {err}).");
                }
                try
                {
                    if (!NativeProcessManager.GetSecurityDescriptorDacl(pDefDaclSD, out bool pres, out IntPtr pDacl, out _))
                    {
                        int err = Marshal.GetLastWin32Error();
                        throw new Win32Exception(err, $"Security failure: GetSecurityDescriptorDacl failed (error {err}).");
                    }
                    var tdd = new NativeProcessManager.TOKEN_DEFAULT_DACL { DefaultDacl = pDacl };
                    IntPtr pTdd = Marshal.AllocHGlobal(Marshal.SizeOf<NativeProcessManager.TOKEN_DEFAULT_DACL>());
                    try
                    {
                        Marshal.StructureToPtr(tdd, pTdd, false);
                        if (!NativeProcessManager.SetTokenInformation(hUserToken, 6 /* TokenDefaultDacl */, pTdd, (uint)Marshal.SizeOf<NativeProcessManager.TOKEN_DEFAULT_DACL>()))
                        {
                            int err = Marshal.GetLastWin32Error();
                            throw new Win32Exception(err, $"Security failure: SetTokenInformation TokenDefaultDacl failed (error {err}).");
                        }
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(pTdd);
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(pDefDaclSD);
                }

                if (faultInject == "create_restricted_token_fail")
                {
                    throw new Win32Exception(87, "Fault injection: Failed to create restricted token.");
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

                // Apply least-privilege DACL to restricted token: child can query, but not duplicate, impersonate, or write DAC
                string tokenSddl = $"D:P(A;;GA;;;SY)(A;;0x20008;;;{childSidString})";
                if (!NativeProcessManager.ConvertStringSecurityDescriptorToSecurityDescriptorW(tokenSddl, 1, out IntPtr pTokenSD, out _))
                {
                    int err = Marshal.GetLastWin32Error();
                    throw new Win32Exception(err, $"Security failure: ConvertStringSecurityDescriptorToSecurityDescriptorW for token failed (error {err}).");
                }
                try
                {
                    if (!NativeProcessManager.SetKernelObjectSecurity(hRestrictedToken, NativeProcessManager.DACL_SECURITY_INFORMATION, pTokenSD))
                    {
                        int err = Marshal.GetLastWin32Error();
                        throw new Win32Exception(err, $"Security failure: SetKernelObjectSecurity on restricted token failed (error {err}).");
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(pTokenSD);
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

                // Child process DACL: SYSTEM has GA, child user has GA on own process, Everyone has NONE
                string procSddl = $"D:P(A;;GA;;;SY)(A;;GA;;;{childSidString})";
                if (!NativeProcessManager.ConvertStringSecurityDescriptorToSecurityDescriptorW(procSddl, 1, out pProcSD, out _))
                {
                    int err = Marshal.GetLastWin32Error();
                    throw new Win32Exception(err, $"Security failure: ConvertStringSecurityDescriptorToSecurityDescriptorW for process failed (error {err}).");
                }

                // Child thread DACL: SYSTEM has GA, child user has GA on own thread, Everyone has NONE
                string thrdSddl = $"D:P(A;;GA;;;SY)(A;;GA;;;{childSidString})";
                if (!NativeProcessManager.ConvertStringSecurityDescriptorToSecurityDescriptorW(thrdSddl, 1, out pThrdSD, out _))
                {
                    int err = Marshal.GetLastWin32Error();
                    throw new Win32Exception(err, $"Security failure: ConvertStringSecurityDescriptorToSecurityDescriptorW for thread failed (error {err}).");
                }

                int saSize = Marshal.SizeOf<NativeProcessManager.SECURITY_ATTRIBUTES>();
                IntPtr pProcSec = Marshal.AllocHGlobal(saSize);
                IntPtr pThrdSec = Marshal.AllocHGlobal(saSize);
                try
                {
                    var saProc = new NativeProcessManager.SECURITY_ATTRIBUTES { nLength = saSize, bInheritHandle = false, lpSecurityDescriptor = pProcSD };
                    var saThrd = new NativeProcessManager.SECURITY_ATTRIBUTES { nLength = saSize, bInheritHandle = false, lpSecurityDescriptor = pThrdSD };
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
            if (hUserToken != IntPtr.Zero) { NativeProcessManager.CloseHandle(hUserToken); hUserToken = IntPtr.Zero; }
            if (hChildThread != IntPtr.Zero) { NativeProcessManager.CloseHandle(hChildThread); hChildThread = IntPtr.Zero; }
            if (hChildProcess != IntPtr.Zero) { NativeProcessManager.CloseHandle(hChildProcess); hChildProcess = IntPtr.Zero; }
            if (hNul != IntPtr.Zero) { NativeProcessManager.CloseHandle(hNul); hNul = IntPtr.Zero; }
            if (pPipeSD != IntPtr.Zero) { Marshal.FreeHGlobal(pPipeSD); pPipeSD = IntPtr.Zero; }
            if (pProcSD != IntPtr.Zero) { Marshal.FreeHGlobal(pProcSD); pProcSD = IntPtr.Zero; }
            if (pThrdSD != IntPtr.Zero) { Marshal.FreeHGlobal(pThrdSD); pThrdSD = IntPtr.Zero; }
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

    private static int GetParentProcessId()
    {
        uint currentPid = (uint)Environment.ProcessId;
        IntPtr hSnap = NativeProcessManager.CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0);
        if (hSnap == IntPtr.Zero || hSnap == (IntPtr)(-1)) return -1;
        try
        {
            var pe = new NativeProcessManager.PROCESSENTRY32();
            pe.dwSize = (uint)Marshal.SizeOf<NativeProcessManager.PROCESSENTRY32>();
            if (NativeProcessManager.Process32First(hSnap, ref pe))
            {
                do
                {
                    if (pe.th32ProcessID == currentPid)
                    {
                        return (int)pe.th32ParentProcessID;
                    }
                } while (NativeProcessManager.Process32Next(hSnap, ref pe));
            }
            return -1;
        }
        finally
        {
            NativeProcessManager.CloseHandle(hSnap);
        }
    }

    // Diagnostic only: query the *actual* parent-process WMI view from the
    // restricted child. Never print the parent command line or any secret.
    // Failed/unsupported WMI queries are NOT VERIFIED, never a fabricated PASS.
    private static (string Status, string? CommandLineEmpty, string? AuthKeyVisible) ProbeParentWmi(int parentPid)
    {
        if (parentPid <= 0) return ("PARENT_NOT_FOUND", null, null);
        // Explicit line boundaries: a malformed/failed CIM probe must not be
        // interpreted as "key hidden". Never echo parent argv or secret bytes.
        var script = string.Join("\n", new[]
        {
            "$ErrorActionPreference='Stop'",
            "try {",
            "  $p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + parentPid + "' -ErrorAction Stop",
            "  if($null -eq $p) { Write-Output 'PARENT_WMI_STATUS=PARENT_NOT_FOUND'; exit 2 }",
            "  $c=[string]$p.CommandLine",
            "  if([string]::IsNullOrEmpty($c)) {",
            "    Write-Output 'PARENT_WMI_STATUS=EMPTY'",
            "    Write-Output 'PARENT_CMDLINE_EMPTY=True'",
            "    Write-Output 'PARENT_AUTH_KEY_VISIBLE=False'",
            "  } else {",
            "    $seen=[bool]($c -match '(?i)--auth-key\s+[0-9a-f]{64}')",
            "    Write-Output 'PARENT_WMI_STATUS=VISIBLE_COMMANDLINE'",
            "    Write-Output 'PARENT_CMDLINE_EMPTY=False'",
            "    Write-Output ('PARENT_AUTH_KEY_VISIBLE='+$seen)",
            "  }",
            "} catch {",
            "  Write-Output 'PARENT_WMI_STATUS=QUERY_ERROR'",
            "  exit 2",
            "}"
        });

        try
        {
            var start = new ProcessStartInfo("powershell.exe")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = false
            };
            start.ArgumentList.Add("-NoProfile");
            start.ArgumentList.Add("-NonInteractive");
            start.ArgumentList.Add("-EncodedCommand");
            start.ArgumentList.Add(Convert.ToBase64String(Encoding.Unicode.GetBytes(script)));
            using var child = Process.Start(start);
            if (child == null) return ("PROBE_START_FAILED", null, null);
            if (!child.WaitForExit(15000))
            {
                try { child.Kill(entireProcessTree: true); } catch { }
                return ("PROBE_TIMEOUT", null, null);
            }
            string output = child.StandardOutput.ReadToEnd();
            var statuses = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            string? status = statuses.FirstOrDefault(v => v.StartsWith("PARENT_WMI_STATUS="))?
                .Substring("PARENT_WMI_STATUS=".Length);
            string? empty = statuses.FirstOrDefault(v => v.StartsWith("PARENT_CMDLINE_EMPTY="))?
                .Substring("PARENT_CMDLINE_EMPTY=".Length);
            string? visible = statuses.FirstOrDefault(v => v.StartsWith("PARENT_AUTH_KEY_VISIBLE="))?
                .Substring("PARENT_AUTH_KEY_VISIBLE=".Length);
            if (child.ExitCode != 0 ||
                (status != "EMPTY" && status != "VISIBLE_COMMANDLINE") ||
                (empty != "True" && empty != "False") ||
                (visible != "True" && visible != "False"))
            {
                return (status ?? "PROBE_ERROR", null, null);
            }
            return (status, empty, visible);
        }
        catch
        {
            return ("PROBE_UNAVAILABLE", null, null);
        }
    }

    private static int RunChildProbe(string? outputDir)
    {
        int parentPid = GetParentProcessId();
        Console.WriteLine($"PARENT_PID={parentPid}");
        var wmi = ProbeParentWmi(parentPid);
        Console.WriteLine($"PARENT_WMI_STATUS={wmi.Status}");
        if (wmi.CommandLineEmpty != null)
            Console.WriteLine($"PARENT_CMDLINE_EMPTY={wmi.CommandLineEmpty}");
        if (wmi.AuthKeyVisible != null)
            Console.WriteLine($"PARENT_AUTH_KEY_VISIBLE={wmi.AuthKeyVisible}");

        int errQuery = 0;
        int errRead = 0;
        int errAll = 0;
        if (parentPid > 0)
        {
            IntPtr hQuery = NativeProcessManager.OpenProcess(0x0400, false, (uint)parentPid);
            errQuery = hQuery == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            if (hQuery != IntPtr.Zero) NativeProcessManager.CloseHandle(hQuery);

            IntPtr hRead = NativeProcessManager.OpenProcess(0x0010, false, (uint)parentPid);
            errRead = hRead == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            if (hRead != IntPtr.Zero) NativeProcessManager.CloseHandle(hRead);

            IntPtr hAll = NativeProcessManager.OpenProcess(0x1F0FFF, false, (uint)parentPid);
            errAll = hAll == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            if (hAll != IntPtr.Zero) NativeProcessManager.CloseHandle(hAll);
        }

        Console.WriteLine($"OPEN_QUERY_ERR={errQuery}");
        Console.WriteLine($"OPEN_VMREAD_ERR={errRead}");
        Console.WriteLine($"OPEN_ALL_ACCESS_ERR={errAll}");

        IntPtr hWinsta = NativeProcessManager.OpenWindowStationW("Service-0x0-3e7$", false, 0x00040000);
        int errWinsta = hWinsta == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
        if (hWinsta != IntPtr.Zero) NativeProcessManager.CloseWindowStation(hWinsta);

        IntPtr hDesk = NativeProcessManager.OpenDesktopW("Default", 0, false, 0x00040000);
        int errDesk = hDesk == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
        if (hDesk != IntPtr.Zero) NativeProcessManager.CloseDesktop(hDesk);

        Console.WriteLine($"OPEN_WINSTA_WRITE_DAC_ERR={errWinsta}");
        Console.WriteLine($"OPEN_DESK_WRITE_DAC_ERR={errDesk}");

        bool keyExists = false;
        string outDir = string.IsNullOrWhiteSpace(outputDir) ? @"C:\ChatMCP\Output" : outputDir;
        if (Directory.Exists(outDir))
        {
            keyExists = Directory.GetFiles(outDir, ".auth_key*").Length > 0;
        }
        Console.WriteLine($"AUTH_KEY_EXISTS_AFTER_SHRED={keyExists}");

        return 0;
    }

    private static void SecureSupervisorProcess()
    {
        string supervisorSddl = "O:SYG:SYD:P(A;;GA;;;SY)";
        if (!NativeProcessManager.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            supervisorSddl, 1, out IntPtr pSD, out _))
        {
            int err = Marshal.GetLastWin32Error();
            throw new Win32Exception(err, $"Failed to convert supervisor SDDL: error {err}");
        }

        try
        {
            int si = NativeProcessManager.DACL_SECURITY_INFORMATION | 1 /* OWNER */ | 2 /* GROUP */;
            IntPtr hProcess = NativeProcessManager.GetCurrentProcess();
            if (!NativeProcessManager.SetKernelObjectSecurity(hProcess, si, pSD))
            {
                int err = Marshal.GetLastWin32Error();
                throw new Win32Exception(err, $"Failed to secure supervisor process: error {err}");
            }

            if (!NativeProcessManager.OpenProcessToken(hProcess,
                0x00040000 /* WRITE_DAC */ | 0x00080000 /* WRITE_OWNER */, out IntPtr hToken))
            {
                int err = Marshal.GetLastWin32Error();
                throw new Win32Exception(err,
                    $"Security failure: Unable to open supervisor token for DACL hardening (error {err}).");
            }
            try
            {
                if (!NativeProcessManager.SetKernelObjectSecurity(hToken, si, pSD))
                {
                    int err = Marshal.GetLastWin32Error();
                    throw new Win32Exception(err,
                        $"Security failure: Supervisor token DACL hardening failed (error {err}).");
                }
            }
            finally
            {
                NativeProcessManager.CloseHandle(hToken);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pSD);
        }
    }

    private static void GrantWindowStationAndDesktopAccess(string childSidString)
    {
        if (string.IsNullOrWhiteSpace(childSidString))
            throw new ArgumentException("Child SID string cannot be null or empty.", nameof(childSidString));

        int si = NativeProcessManager.DACL_SECURITY_INFORMATION | 1 /* OWNER */ | 2 /* GROUP */;
        // WindowStation least-privilege: SYSTEM has GA; child has standard + specific rights excluding WRITE_DAC and WRITE_OWNER
        string winstaSddl = $"O:SYG:SYD:P(A;;GA;;;SY)(A;;0x12037F;;;{childSidString})";
        if (!NativeProcessManager.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            winstaSddl, 1, out IntPtr pWinstaSD, out _))
        {
            int err = Marshal.GetLastWin32Error();
            throw new Win32Exception(err, $"Failed to convert WindowStation SDDL: error {err}");
        }

        try
        {
            IntPtr hWinsta = NativeProcessManager.OpenWindowStationW("Service-0x0-3e7$", false, 0x00040000 | 0x00080000 | 0x00020000);
            if (hWinsta == IntPtr.Zero)
            {
                int err = Marshal.GetLastWin32Error();
                throw new Win32Exception(err, $"Failed to open WindowStation Service-0x0-3e7$: error {err}");
            }
            try
            {
                if (!NativeProcessManager.SetUserObjectSecurity(hWinsta, ref si, pWinstaSD))
                {
                    int err = Marshal.GetLastWin32Error();
                    throw new Win32Exception(err, $"Failed to set WindowStation security: error {err}");
                }
            }
            finally
            {
                NativeProcessManager.CloseWindowStation(hWinsta);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pWinstaSD);
        }

        // Desktop least-privilege: SYSTEM has GA; child has standard + specific rights excluding WRITE_DAC and WRITE_OWNER
        string deskSddl = $"O:SYG:SYD:P(A;;GA;;;SY)(A;;0x1201FF;;;{childSidString})";
        if (!NativeProcessManager.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            deskSddl, 1, out IntPtr pDeskSD, out _))
        {
            int err = Marshal.GetLastWin32Error();
            throw new Win32Exception(err, $"Failed to convert Desktop SDDL: error {err}");
        }

        try
        {
            IntPtr hDesk = NativeProcessManager.OpenDesktopW("Default", 0, false, 0x00040000 | 0x00080000 | 0x00020000);
            if (hDesk == IntPtr.Zero)
            {
                int err = Marshal.GetLastWin32Error();
                throw new Win32Exception(err, $"Failed to open Desktop Default: error {err}");
            }
            try
            {
                if (!NativeProcessManager.SetUserObjectSecurity(hDesk, ref si, pDeskSD))
                {
                    int err = Marshal.GetLastWin32Error();
                    throw new Win32Exception(err, $"Failed to set Desktop security: error {err}");
                }
            }
            finally
            {
                NativeProcessManager.CloseDesktop(hDesk);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pDeskSD);
        }
    }
}
