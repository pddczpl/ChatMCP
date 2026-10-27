using ChatMCP.Native;

namespace ChatMCP.Installer;

/// <summary>
/// What the progress window of an update says. The words depend only on the code and the state of the outcome, never on the text of an exception (that can hold a path), and a failure always says in what
/// state DatGold is left: still the old version (and opened again), or in need of repair. English only, like the rest of the installer.
/// </summary>
internal static class UpdateWords
{
    internal const string Waiting = "Waiting for DatGold to close...";
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

    /// <summary>The message of a failed update: what could not be installed, why, and in what state DatGold is. <paramref name="relaunched"/> says that the app was asked to open again.</summary>
    internal static string FailureFor(UpdateOutcome outcome, bool relaunched)
    {
        var head = "DatGold " + outcome.Version + " could not be installed. " + ReasonFor(outcome.Reason);
        var still = outcome.Previous == null ? "The installed version has not been changed." : "DatGold " + outcome.Previous + " is still installed.";
        return outcome.State switch
        {
            "needs_recovery" => RecoveryFor(outcome),
            "rolled_back" => head + " The files that had been replaced were put back. " + still + (relaunched ? " It was opened again." : ""),
            _ => head + " " + still + (relaunched ? " It was opened again." : ""),
        };
    }

    /// <summary>
    /// An update that left the installation in need of recovery, in two cases that must not be mixed up: the marker of an EARLIER update was found (this one was not started, nothing was changed) or this one stopped
    /// halfway. Nothing recovers it by itself and setup refuses to install while the marker is there (InstallTransaction), so the words do not send the person to run the setup again: they say that DatGold will not
    /// start, where the backup is and that it is not to be deleted, where the log is, that setup will not install meanwhile, and the one way out there is: the section of the setup guide that puts the files
    /// back by hand (it is in the repository, not in the installation, so the words say where to find it).
    /// </summary>
    private static string RecoveryFor(UpdateOutcome outcome)
    {
        const string keep = "Keep the backup that .chatmcp-update-pending.json in the DatGold folder points to (do not delete it) and look in the installer log in %LOCALAPPDATA%\\ChatMCP\\logs. DatGoldSetup.exe will not install again while that file is there. "
            + "To put the files back by hand, follow Recovering an installation by hand in docs/WINDOWS-SETUP.md in the DatGold project on GitHub.";
        return outcome.Reason == "pending_recovery"
            ? "An earlier update of DatGold did not finish, so the update to " + outcome.Version + " was not started and nothing was changed. DatGold will not start until that earlier update is recovered. " + keep
            : "The update to " + outcome.Version + " stopped halfway and the old files could not all be put back. DatGold will not start until this is recovered. " + keep;
    }
}
