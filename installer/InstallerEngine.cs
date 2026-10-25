using ChatMCP.Native;
using System.Text;
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32;

namespace ChatMCP.Installer
{
    public static class InstallerEngine
    {
        public const string AppName = "ChatMCP Studio";
        public const string AppDescription = "ChatMCP - Autonomous AI Coding Agent";
        public static string AppVersion => HubLifecycle.Version;
        public const string Publisher = "Phan Danh Dat";
        public const string RegistryKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatMCP";
        private const string ManifestName = ".chatmcp-installed-files.json";

        private static string NormalizeInstallDirectory(string directory)
        {
            var full = Path.GetFullPath(directory);
            var trimmed = full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (string.Equals(trimmed, Path.GetPathRoot(full)?.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("A drive or share root cannot be an installation directory.");
            return trimmed;
        }

        internal static string SafePath(string directory, string relative)
        {
            var root = NormalizeInstallDirectory(directory);
            var result = Path.GetFullPath(Path.Combine(root, relative));
            if (Path.IsPathRooted(relative) || relative.Contains(':') ||
                !result.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Unsafe installation path.");
            for (var current = result; current != null; current = Path.GetDirectoryName(current))
            {
                try
                {
                    if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                        throw new InvalidOperationException("Installation paths cannot contain junctions or symbolic links.");
                }
                catch (FileNotFoundException) { }
                catch (DirectoryNotFoundException) { }
            }
            return result;
        }

        private static string FileDigest(string file)
        {
            using var stream = File.OpenRead(file);
            return Convert.ToHexString(SHA256.HashData(stream));
        }

        private static Dictionary<string, string> ReadManifest(string directory)
        {
            var manifestPath = SafePath(directory, ManifestName);
            var files = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(manifestPath))
                ?? throw new InvalidOperationException("Installation manifest is invalid.");
            foreach (var item in files)
            {
                SafePath(directory, item.Key);
                if (item.Value == null || item.Value.Length != 64 || !item.Value.All(Uri.IsHexDigit))
                    throw new InvalidOperationException("Installation manifest digest is invalid.");
            }
            var normalized = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in files) normalized.Add(InstallTransaction.Normalize(item.Key), item.Value);
            return normalized;
        }

        internal static void ReplaceFile(string destination, Action<Stream> write)
        {
            // Replacing the directory entry breaks an existing hardlink instead
            // of overwriting the file behind an unrelated hardlink alias.
            var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) write(stream);
                File.Move(temporary, destination, overwrite: true);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        public static string GetDefaultInstallDir()
        {
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(localAppData, "Programs", "ChatMCP");
        }

        public static void Install(string targetDir, bool createDesktopShortcut, bool createStartMenuShortcut,
            Action<int, string> reportProgress)
        {
            var logs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ChatMCP", "logs");
            Directory.CreateDirectory(logs);
            var log = Path.Combine(logs, "install-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N") + ".log");
            File.WriteAllText(log, "ChatMCP installer " + AppVersion + " started " + DateTime.UtcNow.ToString("O") + Environment.NewLine);
            try
            {
                InstallCore(targetDir, createDesktopShortcut, createStartMenuShortcut, (percent, status) =>
                {
                    File.AppendAllText(log, percent + " " + status + Environment.NewLine);
                    reportProgress(percent, status);
                });
            }
            catch (Exception error)
            {
                File.AppendAllText(log, "FAILED " + error.GetType().Name + Environment.NewLine);
                throw new IOException(error.Message + " Installer log: " + log, error);
            }
        }

