using System.Diagnostics;
using ChatMCP.Installer;

// The child process of the tests of the repair (RecoverTests.Crash): it runs a real InstallTransaction.Commit over an installation that the parent has made, and kills itself right after the
// <killAfter>th change (Process.Kill is TerminateProcess: no finally, no rollback, no marker removal; what a power cut leaves). A value past the last change lets the commit finish.
internal static class CrashChild
{
    internal static void Run(string install, int killAfter)
    {
        using var transaction = new InstallTransaction(install);
        RecoverTests.Stage(transaction);
        var changed = 0;
        transaction.Commit((_, _) => { if (++changed == killAfter) Process.GetCurrentProcess().Kill(); });
    }
}
