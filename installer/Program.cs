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

            // Explicit unattended mode uses exactly the same engine, ownership,
            // active-task checks and rollback as the wizard. It is not a test bypass.
            if (Array.Exists(args, arg => arg == "--quiet"))
            {
                try
                {
                    if (isUninstall)
                    {
                        if (args.Length != 2 || !Array.Exists(args, arg => arg == "--uninstall"))
                            throw new ArgumentException("Use Uninstall.exe --quiet --uninstall.");
                        InstallerEngine.Uninstall(AppDomain.CurrentDomain.BaseDirectory, (_, _) => { });
                    }
                    else
                    {
                        int index = Array.IndexOf(args, "--install-dir");
                        if (args.Length != 3 || index < 0 || index + 1 >= args.Length || !Path.IsPathFullyQualified(args[index + 1]))
                            throw new ArgumentException("Use DatGoldSetup.exe --quiet --install-dir <absolute directory>.");
                        InstallerEngine.Install(args[index + 1], true, true, (_, _) => { });
                    }
                }
                catch (Exception error) { Console.Error.WriteLine(error.Message); Environment.ExitCode = 1; }
                return;
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
