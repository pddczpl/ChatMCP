using ChatMCP.Native;

// What a page may ask the shell to open in the SYSTEM browser: the release pages of the project, and nothing else. A link that opens a new window used to be forwarded to the
// preview tab only, whose frame cannot show github.com, so "What's new" opened nothing in the desktop app. The decision is made on the PARSED address and the opener is handed the
// address as it was parsed (AbsoluteUri), so the check and what the browser opens cannot disagree about a dot segment, a backslash, an encoded slash, a trailing dot or a user name.
internal static class LinkTests
{
    private const string Notes = "https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.2";

    internal static void Run(TestKit kit)
    {
        string? Open(string? address) => OpenLink.TryGetExternalLink(address, out var external) ? external : null;

        // ---- what opens ---------------------------------------------------------------------------------------------------------------------------------
        kit.Check(Open(Notes) == Notes, "the release notes of the project open in the system browser");
        kit.Check(Open("HTTPS://GitHub.COM/pddczpl/ChatMCP/releases/tag/v3.10.2") == Notes, "the scheme and the host may be written in any letter case; the opener gets them as parsed");
        kit.Check(Open("https://github.com/pddczpl/ChatMCP/releases/latest") == "https://github.com/pddczpl/ChatMCP/releases/latest", "the Latest release page opens");
        kit.Check(Open("https://github.com/pddczpl/ChatMCP/releases/") == "https://github.com/pddczpl/ChatMCP/releases/", "so does the list of releases (the prefix itself)");
        kit.Check(Open(Notes + "?expanded=true#notes") == Notes + "?expanded=true#notes", "a query and a fragment on a release page go on with it");

        // ---- what does not -------------------------------------------------------------------------------------------------------------------------------
        var refused = new (string Why, string? Address)[]
        {
            ("nothing", null), ("an empty string", ""), ("a space", " "), ("a relative path", "/pddczpl/ChatMCP/releases/"), ("a path with no host", "pddczpl/ChatMCP/releases/tag/v1"),
            // the scheme
            ("http", "http://github.com/pddczpl/ChatMCP/releases/tag/v3.10.2"), ("ftp", "ftp://github.com/pddczpl/ChatMCP/releases/"),
            ("javascript:", "javascript:window.open('https://github.com/pddczpl/ChatMCP/releases/')"), ("file:", "file:///C:/pddczpl/ChatMCP/releases/"),
            ("data:", "data:text/html,<script>1</script>"), ("about:blank", "about:blank"), ("chrome:", "chrome://settings"),
            ("a protocol handler of Windows (ms-msdt:)", "ms-msdt:/id PCWDiagnostic /skip force /param \"IT_BrowseForFile=x\""), ("a protocol handler of Windows (search-ms:)", "search-ms:query=x&crumb=location:https://github.com/pddczpl/ChatMCP/releases/"),
            ("a protocol handler of Windows (ms-settings:)", "ms-settings:privacy"), ("a protocol handler of an application (steam:)", "steam://run/1"),
            // the host
            ("a host that only starts with github.com", "https://github.com.evil.example/pddczpl/ChatMCP/releases/tag/v3.10.2"),
            ("github.com in the path of another host", "https://evil.example/github.com/pddczpl/ChatMCP/releases/"),
            ("github.com as the user name of another host", "https://github.com@evil.example/pddczpl/ChatMCP/releases/"),
            ("a subdomain", "https://gist.github.com/pddczpl/ChatMCP/releases/"), ("a trailing dot on the host", "https://github.com./pddczpl/ChatMCP/releases/tag/v3.10.2"),
            ("a host with a letter that only looks like an i", "https://g" + char.ConvertFromUtf32(0x0456) + "thub.com/pddczpl/ChatMCP/releases/tag/v3.10.2"),
            ("an address of the machine", "https://127.0.0.1/pddczpl/ChatMCP/releases/"), ("an address of the machine as an IPv6 literal", "https://[::1]/pddczpl/ChatMCP/releases/"),
            ("a backslash where the host ends", "https://github.com\\@evil.example/pddczpl/ChatMCP/releases/"), ("a backslash before the path", "https://github.com\\pddczpl\\ChatMCP\\releases\\tag\\v1"),
            // a user name, a password or a port
            ("a user name and a password", "https://user:secret@github.com/pddczpl/ChatMCP/releases/tag/v3.10.2"), ("a user name", "https://user@github.com/pddczpl/ChatMCP/releases/"),
            ("a port", "https://github.com:8443/pddczpl/ChatMCP/releases/"), ("the default port written out", "https://github.com:443/pddczpl/ChatMCP/releases/tag/v3.10.2"),
            ("an empty port", "https://github.com:/pddczpl/ChatMCP/releases/"),
            // the path
            ("the start page", "https://github.com/"), ("the repository", "https://github.com/pddczpl/ChatMCP/"), ("the releases page with no slash after it", "https://github.com/pddczpl/ChatMCP/releases"),
            ("another page of the repository", "https://github.com/pddczpl/ChatMCP/issues/1"), ("a path that only starts with releases", "https://github.com/pddczpl/ChatMCP/releasesevil/tag/v1"),
            ("the repository in another letter case", "https://github.com/pddczpl/chatmcp/releases/tag/v3.10.2"), ("the owner in another letter case", "https://github.com/PDDCZPL/ChatMCP/releases/tag/v3.10.2"),
            ("a repository whose name starts with ChatMCP", "https://github.com/pddczpl/ChatMCP-fork/releases/tag/v1"), ("another owner", "https://github.com/evil/pddczpl/ChatMCP/releases/"),
            ("an empty segment at the start of the path", "https://github.com//pddczpl/ChatMCP/releases/tag/v1"),
            ("dot segments that leave the releases folder", "https://github.com/pddczpl/ChatMCP/releases/../../../evil/x"), ("encoded dot segments", "https://github.com/pddczpl/ChatMCP/releases/%2e%2e/%2e%2e/evil"),
            ("encoded dot segments in capitals", "https://github.com/pddczpl/ChatMCP/releases/%2E%2E/evil"), ("a dot segment that stays inside", "https://github.com/pddczpl/ChatMCP/releases/./tag/v3.10.2"),
            ("an encoded slash", "https://github.com/pddczpl/ChatMCP/releases/..%2f..%2fevil"), ("an encoded backslash", "https://github.com/pddczpl/ChatMCP/releases/tag%5c..%5cevil"),
            ("a backslash in the path", "https://github.com/pddczpl/ChatMCP/releases\\..\\evil"),
            // characters that are not part of an address
            ("a space at the end", Notes + " "), ("a space at the start", " " + Notes), ("a line break at the end", Notes + "\n"), ("a tab in the path", "https://github.com/pddczpl/ChatMCP/releases/\ttag/v1"),
            ("a null character", Notes + "\0"), ("a character that is not ASCII", "https://github.com/pddczpl/ChatMCP/releases/tag/v" + char.ConvertFromUtf32(0x00E9)),
            ("an address over 2048 characters", "https://github.com/pddczpl/ChatMCP/releases/tag/v" + new string('1', 2100)),
        };
        foreach (var (why, address) in refused)
            kit.Check(Open(address) == null, "not opened in the system browser: " + why);

        // what is not opened there keeps its old road: the page is told, and the preview tab decides (OpenLink.TryCreateMessage is untouched)
        kit.Check(OpenLink.TryCreateMessage("https://github.com.evil.example/pddczpl/ChatMCP/releases/tag/v3.10.2", out _), "a link that is not on the list is still forwarded to the page, as before");
        kit.Check(OpenLink.TryCreateMessage("http://127.0.0.1:3007/#preview", out _) && Open("http://127.0.0.1:3007/#preview") == null, "so is a link to the app itself, and it never reaches the system browser");
        kit.Check(!OpenLink.TryCreateMessage("javascript:1", out _) && !OpenLink.TryCreateMessage("ms-settings:privacy", out _), "and a scheme that is not http or https is still dropped");
    }
}
