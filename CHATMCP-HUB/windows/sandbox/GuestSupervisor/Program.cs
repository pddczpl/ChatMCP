// ChatMCP Windows Sandbox Guest Supervisor (Phase 1, PR 2)
//
// Provides bounded execution under a kill-on-close Windows Job Object,
// eliminates process-start races via CREATE_SUSPENDED, creates restricted
// tokens when running as privileged SYSTEM, captures bounded output streams,
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
}

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        string? requestPath = null;
        string? outputPath = null;
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

        // Anonymous pipes for bounded stdout and stderr capture
        var sa = new NativeProcessManager.SECURITY_ATTRIBUTES
        {
            nLength = Marshal.SizeOf<NativeProcessManager.SECURITY_ATTRIBUTES>(),
            bInheritHandle = true,
            lpSecurityDescriptor = IntPtr.Zero
        };

        if (!NativeProcessManager.CreatePipe(out IntPtr hStdOutRead, out IntPtr hStdOutWrite, ref sa, 0) ||
            !NativeProcessManager.CreatePipe(out IntPtr hStdErrRead, out IntPtr hStdErrWrite, ref sa, 0))
        {
            await WriteErrorReceiptAsync(outputPath, "error", "Failed to create I/O redirection pipes.", startedAt, sw.ElapsedMilliseconds);
            return 1;
        }

        // Ensure read ends are NOT inherited by the child process
        NativeProcessManager.SetHandleInformation(hStdOutRead, NativeProcessManager.HANDLE_FLAG_INHERIT, 0);
        NativeProcessManager.SetHandleInformation(hStdErrRead, NativeProcessManager.HANDLE_FLAG_INHERIT, 0);

        IntPtr hRestrictedToken = IntPtr.Zero;
        try
        {
            bool isSystem = false;
            if (OperatingSystem.IsWindows())
            {
                try
                {
                    using var id = WindowsIdentity.GetCurrent();
                    isSystem = id.IsSystem;
                }
                catch { }
            }

            // When running as privileged SYSTEM in guest, drop privileges to a restricted non-admin token
            if (isSystem && guestFixture)
            {
                if (NativeProcessManager.OpenProcessToken(
                    NativeProcessManager.GetCurrentProcess(),
                    NativeProcessManager.TOKEN_ASSIGN_PRIMARY | NativeProcessManager.TOKEN_DUPLICATE |
                    NativeProcessManager.TOKEN_QUERY | NativeProcessManager.TOKEN_ADJUST_DEFAULT,
                    out IntPtr hCurrentToken))
                {
                    try
                    {
                        if (NativeProcessManager.CreateRestrictedToken(
                            hCurrentToken,
                            NativeProcessManager.DISABLE_MAX_PRIVILEGE | NativeProcessManager.LUA_TOKEN,
                            0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero,
                            out hRestrictedToken))
                        {
                            isRestrictedChild = true;
                        }
                    }
                    finally
                    {
                        NativeProcessManager.CloseHandle(hCurrentToken);
                    }
                }
            }

            var si = new NativeProcessManager.STARTUPINFO
            {
                cb = Marshal.SizeOf<NativeProcessManager.STARTUPINFO>(),
                dwFlags = (int)NativeProcessManager.STARTF_USESTDHANDLES,
                hStdInput = IntPtr.Zero,
                hStdOutput = hStdOutWrite,
                hStdError = hStdErrWrite
            };

            string commandLine = BuildCommandLine(request.Command, request.Args);
            string workingDir = string.IsNullOrWhiteSpace(request.Cwd) ? Directory.GetCurrentDirectory() : request.Cwd;

            uint creationFlags = NativeProcessManager.CREATE_SUSPENDED | NativeProcessManager.CREATE_NO_WINDOW;
            NativeProcessManager.PROCESS_INFORMATION pi;
            bool created;

            if (hRestrictedToken != IntPtr.Zero)
            {
                created = NativeProcessManager.CreateProcessAsUserW(
                    hRestrictedToken,
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

            childPid = pi.dwProcessId;

            // RACE-FREE JOB OBJECT ASSIGNMENT:
            // Child was created in SUSPENDED state. It has not executed a single user instruction.
            // Assign to Job Object before resuming. If assignment fails, kill child immediately!
            if (!jobObject.AssignProcess(pi.hProcess))
            {
                int assignErr = Marshal.GetLastWin32Error();
                NativeProcessManager.TerminateProcess(pi.hProcess, 1);
                NativeProcessManager.CloseHandle(pi.hThread);
                NativeProcessManager.CloseHandle(pi.hProcess);
                throw new Win32Exception(assignErr, "AssignProcessToJobObject failed on suspended process; child terminated.");
            }

            // Now that the process is securely contained in the Job Object, resume execution
            NativeProcessManager.ResumeThread(pi.hThread);
            NativeProcessManager.CloseHandle(pi.hThread);

            // Read bounded output streams asynchronously
            using var outStream = new FileStream(new SafeFileHandle(hStdOutRead, ownsHandle: true), FileAccess.Read);
            using var errStream = new FileStream(new SafeFileHandle(hStdErrRead, ownsHandle: true), FileAccess.Read);
            hStdOutRead = IntPtr.Zero;
            hStdErrRead = IntPtr.Zero;

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(Math.Max(1, request.TimeoutSeconds)));

            var stdoutTask = ReadBoundedStreamAsync(outStream, request.MaxOutputBytes, cts.Token);
            var stderrTask = ReadBoundedStreamAsync(errStream, request.MaxOutputBytes, cts.Token);

            uint waitResult = await Task.Run(() =>
            {
                int timeoutMs = (int)(request.TimeoutSeconds * 1000);
                return NativeProcessManager.WaitForSingleObject(pi.hProcess, (uint)Math.Max(1000, timeoutMs));
            });

            if (waitResult == NativeProcessManager.WAIT_TIMEOUT)
            {
                status = "timed_out";
                exitCode = null;
                reasons.Add("Command execution exceeded timeout");
                NativeProcessManager.TerminateProcess(pi.hProcess, 1);
            }
            else
            {
                NativeProcessManager.GetExitCodeProcess(pi.hProcess, out int cExitCode);
                exitCode = cExitCode;
                status = exitCode == 0 ? "completed" : "failed";
                if (exitCode != 0)
                {
                    reasons.Add($"Process exited with non-zero exit code {exitCode}");
                }
            }

            NativeProcessManager.CloseHandle(pi.hProcess);

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
            if (hStdOutWrite != IntPtr.Zero) NativeProcessManager.CloseHandle(hStdOutWrite);
            if (hStdErrWrite != IntPtr.Zero) NativeProcessManager.CloseHandle(hStdErrWrite);
            if (hStdOutRead != IntPtr.Zero) NativeProcessManager.CloseHandle(hStdOutRead);
            if (hStdErrRead != IntPtr.Zero) NativeProcessManager.CloseHandle(hStdErrRead);
            if (hRestrictedToken != IntPtr.Zero) NativeProcessManager.CloseHandle(hRestrictedToken);
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

        await WriteReceiptFilesAsync(outputPath, receipt);
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

    private static async Task WriteReceiptFilesAsync(string outputDir, ExecutionReceipt receipt)
    {
        Directory.CreateDirectory(outputDir);
        string receiptJsonPath = Path.Combine(outputDir, "receipt.json");
        string json = JsonSerializer.Serialize(receipt, new JsonSerializerOptions { WriteIndented = true });
        var utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        await File.WriteAllTextAsync(receiptJsonPath, json, utf8NoBom);

        using var sha256 = SHA256.Create();
        byte[] hash = sha256.ComputeHash(utf8NoBom.GetBytes(json));
        string hashHex = Convert.ToHexStringLower(hash);
        string receiptShaPath = Path.Combine(outputDir, "receipt.sha256");
        await File.WriteAllTextAsync(receiptShaPath, hashHex + "  receipt.json\n", utf8NoBom);
    }

    private static async Task WriteErrorReceiptAsync(string outputDir, string status, string error, DateTime startedAt, long durationMs)
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
            await WriteReceiptFilesAsync(outputDir, receipt);
        }
        catch
        {
            // Ignored
        }
    }
}