        private static void InstallCore(
            string targetDir,
            bool createDesktopShortcut,
            bool createStartMenuShortcut,
            Action<int, string> reportProgress)
        {
            targetDir = NormalizeInstallDirectory(targetDir);
            using var updateLock = HubLifecycle.AcquireUpdateLock(targetDir);
            try
            {
            var manifestPath = SafePath(targetDir, ManifestName);
            var previousFiles = File.Exists(manifestPath) ? ReadManifest(targetDir) : null;
            using var priorRegistration = Registry.CurrentUser.OpenSubKey(RegistryKeyPath);
            var legacyUpgrade = previousFiles == null && string.Equals(
                priorRegistration?.GetValue("InstallLocation") as string, targetDir, StringComparison.OrdinalIgnoreCase);
            InstallFiles(targetDir, previousFiles, legacyUpgrade, reportProgress);
            var uninstallerPath = SafePath(targetDir, "Uninstall.exe");

            var mainExePath = Path.Combine(targetDir, "ChatMCP.exe");
            var iconPath = Path.Combine(targetDir, "assets", "icons", "chatmcp.ico");
            if (!File.Exists(iconPath))
            {
                iconPath = mainExePath;
            }

            // Create Shortcuts
            reportProgress(85, "Creating system shortcuts...");
            if (createDesktopShortcut)
            {
                var desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
                var desktopLnk = Path.Combine(desktopDir, $"{AppName}.lnk");
                CreateShortcut(desktopLnk, mainExePath, targetDir, iconPath, AppDescription);
            }

            if (createStartMenuShortcut)
            {
                var programsDir = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
                var appStartMenuDir = Path.Combine(programsDir, "ChatMCP");
                if (!Directory.Exists(appStartMenuDir))
                {
                    Directory.CreateDirectory(appStartMenuDir);
                }
                var startMenuLnk = Path.Combine(appStartMenuDir, $"{AppName}.lnk");
                CreateShortcut(startMenuLnk, mainExePath, targetDir, iconPath, AppDescription);

                var uninstallLnk = Path.Combine(appStartMenuDir, $"Uninstall {AppName}.lnk");
                CreateShortcut(uninstallLnk, uninstallerPath, targetDir, iconPath, $"Uninstall {AppName}");
            }

            // Register in Windows Registry
            reportProgress(95, "Registering in Windows Installed Apps...");
            RegisterUninstall(targetDir, uninstallerPath, iconPath);

            reportProgress(100, "Installation complete!");
            }
            finally { updateLock.ReleaseMutex(); }
        }

