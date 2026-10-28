using ChatMCP.Native;

// The folder that holds the Hub: DATGOLD-HUB in a source checkout, CHATMCP-HUB in an installation (scripts/InstallerPayload.ps1 maps the one onto the other, so that every installation of every
// version has the folder that the installer, the update and the Hub ownership check look for). The shell and the ownership check ask HubFolder instead of writing a name.
internal static class HubFolderTests
{
    internal static void Run(TestKit kit)
    {
        var installation = kit.Folder("hub folder installation");
        Directory.CreateDirectory(Path.Combine(installation, "CHATMCP-HUB"));
        kit.Check(HubFolder.Name(installation) == "CHATMCP-HUB" && HubFolder.Exists(installation), "an installation has the folder CHATMCP-HUB, and it is found by that name");

        var checkout = kit.Folder("hub folder checkout");
        Directory.CreateDirectory(Path.Combine(checkout, "DATGOLD-HUB"));
        kit.Check(HubFolder.Name(checkout) == "DATGOLD-HUB" && HubFolder.Exists(checkout), "a source checkout has the folder DATGOLD-HUB, and it is found by that name");

        var both = kit.Folder("hub folder both");
        Directory.CreateDirectory(Path.Combine(both, "CHATMCP-HUB"));
        Directory.CreateDirectory(Path.Combine(both, "DATGOLD-HUB"));
        kit.Check(HubFolder.Name(both) == "DATGOLD-HUB" && HubFolder.Exists(both), "a checkout that still has the old folder of an earlier version beside the new one uses the new one");

        var neither = kit.Folder("hub folder neither");
        kit.Check(!HubFolder.Exists(neither) && HubFolder.Name(neither) == "CHATMCP-HUB", "a folder with neither holds no Hub, and is asked for the name that an installation has");

        // The ownership check compares the command line of the program that listens on the port with the hub.mjs of the folder that is there.
        kit.Check(HubFolder.Source == "DATGOLD-HUB" && HubFolder.Installed == "CHATMCP-HUB", "the two names are the ones the repository and the installations use");
    }
}
