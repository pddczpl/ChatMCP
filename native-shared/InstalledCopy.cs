namespace ChatMCP.Native;

/// <summary>
/// What makes a folder an installed copy of DatGold: the receipt of the files the installer owns (InstallerEngine writes it last, and the uninstaller and every later setup read it). The shell applies an update
/// only to a copy that has one: a build run from a work tree, or a folder that somebody copied the program into, was not made by the installer, and the installer would refuse to touch it anyway.
/// </summary>
internal static class InstalledCopy
{
    internal const string ReceiptName = ".chatmcp-installed-files.json";

    // The names below are written once, here, because the shell and the setup must agree on them: the shell looks for the marker that the setup's transaction writes, and both find the app by its file name.
    // They are identifiers, not the product's name (docs/NAMING.md says which old names stay and why); a message for a person spells them out itself.

    /// <summary>The file of the app in an installation. The setup stages, starts and closes it by this name, the shortcuts point at it, and an update of the shell looks for it beside the receipt.</summary>
    internal const string ProgramName = "ChatMCP.exe";

    /// <summary>The marker that an update writes before it replaces the first file and removes after the last one (InstallTransaction). While it is there the installation is a mix of two versions: the shell does not start its Hub, and setup repairs before anything else.</summary>
    internal const string PendingName = ".chatmcp-update-pending.json";

    /// <summary>How the folder of one update begins (the staged files and the backup; a GUID follows). The marker points at one, and the repair accepts no other name.</summary>
    internal const string UpdateFolderPrefix = ".ChatMCP-update-";

    internal static bool Is(string? directory) => !string.IsNullOrEmpty(directory) && File.Exists(Path.Combine(directory, ReceiptName));
}
