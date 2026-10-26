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

        var unchanged = new UpdateOutcome(false, "3.11.0", "3.10.2", "unchanged", "tasks_running");
        var text = UpdateWords.FailureFor(unchanged, relaunched: true);
        kit.Check(text.Contains("3.11.0") && text.Contains("3.10.2") && text.Contains(UpdateWords.ReasonFor("tasks_running")) && text.Contains("opened again"), "a refusal says which version could not be installed, why, which one is still there, and that it was opened again");
        kit.Check(!UpdateWords.FailureFor(unchanged, relaunched: false).Contains("opened again"), "and does not say it was opened when it was not asked to");
        var rolledBack = new UpdateOutcome(false, "3.11.0", "3.10.2", "rolled_back", "install_failed");
        kit.Check(UpdateWords.FailureFor(rolledBack, true).Contains("put back") && UpdateWords.FailureFor(rolledBack, true).Contains("3.10.2"), "a clean rollback says that the files were put back and which version is installed");
        var recovery = new UpdateOutcome(false, "3.11.0", "3.10.2", "needs_recovery", "install_failed");
        var repair = UpdateWords.FailureFor(recovery, true);
        kit.Check(repair.Contains("will not start") && repair.Contains("DatGoldSetup.exe") && repair.Contains("logs") && !repair.Contains("opened again"), "an update that needs recovery says that DatGold will not start until it is repaired, and where to look, and never says it was opened");
        var unknownOld = new UpdateOutcome(false, "3.11.0", null, "unchanged", "no_installation");
        kit.Check(!UpdateWords.FailureFor(unknownOld, true).Contains("null") && !UpdateWords.FailureFor(unknownOld, true).Contains("  "), "an old version that is not known is not printed as null");
        kit.Check(UpdateWords.Title("3.11.0") == "Updating DatGold to 3.11.0" && UpdateWords.Waiting == "Waiting for DatGold to close...", "the window says what it is doing in the words the owner asked for");
    }
}
