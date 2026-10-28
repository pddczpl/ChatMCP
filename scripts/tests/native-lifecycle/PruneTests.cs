using ChatMCP.Installer;
using ChatMCP.Native;

// The folders that an update leaves empty. An installation made up to 3.11.0 kept its Hub in CHATMCP-HUB. The setup of this version removes the files that the manifest of the old setup lists, and
// InstallerEngine.PruneEmptyFolders takes away the folders that held them, and only those: a file that is still there (somebody changed it, or it was never the setup's) keeps its folder.
internal static class PruneTests
{
    internal static void Run(TestKit kit)
    {
        var root = kit.Folder("prune empty folders");
        Exception? Caught(Action action) { try { action(); return null; } catch (Exception error) { return error; } }

        var legacy = Path.Combine(root, "legacy");
        Directory.CreateDirectory(Path.Combine(legacy, "lib", "deep", "deeper"));
        Directory.CreateDirectory(Path.Combine(legacy, "web", "assets"));
        Directory.CreateDirectory(Path.Combine(legacy, "keep"));
        File.WriteAllText(Path.Combine(legacy, "keep", "user.txt"), "somebody's file");
        Directory.CreateDirectory(Path.Combine(legacy, "empty"));
        InstallerEngine.PruneEmptyFolders(legacy);
        kit.Check(!Directory.Exists(Path.Combine(legacy, "lib")) && !Directory.Exists(Path.Combine(legacy, "web")) && !Directory.Exists(Path.Combine(legacy, "empty")),
            "the folders that hold nothing, however deep, are removed");
        kit.Check(Directory.Exists(legacy) && File.ReadAllText(Path.Combine(legacy, "keep", "user.txt")) == "somebody's file",
            "and a file that is still there keeps its folder, and the folder above it, untouched");

        var hollow = Path.Combine(root, "hollow");
        Directory.CreateDirectory(Path.Combine(hollow, "a", "b"));
        InstallerEngine.PruneEmptyFolders(hollow);
        kit.Check(!Directory.Exists(hollow), "a tree with no file in it goes away with its own root");

        kit.Check(Caught(() => InstallerEngine.PruneEmptyFolders(Path.Combine(root, "missing"))) == null, "a folder that is not there is nothing to do, and no error");
        var notFolder = Path.Combine(root, "a-file.txt");
        File.WriteAllText(notFolder, "x");
        kit.Check(Caught(() => InstallerEngine.PruneEmptyFolders(notFolder)) == null && File.Exists(notFolder), "a file given by mistake is left alone");
    }
}
