using ChatMCP.Native;

// Runs the installer's real preflight (HubLifecycle.StopInstalledHub) against the Hub installed under args[0].
var root = args[0];
try
{
    await HubLifecycle.StopInstalledHub(root);
    Console.WriteLine("STOPPED");
    return 0;
}
catch (Exception error)
{
    Console.WriteLine("REFUSED: " + error.Message);
    return 2;
}
