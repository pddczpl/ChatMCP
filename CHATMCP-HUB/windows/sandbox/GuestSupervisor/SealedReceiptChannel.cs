// Experimental G4 transport. The host must independently pin the SYSTEM launch,
// own the disposable guest, and keep production hostAttested=false until review.
// Exported JSON is untrusted; only an independently observed process ExitCode
// from this exact binary can carry a word of the guest-local protected digest.
using System.Buffers.Binary;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace ChatMCP.Sandbox.GuestSupervisor;

internal sealed class SealedReceiptChannel : IDisposable
{
    internal const string Input = @"C:\ChatMCP\Input";
    internal const string EnvelopePath = Input + @"\envelope.json";
    private const string SupervisorPath = Input + @"\GuestSupervisor.exe";
    private const string ToolchainPath = Input + @"\toolchain\node.exe";
    private const string Project = Input + @"\project";
    private const string Output = @"C:\ChatMCP\Output";
    private const string Domain = "ChatMCP.G4.SealedReceipt.v1\n";
    private const uint ReadControl = 0x20000, ReadAttributes = 0x80;
    private const uint GenericRead = 0x80000000, GenericWrite = 0x40000000;
    private const uint BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;
    private const string DirectorySddl = "O:SYG:SYD:P(A;OICI;FA;;;SY)";
    private const string FileSddl = "O:SYG:SYD:P(A;;FA;;;SY)";
    private static readonly Regex HashPattern = new("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
    private static readonly string[] EnvelopeFields = ["version", "instanceId", "generation", "runId", "nonce",
        "supervisorSha256", "toolchainSha256", "checkSha256", "snapshotSha256", "testBaselineSha256", "requestSha256", "reporterSha256", "graderSha256"];
    private readonly List<IDisposable> pins = [];
    private readonly HashSet<string> pinnedDirectories = new(StringComparer.OrdinalIgnoreCase);
    private byte[] envelopeBytes = [];
    private JsonDocument? envelope;
    private FileStream? sealStream;
    private bool sealedOnce;
    internal NativeBlackBoxGrader? Grader { get; private set; }

    internal static SealedReceiptChannel Create(string envelopePath, string requestPath, string outputPath, ExecutionRequest request)
    {
        RequireSystem();
        var channel = new SealedReceiptChannel();
        try
        {
            channel.LoadEnvelope(envelopePath);
            RequireExactPath(requestPath, Input + @"\request.json");
            RequireExactPath(outputPath, Output);
            byte[] requestBytes = channel.ReadAndPin(requestPath, 64 * 1024);
            channel.ExpectHash(requestBytes, "requestSha256");
            // Bind the object actually executed, not just a second read of a file.
            var actual = JsonSerializer.Deserialize(requestBytes, SupervisorJsonContext.Default.ExecutionRequest)
                ?? throw new InvalidDataException("Empty execution request.");
            if (JsonSerializer.Serialize(actual, SupervisorJsonContext.Default.ExecutionRequest) !=
                JsonSerializer.Serialize(request, SupervisorJsonContext.Default.ExecutionRequest))
                throw new InvalidDataException("Execution request changed before pinning.");
            if (request.RunId != channel.Get("runId") || request.Nonce != channel.Get("nonce"))
                throw new InvalidDataException("Execution request is not bound to envelope.");
            RequireExactPath(request.Command, ToolchainPath);
            RequireExactPath(request.Cwd ?? "", Project);
            channel.PinHash(ToolchainPath, "toolchainSha256", 256 * 1024 * 1024);
            if (request.Grader != null)
            {
                var spec = request.Grader;
                if (spec.Version != 1 || spec.Kind != "node-json-blackbox" ||
                    spec.ManifestSha256 != channel.Get("graderSha256") || channel.Get("reporterSha256") != new string('0', 64) ||
                    request.MaxOutputBytes > NativeBlackBoxGrader.MaxDocumentBytes)
                    throw new InvalidDataException("Invalid black-box request binding or output limit.");
                RequireExactPath(spec.ManifestPath, Input + @"\blackbox-check.json");
                byte[] manifest = channel.ReadAndPin(spec.ManifestPath, NativeBlackBoxGrader.MaxDocumentBytes);
                channel.ExpectHash(manifest, "graderSha256");
                channel.Grader = new NativeBlackBoxGrader(manifest, spec.ManifestSha256);
                if (request.Args == null || request.Args.Length != 1 || request.Args[0] != channel.Grader.AdapterPath)
                    throw new InvalidDataException("Black-box execution must invoke only its approved adapter.");
            }
            else
            {
                if (request.Args == null || request.Args.Length != 2 || request.Args[0] != "--test" ||
                    request.Args[1] != "--test-reporter=file:///C:/ChatMCP/Input/node-test-reporter.mjs" ||
                    channel.Get("graderSha256") != new string('0', 64))
                    throw new InvalidDataException("Only pinned Node --test with the pinned reporter is supported.");
                channel.PinHash(Input + @"\node-test-reporter.mjs", "reporterSha256", 64 * 1024);
            }
            channel.ValidateSnapshot();
            if (channel.Grader != null)
            {
                // The adapter must be a member of the validated complete project
                // snapshot, not merely some other readable guest-local file.
                channel.OpenAndPin(channel.Grader.AdapterPath, 8 * 1024 * 1024);
            }
            channel.PinDirectoryChain(Output);
            channel.OpenProtectedDirectory(create: true);
            channel.sealStream = channel.CreateNewSeal();
            return channel;
        }
        catch { channel.Dispose(); throw; }
    }

    private string Get(string key) => envelope!.RootElement.GetProperty(key).GetString()
        ?? throw new InvalidDataException("Missing envelope field.");

    private void LoadEnvelope(string path)
    {
        RequireExactPath(path, EnvelopePath);
        RequireExactPath(Environment.ProcessPath ?? "", SupervisorPath);
        envelopeBytes = ReadAndPin(path, 16 * 1024);
        envelope = JsonDocument.Parse(envelopeBytes, new JsonDocumentOptions { MaxDepth = 4 });
        if (envelope.RootElement.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Envelope must be an object.");
        var properties = envelope.RootElement.EnumerateObject().ToArray();
        if (properties.Length != EnvelopeFields.Length ||
            !properties.Select(p => p.Name).SequenceEqual(EnvelopeFields))
            throw new InvalidDataException("Envelope keys must be unique and in canonical order.");
        if (!envelope.RootElement.GetProperty("version").TryGetInt32(out int version) || version != 1)
            throw new InvalidDataException("Unsupported envelope version.");
        foreach (var key in new[] { "instanceId", "generation" })
            if (!Guid.TryParseExact(Get(key), "D", out var value) || value.ToString("D") != Get(key))
                throw new InvalidDataException("Expected canonical lowercase UUID.");
        if (!Regex.IsMatch(Get("runId"), "^[A-Za-z0-9_-]{1,128}$"))
            throw new InvalidDataException("Invalid run identifier.");
        foreach (var key in EnvelopeFields.Skip(4))
            if (!HashPattern.IsMatch(Get(key))) throw new InvalidDataException("Expected lowercase SHA-256 value.");
        // JSON.stringify for the restricted ASCII schema has exactly this encoding.
        using var canonical = new MemoryStream();
        using (var writer = new Utf8JsonWriter(canonical))
        {
            writer.WriteStartObject();
            writer.WriteNumber("version", 1);
            foreach (var key in EnvelopeFields.Skip(1)) writer.WriteString(key, Get(key));
            writer.WriteEndObject();
        }
        if (!canonical.ToArray().AsSpan().SequenceEqual(envelopeBytes))
            throw new InvalidDataException("Envelope bytes are not canonical.");
        PinHash(SupervisorPath, "supervisorSha256", 256 * 1024 * 1024);
    }

    private void ExpectHash(byte[] bytes, string field)
    {
        if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(bytes), Convert.FromHexString(Get(field))))
            throw new InvalidDataException("Pinned digest mismatch: " + field);
    }

