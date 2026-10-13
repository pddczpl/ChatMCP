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
        var width = 1600;
        var height = 1000;
        if ((args.Length != 2 && args.Length != 4) || !Uri.TryCreate(args[0], UriKind.Absolute, out var url)
            || url.Scheme != "http" || url.Host != "127.0.0.1" || url.Port == 3007)
        {
            Console.Error.WriteLine("FAIL: Supply an isolated loopback Hub URL and temporary WebView2 profile.");
            return 1;
        }
        if (args.Length == 4 && (!int.TryParse(args[2], out width) || !int.TryParse(args[3], out height)
            || width < 640 || width > 1920 || height < 480 || height > 1200))
        {
            Console.Error.WriteLine("FAIL: Optional window width and height must be within 640–1920 and 480–1200.");
            return 1;
        }
        ApplicationConfiguration.Initialize();
        using var form = new SmokeWindow(url, args[1], new Size(width, height));
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
    private readonly Size requestedSize;

    public SmokeWindow(Uri origin, string profile, Size requestedSize)
    {
        this.origin = origin;
        this.profile = profile;
        this.requestedSize = requestedSize;
        // WebView2 needs a native window/message pump. Keep the harness invisible,
        // off screen and out of the taskbar; it never opens the user's desktop app.
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(-20000, -20000);
        ClientSize = requestedSize;
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
        var body = await browser.CoreWebView2.ExecuteScriptAsync("JSON.stringify({width:innerWidth,height:innerHeight,body:document.body?.innerText?.slice(0,2500)})");
        throw new TimeoutException($"Waiting for {label}: {body}");
    }

    private async Task SelectInspectorTab(string title)
    {
        // Compact layouts intentionally start with Inspector closed. Use its
        // real header control, then address tabs within the visible panel.
        await WaitFor("document.querySelector('header button[title=\"Mở Inspector (Ctrl+J)\"]') || document.querySelector('#panel-inspector nav')", "Inspector control available");
        await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('header button[title=\"Mở Inspector (Ctrl+J)\"]')?.click()");
        await WaitFor("document.querySelector('#panel-inspector nav')?.getClientRects().length > 0", "Inspector opened through UI");
        var selector = JsonSerializer.Serialize($"#panel-inspector nav button[title=\"{title}\"]");
        await WaitFor($"document.querySelector({selector})?.getClientRects().length > 0", $"{title} tab visible");
        var clicked = await browser.CoreWebView2.ExecuteScriptAsync($"(() => {{ const button=document.querySelector({selector}); if (!button || button.disabled) return false; button.click(); return true; }})()");
        if (clicked != "true") throw new InvalidOperationException($"Could not click {title} tab.");
        await WaitFor($"document.querySelector({selector})?.getAttribute('aria-pressed') === 'true'", $"{title} tab selected");
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
            await SelectInspectorTab("Skills");
            await WaitFor("Array.from(document.querySelectorAll('aside')).some(panel => panel.innerText.includes('Kỹ năng cho trợ lý'))", "Skills inspector rendered");
            await WaitFor("performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/plugins/marketplace')) && performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/plugins/registry'))", "Skills API requests completed");
            await browser.CoreWebView2.ExecuteScriptAsync("Array.from(document.querySelectorAll('summary')).find(el => el.textContent === 'Nguồn kỹ năng & tùy chỉnh').click()");
            await browser.CoreWebView2.ExecuteScriptAsync("Array.from(document.querySelectorAll('button')).find(el => el.textContent.includes('Thêm kỹ năng từ URL hoặc tự viết')).click()");
            await WaitFor("document.querySelector('dialog[open]')?.innerText.includes('Thêm kỹ năng')", "native Skills dialog rendered without CSP violations");
            await browser.CoreWebView2.ExecuteScriptAsync("Array.from(document.querySelectorAll('dialog[open] button')).find(el => el.textContent === 'Hủy').click()");
            await WaitFor("!document.querySelector('dialog[open]')", "native Skills dialog dismissal works");
            // Exercise close/reopen via the same user-facing control as well;
            // selecting a tab must not rely on the panel already being open.
            await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('header button[title=\"Thu gọn Inspector (Ctrl+J)\"]').click()");
            await WaitFor("!document.querySelector('#panel-inspector')", "Inspector close works");
            await SelectInspectorTab("Kế hoạch");
            await WaitFor("document.querySelector('[aria-label=\"Task plan\"]')?.innerText.includes('Chưa có kế hoạch')", "empty plan reports no plan");
            var fabricated = await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('[aria-label=\"Task plan\"]')?.innerText.includes('100%')");
            if (fabricated == "true") throw new InvalidOperationException("Empty plan claimed 100% completion.");
            if (errors.Count > 0) throw new InvalidOperationException(string.Join("; ", errors));
            foreach (var route in new[] { "/api/state", "/api/plugins/marketplace", "/api/plugins/registry" })
                if (!requests.Contains(route)) throw new InvalidOperationException($"Missing real API request: {route}");
            var viewportJson = await browser.CoreWebView2.ExecuteScriptAsync("({width:innerWidth,height:innerHeight,compact:matchMedia('(max-width:1099px)').matches})");
            using var viewport = JsonDocument.Parse(viewportJson);
            Console.WriteLine(JsonSerializer.Serialize(new { result = "PASS", runtime = environment.BrowserVersionString,
                requestedViewport = new { width = requestedSize.Width, height = requestedSize.Height }, viewport = viewport.RootElement,
                checks = passed, apiRequests = requests, errors }));
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
