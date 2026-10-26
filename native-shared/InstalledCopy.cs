namespace ChatMCP.Native;

/// <summary>
/// What makes a folder an installed copy of DatGold: the receipt of the files the installer owns (InstallerEngine writes it last, and the uninstaller and every later setup read it). The shell applies an update
/// only to a copy that has one: a build run from a work tree, or a folder that somebody copied the program into, was not made by the installer, and the installer would refuse to touch it anyway.
/// </summary>
internal static class InstalledCopy
{
    internal const string ReceiptName = ".chatmcp-installed-files.json";

    internal static bool Is(string? directory) => !string.IsNullOrEmpty(directory) && File.Exists(Path.Combine(directory, ReceiptName));
}