    private void PinHash(string path, string field, int limit)
    {
        using var hash = SHA256.Create();
        var stream = OpenAndPin(path, limit);
        if (!CryptographicOperations.FixedTimeEquals(hash.ComputeHash(stream), Convert.FromHexString(Get(field))))
            throw new InvalidDataException("Pinned executable mismatch: " + field);
    }

    private void ValidateSnapshot()
    {
        byte[] manifestBytes = ReadAndPin(Input + @"\snapshot.json", 1024 * 1024);
        ExpectHash(manifestBytes, "snapshotSha256");
        if (Get("testBaselineSha256") != Get("snapshotSha256"))
            throw new InvalidDataException("Full granted snapshot must bind the baseline.");
        using var manifest = JsonDocument.Parse(manifestBytes);
        var files = manifest.RootElement.GetProperty("files");
        if (files.ValueKind != JsonValueKind.Array || files.GetArrayLength() is < 1 or > 256)
            throw new InvalidDataException("Unbounded snapshot file count.");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        foreach (var item in files.EnumerateArray())
        {
            string name = item.GetProperty("path").GetString() ?? "";
            ValidateRelativePath(name);
            if (!names.Add(name)) throw new InvalidDataException("Duplicate snapshot file.");
            long size = item.GetProperty("size").GetInt64();
            string hash = item.GetProperty("sha256").GetString() ?? "";
            if (size is < 0 or > 8 * 1024 * 1024 || !HashPattern.IsMatch(hash))
                throw new InvalidDataException("Invalid snapshot entry.");
            total += size;
            if (total > 48 * 1024 * 1024) throw new InvalidDataException("Snapshot is too large.");
            foreach (string root in new[] { Project })
            {
                var stream = OpenAndPin(Path.Combine(root, name.Replace('/', '\\')), 8 * 1024 * 1024);
                if (stream.Length != size || Convert.ToHexStringLower(SHA256.HashData(stream)) != hash)
                    throw new InvalidDataException("Snapshot content differs from its pinned manifest.");
            }
        }
        // Existing FILE_WRITE_DATA/DELETE handles conflict with these read-share
        // pins. The host readonly mapping also forbids new directory entries;
        // handle sharing alone does not revoke pre-existing WRITE_DAC rights.
        foreach (var root in new[] { Project })
        {
            var actual = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            ScanDirectory(root, root, actual, names.Count);
            if (!actual.SetEquals(names)) throw new InvalidDataException("Unexpected snapshot file.");
        }
    }

