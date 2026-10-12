// ChatMCP Windows Sandbox Guest Supervisor (Phase 1, PR 2)
//
// EXPERIMENTAL HOST FIXTURE ONLY: this prototype cannot safely run arbitrary
// project code until suspended-process assignment, restricted child identity,
// and guest-owned receipt publication have been independently verified.
// Loads an UNAUTHENTICATED synthetic request and enforces bounded execution under a
// kill-on-close Windows Job Object, captures outputs, and produces an immutable receipt.

using System;
using System.Diagnostics;
using System.ComponentModel;
using System.Text.RegularExpressions;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

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
}

internal static class NativeJobObject
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
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
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    public sealed class SafeJobHandle : IDisposable
    {
        private IntPtr _handle;

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

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        string? requestPath = null;
        string? outputPath = null;
        bool hostFixture = false;

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
        }

        // Until a restricted identity + suspended Job Object launch is proven, never
        // silently accept this executable as a production in-guest supervisor.
        if (!hostFixture)
        {
            Console.Error.WriteLine("BLOCKED: GuestSupervisor is a host-only synthetic fixture; isolated execution is not implemented.");
            return 3;
        }

        if (string.IsNullOrWhiteSpace(requestPath) || string.IsNullOrWhiteSpace(outputPath))
        {
            Console.Error.WriteLine("Usage (synthetic fixture only): GuestSupervisor.exe --host-fixture --request <request.json> --output <output-directory>");
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
                throw new InvalidOperationException("Invalid or unsupported synthetic execution request.");
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
        var reasons = new List<string>();

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = request.Command,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = string.IsNullOrWhiteSpace(request.Cwd) ? Directory.GetCurrentDirectory() : request.Cwd,
            };

            if (request.Args != null && request.Args.Length > 0)
            {
                foreach (var arg in request.Args)
                {
                    psi.ArgumentList.Add(arg);
                }
            }

            using var process = new Process { StartInfo = psi };
            process.Start();
            childPid = process.Id;

            // The process may execute briefly before assignment: this is NOT a
            // suspended-start or a production security boundary. Fail closed on
            // assignment failure and do not publish a successful receipt.
            if (!jobObject.AssignProcess(process.Handle))
            {
                int nativeError = Marshal.GetLastWin32Error();
                try { process.Kill(entireProcessTree: true); process.WaitForExit(5000); } catch { }
                throw new Win32Exception(nativeError, "AssignProcessToJobObject failed; child terminated.");
            }

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(Math.Max(1, request.TimeoutSeconds)));

            var stdoutTask = ReadBoundedStreamAsync(process.StandardOutput.BaseStream, request.MaxOutputBytes, cts.Token);
            var stderrTask = ReadBoundedStreamAsync(process.StandardError.BaseStream, request.MaxOutputBytes, cts.Token);

            try
            {
                await process.WaitForExitAsync(cts.Token);
                var (outStr, outTrunc) = await stdoutTask;
                var (errStr, errTrunc) = await stderrTask;

                stdout = outStr;
                stderr = errStr;
                truncated = outTrunc || errTrunc;
                exitCode = process.ExitCode;

                if (exitCode == 0)
                {
                    status = "completed";
                }
                else
                {
                    status = "failed";
                    reasons.Add($"Process exited with non-zero exit code {exitCode}");
                }
            }
            catch (OperationCanceledException)
            {
                status = "timed_out";
                exitCode = null;
                reasons.Add("Command execution exceeded timeout");

                try
                {
                    process.Kill(entireProcessTree: true);
                }
                catch
                {
                    // Ignored on best-effort kill
                }
            }
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
            sw.Stop();
        }

        DateTime completedAt = DateTime.UtcNow;

        var receipt = new ExecutionReceipt
        {
            Version = 1,
            RunId = request.RunId,
            Nonce = request.Nonce,
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
        };

        await WriteReceiptFilesAsync(outputPath, receipt);
        return status == "completed" ? 0 : (exitCode ?? 1);
    }

    private static async Task<(string Text, bool Truncated)> ReadBoundedStreamAsync(Stream stream, int maxBytes, CancellationToken ct)
    {
        byte[] buffer = new byte[4096];
        using var ms = new MemoryStream();
        bool truncated = false;

        while (true)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), ct);
            if (read <= 0) break;

            if (truncated)
            {
                // Already reached byte limit; drain remaining bytes to avoid blocking child process
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

        // Emit SHA256 checksum
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
