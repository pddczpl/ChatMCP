using ChatMCP.Native;
using System;
using System.IO;
using System.Threading.Tasks;
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

            // Every form of the command line is read in one place (native-shared/UpdateContract.cs) and held to literal vectors by the native tests.
            InstallerCommand command;
            try { command = InstallerCommandLine.Parse(args, Path.GetFileNameWithoutExtension(Environment.ProcessPath ?? "")); }
            catch (ArgumentException error) { Console.Error.WriteLine(error.Message); Environment.ExitCode = 1; return; }

            switch (command.Mode)
            {
                // Explicit unattended mode uses exactly the same engine, ownership,
                // active-task checks and rollback as the wizard. It is not a test bypass.
                case InstallerMode.QuietUninstall:
                    try { InstallerEngine.Uninstall(AppDomain.CurrentDomain.BaseDirectory, (_, _) => { }); }
                    catch (Exception error) { Console.Error.WriteLine(error.Message); Environment.ExitCode = 1; }
                    return;
                case InstallerMode.QuietInstall:
                    try { InstallerEngine.Install(command.InstallDir!, true, true, (_, _) => { }); }
                    catch (Exception error) { Console.Error.WriteLine(error.Message); Environment.ExitCode = 1; }
                    return;
                // The shell started this setup to replace the installation it was running from: see UpdateRun.
                case InstallerMode.Update:
                    Environment.ExitCode = RunUpdate(command);
                    return;
                case InstallerMode.WizardUninstall:
                    Application.Run(new UninstallForm(AppDomain.CurrentDomain.BaseDirectory));
                    return;
                default:
                    Application.Run(new SetupForm());
                    return;
            }
        }

        /// <summary>The update, with its window. The work runs on another thread so that the window keeps moving; the exit code says whether the new version is in place.</summary>
        private static int RunUpdate(InstallerCommand command)
        {
            UpdateEnvironment environment;
            try { environment = UpdateRun.Real(); }
            catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
            UpdateOutcome? outcome = null;
            using var form = new UpdateProgressForm(InstallerEngine.AppVersion);
            form.Shown += (_, _) => Task.Run(() =>
            {
                var relaunched = false;
                try { outcome = UpdateRun.Run(command, environment, (_, status) => form.Report(status), out relaunched); }
                catch (Exception error)
                {
                    Console.Error.WriteLine(error.Message);
                    outcome = new UpdateOutcome(false, InstallerEngine.AppVersion, null, "unchanged", "install_failed");
                }
                // "opened again" is said only when the app really was opened, not when it was asked for
                if (outcome.Ok == false) Console.Error.WriteLine(UpdateWords.FailureFor(outcome, relaunched));
                form.Finish(outcome, relaunched);
            });
            Application.Run(form);
            return outcome is { Ok: true } ? 0 : 1;
        }
    }
}
