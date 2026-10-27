using ChatMCP.Native;

namespace ChatMCP.Installer;

/// <summary>
/// What the progress window of an update says. The words depend only on the code and the state of the outcome, never on the text of an exception (that can hold a path), and a failure always says in what
/// state DatGold is left: still the old version (and opened again), put back by a repair, or in need of one. English only, like the rest of the installer.
/// </summary>
internal static class UpdateWords
{
    internal const string Waiting = "Waiting for DatGold to close...";
    /// <summary>What the window says during the pause before the setup repairs by itself an update whose rollback could not put every file back.</summary>
    internal const string WaitingToRepair = "The update stopped halfway. Putting the files back in a moment...";
    /// <summary>What the repair form prints when it put the installation back, and when there was no unfinished update to put back.</summary>
    internal const string Repaired = "DatGold was put back as it was before the update that stopped halfway.";
    internal const string NothingToRepair = "There is no unfinished update to repair in this folder.";
    /// <summary>The question the setup wizard asks when the folder it is to install into holds the marker of an update that stopped halfway.</summary>
    internal const string RepairQuestion = "An earlier update of DatGold stopped halfway, and DatGold cannot be installed over it until it is repaired. Setup can put the files of that update back from its backup now and then install. Repair and install?";
    internal static string Title(string version) => "Updating DatGold to " + version;

    internal static string ReasonFor(string? code) => code switch
    {
        "shell_not_exited" => "DatGold did not close in time.",
        "no_installation" => "The installed DatGold could not be found.",
        "not_newer" => "This installer is not newer than the installed DatGold.",
        "disk_full" => "There is not enough free disk space for the update.",
        "pending_recovery" => "An earlier update did not finish and has to be recovered first.",
        "tasks_running" => "DatGold is still running tasks. Stop them and try again.",
        "foreign_listener" => "Another program is using the port that DatGold needs (3007).",
        "hub_stop_failed" => "DatGold's background service could not be stopped.",
        "window_open" => "A DatGold window could not be closed.",
        "another_update" => "Another installation or update is running.",
        "payload_invalid" => "This installer is damaged.",
        _ => "The files could not be replaced.",
    };

    /// <summary>Why a repair did not happen or did not finish: its own refusals, the reasons of the steps before it (tasks that run, a window that stays open), and, for anything else, a file that could not be put back.</summary>
    internal static string RefusalFor(string? code) => code switch
    {
        InstallRecovery.NotRecoverable => "The backup of the update is missing or damaged.",
        InstallRecovery.ForeignChanges => "A file of DatGold was changed by something else after the update began.",
        InstallRecovery.InsideInstallation => "The repair cannot be run by a program that is inside the DatGold folder.",
        var known when StepCode.IsKnown(known) => ReasonFor(known),
        _ => "A file could not be put back, probably because another program has it open.",
    };

    /// <summary>The message of a failed update: what could not be installed, why, and in what state DatGold is. <paramref name="relaunched"/> says that the app was asked to open again.</summary>
    internal static string FailureFor(UpdateOutcome outcome, bool relaunched) => EndFor(new UpdateEnd(outcome, relaunched, false, null));

    /// <summary>The title of the window once the update is over without the new version: what state DatGold is in.</summary>
    internal static string TitleFor(UpdateEnd end) =>
        end.Repaired ? "DatGold was repaired" : end.Outcome.State == "needs_recovery" ? "DatGold needs to be repaired" : "DatGold was not updated";

    /// <summary>Everything the window says once the update is over without the new version, and what a repair did if one was tried.</summary>
    internal static string EndFor(UpdateEnd end)
    {
        var outcome = end.Outcome;
        if (end.Repaired) return RepairedFor(end);
        var head = "DatGold " + outcome.Version + " could not be installed. " + ReasonFor(outcome.Reason);
        var still = outcome.Previous == null ? "The installed version has not been changed." : "DatGold " + outcome.Previous + " is still installed.";
        return outcome.State switch
        {
            "needs_recovery" => RecoveryFor(end),
            "rolled_back" => head + " The files that had been replaced were put back. " + still + (end.Relaunched ? " It was opened again." : ""),
            _ => head + " " + still + (end.Relaunched ? " It was opened again." : ""),
        };
    }

    /// <summary>What the repair form prints when it did not finish: a refusal changed nothing, a repair that stopped halfway can be run again. Any other failure (tasks that run, another update) says what it says.</summary>
    internal static string RepairFailureFor(Exception error) => error is RecoveryException stopped
        ? (stopped.Touched ? "The repair stopped halfway and can be run again: " : "The repair was refused and nothing was changed: ") + RefusalFor(stopped.Code) + ByHand
        : error.Message;

    private const string ByHand = " To put the files back by hand, follow Recovering an installation by hand in docs/WINDOWS-SETUP.md in the DatGold project on GitHub.";

    /// <summary>The installation was repaired: every file the update had changed is back, and the version from before works again. The reason of the update is kept for the page; here it is said once.</summary>
    private static string RepairedFor(UpdateEnd end)
    {
        var outcome = end.Outcome;
        var back = outcome.Previous == null ? "DatGold" : "DatGold " + outcome.Previous;
        var opened = end.Relaunched ? " It was opened again." : "";
        return outcome.Reason == "pending_recovery"
            ? "An earlier update of DatGold had stopped halfway. DatGold has repaired the installation: every file that update had changed was put back, and " + back + " works again. The update to " + outcome.Version + " was not started; run it again." + opened
            : "DatGold " + outcome.Version + " could not be installed. " + ReasonFor(outcome.Reason) + " The update stopped halfway and its files could not all be put back at first; DatGold has repaired the installation: every file it had changed was put back, and " + back + " works again." + opened;
    }

    /// <summary>
    /// An update that left the installation in need of repair, in two cases that must not be mixed up: the marker of an EARLIER update was found (this one was not started, nothing was changed) or this one stopped
    /// halfway. The words say that DatGold will not start, where the backup is and that it is not to be deleted, where the log is, and what to press. When a repair was tried and refused they say why, and name the one
    /// way out that always exists: the section of the setup guide that puts the files back by hand (it is in the repository, not in the installation, so the words say where to find it).
    /// </summary>
    private static string RecoveryFor(UpdateEnd end)
    {
        var outcome = end.Outcome;
        const string keep = "Keep the backup that .chatmcp-update-pending.json in the DatGold folder points to (do not delete it) and look in the installer log in %LOCALAPPDATA%\\ChatMCP\\logs.";
        var earlier = outcome.Reason == "pending_recovery";
        var what = earlier
            ? "An earlier update of DatGold did not finish, so the update to " + outcome.Version + " was not started and nothing was changed. DatGold will not start until that earlier update is repaired."
            : "The update to " + outcome.Version + " stopped halfway and the old files could not all be put back. DatGold will not start until this is repaired.";
        if (end.RepairRefusal == null)
            return what + " Press Repair now to put the files back from " + (earlier ? "its" : "the") + " backup. " + keep;
        return what + " DatGold tried to repair it and could not: " + RefusalFor(end.RepairRefusal) + " Press Repair now to try again once that is fixed." + ByHand + " " + keep;
    }
}