        private static void InstallFiles(string targetDir, Dictionary<string, string>? previousFiles,
            bool legacyUpgrade, Action<int, string> reportProgress)
        {
            using var transaction = new InstallTransaction(targetDir);
            reportProgress(5, "Validating and staging the complete installer...");
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("ChatMCP.Installer.payload.zip")
                ?? throw new InvalidOperationException("The standalone installer payload is missing. No files were replaced.");
            using var archive = new ZipArchive(stream, ZipArchiveMode.Read);
            foreach (var entry in archive.Entries)
            {
                // Validate directories too, before ignoring their empty content.
                var relative = InstallTransaction.Normalize(entry.FullName.Replace('\\', '/').TrimEnd('/'));
                SafePath(targetDir, relative);
                if (string.IsNullOrEmpty(entry.Name)) continue;
                if (relative.Equals(ManifestName, StringComparison.OrdinalIgnoreCase) ||
                    relative.Equals(InstallTransaction.PendingName, StringComparison.OrdinalIgnoreCase) ||
                    relative.Equals("Uninstall.exe", StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Reserved installer payload path.");
                var target = SafePath(targetDir, relative);
                if (File.Exists(target) && !legacyUpgrade && previousFiles?.ContainsKey(relative) != true)
                    throw new InvalidOperationException("Installation would overwrite an unrelated file: " + relative);
                using var source = entry.Open();
                transaction.Add(relative, source);
            }
            // A renamed setup is still the same version. Use metadata, not its
            // filename or Installed Apps' old hard-coded DisplayVersion.
            using (var package = JsonDocument.Parse(File.ReadAllText(transaction.StagedPath("CHATMCP-HUB/package.json"))))
                if (package.RootElement.GetProperty("version").GetString() != AppVersion)
                    throw new IOException("Installer and embedded Hub package versions differ.");
            var desktopVersion = FileVersionInfo.GetVersionInfo(transaction.StagedPath("ChatMCP.exe")).ProductVersion?.Split('+')[0];
            if (desktopVersion != AppVersion) throw new IOException("Embedded desktop version differs from the installer.");
            var manager = File.ReadAllText(transaction.StagedPath("CHATMCP-HUB/lib/manager.mjs"));
            var hub = File.ReadAllText(transaction.StagedPath("CHATMCP-HUB/hub.mjs"));
            if (!manager.Contains("export const VERSION = '" + AppVersion + "';") ||
                !hub.Contains("export const UI_BUILD = '" + AppVersion + "-react-agent';"))
                throw new IOException("Embedded Hub runtime version/build differs from the installer.");
            var uninstallTarget = SafePath(targetDir, "Uninstall.exe");
            if (File.Exists(uninstallTarget) && !legacyUpgrade && previousFiles?.ContainsKey("Uninstall.exe") != true && !IsChatMcpBinary(uninstallTarget))
                throw new InvalidOperationException("Installation would overwrite an unrelated Uninstall.exe.");
            using (var self = File.OpenRead(Environment.ProcessPath ?? throw new IOException("Setup executable path is unavailable.")))
                transaction.Add("Uninstall.exe", self);
            var installedFiles = transaction.Files.ToDictionary(x => x.Key, x => x.Value, StringComparer.OrdinalIgnoreCase);
            if (previousFiles != null)
                foreach (var previous in previousFiles)
                {
                    if (installedFiles.ContainsKey(previous.Key)) continue;
                    var obsolete = SafePath(targetDir, previous.Key);
                    if (File.Exists(obsolete) && string.Equals(FileDigest(obsolete), previous.Value, StringComparison.OrdinalIgnoreCase))
                        transaction.RemoveObsolete(previous.Key);
                }
            using (var manifest = new MemoryStream(JsonSerializer.SerializeToUtf8Bytes(installedFiles)))
                transaction.Add(ManifestName, manifest); // Ownership receipt is committed LAST.
            reportProgress(35, "Checking running tasks and stopping the installed Hub...");
            HubLifecycle.StopInstalledHub(targetDir).GetAwaiter().GetResult();
            CloseRunningProcesses(targetDir);
            if (HubLifecycle.ListenerPid() != null)
                throw new IOException("A listener appeared during upgrade. No files were replaced.");
            transaction.Commit(reportProgress);
        }

        public static void CreateShortcut(string shortcutPath, string targetPath, string workingDir, string iconPath, string description)
        {
            try
            {
                var shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType != null)
                {
                    dynamic shell = Activator.CreateInstance(shellType)!;
                    dynamic shortcut = shell.CreateShortcut(shortcutPath);
                    shortcut.TargetPath = targetPath;
                    shortcut.WorkingDirectory = workingDir;
                    shortcut.WindowStyle = 1; // Normal window
                    shortcut.Description = description;
                    if (File.Exists(iconPath))
                    {
                        shortcut.IconLocation = $"{iconPath},0";
                    }
                    shortcut.Save();
                }
            }
            catch
            {
                // Fallback: ignore shortcut failure
            }
        }

        public static void RegisterUninstall(string installDir, string uninstallerPath, string iconPath)
        {
            try
            {
                using var key = Registry.CurrentUser.CreateSubKey(RegistryKeyPath);
                if (key != null)
                {
                    key.SetValue("DisplayName", AppName);
                    key.SetValue("DisplayVersion", AppVersion);
                    key.SetValue("Publisher", Publisher);
                    key.SetValue("InstallLocation", installDir);
                    key.SetValue("UninstallString", $"\"{uninstallerPath}\"");
                    key.SetValue("DisplayIcon", $"{iconPath},0");
                    key.SetValue("URLInfoAbout", "https://github.com/pddczpl/ChatMCP");
                    key.SetValue("HelpLink", "https://github.com/pddczpl/ChatMCP/tree/main/docs");
                    key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                }
            }
            catch
            {
                // Ignore registry errors
            }
        }

        public static void Uninstall(string installDir, Action<int, string> reportProgress)
        {
            installDir = NormalizeInstallDirectory(installDir);
            var manifestPath = SafePath(installDir, ManifestName);
            if (!File.Exists(manifestPath))
                throw new InvalidOperationException("Installation manifest is missing. Reinstall before uninstalling; user data has not been deleted.");
            var installedFiles = ReadManifest(installDir);
            using var updateLock = HubLifecycle.AcquireUpdateLock(installDir);
            try
            {
            if (File.Exists(SafePath(installDir, InstallTransaction.PendingName)))
                throw new IOException("An interrupted update must be recovered before uninstalling.");
            reportProgress(10, "Checking tasks and stopping the installed Hub...");
            HubLifecycle.StopInstalledHub(installDir).GetAwaiter().GetResult();
            CloseRunningProcesses(installDir);

            reportProgress(30, "Removing Desktop shortcut...");
            var desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
            var desktopLnk = Path.Combine(desktopDir, $"{AppName}.lnk");
            RemoveOwnedShortcut(desktopLnk, Path.Combine(installDir, "ChatMCP.exe"));

            reportProgress(50, "Removing Start Menu shortcuts...");
            var programsDir = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            var appStartMenuDir = Path.Combine(programsDir, "ChatMCP");
            if (Directory.Exists(appStartMenuDir))
            {
                RemoveOwnedShortcut(Path.Combine(appStartMenuDir, $"{AppName}.lnk"), Path.Combine(installDir, "ChatMCP.exe"));
                RemoveOwnedShortcut(Path.Combine(appStartMenuDir, $"Uninstall {AppName}.lnk"), Path.Combine(installDir, "Uninstall.exe"));
                if (!Directory.EnumerateFileSystemEntries(appStartMenuDir).Any()) Directory.Delete(appStartMenuDir);
            }

            reportProgress(70, "Unregistering from Windows...");
            using (var key = Registry.CurrentUser.OpenSubKey(RegistryKeyPath))
            {
                var registeredDirectory = key?.GetValue("InstallLocation") as string;
                if (string.Equals(registeredDirectory, installDir, StringComparison.OrdinalIgnoreCase))
                    Registry.CurrentUser.DeleteSubKeyTree(RegistryKeyPath, throwOnMissingSubKey: false);
            }

            reportProgress(90, "Cleaning application files...");
            // Remove only unchanged owned files. Never recursively delete a directory:
            // it may contain settings or documents created after installation.
            if (Directory.Exists(installDir))
            {
                var currentExe = Environment.ProcessPath ?? "";
                foreach (var item in installedFiles)
                {
                    var file = SafePath(installDir, item.Key);
                    if (!file.Equals(currentExe, StringComparison.OrdinalIgnoreCase) && File.Exists(file) &&
                        string.Equals(FileDigest(file), item.Value, StringComparison.OrdinalIgnoreCase)) File.Delete(file);
                }
                File.Delete(manifestPath);
            }

            // The running uninstaller cannot remove its own image. A narrowly scoped
            // helper waits for this process and deletes that one unchanged file only.
            var self = Environment.ProcessPath ?? "";
            var installedUninstaller = SafePath(installDir, "Uninstall.exe");
            if (string.Equals(self, installedUninstaller, StringComparison.OrdinalIgnoreCase) &&
                installedFiles.TryGetValue("Uninstall.exe", out var selfDigest))
            {
                var literal = installedUninstaller.Replace("'", "''");
                var command = $"Wait-Process -Id {Environment.ProcessId} -ErrorAction SilentlyContinue; " +
                    $"if ((Test-Path -LiteralPath '{literal}') -and ((Get-FileHash -LiteralPath '{literal}' -Algorithm SHA256).Hash -eq '{selfDigest}')) {{ Remove-Item -LiteralPath '{literal}' -Force }}";
                // The helper must not inherit this process's PSModulePath: started from PowerShell 7 it would lose Get-FileHash and leave Uninstall.exe behind.
                var helper = HubLifecycle.WindowsPowerShell(command);
                helper.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(helper);
            }

            reportProgress(100, "Uninstall completed successfully!");
            }
            finally { updateLock.ReleaseMutex(); }
        }

        private static void RemoveOwnedShortcut(string shortcutPath, string expectedTarget)
        {
            if (!File.Exists(shortcutPath)) return;
            var shellType = Type.GetTypeFromProgID("WScript.Shell")!;
            dynamic shell = Activator.CreateInstance(shellType)!;
            dynamic shortcut = shell.CreateShortcut(shortcutPath);
            if (string.Equals((string)shortcut.TargetPath, expectedTarget, StringComparison.OrdinalIgnoreCase))
                File.Delete(shortcutPath);
        }

        private static void CloseRunningProcesses(string installDir)
        {
            var expected = Path.Combine(installDir, "ChatMCP.exe");
            foreach (var proc in Process.GetProcessesByName("ChatMCP"))
            {
                using (proc)
                {
                    try
                    {
                        if (!string.Equals(proc.MainModule?.FileName, expected, StringComparison.OrdinalIgnoreCase)) continue;
                        proc.CloseMainWindow();
                        if (!proc.WaitForExit(5000))
                            throw new IOException("Close the installed ChatMCP window before upgrading. No files were replaced.");
                    }
                    catch (InvalidOperationException) { /* Process already exited. */ }
                }
            }
        }

        private static bool IsChatMcpBinary(string path)
        {
            try
            {
                if (!File.Exists(path)) return false;
                var info = FileVersionInfo.GetVersionInfo(path);
                var product = info.ProductName ?? "";
                var desc = info.FileDescription ?? "";
                var internalName = info.InternalName ?? "";
                var original = info.OriginalFilename ?? "";
                return product.Contains("ChatMCP", StringComparison.OrdinalIgnoreCase) ||
                       desc.Contains("ChatMCP", StringComparison.OrdinalIgnoreCase) ||
                       internalName.Contains("ChatMCP", StringComparison.OrdinalIgnoreCase) ||
                       original.Contains("ChatMCP", StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }
    }
}
