using ChatMCP.Installer;
using ChatMCP.Native;

// What the progress window of an update says when it did not work. The words are chosen by the code and the state of the outcome and never contain text of an exception (that can hold a path),
// and a failure always says what state the installed DatGold is in: still the old version and opened again, or in need of repair.
internal static class UpdateWordsTests
{
    internal static void Run(TestKit kit)
    {
        // every reason of the closed list has words of its own
        foreach (var code in StepCode.Known)
        {
            var words = UpdateWords.ReasonFor(code);
            kit.Check(words.Length > 10 && words.EndsWith('.') && !words.Contains(":\\") && !words.Contains("Exception"), "reason " + code + " has words: " + words);
        }
        kit.Check(UpdateWords.ReasonFor("a code that is not on the list") == UpdateWords.ReasonFor("install_failed") && UpdateWords.ReasonFor(null) == UpdateWords.ReasonFor("install_failed"), "and a code that is not on the list (or none) is said as an install that failed");
        kit.Check(new[] { "tasks_running", "disk_full", "not_newer", "foreign_listener", "window_open" }.Select(UpdateWords.ReasonFor).Distinct().Count() == 5, "different reasons are not said alike");
        kit.Check(UpdateWords.ReasonFor("foreign_listener").Contains("3007") && UpdateWords.ReasonFor("tasks_running").Contains("Stop") && UpdateWords.ReasonFor("disk_full").Contains("disk space") && UpdateWords.ReasonFor("not_newer").Contains("not newer") && UpdateWords.ReasonFor("shell_not_exited").Contains("close") && UpdateWords.ReasonFor("pending_recovery").Contains("recovered"),
            "and the ones a person can act on say what to act on: the port 3007, stopping tasks, the disk space, an installer that is not newer, an app that did not close, an update to recover");

        var unchanged = new UpdateOutcome(false, "3.11.0", "3.10.2", "unchanged", "tasks_running");
        var text = UpdateWords.FailureFor(unchanged, relaunched: true);
        kit.Check(text.Contains("3.11.0") && text.Contains("3.10.2") && text.Contains(UpdateWords.ReasonFor("tasks_running")) && text.Contains("opened again"), "a refusal says which version could not be installed, why, which one is still there, and that it was opened again");
        kit.Check(!UpdateWords.FailureFor(unchanged, relaunched: false).Contains("opened again"), "and does not say it was opened when it was not asked to");
        var rolledBack = new UpdateOutcome(false, "3.11.0", "3.10.2", "rolled_back", "install_failed");
        kit.Check(UpdateWords.FailureFor(rolledBack, true).Contains("put back") && UpdateWords.FailureFor(rolledBack, true).Contains("3.10.2"), "a clean rollback says that the files were put back and which version is installed");
        kit.Check(UpdateWords.FailureFor(rolledBack, true).Contains("opened again") && !UpdateWords.FailureFor(rolledBack, false).Contains("opened again"), "and that it was opened again only when it was asked to");
        // an update that needs recovery. Nothing repairs it by itself, and setup REFUSES to install while the marker of the unfinished update is there (InstallTransaction), so the words never send the person
        // to run the setup again; they say what is true: DatGold will not start, which file holds the backup (and that it must not be deleted), where the log is, and that setup will not install meanwhile.
        var recovery = new UpdateOutcome(false, "3.11.0", "3.10.2", "needs_recovery", "install_failed");
        var repair = UpdateWords.FailureFor(recovery, true);
        kit.Check(repair.Contains("3.11.0") && repair.Contains("stopped halfway") && repair.Contains("could not all be put back"), "it names the update that stopped halfway and says that the old files could not all be put back");
        kit.Check(repair.Contains("will not start") && repair.Contains(".chatmcp-update-pending.json") && repair.Contains("do not delete it") && repair.Contains("logs") && !repair.Contains("opened again"), "an update that needs recovery says that DatGold will not start until it is recovered, which file holds the backup and that it is not to be deleted, and where the log is, and never says it was opened");
        kit.Check(repair.Contains("will not install again while that file is there") && !repair.Contains("run DatGoldSetup.exe again", StringComparison.OrdinalIgnoreCase) && !repair.Contains("repaired"), "and it does not promise what is not true: running the setup again does not recover it (setup refuses while the marker is there)");
        var earlier = UpdateWords.FailureFor(new UpdateOutcome(false, "3.11.0", "3.10.2", "needs_recovery", "pending_recovery"), true);
        kit.Check(earlier.Contains("earlier update") && earlier.Contains("did not finish") && earlier.Contains("was not started") && earlier.Contains("nothing was changed") && earlier.Contains("3.11.0"), "when the marker belongs to an EARLIER update it says so: this update was not started and nothing was changed");
        kit.Check(!earlier.Contains("stopped halfway") && !earlier.Contains("put back") && earlier.Contains("will not start") && earlier.Contains(".chatmcp-update-pending.json") && earlier.Contains("do not delete it") && earlier.Contains("logs") && earlier.Contains("will not install again while that file is there") && !earlier.Contains("opened again"),
            "and does not claim that this update stopped halfway; it gives the same facts about the backup, the log and the setup");
        kit.Check(!UpdateWords.FailureFor(new UpdateOutcome(false, "3.11.0", null, "needs_recovery", "pending_recovery"), true).Contains("  ") && !repair.Contains("  "), "(no gaps in the sentences)");
        var unknownOld = new UpdateOutcome(false, "3.11.0", null, "unchanged", "no_installation");
        kit.Check(!UpdateWords.FailureFor(unknownOld, true).Contains("null") && !UpdateWords.FailureFor(unknownOld, true).Contains("  "), "an old version that is not known is not printed as null");
        kit.Check(UpdateWords.Title("3.11.0") == "Updating DatGold to 3.11.0" && UpdateWords.Waiting == "Waiting for DatGold to close...", "the window says what it is doing in the words the owner asked for");
    }
}
