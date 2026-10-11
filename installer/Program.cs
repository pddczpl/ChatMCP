using System;
using System.IO;
using System.Windows.Forms;

namespace ChatMCP.Installer
{
    internal static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            var exeName = Path.GetFileNameWithoutExtension(Environment.ProcessPath ?? "");
            var isUninstall = exeName.Contains("uninstall", StringComparison.OrdinalIgnoreCase);

            foreach (var arg in args)
            {
                if (arg.Equals("--uninstall", StringComparison.OrdinalIgnoreCase) ||
                    arg.Equals("/uninstall", StringComparison.OrdinalIgnoreCase) ||
                    arg.Equals("-uninstall", StringComparison.OrdinalIgnoreCase))
                {
                    isUninstall = true;
                    break;
                }
            }

            if (isUninstall)
            {
                var installDir = AppDomain.CurrentDomain.BaseDirectory;
                Application.Run(new UninstallForm(installDir));
            }
            else
            {
                Application.Run(new SetupForm());
            }
        }
    }
}
