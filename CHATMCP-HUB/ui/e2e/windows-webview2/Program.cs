using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ChatMCP.WebViewSmoke;

internal static class Program
{
    public static int Result = 1;

    [STAThread]
    private static int Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.InputEncoding = System.Text.Encoding.UTF8;
        if (args.Length != 2 || !Uri.TryCreate(args[0], UriKind.Absolute, out var url)
            || url.Scheme != "http" || url.Host != "127.0.0.1" || url.Port == 3007)
        {
            Console.Error.WriteLine("FAIL: Supply an isolated loopback Hub URL and temporary WebView2 profile.");
            return 1;
        }
        ApplicationConfiguration.Initialize();
        using var form = new SmokeWindow(url, args[1]);
        Application.Run(form);
        return Result;
    }
}

internal sealed class SmokeWindow : Form
{
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill };
    private readonly Uri origin;
    private readonly string profile;
    private readonly List<string> errors = [];
    private readonly HashSet<string> requests = [];
    private readonly List<string> passed = [];

    public SmokeWindow(Uri origin, string profile)
    {
        this.origin = origin;
        this.profile = profile;
        // WebView2 needs a native window/message pump. Keep the harness invisible,
        // off screen and out of the taskbar; it never opens the user's desktop app.
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(-20000, -20000);
        Size = new Size(1600, 1000);
        Opacity = 0;
        Controls.Add(browser);
        Shown += async (_, _) => await RunSmoke();
    }

    private async Task WaitFor(string expression, string label)
    {
        var deadline = DateTime.UtcNow.AddSeconds(25);
        while (DateTime.UtcNow < deadline)
        {
            if (await browser.CoreWebView2.ExecuteScriptAsync($"Boolean({expression})") == "true")
            {
                passed.Add(label);
                return;
            }
            if (errors.Count > 0) throw new InvalidOperationException(string.Join("; ", errors));
            await Task.Delay(150);
        }
        var body = await browser.CoreWebView2.ExecuteScriptAsync("document.body?.innerText?.slice(0, 2500)");
        throw new TimeoutException($"Waiting for {label}: {body}");
    }

    private async Task RunSmoke()
    {
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: profile);
            await browser.EnsureCoreWebView2Async(environment);
            browser.CoreWebView2.WebMessageReceived += (_, message) =>
            {
                try { errors.Add(message.TryGetWebMessageAsString()); }
                catch (Exception error) { errors.Add(error.Message); }
            };
            browser.CoreWebView2.ProcessFailed += (_, failure) => errors.Add($"WebView2 process failed: {failure.ProcessFailedKind}");
            browser.CoreWebView2.NavigationStarting += (_, navigation) =>
            {
                if (!navigation.Uri.StartsWith(origin.GetLeftPart(UriPartial.Authority) + "/", StringComparison.Ordinal))
                {
                    navigation.Cancel = true;
                    errors.Add($"Unexpected navigation: {navigation.Uri}");
                }
            };
            browser.CoreWebView2.WebResourceResponseReceived += (_, response) =>
            {
                if (!Uri.TryCreate(response.Request.Uri, UriKind.Absolute, out var url) || !url.AbsolutePath.StartsWith("/api/")) return;
                requests.Add(url.AbsolutePath);
                if (response.Response.StatusCode >= 400) errors.Add($"HTTP {response.Response.StatusCode}: {url.AbsolutePath}");
            };
            await browser.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("""
                addEventListener('error', event => chrome.webview.postMessage('JavaScript: ' + event.message));
                addEventListener('unhandledrejection', event => chrome.webview.postMessage('Promise: ' + String(event.reason)));
                const originalError = console.error;
                console.error = (...args) => {
                  chrome.webview.postMessage('Console: ' + args.map(String).join(' '));
                  originalError.apply(console, args);
                };
                """);
            browser.CoreWebView2.Navigate(origin.ToString());
            await WaitFor("document.querySelector('#root header')", "current React root rendered");
            await WaitFor("document.querySelector('[role=dialog][aria-label=\"Thiết lập ChatMCP\"]')", "fresh onboarding rendered");
            await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('[aria-label=\"Đóng thiết lập\"]').click()");
            await WaitFor("!document.querySelector('[role=dialog][aria-label=\"Thiết lập ChatMCP\"]')", "onboarding dismiss works");
            await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('button[title=\"Skills\"]').click()");
            await WaitFor("Array.from(document.querySelectorAll('aside')).some(panel => panel.innerText.includes('GitHub Agent Skills Hub'))", "Skills inspector rendered");
            await WaitFor("performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/plugins/marketplace')) && performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/plugins/registry'))", "Skills API requests completed");
            await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('button[title=\"Kế hoạch\"]').click()");
            await WaitFor("document.querySelector('[aria-label=\"Task plan\"]')?.innerText.includes('Chưa có kế hoạch')", "empty plan reports no plan");
            var fabricated = await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('[aria-label=\"Task plan\"]')?.innerText.includes('100%')");
            if (fabricated == "true") throw new InvalidOperationException("Empty plan claimed 100% completion.");
            if (errors.Count > 0) throw new InvalidOperationException(string.Join("; ", errors));
            foreach (var route in new[] { "/api/state", "/api/plugins/marketplace", "/api/plugins/registry" })
                if (!requests.Contains(route)) throw new InvalidOperationException($"Missing real API request: {route}");
            Console.WriteLine(JsonSerializer.Serialize(new { result = "PASS", runtime = environment.BrowserVersionString, checks = passed, apiRequests = requests, errors }));
            Program.Result = 0;
        }
        catch (WebView2RuntimeNotFoundException error)
        {
            Console.Error.WriteLine($"UNAVAILABLE: {error.Message}");
            Program.Result = 77;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"FAIL: {error}");
            Program.Result = 1;
        }
        finally
        {
            browser.Dispose();
            Close();
        }
    }
}
