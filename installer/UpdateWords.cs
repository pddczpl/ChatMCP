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
            "needs_recovery" => "The update to " + outcome.Version + " stopped halfway and the old files could not all be put back. DatGold will not start until this is repaired: run DatGoldSetup.exe again, or look in the installer log in %LOCALAPPDATA%\\ChatMCP\\logs.",
            "rolled_back" => head + " The files that had been replaced were put back. " + still + (relaunched ? " It was opened again." : ""),
            _ => head + " " + still + (relaunched ? " It was opened again." : ""),
        };
    }
}
