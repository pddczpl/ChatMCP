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
        // an update that needs recovery. The setup repairs it itself (InstallRecovery): the window offers the repair, and says what is true while it is not done: DatGold will not start, which file holds the backup
        // (and that it must not be deleted), where the log is. It never promises that a repair will work: a repair that was refused says why, and names the way out that always exists, the guide's block by hand.
        var recovery = new UpdateOutcome(false, "3.11.0", "3.10.2", "needs_recovery", "install_failed");
        var repair = UpdateWords.FailureFor(recovery, true);
        kit.Check(repair.Contains("3.11.0") && repair.Contains("stopped halfway") && repair.Contains("could not all be put back"), "it names the update that stopped halfway and says that the old files could not all be put back");
        kit.Check(repair.Contains("will not start") && repair.Contains(".chatmcp-update-pending.json") && repair.Contains("do not delete it") && repair.Contains("logs") && !repair.Contains("opened again"), "an update that needs recovery says that DatGold will not start until it is repaired, which file holds the backup and that it is not to be deleted, and where the log is, and never says it was opened");
        kit.Check(repair.Contains("Repair now") && repair.Contains("from the backup") && !repair.Contains("run DatGoldSetup.exe again", StringComparison.OrdinalIgnoreCase), "and it says what to press, Repair now, and that it puts the files back from the backup");
        kit.Check(!repair.Contains("will not install again while that file is there") && !repair.Contains("by hand"), "while it no longer sends the person to do by hand what the button does (the way by hand is named only when the button could not do it)");
        var earlier = UpdateWords.FailureFor(new UpdateOutcome(false, "3.11.0", "3.10.2", "needs_recovery", "pending_recovery"), true);
        kit.Check(earlier.Contains("Repair now") && earlier.Contains("from its backup"), "the same for the marker of an earlier update");
        kit.Check(earlier.Contains("earlier update") && earlier.Contains("did not finish") && earlier.Contains("was not started") && earlier.Contains("nothing was changed") && earlier.Contains("3.11.0"), "when the marker belongs to an EARLIER update it says so: this update was not started and nothing was changed");
        kit.Check(!earlier.Contains("stopped halfway") && !earlier.Contains("put back") && earlier.Contains("will not start") && earlier.Contains(".chatmcp-update-pending.json") && earlier.Contains("do not delete it") && earlier.Contains("logs") && !earlier.Contains("opened again"),
            "and does not claim that this update stopped halfway; it gives the same facts about the backup and the log");
        kit.Check(!UpdateWords.FailureFor(new UpdateOutcome(false, "3.11.0", null, "needs_recovery", "pending_recovery"), true).Contains("  ") && !repair.Contains("  "), "(no gaps in the sentences)");

        // the words for everything the window may say once a repair has been tried (UpdateEnd: the outcome, whether the app was opened, whether the repair worked, why it was refused)
        string End(UpdateOutcome outcome, bool relaunched = false, bool repaired = false, string? refusal = null) => UpdateWords.EndFor(new UpdateEnd(outcome, relaunched, repaired, refusal));
        kit.Check(End(recovery) == repair && End(recovery with { Reason = "pending_recovery" }) == UpdateWords.FailureFor(recovery with { Reason = "pending_recovery" }, false), "an end with no repair tried is said as the failure it is");
        foreach (var code in new[] { InstallRecovery.NotRecoverable, InstallRecovery.ForeignChanges, InstallRecovery.InsideInstallation, InstallRecovery.RestoreFailed })
        {
            var words = UpdateWords.RefusalFor(code);
            kit.Check(words.Length > 20 && words.EndsWith('.') && !words.Contains(":\\") && !words.Contains("Exception"), "a repair that was refused for " + code + " has words: " + words);
        }
        kit.Check(new[] { InstallRecovery.NotRecoverable, InstallRecovery.ForeignChanges, InstallRecovery.InsideInstallation, InstallRecovery.RestoreFailed }.Select(UpdateWords.RefusalFor).Distinct().Count() == 4, "different refusals are not said alike");
        kit.Check(UpdateWords.RefusalFor("tasks_running") == UpdateWords.ReasonFor("tasks_running") && UpdateWords.RefusalFor("window_open") == UpdateWords.ReasonFor("window_open"), "a refusal of the steps before it (tasks, a window that stays open) is said as the update says it");
        kit.Check(UpdateWords.RefusalFor("a code that is not on the list") == UpdateWords.RefusalFor(InstallRecovery.RestoreFailed) && UpdateWords.RefusalFor(null) == UpdateWords.RefusalFor(InstallRecovery.RestoreFailed), "and a code that is not on any list is said as a file that could not be put back");
        var refused = End(recovery, refusal: InstallRecovery.ForeignChanges);
        kit.Check(refused.Contains("tried to repair") && refused.Contains(UpdateWords.RefusalFor(InstallRecovery.ForeignChanges)) && refused.Contains("Repair now") && refused.Contains("Recovering an installation by hand") && refused.Contains("docs/WINDOWS-SETUP.md") && refused.Contains("will not start") && refused.Contains("do not delete it") && !refused.Contains("opened again"),
            "a repair that was refused says that it tried, why it could not, that Repair now can be pressed again, and the way out that always exists (the guide's block by hand); DatGold still will not start and the backup is still not to be deleted");
        var earlierRefused = End(new UpdateOutcome(false, "3.11.0", "3.10.2", "needs_recovery", "pending_recovery"), refusal: InstallRecovery.NotRecoverable);
        kit.Check(earlierRefused.Contains("earlier update") && earlierRefused.Contains("was not started") && earlierRefused.Contains(UpdateWords.RefusalFor(InstallRecovery.NotRecoverable)) && earlierRefused.Contains("Recovering an installation by hand"), "the same for an earlier update's marker");
        var done = End(new UpdateOutcome(false, "3.11.0", "3.10.1", "rolled_back", "install_failed"), relaunched: true, repaired: true);
        kit.Check(done.Contains("3.11.0") && done.Contains("could not be installed") && done.Contains("stopped halfway") && done.Contains("repaired") && done.Contains("put back") && done.Contains("3.10.1") && done.Contains("works again") && done.Contains("opened again") && !done.Contains("will not start") && !done.Contains("Repair now"),
            "a repair that worked says that the update could not be installed, that it stopped halfway, that DatGold repaired it, which version is back and works again, and that it was opened again");
        kit.Check(!End(new UpdateOutcome(false, "3.11.0", "3.10.1", "rolled_back", "install_failed"), relaunched: false, repaired: true).Contains("opened again"), "and does not say it was opened when it was not");
        kit.Check(done.Contains(UpdateWords.ReasonFor("install_failed")), "it gives the reason the update failed for");
        var doneEarlier = End(new UpdateOutcome(false, "3.11.0", "3.10.2", "rolled_back", "pending_recovery"), relaunched: true, repaired: true);
        kit.Check(doneEarlier.Contains("earlier update") && doneEarlier.Contains("repaired") && doneEarlier.Contains("3.10.2") && doneEarlier.Contains("was not started") && doneEarlier.Contains("run it again") && !doneEarlier.Contains("has to be recovered first") && !doneEarlier.Contains("will not start"),
            "when the marker was an earlier update's the words say that THAT update was put back, that this one was not started and should be run again, and do not call the earlier update one that still has to be recovered");
        kit.Check(!done.Contains("  ") && !doneEarlier.Contains("  ") && !refused.Contains("  ") && !End(new UpdateOutcome(false, "3.11.0", null, "rolled_back", "install_failed"), repaired: true).Contains("null"), "(no gaps in the sentences, and an old version that is not known is not printed as null)");
        kit.Check(UpdateWords.TitleFor(new UpdateEnd(recovery, false, false, null)) == "DatGold needs to be repaired" && UpdateWords.TitleFor(new UpdateEnd(recovery with { State = "rolled_back" }, true, true, null)) == "DatGold was repaired" && UpdateWords.TitleFor(new UpdateEnd(unchanged, true, false, null)) == "DatGold was not updated" && UpdateWords.TitleFor(new UpdateEnd(rolledBack, true, false, null)) == "DatGold was not updated",
            "the title says what state DatGold is in: needs to be repaired, was repaired, was not updated (a clean rollback is not a repair)");
        var unknownOld = new UpdateOutcome(false, "3.11.0", null, "unchanged", "no_installation");
        kit.Check(!UpdateWords.FailureFor(unknownOld, true).Contains("null") && !UpdateWords.FailureFor(unknownOld, true).Contains("  "), "an old version that is not known is not printed as null");
        kit.Check(UpdateWords.Title("3.11.0") == "Updating DatGold to 3.11.0" && UpdateWords.Waiting == "Waiting for DatGold to close...", "the window says what it is doing in the words the owner asked for");

        // what the repair form prints when it did not finish, and what the wizard asks and says: a refusal changed nothing, a repair that stopped halfway can be run again, any other failure says what it says
        var formRefused = UpdateWords.RepairFailureFor(new RecoveryException(InstallRecovery.ForeignChanges, "x"));
        kit.Check(formRefused.Contains("refused") && formRefused.Contains("nothing was changed") && formRefused.Contains(UpdateWords.RefusalFor(InstallRecovery.ForeignChanges)) && formRefused.Contains("Recovering an installation by hand") && formRefused.Contains("docs/WINDOWS-SETUP.md") && !formRefused.Contains("stopped halfway"),
            "the repair form says that a refusal changed nothing, why, and the way out by hand");
        var formStopped = UpdateWords.RepairFailureFor(new RecoveryException(InstallRecovery.RestoreFailed, "x", touched: true));
        kit.Check(formStopped.Contains("stopped halfway") && formStopped.Contains("run again") && formStopped.Contains(UpdateWords.RefusalFor(InstallRecovery.RestoreFailed)) && !formStopped.Contains("nothing was changed") && !formStopped.Contains("refused"),
            "and that a repair that stopped halfway can be run again, and why it stopped");
        kit.Check(UpdateWords.RepairFailureFor(new InvalidOperationException("Stop active DatGold tasks")) == "Stop active DatGold tasks" && !formRefused.Contains(":\\") && !formStopped.Contains(":\\") && !formRefused.Contains("  "), "any other failure (tasks that run, another update) says what it says, and no sentence holds a path");
        kit.Check(UpdateWords.Repaired.Contains("put back") && UpdateWords.NothingToRepair.Contains("no unfinished update") && UpdateWords.Repaired != UpdateWords.NothingToRepair, "the repair form says in one line that the installation was put back, or that there was nothing to put back");
        kit.Check(UpdateWords.RepairQuestion.Contains("stopped halfway") && UpdateWords.RepairQuestion.Contains("from its backup") && UpdateWords.RepairQuestion.EndsWith("Repair and install?") && !UpdateWords.RepairQuestion.Contains("  "), "and the wizard asks, before it installs over the marker of an update that stopped halfway, whether to repair it first");
    }
}
