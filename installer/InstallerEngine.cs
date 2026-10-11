using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using Microsoft.Win32;

namespace ChatMCP.Installer
{
    public static class InstallerEngine
    {
        public const string AppName = "ChatMCP Studio";
        public const string AppDescription = "ChatMCP - Autonomous AI Coding Agent";
        public const string AppVersion = "2.3.0";
        public const string Publisher = "Phan Danh Dat";
        public const string RegistryKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatMCP";

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
            reportProgress(5, "Preparing installation directory...");
            if (!Directory.Exists(targetDir))
            {
                Directory.CreateDirectory(targetDir);
            }

            // Extract embedded payload
            var assembly = Assembly.GetExecutingAssembly();
            var resourceName = "ChatMCP.Installer.payload.zip";
            using (var stream = assembly.GetManifestResourceStream(resourceName))
            {
                if (stream != null)
                {
                    reportProgress(15, "Extracting application components from installer payload...");
                    using var archive = new ZipArchive(stream, ZipArchiveMode.Read);
                    var totalEntries = archive.Entries.Count;
                    var processed = 0;

                    foreach (var entry in archive.Entries)
                    {
                        var destPath = Path.Combine(targetDir, entry.FullName);
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
                            entry.ExtractToFile(destPath, overwrite: true);
                        }

                        processed++;
                        var pct = 15 + (int)((processed / (double)totalEntries) * 60);
                        reportProgress(pct, $"Extracting {entry.Name}...");
                    }
                }
                else
                {
                    // Fallback in case of local repository installation
                    reportProgress(20, "Copying local files...");
                    CopyLocalPayload(targetDir, reportProgress);
                }
            }

            // Copy this installer executable as Uninstall.exe into target directory
            reportProgress(80, "Configuring uninstaller...");
            var currentExe = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName;
            var uninstallerPath = Path.Combine(targetDir, "Uninstall.exe");
            if (!string.IsNullOrEmpty(currentExe) && File.Exists(currentExe))
            {
                try
                {
                    File.Copy(currentExe, uninstallerPath, overwrite: true);
                }
                catch
                {
                    // Ignore if copying fails in dev mode
                }
            }

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

        private static void CopyLocalPayload(string targetDir, Action<int, string> reportProgress)
        {
            var baseDir = AppDomain.CurrentDomain.BaseDirectory;
            var repoDir = FindRepoRoot(baseDir);
            if (Directory.Exists(repoDir))
            {
                // Copy assets
                CopyDirectory(Path.Combine(repoDir, "assets"), Path.Combine(targetDir, "assets"));
                // Copy CHATMCP-HUB
                CopyDirectory(Path.Combine(repoDir, "CHATMCP-HUB"), Path.Combine(targetDir, "CHATMCP-HUB"));
                // Copy desktop-shell/bin/dist/ChatMCP.exe
                var exeSource = Path.Combine(repoDir, "desktop-shell", "bin", "dist", "ChatMCP.exe");
                if (File.Exists(exeSource))
                {
                    File.Copy(exeSource, Path.Combine(targetDir, "ChatMCP.exe"), overwrite: true);
                }
                var loaderSource = Path.Combine(repoDir, "desktop-shell", "bin", "dist", "WebView2Loader.dll");
                if (File.Exists(loaderSource))
                {
                    File.Copy(loaderSource, Path.Combine(targetDir, "WebView2Loader.dll"), overwrite: true);
                }
            }
        }

        private static void CopyDirectory(string sourceDir, string targetDir)
        {
            if (!Directory.Exists(sourceDir)) return;
            Directory.CreateDirectory(targetDir);

            foreach (var file in Directory.GetFiles(sourceDir))
            {
                var dest = Path.Combine(targetDir, Path.GetFileName(file));
                File.Copy(file, dest, overwrite: true);
            }

            foreach (var sub in Directory.GetDirectories(sourceDir))
            {
                var dirName = Path.GetFileName(sub);
                if (dirName.Equals("node_modules", StringComparison.OrdinalIgnoreCase) ||
                    dirName.Equals("tests", StringComparison.OrdinalIgnoreCase) ||
                    dirName.Equals(".git", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                CopyDirectory(sub, Path.Combine(targetDir, dirName));
            }
        }

        private static string FindRepoRoot(string startDir)
        {
            var dir = new DirectoryInfo(startDir);
            while (dir != null)
            {
                if (Directory.Exists(Path.Combine(dir.FullName, "CHATMCP-HUB")))
                {
                    return dir.FullName;
                }
                dir = dir.Parent;
            }
            return startDir;
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
            reportProgress(10, "Closing running ChatMCP processes...");
            CloseRunningProcesses();

            reportProgress(30, "Removing Desktop shortcut...");
            var desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
            var desktopLnk = Path.Combine(desktopDir, $"{AppName}.lnk");
            if (File.Exists(desktopLnk))
            {
                try { File.Delete(desktopLnk); } catch { }
            }

            reportProgress(50, "Removing Start Menu shortcuts...");
            var programsDir = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            var appStartMenuDir = Path.Combine(programsDir, "ChatMCP");
            if (Directory.Exists(appStartMenuDir))
            {
                try { Directory.Delete(appStartMenuDir, recursive: true); } catch { }
            }

            reportProgress(70, "Unregistering from Windows...");
            try
            {
                Registry.CurrentUser.DeleteSubKeyTree(RegistryKeyPath, throwOnMissingSubKey: false);
            }
            catch { }

            reportProgress(90, "Cleaning application files...");
            // Delete all files except currently executing uninstaller
            if (Directory.Exists(installDir))
            {
                var currentExe = Environment.ProcessPath ?? "";
                foreach (var file in Directory.GetFiles(installDir, "*", SearchOption.AllDirectories))
                {
                    if (!file.Equals(currentExe, StringComparison.OrdinalIgnoreCase))
                    {
                        try { File.Delete(file); } catch { }
                    }
                }
            }

            reportProgress(100, "Uninstall completed successfully!");
        }

        private static void CloseRunningProcesses()
        {
            try
            {
                foreach (var proc in Process.GetProcessesByName("ChatMCP"))
                {
                    try { proc.Kill(); } catch { }
                }
            }
            catch { }
        }
    }
}