    private void ScanDirectory(string root, string dir, HashSet<string> actual, int limit)
    {
        PinDirectoryChain(dir);
        foreach (var entry in Directory.EnumerateFileSystemEntries(dir))
        {
            var attrs = File.GetAttributes(entry);
            if ((attrs & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Reparse entry in snapshot.");
            if ((attrs & FileAttributes.Directory) != 0) ScanDirectory(root, entry, actual, limit);
            else
            {
                actual.Add(Path.GetRelativePath(root, entry).Replace('\\', '/'));
                if (actual.Count > limit) throw new InvalidDataException("Unexpected snapshot content.");
            }
        }
    }

    internal static void ValidateRelativePath(string path)
    {
        if (path.Length is < 1 or > 1024 || path.Contains('\\') || path.Contains(':') || path.Contains('\0') ||
            path.Split('/').Any(p => p.Length == 0 || p is "." or ".." || p.EndsWith('.') || p.EndsWith(' ') ||
                Regex.IsMatch(p, "^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\..*)?$", RegexOptions.IgnoreCase)))
            throw new InvalidDataException("Unsafe snapshot path.");
    }

    private byte[] ReadAndPin(string path, int limit)
    {
        var stream = OpenAndPin(path, limit);
        byte[] bytes = new byte[checked((int)stream.Length)];
        stream.ReadExactly(bytes);
        return bytes;
    }

    private FileStream OpenAndPin(string path, int limit)
    {
        PinDirectoryChain(Path.GetDirectoryName(path)!);
        var handle = Open(path, GenericRead | ReadControl, share: 1, directory: false);
        try
        {
            ValidateHandle(handle, directory: false);
            var stream = new FileStream(handle, FileAccess.Read);
            pins.Add(stream);
            if (stream.Length < 0 || stream.Length > limit) throw new InvalidDataException("File exceeds input limit.");
            return stream;
        }
        catch { handle.Dispose(); throw; }
    }

    private void PinDirectoryChain(string path)
    {
        string full = Path.GetFullPath(path);
        if (!Regex.IsMatch(full, "^[A-Za-z]:\\\\") || full.IndexOf(':', 2) >= 0)
            throw new InvalidDataException("Only local DOS paths are permitted.");
        string? parent = Path.GetDirectoryName(full.TrimEnd('\\'));
        if (!string.IsNullOrEmpty(parent) && parent != full) PinDirectoryChain(parent);
        if (pinnedDirectories.Contains(full)) return;
        var handle = Open(full, ReadAttributes, share: 3, directory: true);
        try { ValidateHandle(handle, directory: true); pins.Add(handle); pinnedDirectories.Add(full); }
        catch { handle.Dispose(); throw; }
    }

    private static string WindowsDirectory()
    {
        var buffer = new StringBuilder(32768);
        uint length = Native.GetWindowsDirectoryW(buffer, (uint)buffer.Capacity);
        if (length == 0 || length >= buffer.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
        return buffer.ToString();
    }

    private static string StateDirectory => Path.Combine(WindowsDirectory(), "System32", "ChatMCP.G4");
    private string StatePath => Path.Combine(StateDirectory, Convert.ToHexStringLower(SHA256.HashData(envelopeBytes)) + ".bin");

    private void OpenProtectedDirectory(bool create)
    {
        string dir = StateDirectory;
        PinDirectoryChain(Path.GetDirectoryName(dir)!);
        // The parent is an OS-controlled System32 directory. Inspect its actual
        // handle DACL so an unexpectedly writable parent cannot replace the seal.
        using (var parent = Open(Path.GetDirectoryName(dir)!, ReadControl | ReadAttributes, 3, true))
        {
            var sd = Descriptor(parent);
            var trusted = new HashSet<string>(StringComparer.Ordinal) { "S-1-5-18", "S-1-5-32-544",
                "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" };
            if (sd.Owner == null || !trusted.Contains(sd.Owner.Value) || sd.DiscretionaryAcl == null)
                throw new InvalidDataException("Untrusted System32 owner or DACL.");
            const int mutation = 0x40000000 | 0x10000000 | 0x000D0156; // generic write/all, data, delete, owner/DACL
            foreach (GenericAce ace in sd.DiscretionaryAcl)
                if (ace is QualifiedAce allow && allow.AceQualifier == AceQualifier.AccessAllowed &&
                    (allow.AceFlags & AceFlags.InheritOnly) == 0 && (allow.AccessMask & mutation) != 0 &&
                    !trusted.Contains(allow.SecurityIdentifier.Value))
                    throw new InvalidDataException("System32 permits an untrusted writer.");
        }
        if (create)
        {
            IntPtr sd = SecurityDescriptor(DirectorySddl);
            try
            {
                var sa = Attributes(sd);
                if (!Native.CreateDirectoryW(dir, ref sa) && Marshal.GetLastWin32Error() != 183)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot create protected seal directory.");
            }
            finally { NativeProcessManager.LocalFree(sd); }
        }
        var handle = Open(dir, ReadControl | ReadAttributes, share: 3, directory: true);
        try
        {
            ValidateHandle(handle, directory: true);
            ValidateSystemOnly(handle, directory: true);
            pins.Add(handle);
        }
        catch { handle.Dispose(); throw; }
    }

    private FileStream CreateNewSeal()
    {
        IntPtr sd = SecurityDescriptor(FileSddl);
        try
        {
            var sa = Attributes(sd);
            var handle = Native.CreateFileW(StatePath, GenericRead | GenericWrite | ReadControl, 0, ref sa,
                1 /* CREATE_NEW, never overwrite a prior run */, OpenReparsePoint | 0x80000000 /* WRITE_THROUGH */, IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error(), "Seal already exists or cannot be created."); }
            try
            {
                ValidateHandle(handle, false);
                ValidateSystemOnly(handle, false);
                return new FileStream(handle, FileAccess.ReadWrite);
            }
            catch { handle.Dispose(); throw; }
        }
        finally { NativeProcessManager.LocalFree(sd); }
    }

    internal void Seal(byte[] receipt)
    {
        if (sealedOnce || sealStream == null || receipt.Length is < 1 or > 5 * 1024 * 1024)
            throw new InvalidOperationException("Invalid or repeated seal.");
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(Encoding.ASCII.GetBytes(Domain));
        byte[] size = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(size, (uint)envelopeBytes.Length);
        hash.AppendData(size);
        hash.AppendData(envelopeBytes);
        hash.AppendData(receipt);
        byte[] digest = hash.GetHashAndReset();
        // Magic + envelope digest + 256-bit receipt digest. A partially written
        // placeholder is rejected; no path-based replace or writable mapping.
        byte[] record = new byte[72];
        Encoding.ASCII.GetBytes("CMCSEAL1").CopyTo(record, 0);
        SHA256.HashData(envelopeBytes).CopyTo(record, 8);
        digest.CopyTo(record, 40);
        sealStream.Write(record);
        sealStream.Flush(flushToDisk: true);
        sealedOnce = true;
    }

    internal static void WriteNewExport(string path, byte[] bytes)
    {
        // An untrusted child can plant export entries. Never follow/overwrite one,
        // even when the eventual host verifier would reject its digest.
        var sa = Attributes(IntPtr.Zero);
        using var handle = Native.CreateFileW(path, GenericWrite | ReadAttributes, 0, ref sa,
            1 /* CREATE_NEW */, OpenReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Export path already exists or cannot be created.");
        ValidateHandle(handle, false);
        using var stream = new FileStream(handle, FileAccess.Write);
        stream.Write(bytes);
        stream.Flush(flushToDisk: true);
    }

    internal static int ReadWordCommand(string[] args)
    {
        try
        {
            RequireSystem(); // Check before parsing caller-supplied paths.
            if (args.Length != 3 || !int.TryParse(args[2], out int index) || index is < 0 or > 8 ||
                index.ToString(System.Globalization.CultureInfo.InvariantCulture) != args[2])
                throw new InvalidDataException("Expected digest word index 0 through 8.");
            using var channel = new SealedReceiptChannel();
            channel.LoadEnvelope(args[1]);
            channel.OpenProtectedDirectory(create: false);
            using var handle = Open(channel.StatePath, GenericRead | ReadControl, share: 1, directory: false);
            ValidateHandle(handle, directory: false);
            ValidateSystemOnly(handle, directory: false);
            using var stream = new FileStream(handle, FileAccess.Read);
            if (stream.Length != 72) throw new InvalidDataException("Incomplete seal.");
            byte[] record = new byte[72];
            stream.ReadExactly(record);
            if (!record.AsSpan(0, 8).SequenceEqual(Encoding.ASCII.GetBytes("CMCSEAL1")) ||
                !CryptographicOperations.FixedTimeEquals(record.AsSpan(8, 32), SHA256.HashData(channel.envelopeBytes)))
                throw new InvalidDataException("Seal does not bind this envelope.");
            uint payload = 0;
            for (int bit = index * 30; bit < index * 30 + 30; bit++)
                payload = (payload << 1) | (bit < 256 ? (uint)((record[40 + bit / 8] >> (7 - bit % 8)) & 1) : 0);
            return checked((int)(0x40000000u | payload));
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("BLOCKED: Digest word unavailable: " + ex.Message);
            return 3; // Never return a framed value on an error.
        }
    }

    private static void RequireSystem()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows required.");
        using var identity = WindowsIdentity.GetCurrent();
        if (!identity.IsSystem || identity.User?.Value != "S-1-5-18" ||
            identity.ImpersonationLevel != TokenImpersonationLevel.None)
            throw new UnauthorizedAccessException("An unimpersonated SYSTEM process is required.");
    }

    private static void RequireExactPath(string path, string expected)
    {
        if (!string.Equals(path, expected, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetFullPath(path), expected, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Unexpected sealed-publication path.");
    }

    private static NativeProcessManager.SECURITY_ATTRIBUTES Attributes(IntPtr descriptor) => new()
    {
        nLength = Marshal.SizeOf<NativeProcessManager.SECURITY_ATTRIBUTES>(),
        bInheritHandle = false,
        lpSecurityDescriptor = descriptor,
    };

    private static IntPtr SecurityDescriptor(string sddl)
    {
        if (!NativeProcessManager.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out var sd, out _))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Invalid seal security descriptor.");
        return sd;
    }

    private static SafeFileHandle Open(string path, uint access, uint share, bool directory)
    {
        var sa = Attributes(IntPtr.Zero);
        var handle = Native.CreateFileW(path, access, share, ref sa, 3,
            OpenReparsePoint | (directory ? BackupSemantics : 0), IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error, "Cannot open pinned native path: " + path);
        }
        return handle;
    }

    private static void ValidateHandle(SafeFileHandle handle, bool directory)
    {
        if (!Native.GetFileInformationByHandle(handle, out var info))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "File identity could not be inspected.");
        if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory ||
            (!directory && info.NumberOfLinks != 1))
            throw new InvalidDataException("Reparse, hard-linked, or unexpected native object.");
        if (!Native.GetHandleInformation(handle, out uint flags) || (flags & 1) != 0)
            throw new InvalidDataException("Protected handles must not be inherited.");
    }

