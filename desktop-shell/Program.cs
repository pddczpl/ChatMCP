using System;
using System.IO;
using System.Windows.Forms;

namespace ChatMCP.Desktop
{
    internal static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // Determine repo or app root
            var baseDir = AppDomain.CurrentDomain.BaseDirectory;
            var repoRoot = FindRepoRoot(baseDir);

            Application.Run(new MainWindow(repoRoot));
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
    }
}
