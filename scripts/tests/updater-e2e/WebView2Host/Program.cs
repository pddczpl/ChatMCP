using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ChatMCP.UpdaterRehearsal;

// A stand-in for the desktop shell, for the rehearsal of the page driver only. It opens a WebView2 window (off screen, out of the taskbar), loads an address, writes every message the page posts to it
// (chrome.webview.postMessage) to a file, and answers the apply-update message the way the shell does, with a code that a script put in a file of replies, one per line (consumed when used; "launched"
// when the file is empty). usage: WebView2Host <address> <profile folder> <replies file> <received file>
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 4) { Console.Error.WriteLine("usage: WebView2Host <address> <profile folder> <replies file> <received file>"); return 2; }
        ApplicationConfiguration.Initialize();
        Application.Run(new Host(args[0], args[1], args[2], args[3]));
        return 0;
    }
}

internal sealed class Host : Form
{
    private readonly WebView2 view = new() { Dock = DockStyle.Fill };

    public Host(string address, string profile, string repliesFile, string receivedFile)
    {
        Controls.Add(view);
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(-20000, -20000);
        ClientSize = new Size(1366, 850);
        Shown += async (_, _) =>
        {
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: profile);
            await view.EnsureCoreWebView2Async(environment);
            view.CoreWebView2.WebMessageReceived += (_, message) =>
            {
                File.AppendAllText(receivedFile, message.WebMessageAsJson + "\n");
                using var document = JsonDocument.Parse(message.WebMessageAsJson);
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var type) || type.GetString() != "chatmcp.apply-update") return;
                var id = root.TryGetProperty("id", out var identifier) ? identifier.GetString() : null;
                var code = "launched";
                if (File.Exists(repliesFile))
                {
                    var lines = File.ReadAllLines(repliesFile).Where(line => line.Trim().Length > 0).ToList();
                    if (lines.Count > 0) { code = lines[0].Trim(); File.WriteAllLines(repliesFile, lines.Skip(1)); }
                }
                view.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "chatmcp.update-result", id, ok = code == "launched", code }));
            };
            view.CoreWebView2.Navigate(address);
        };
    }
}
