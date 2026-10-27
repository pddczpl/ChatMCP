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
                // An installation behind the marker of an update that stopped halfway is put back (see InstallRecovery): a line says what happened, and the exit code whether the installation is whole.
                case InstallerMode.Recover:
                    Environment.ExitCode = RunRecover(command);
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

        /// <summary>The explicit repair, with no window. Exit code 0 when the installation is whole (put back, or there was nothing to put back), 1 when it is not or the repair was refused (nothing was changed) or stopped halfway (run it again).</summary>
        private static int RunRecover(InstallerCommand command)
        {
            try
            {
                var result = InstallerEngine.Recover(command.InstallDir!, (_, _) => { });
                Console.WriteLine(result == RecoveryResult.Repaired ? UpdateWords.Repaired : UpdateWords.NothingToRepair);
                return 0;
            }
            catch (Exception error) { Console.Error.WriteLine(UpdateWords.RepairFailureFor(error)); return 1; }
        }

        /// <summary>
        /// The update, with its window. The work runs on another thread so that the window keeps moving; the exit code says whether the new version is in place. When it did not go through and the installation
        /// needs repair, the setup has tried to repair it by itself (UpdateRun), and the window offers the repair again.
        /// </summary>
        private static int RunUpdate(InstallerCommand command)
        {
            UpdateEnvironment environment;
            try { environment = UpdateRun.Real(); }
            catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
            UpdateEnd? end = null;
            using var form = new UpdateProgressForm(InstallerEngine.AppVersion);
            // the button of the window: the same repair, asked for by the person
            UpdateEnd Repair(UpdateOutcome failed)
            {
                var next = UpdateRun.RepairNow(command, environment, failed, (_, status) => form.Report(status));
                end = next;
                // "opened again" is said only when the app really was opened, not when it was asked for
                if (next.Outcome.Ok == false) Console.Error.WriteLine(UpdateWords.EndFor(next));
                return next;
            }
            form.Shown += (_, _) => Task.Run(() =>
            {
                try { end = UpdateRun.RunToEnd(command, environment, (_, status) => form.Report(status)); }
                catch (Exception error)
                {
                    Console.Error.WriteLine(error.Message);
                    end = new UpdateEnd(new UpdateOutcome(false, InstallerEngine.AppVersion, null, "unchanged", "install_failed"), false, false, null);
                }
                if (end.Outcome.Ok == false) Console.Error.WriteLine(UpdateWords.EndFor(end));
                form.Finish(end, Repair);
            });
            Application.Run(form);
            return end is { Outcome.Ok: true } ? 0 : 1;
        }
    }
}