    private static RawSecurityDescriptor Descriptor(SafeFileHandle handle, bool includeLabel = false, int objectType = 1)
    {
        uint error = Native.GetSecurityInfo(handle, objectType, includeLabel ? 0x17u : 7u,
            out _, out _, out _, out _, out var sd);
        if (error != 0) throw new Win32Exception((int)error, "Cannot inspect actual handle security.");
        try
        {
            int length = checked((int)Native.GetSecurityDescriptorLength(sd));
            if (length is < 20 or > 65536) throw new InvalidDataException("Invalid descriptor length.");
            byte[] bytes = new byte[length];
            Marshal.Copy(sd, bytes, 0, length);
            return new RawSecurityDescriptor(bytes, 0);
        }
        finally { NativeProcessManager.LocalFree(sd); }
    }

    internal NativeSecurityEvidence CaptureSecurityEvidence(string childSid, string childIntegritySid, bool freshAccount,
        NativeChildTokenEvidence? childToken = null)
    {
        if (sealStream == null) throw new InvalidOperationException("No seal object to inspect.");
        ValidateSystemOnly(sealStream.SafeFileHandle, false);
        var sd = Descriptor(sealStream.SafeFileHandle, includeLabel: true);
        string label = "implicit-medium";
        if (sd.SystemAcl != null)
            foreach (GenericAce ace in sd.SystemAcl)
                if ((byte)ace.AceType == 17)
                {
                    byte[] mandatory = new byte[ace.BinaryLength];
                    ace.GetBinaryForm(mandatory, 0);
                    label = new SecurityIdentifier(mandatory, 8).Value;
                }
        using var identity = WindowsIdentity.GetCurrent();
        using var current = Process.GetCurrentProcess();
        string system32 = Path.Combine(WindowsDirectory(), "System32") + "\\";
        string sideBySide = Path.Combine(WindowsDirectory(), "WinSxS") + "\\";
        string[] modules = current.Modules.Cast<ProcessModule>().Select(module => Path.GetFullPath(module.FileName))
            .OrderBy(name => name, StringComparer.OrdinalIgnoreCase).ToArray();
        if (System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported ||
            modules.Any(name => !name.Equals(SupervisorPath, StringComparison.OrdinalIgnoreCase) &&
                !name.StartsWith(system32, StringComparison.OrdinalIgnoreCase) && !name.StartsWith(sideBySide, StringComparison.OrdinalIgnoreCase)) ||
            modules.Any(name => Path.GetFileName(name).Equals("coreclr.dll", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidDataException("Supervisor is not the native AOT image with trusted OS-only loaded dependencies.");
        return new NativeSecurityEvidence
        {
            SupervisorSid = identity.User?.Value ?? "", SupervisorIntegritySid = TokenIntegritySid(identity.AccessToken.DangerousGetHandle()),
            SupervisorPid = Environment.ProcessId, ChildSid = childSid, ChildIntegritySid = childIntegritySid,
            FreshAccount = freshAccount, ChildToken = childToken, SealPath = StatePath, SealOwnerSid = sd.Owner?.Value ?? "",
            SealSddl = sd.GetSddlForm(AccessControlSections.All), SealIntegritySid = label,
            SealRecordBytes = sealStream.Length, RuntimeDynamicCodeSupported = false, LoadedModules = modules,
        };
    }

    internal static int AuditCommand(string[] args)
    {
        try
        {
            RequireSystem();
            if (args.Length != 2) throw new InvalidDataException("Expected fixed envelope path.");
            using var channel = new SealedReceiptChannel();
            channel.LoadEnvelope(args[1]);
            channel.OpenProtectedDirectory(create: false);
            var handle = Open(channel.StatePath, GenericRead | ReadControl, 1, false);
            ValidateHandle(handle, false);
            channel.sealStream = new FileStream(handle, FileAccess.Read);
            if (channel.sealStream.Length != 72 || ReadWordCommand(["--digest-word", args[1], "0"]) < 0x40000000)
                throw new InvalidDataException("Cannot audit an incomplete or invalid published seal.");
            var evidence = channel.CaptureSecurityEvidence("", "", false);
            evidence.DiagnosticOnly = true;
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(evidence, SupervisorJsonContext.Default.NativeSecurityEvidence);
            WriteNewExport(Output + @"\seal-audit.json", bytes);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("BLOCKED: Diagnostic seal audit unavailable: " + ex.Message);
            return 3;
        }
    }

    internal static string TokenIntegritySid(IntPtr token)
    {
        string result = "";
        WithTokenInfo(token, 25, pointer =>
            result = new SecurityIdentifier(Marshal.PtrToStructure<NativeProcessManager.SID_AND_ATTRIBUTES>(pointer).Sid).Value);
        return result;
    }

    internal static NativeChildTokenEvidence CaptureChildToken(IntPtr token)
    {
        using var borrowedHandle = new SafeFileHandle(token, ownsHandle: false);
        var descriptor = Descriptor(borrowedHandle, objectType: 6 /* SE_KERNEL_OBJECT */);
        if (descriptor.Owner?.Value != "S-1-5-18" || descriptor.Group?.Value != "S-1-5-18")
            throw new InvalidDataException("Restricted token ownership was not secured to SYSTEM.");
        var groups = new List<NativeTokenGroup>();
        var privileges = new List<NativeTokenPrivilege>();
        WithTokenInfo(token, 2, pointer =>
        {
            int count = Marshal.ReadInt32(pointer);
            int start = IntPtr.Size == 8 ? 8 : 4;
            for (int i = 0; i < count; i++)
            {
                var item = Marshal.PtrToStructure<NativeProcessManager.SID_AND_ATTRIBUTES>(
                    IntPtr.Add(pointer, start + i * Marshal.SizeOf<NativeProcessManager.SID_AND_ATTRIBUTES>()));
                groups.Add(new NativeTokenGroup { Sid = new SecurityIdentifier(item.Sid).Value, Attributes = item.Attributes });
            }
        });
        WithTokenInfo(token, 3, pointer =>
        {
            int count = Marshal.ReadInt32(pointer);
            for (int i = 0; i < count; i++)
            {
                var item = Marshal.PtrToStructure<Native.LuidAndAttributes>(IntPtr.Add(pointer, 4 + i * 12));
                var name = new StringBuilder(256);
                uint length = 256;
                if (!Native.LookupPrivilegeNameW(null, ref item.Luid, name, ref length))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect retained token privilege name.");
                privileges.Add(new NativeTokenPrivilege { Name = name.ToString(), Attributes = item.Attributes });
            }
        });
        return new NativeChildTokenEvidence
        {
            OwnerSid = descriptor.Owner.Value, GroupSid = descriptor.Group.Value,
            Sddl = descriptor.GetSddlForm(AccessControlSections.All),
            AdminEnabled = groups.Any(group => group.Sid == "S-1-5-32-544" && (group.Attributes & 4) != 0 && (group.Attributes & 0x10) == 0),
            Groups = groups.ToArray(), Privileges = privileges.ToArray(),
        };
    }

    private static void ValidateSystemOnly(SafeFileHandle handle, bool directory)
    {
        var sd = Descriptor(handle);
        if (sd.Owner?.Value != "S-1-5-18" || sd.Group?.Value != "S-1-5-18" ||
            (sd.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 || sd.DiscretionaryAcl?.Count != 1 ||
            sd.DiscretionaryAcl[0] is not CommonAce ace || ace.AceQualifier != AceQualifier.AccessAllowed ||
            ace.SecurityIdentifier.Value != "S-1-5-18" || ace.AccessMask != 0x1F01FF ||
            ace.AceFlags != (directory ? AceFlags.ContainerInherit | AceFlags.ObjectInherit : AceFlags.None))
            throw new InvalidDataException("Seal is not protected by exact SYSTEM-only ownership and DACL.");
    }

    internal static bool CreateRestrictedProcess(IntPtr token, string executable, string command,
        IntPtr processSecurity, IntPtr threadSecurity, uint flags, string cwd,
        ref NativeProcessManager.STARTUPINFO startup, out NativeProcessManager.PROCESS_INFORMATION process)
    {
        if (startup.hStdInput == IntPtr.Zero || startup.hStdInput == new IntPtr(-1))
            throw new InvalidDataException("A valid read-only NUL input handle is required.");
        nuint size = 0;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        if (size == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot size process handle allowlist.");
        IntPtr list = Marshal.AllocHGlobal(checked((int)size));
        IntPtr handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
        string windows = WindowsDirectory();
        // A deterministic environment excludes NODE_OPTIONS, NODE_PATH and any
        // supervisor credentials. No host or project-provided shell lookup.
        string environment = "PATH=" + windows + "\\System32\0SystemRoot=" + windows +
            "\0TEMP=" + Output + "\0TMP=" + Output + "\0windir=" + windows + "\0\0";
        IntPtr env = Marshal.StringToHGlobalUni(environment);
        bool initialized = false;
        try
        {
            if (!Native.InitializeProcThreadAttributeList(list, 1, 0, ref size))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot initialize process handle allowlist.");
            initialized = true;
            Marshal.WriteIntPtr(handles, 0, startup.hStdInput);
            Marshal.WriteIntPtr(handles, IntPtr.Size, startup.hStdOutput);
            Marshal.WriteIntPtr(handles, IntPtr.Size * 2, startup.hStdError);
            if (!Native.UpdateProcThreadAttribute(list, 0, (nuint)0x20002 /* HANDLE_LIST */, handles,
                (nuint)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot set process handle allowlist.");
            var extended = new Native.StartupInfoEx { Startup = startup, AttributeList = list };
            extended.Startup.cb = Marshal.SizeOf<Native.StartupInfoEx>();
            return Native.CreateProcessAsUserW(token, executable, command, processSecurity, threadSecurity, true,
                flags | 0x80000 /* EXTENDED_STARTUPINFO_PRESENT */ | 0x400 /* UNICODE_ENVIRONMENT */,
                env, cwd, ref extended, out process);
        }
        finally
        {
            if (initialized) Native.DeleteProcThreadAttributeList(list);
            Marshal.FreeHGlobal(env);
            Marshal.FreeHGlobal(handles);
            Marshal.FreeHGlobal(list);
        }
    }

    internal static void ValidateAndConstrainChildToken(IntPtr token, string expectedSid)
    {
        if (!NativeProcessManager.ConvertStringSidToSidW("S-1-16-8192", out var mediumSid))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var label = new NativeProcessManager.SID_AND_ATTRIBUTES { Sid = mediumSid, Attributes = 0x20 };
            IntPtr data = Marshal.AllocHGlobal(Marshal.SizeOf<NativeProcessManager.SID_AND_ATTRIBUTES>());
            try
            {
                Marshal.StructureToPtr(label, data, false);
                if (!NativeProcessManager.SetTokenInformation(token, 25 /* TokenIntegrityLevel */, data,
                    (uint)Marshal.SizeOf<NativeProcessManager.SID_AND_ATTRIBUTES>() + Native.GetLengthSid(mediumSid)))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot constrain child integrity.");
            }
            finally { Marshal.FreeHGlobal(data); }
        }
        finally { NativeProcessManager.LocalFree(mediumSid); }
        WithTokenInfo(token, 1, p =>
        {
            var user = Marshal.PtrToStructure<NativeProcessManager.SID_AND_ATTRIBUTES>(p);
            if (new SecurityIdentifier(user.Sid).Value != expectedSid || expectedSid == "S-1-5-18")
                throw new InvalidDataException("Restricted child has an unexpected identity.");
        });
        WithTokenInfo(token, 25, p =>
        {
            var label = Marshal.PtrToStructure<NativeProcessManager.SID_AND_ATTRIBUTES>(p);
            if (new SecurityIdentifier(label.Sid).Value != "S-1-16-8192")
                throw new InvalidDataException("Restricted child integrity is not medium.");
        });
        WithTokenInfo(token, 2 /* TokenGroups */, p =>
        {
            int count = Marshal.ReadInt32(p);
            int start = IntPtr.Size == 8 ? 8 : 4;
            for (int i = 0; i < count; i++)
            {
                var group = Marshal.PtrToStructure<NativeProcessManager.SID_AND_ATTRIBUTES>(
                    IntPtr.Add(p, start + i * Marshal.SizeOf<NativeProcessManager.SID_AND_ATTRIBUTES>()));
                string sid = new SecurityIdentifier(group.Sid).Value;
                if (sid is "S-1-5-32-544" or "S-1-5-114" or "S-1-5-18")
                    if ((group.Attributes & 0x10) == 0 || (group.Attributes & 0x4) != 0)
                        throw new InvalidDataException("Administrator group was not disabled.");
            }
        });
        if (!Native.LookupPrivilegeValueW(null, "SeChangeNotifyPrivilege", out var traverse))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        WithTokenInfo(token, 3 /* TokenPrivileges */, p =>
        {
            int count = Marshal.ReadInt32(p);
            for (int i = 0; i < count; i++)
            {
                var privilege = Marshal.PtrToStructure<Native.LuidAndAttributes>(IntPtr.Add(p, 4 + i * 12));
                if ((privilege.Attributes & 2) != 0 &&
                    (privilege.Luid.Low != traverse.Low || privilege.Luid.High != traverse.High))
                    throw new InvalidDataException("Unexpected enabled privilege in child token.");
            }
        });
    }

    private static void WithTokenInfo(IntPtr token, int kind, Action<IntPtr> read)
    {
        NativeProcessManager.GetTokenInformation(token, kind, IntPtr.Zero, 0, out uint size);
        if (size is < 4 or > 1024 * 1024) throw new InvalidDataException("Invalid token information size.");
        IntPtr buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            if (!NativeProcessManager.GetTokenInformation(token, kind, buffer, size, out _))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            read(buffer);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    internal static int ChildProbe(string[] args)
    {
        if (args.Length is < 2 or > 3) return 2;
        try { RequireExactPath(args[1], EnvelopePath); } catch { return 2; }
        using var identity = WindowsIdentity.GetCurrent();
        Console.WriteLine("SEAL_CHILD_SID=" + identity.User?.Value);
        if (identity.IsSystem) return 2;
        Console.WriteLine("SEAL_CHILD_INTEGRITY_SID=" + TokenIntegritySid(identity.AccessToken.DangerousGetHandle()));
        Console.WriteLine("SEAL_CHILD_ADMIN_ENABLED=" + new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator));
        bool allDenied = true;
        string leaf;
        try { leaf = Path.Combine(StateDirectory, Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(EnvelopePath))) + ".bin"); }
        catch { return 2; }
        foreach (var target in new[] { ("DIRECTORY", StateDirectory, true), ("LEAF", leaf, false) })
        {
            foreach (var probe in new[] { ("READ", GenericRead), ("WRITE", GenericWrite),
                ("DELETE", 0x10000u), ("WRITE_DAC", 0x40000u), ("WRITE_OWNER", 0x80000u) })
            {
                var sa = Attributes(IntPtr.Zero);
                using var handle = Native.CreateFileW(target.Item2, probe.Item2, 3, ref sa, 3,
                    (target.Item3 ? BackupSemantics : 0) | OpenReparsePoint, IntPtr.Zero);
                int error = handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
                Console.WriteLine("SEAL_" + target.Item1 + "_" + probe.Item1 + "_ERROR=" + error);
                allDenied &= error == 5;
            }
        }
        if (args.Length == 3)
        {
            if (!uint.TryParse(args[2], out uint supervisorPid) || supervisorPid == 0) return 2;
            allDenied &= ProbePrivilegedProcess(supervisorPid, "SUPERVISOR");
        }
        int explorerCount = 0;
        foreach (var explorer in Process.GetProcessesByName("explorer"))
        {
            using (explorer)
            {
                explorerCount++;
                allDenied &= ProbePrivilegedProcess((uint)explorer.Id, "EXPLORER_" + explorer.Id);
            }
        }
        Console.WriteLine("SEAL_EXPLORER_PROBE_COUNT=" + explorerCount);
        try
        {
            var start = new ProcessStartInfo(SupervisorPath) { UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true };
            start.ArgumentList.Add("--digest-word");
            start.ArgumentList.Add(args[1]);
            start.ArgumentList.Add("0");
            using var child = Process.Start(start) ?? throw new IOException("Cannot start digest denial probe.");
            if (!child.WaitForExit(10000)) { child.Kill(entireProcessTree: true); return 2; }
            Console.WriteLine("SEAL_CHILD_DIGEST_EXIT=" + child.ExitCode);
            allDenied &= child.ExitCode == 3;
        }
        catch (Exception ex) { Console.WriteLine("SEAL_CHILD_DIGEST_ERROR=" + ex.GetType().Name); return 2; }
        Console.WriteLine("SEAL_CHILD_DENIAL_CONFIRMED=" + allDenied);
        return allDenied ? 0 : 1;
    }

    private static bool ProbePrivilegedProcess(uint pid, string label)
    {
        bool denied = true;
        Console.WriteLine("SEAL_" + label + "_PID=" + pid);
        foreach (var probe in new[] { ("QUERY", 0x400u), ("VMREAD", 0x10u), ("VMWRITE", 0x28u),
            ("DUP_HANDLE", 0x40u), ("WRITE_DAC", 0x40000u), ("WRITE_OWNER", 0x80000u) })
        {
            IntPtr process = NativeProcessManager.OpenProcess(probe.Item2, false, pid);
            int error = process == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            if (process != IntPtr.Zero) NativeProcessManager.CloseHandle(process);
            Console.WriteLine("SEAL_" + label + "_PROCESS_" + probe.Item1 + "_ERROR=" + error);
            denied &= error == 5;
        }
        IntPtr limited = NativeProcessManager.OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid);
        int limitedError = limited == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
        Console.WriteLine("SEAL_" + label + "_PROCESS_LIMITED_QUERY_ERROR=" + limitedError);
        if (limited == IntPtr.Zero)
        {
            Console.WriteLine("SEAL_" + label + "_TOKEN_OPEN_ATTEMPTED=False");
            return denied && limitedError == 5; // Token acquisition blocked by the process handle gate.
        }
        try
        {
            Console.WriteLine("SEAL_" + label + "_TOKEN_OPEN_ATTEMPTED=True");
            foreach (var probe in new[] { ("QUERY", 8u), ("DUPLICATE", 2u), ("IMPERSONATE", 4u), ("ASSIGN_PRIMARY", 1u) })
            {
                bool opened = NativeProcessManager.OpenProcessToken(limited, probe.Item2, out var token);
                int error = opened ? 0 : Marshal.GetLastWin32Error();
                if (opened) NativeProcessManager.CloseHandle(token);
                Console.WriteLine("SEAL_" + label + "_TOKEN_" + probe.Item1 + "_ERROR=" + error);
                if (probe.Item1 != "QUERY") denied &= error == 5;
            }
        }
        finally { NativeProcessManager.CloseHandle(limited); }
        return denied;
    }

    public void Dispose()
    {
        sealStream?.Dispose();
        sealStream = null;
        for (int i = pins.Count - 1; i >= 0; i--) pins[i].Dispose();
        pins.Clear();
        envelope?.Dispose();
    }

    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct FileInformation
        {
            internal uint Attributes;
            internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime;
            internal uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
        }
        [StructLayout(LayoutKind.Sequential)]
        internal struct StartupInfoEx { internal NativeProcessManager.STARTUPINFO Startup; internal IntPtr AttributeList; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct Luid { internal uint Low; internal int High; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct LuidAndAttributes { internal Luid Luid; internal uint Attributes; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern uint GetWindowsDirectoryW(StringBuilder path, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool CreateDirectoryW(string path, ref NativeProcessManager.SECURITY_ATTRIBUTES attributes);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern SafeFileHandle CreateFileW(string path, uint access, uint sharing,
            ref NativeProcessManager.SECURITY_ATTRIBUTES attributes, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool GetHandleInformation(SafeFileHandle handle, out uint flags);
        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern uint GetSecurityInfo(SafeFileHandle handle, int objectType, uint securityInformation,
            out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll")]
        internal static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref nuint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, nuint attribute,
            IntPtr value, nuint size, IntPtr previous, IntPtr returnedSize);
        [DllImport("kernel32.dll")]
        internal static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool CreateProcessAsUserW(IntPtr token, string executable, string command,
            IntPtr processSecurity, IntPtr threadSecurity, bool inheritHandles, uint creationFlags,
            IntPtr environment, string cwd, ref StartupInfoEx startup, out NativeProcessManager.PROCESS_INFORMATION process);
        [DllImport("advapi32.dll")]
        internal static extern uint GetLengthSid(IntPtr sid);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool LookupPrivilegeValueW(string? system, string name, out Luid value);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool LookupPrivilegeNameW(string? system, ref Luid value, StringBuilder name, ref uint length);
    }
}
