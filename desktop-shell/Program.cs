using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using ChatMCP.Native;

namespace ChatMCP.Desktop
{
    internal static class Program
    {
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
        [STAThread]
        static void Main(string[] args)
        {
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var repoRoot = FindRepoRoot(AppDomain.CurrentDomain.BaseDirectory);
            // One window per user/session for the fixed localhost Hub. A second
            // launch activates the first, never takes ownership of its process.
            using var instance = new Mutex(false, "Local\\ChatMCP.Desktop." + HubLifecycle.UserKey);
            bool owned;
            try { owned = instance.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
            if (!owned)
            {
                using var self = Process.GetCurrentProcess();
                foreach (var process in Process.GetProcessesByName("ChatMCP"))
                {
                    using (process)
                    {
                        try
                        {
                            if (process.Id == self.Id || process.SessionId != self.SessionId ||
                                !string.Equals(process.MainModule?.FileName, Environment.ProcessPath, StringComparison.OrdinalIgnoreCase)) continue;
                            if (process.MainWindowHandle != IntPtr.Zero)
                            {
                                ShowWindow(process.MainWindowHandle, 9);
                                SetForegroundWindow(process.MainWindowHandle);
                                return;
                            }
                        }
                        catch (Exception) { /* No process changes on inaccessible or exited windows. */ }
                    }
                }
                // The primary may still be booting, or another installed copy
                // owns the session. Do not create a second controller window.
                return;
            }
            try { Application.Run(new MainWindow(repoRoot)); }
            finally { instance.ReleaseMutex(); }
        }
        private static string FindRepoRoot(string startDir)
        {
            var dir = new DirectoryInfo(startDir);
            while (dir != null)
            {
                if (Directory.Exists(Path.Combine(dir.FullName, "CHATMCP-HUB"))) return dir.FullName;
                dir = dir.Parent;
            }
            return startDir;
        }
    }
}
