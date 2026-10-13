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
        public const string AppVersion = "3.0.2";
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

        private static string SafePath(string directory, string relative)
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
            return new Dictionary<string, string>(files, StringComparer.OrdinalIgnoreCase);
        }

        private static void ReplaceFile(string destination, Action<Stream> write)
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

        public static void Install(
            string targetDir,
            bool createDesktopShortcut,
            bool createStartMenuShortcut,
            Action<int, string> reportProgress)
        {
            targetDir = NormalizeInstallDirectory(targetDir);
            var manifestPath = SafePath(targetDir, ManifestName);
            var previousFiles = File.Exists(manifestPath) ? ReadManifest(targetDir) : null;
            using var priorRegistration = Registry.CurrentUser.OpenSubKey(RegistryKeyPath);
            var legacyUpgrade = previousFiles == null && string.Equals(
                priorRegistration?.GetValue("InstallLocation") as string, targetDir, StringComparison.OrdinalIgnoreCase);
            CloseRunningProcesses(targetDir);
            var installedFiles = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            reportProgress(5, "Preparing installation directory...");
            if (!Directory.Exists(targetDir))
            {
                Directory.CreateDirectory(targetDir);
            }

            // Extract embedded payload
            var assembly = Assembly.GetExecutingAssembly();
            Stream? stream = assembly.GetManifestResourceStream("ChatMCP.Installer.payload.zip");
            if (stream == null)
            {
                foreach (var name in assembly.GetManifestResourceNames())
                {
                    if (name.EndsWith("payload.zip", StringComparison.OrdinalIgnoreCase))
                    {
                        stream = assembly.GetManifestResourceStream(name);
                        break;
                    }
                }
            }

            FileStream? fileStreamToDispose = null;
            if (stream == null)
            {
                var baseDir = AppDomain.CurrentDomain.BaseDirectory;
                var localZip = Path.Combine(baseDir, "payload.zip");
                if (File.Exists(localZip))
                {
                    fileStreamToDispose = File.OpenRead(localZip);
                    stream = fileStreamToDispose;
                }
            }

            try
            {
                if (stream != null)
                {
                    reportProgress(15, "Extracting application components from installer payload...");
                    using var archive = new ZipArchive(stream, ZipArchiveMode.Read, leaveOpen: true);
                    var totalEntries = archive.Entries.Count;
                    var processed = 0;

                    // Refuse collisions in a fresh install or with user-created
                    // files absent from an existing ownership manifest.
                    foreach (var entry in archive.Entries)
                    {
                        var candidatePath = SafePath(targetDir, entry.FullName);
                        if (!string.IsNullOrEmpty(entry.Name) && File.Exists(candidatePath) &&
                            !legacyUpgrade && previousFiles?.ContainsKey(entry.FullName) != true)
                            throw new InvalidOperationException($"Installation would overwrite an unrelated file: {entry.FullName}");
                    }
                    var uninstallTarget = SafePath(targetDir, "Uninstall.exe");
                    if (File.Exists(uninstallTarget) && !legacyUpgrade && previousFiles?.ContainsKey("Uninstall.exe") != true && !IsChatMcpBinary(uninstallTarget))
                        throw new InvalidOperationException("Installation would overwrite an unrelated Uninstall.exe.");

                    foreach (var entry in archive.Entries)
                    {
                        var destPath = SafePath(targetDir, entry.FullName);
                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(destPath);
                        }
                        else
                        {
                            var parentDir = Path.GetDirectoryName(destPath);
                            if (!string.IsNullOrEmpty(parentDir) && !Directory.Exists(parentDir))
                            {
                                Directory.CreateDirectory(parentDir);
                            }
                            ReplaceFile(destPath, output => { using var source = entry.Open(); source.CopyTo(output); });
                            installedFiles[entry.FullName] = FileDigest(destPath);
                        }

                        processed++;
                        var pct = 15 + (int)((processed / (double)totalEntries) * 60);
                        reportProgress(pct, $"Extracting {entry.Name}...");
                    }
                }
                else
                {
                    throw new InvalidOperationException("Installer payload is missing. Rebuild the standalone installer.");
                }
            }
            finally
            {
                stream?.Dispose();
                fileStreamToDispose?.Dispose();
            }

            // Copy this installer executable as Uninstall.exe into target directory
            reportProgress(80, "Configuring uninstaller...");
            var currentExe = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName;
            var uninstallerPath = SafePath(targetDir, "Uninstall.exe");
            if (!string.IsNullOrEmpty(currentExe) && File.Exists(currentExe))
            {
                ReplaceFile(uninstallerPath, output => { using var source = File.OpenRead(currentExe); source.CopyTo(output); });
                installedFiles["Uninstall.exe"] = FileDigest(uninstallerPath);
            }

            // The manifest records only files shipped by this installer. User state,
            // downloaded skills, workspaces and unrelated files are never owned.
            if (previousFiles != null)
                foreach (var previous in previousFiles)
                {
                    if (installedFiles.ContainsKey(previous.Key)) continue;
                    var obsolete = SafePath(targetDir, previous.Key);
                    if (File.Exists(obsolete) && string.Equals(FileDigest(obsolete), previous.Value, StringComparison.OrdinalIgnoreCase))
                        File.Delete(obsolete);
                }
            ReplaceFile(manifestPath, output => JsonSerializer.Serialize(output, installedFiles));

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
            reportProgress(10, "Closing running ChatMCP processes...");
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
                var powershell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
                Process.Start(new ProcessStartInfo(powershell, "-NoProfile -NonInteractive -EncodedCommand " +
                    Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(command)))
                { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });
            }

            reportProgress(100, "Uninstall completed successfully!");
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
                        if (!proc.WaitForExit(5000)) { proc.Kill(entireProcessTree: true); proc.WaitForExit(5000); }
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
