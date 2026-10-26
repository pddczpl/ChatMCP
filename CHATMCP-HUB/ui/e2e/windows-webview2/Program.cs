using System.Net;
using System.Net.Http;
using System.Text.Json;
using ChatMCP.Native;
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
        if ((args.Length != 3 && args.Length != 5) || !Uri.TryCreate(args[0], UriKind.Absolute, out var url)
            || url.Scheme != "http" || url.Host != "127.0.0.1" || url.Port == 3007)
        {
            Console.Error.WriteLine("FAIL: Supply an isolated loopback Hub URL, a temporary WebView2 profile and that Hub's state directory.");
            return 1;
        }
        if (args.Length == 5 && (!int.TryParse(args[3], out width) || !int.TryParse(args[4], out height)
            || width < 640 || width > 1920 || height < 480 || height > 1200))
        {
            Console.Error.WriteLine("FAIL: Optional window width and height must be within 640–1920 and 480–1200.");
            return 1;
        }
        ApplicationConfiguration.Initialize();
        using var form = new SmokeWindow(url, args[1], args[2], new Size(width, height));
        Application.Run(form);
        return Result;
    }
}

internal sealed class SmokeWindow : Form
{
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill };
    private readonly Uri origin;
    private readonly string profile;
    private readonly string stateDirectory;
    private readonly List<string> errors = [];
    private readonly HashSet<string> requests = [];
    private readonly List<string> passed = [];
    private readonly List<string> newWindowUris = [];
    // for each request for a new window: whether WebView2 says that a person made it (IsUserInitiated), and the address
    private readonly List<(bool Person, string Uri)> newWindowRequests = [];
    // What the shell hands to the SYSTEM browser: the harness stands in for it, so no browser starts on the machine that runs the smoke.
    private readonly List<string> externalOpened = [];
    private readonly Size requestedSize;

    public SmokeWindow(Uri origin, string profile, string stateDirectory, Size requestedSize)
    {
        this.origin = origin;
        this.profile = profile;
        this.stateDirectory = stateDirectory;
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

    /// <summary>
    /// What the desktop shell does before it shows the dashboard, run with the shell's own code: an API call without the secret
    /// is refused, the session file of the process listening on the port is readable, and the secret buys a one-time ticket.
    /// </summary>
    private async Task<string> SignInUrl()
    {
        using var client = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(10) };
        var authority = origin.GetLeftPart(UriPartial.Authority);
        using (var bare = await client.GetAsync(authority + "/api/state"))
        {
            var body = await bare.Content.ReadAsStringAsync();
            if (bare.StatusCode != HttpStatusCode.Unauthorized || body.Contains("csrfToken"))
                throw new InvalidOperationException($"An API call without the session secret must be refused with 401 and no token, got {(int)bare.StatusCode}.");
            passed.Add("Hub refuses an API call without the session secret");
        }
        var session = HubSession.ReadForListener(stateDirectory, origin.Port)
            ?? throw new InvalidOperationException("The shell code could not read run/hub-session.json for the process listening on the port.");
        passed.Add("shell reads the session file of the listening Hub");
        var ticket = await HubSession.RequestTicket(client, authority, session.Secret);
        passed.Add("shell obtains a one-time ticket with the bearer secret");
        return HubSession.DashboardUrl(authority, ticket);
    }

    /// <summary>
    /// pod-9: a link whose address holds a backslash, a single and a double quote and a script end tag reaches the page as the
    /// exact string WebView2 reported, and runs nothing. Addresses that are not http/https are dropped by the shell.
    /// The characters sit in the fragment, where Chromium keeps them as written.
    /// </summary>
    private async Task CheckNewWindowBridge()
    {
        var listener = "window.__opened = []; window.__pwned = 0; window.addEventListener('chatmcp:open-in-app-tab', event => window.__opened.push(event.detail.url)); true";
        await browser.CoreWebView2.ExecuteScriptAsync(listener);
        var hostile = origin.GetLeftPart(UriPartial.Authority) + "/#back\\slash'quote\"dq</script><img src=x onerror=window.__pwned=1>";
        await browser.CoreWebView2.ExecuteScriptAsync("window.open(" + JsonSerializer.Serialize(hostile) + ", '_blank'); true");
        await WaitFor("window.__opened.length === 1", "the page received the forwarded link");
        if (newWindowUris.Count != 1) throw new InvalidOperationException($"Expected one new-window request, saw {newWindowUris.Count}.");
        var reported = newWindowUris[0];
        if (!reported.Contains('\\') || !reported.Contains('\'') || !reported.Contains("</script>", StringComparison.OrdinalIgnoreCase) && !reported.Contains("%3C/script%3E", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("WebView2 normalised the test address so it no longer holds a backslash, a quote and a script end tag: " + reported);
        var received = JsonSerializer.Deserialize<string[]>(await browser.CoreWebView2.ExecuteScriptAsync("window.__opened")) ?? [];
        if (received.Length != 1 || !string.Equals(received[0], reported, StringComparison.Ordinal))
            throw new InvalidOperationException($"The link changed on its way to the page.\nWebView2 reported: {reported}\nThe page received: {string.Join(" | ", received)}");
        passed.Add("a link with a backslash, quotes and </script> reached the page as the exact URL string");
        if (await browser.CoreWebView2.ExecuteScriptAsync("window.__pwned") != "0") throw new InvalidOperationException("The link ran script in the page.");
        passed.Add("and ran no script");
        await browser.CoreWebView2.ExecuteScriptAsync("window.open('about:blank', '_blank'); window.open('javascript:window.__pwned=2', '_blank'); window.open('file:///C:/Windows/win.ini', '_blank'); true");
        await Task.Delay(1500);
        var opened = int.Parse(await browser.CoreWebView2.ExecuteScriptAsync("window.__opened.length"));
        if (opened != 1 || await browser.CoreWebView2.ExecuteScriptAsync("window.__pwned") != "0")
            throw new InvalidOperationException("A non-http(s) address reached the page or ran script.");
        passed.Add("about:, javascript: and file: addresses are dropped by the shell");

        // A release page of the project goes to the SYSTEM browser and not to the preview tab (that is what "What's new" is), but only when a PERSON asked for it: script that runs in the page
        // (window.open, or a click that code makes) has no user gesture, and a program on the page must not be able to start the browser of the person on its own. A look-alike address is not
        // on the list and keeps the old road, to the page.
        const string notes = "https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.2";
        // a link made the way the page makes its own (target=_blank, rel=noopener noreferrer), laid out where a mouse can reach it; `then` is what is done to it at once
        string LinkTo(string address, string then) => "(() => { const a = document.createElement('a'); a.id = 'chatmcp-smoke-link'; a.href = " + JsonSerializer.Serialize(address) + "; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'notes'; a.style.cssText = 'position:fixed;left:20px;top:20px;width:200px;height:40px;display:block;z-index:2147483647;background:#fff;color:#000'; document.body.append(a); " + then + " return true; })()";
        // Script WITHOUT a user gesture. ExecuteScriptAsync is not one: WebView2 runs it as if a person had acted, and the page keeps that user activation for about five seconds (a DevTools
        // evaluation with userGesture false does not give it, but it inherits what an earlier step left). So the two requests are made by a timer that fires after every earlier activation has run out.
        var before = newWindowRequests.Count;
        await Evaluate("setTimeout(() => { window.open(" + JsonSerializer.Serialize(notes) + ", '_blank'); " + LinkTo(notes + "#script", "a.click(); a.remove();") + " }, 6500); true", userGesture: false);
        await WaitForCount(newWindowUris, before + 2, "WebView2 reports the two windows that script without a user gesture asked for: window.open, and a click that the script made");
        if (newWindowRequests.Skip(before).Any(request => request.Person)) throw new InvalidOperationException("Premise of the test: WebView2 says that a person made a request that a timer made: " + string.Join(" | ", newWindowRequests.Skip(before)));
        await WaitFor("window.__opened.length === 3", "a release page asked for by script (window.open, and a click that code makes: the way a page could try to start the browser) is forwarded to the page like any other address");
        await Task.Delay(1000);
        if (externalOpened.Count != 0) throw new InvalidOperationException("Script that runs in the page started the system browser: " + string.Join(" | ", externalOpened));
        passed.Add("and neither reaches the system browser");
        // the same two roads with a person: script that runs with a user gesture, and a real press and release of the mouse button on the link
        before = newWindowRequests.Count;
        await Evaluate("window.open(" + JsonSerializer.Serialize(notes) + ", '_blank'); true", userGesture: true);
        await WaitForCount(externalOpened, 1, "a release page of the project reaches the system browser through window.open when a person asked for it");
        if (!newWindowRequests[before].Person) throw new InvalidOperationException("Premise of the test: WebView2 does not say that a person made a request with a user gesture: " + newWindowRequests[before].Uri);
        if (externalOpened[0] != notes) throw new InvalidOperationException("The system browser was handed " + externalOpened[0] + " instead of " + notes);
        before = newWindowRequests.Count;
        await Evaluate(LinkTo(notes + "#readme", ""), userGesture: false);
        await ClickLikeAPerson("#chatmcp-smoke-link");
        await WaitForCount(externalOpened, 2, "and through a click on a link with target=_blank and rel=noopener, the way the page's own link is made");
        if (newWindowRequests.Count != before + 1 || !newWindowRequests[before].Person) throw new InvalidOperationException("Premise of the test: the click of the mouse is not one request that WebView2 says a person made: " + string.Join(" | ", newWindowRequests.Skip(before)));
        await Evaluate("document.getElementById('chatmcp-smoke-link')?.remove(); true", userGesture: false);
        if (externalOpened[1] != notes + "#readme") throw new InvalidOperationException("The link was handed over as " + externalOpened[1]);
        await Task.Delay(1000);
        if (int.Parse(await browser.CoreWebView2.ExecuteScriptAsync("window.__opened.length")) != 3)
            throw new InvalidOperationException("A release page was also forwarded to the preview tab.");
        passed.Add("and is not forwarded to the preview tab as well");
        var lookalike = "https://github.com.evil.example/pddczpl/ChatMCP/releases/tag/v3.10.2";
        await Evaluate("window.open(" + JsonSerializer.Serialize(lookalike) + ", '_blank'); true", userGesture: true);
        await WaitFor("window.__opened.length === 4", "a look-alike address is forwarded to the page as before, also when a person asked");
        if (externalOpened.Count != 2) throw new InvalidOperationException("A look-alike address reached the system browser: " + string.Join(" | ", externalOpened));
        passed.Add("and never reaches the system browser");
    }

    /// <summary>Runs script in the page through the DevTools protocol, with or without the user-activation flag (a person acting), which is what WebView2 reports as IsUserInitiated.</summary>
    private async Task Evaluate(string expression, bool userGesture)
    {
        var answer = await browser.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.evaluate", JsonSerializer.Serialize(new { expression, userGesture }));
        if (answer.Contains("exceptionDetails", StringComparison.Ordinal)) throw new InvalidOperationException("The script of the smoke failed: " + answer);
    }

    /// <summary>A real press and release of the left mouse button in the middle of an element, sent to the page by the DevTools protocol: a trusted event, which carries a user gesture.</summary>
    private async Task ClickLikeAPerson(string selector)
    {
        var centre = JsonSerializer.Deserialize<double[]>(await browser.CoreWebView2.ExecuteScriptAsync("(() => { const r = document.querySelector(" + JsonSerializer.Serialize(selector) + ").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()"))
            ?? throw new InvalidOperationException("The element to click is not on the page: " + selector);
        foreach (var type in new[] { "mousePressed", "mouseReleased" })
            await browser.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x = centre[0], y = centre[1], button = "left", clickCount = 1 }));
    }

    private async Task WaitForCount(List<string> list, int count, string label)
    {
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < deadline)
        {
            if (list.Count >= count) { passed.Add(label); return; }
            await Task.Delay(100);
        }
        throw new TimeoutException("Waiting for " + label + "; saw " + list.Count + " of " + count);
    }

    private async Task SelectWorkTab(string title)
    {
        // Compact layouts intentionally start with the work panel closed. Use its real header control, then address the tab
        // in the visible strip (role=tab, aria-selected).
        await WaitFor("document.querySelector('header button[title=\"Mở Inspector (Ctrl+J)\"]') || document.querySelector('#panel-inspector')", "work panel control available");
        await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('header button[title=\"Mở Inspector (Ctrl+J)\"]')?.click()");
        await WaitFor("document.querySelector('#panel-inspector [role=\"tablist\"]')?.getClientRects().length > 0", "work panel opened through UI");
        var tab = $"Array.from(document.querySelectorAll('#panel-inspector [role=\"tab\"]')).find(item => item.textContent?.trim() === {JsonSerializer.Serialize(title)})";
        await WaitFor($"{tab}?.getClientRects().length > 0", $"{title} tab visible");
        var clicked = await browser.CoreWebView2.ExecuteScriptAsync($"(() => {{ const item = {tab}; if (!item || item.disabled) return false; item.click(); return true; }})()");
        if (clicked != "true") throw new InvalidOperationException($"Could not click {title} tab.");
        await WaitFor($"{tab}?.getAttribute('aria-selected') === 'true'", $"{title} tab selected");
    }

    /// <summary>Settings is a full-page native dialog; its sections are the buttons of its left menu.</summary>
    private async Task OpenSettingsSection(string section)
    {
        await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('header button[aria-label=\"Cài đặt\"]').click()");
        await WaitFor("document.querySelector('dialog[open][aria-label=\"Cài đặt\"]')", "Settings opened");
        var name = JsonSerializer.Serialize(section);
        await browser.CoreWebView2.ExecuteScriptAsync($"Array.from(document.querySelectorAll('dialog[open][aria-label=\"Cài đặt\"] nav[aria-label=\"Các mục cài đặt\"] button')).find(item => item.textContent?.trim() === {name})?.click()");
        await WaitFor($"document.querySelector('dialog[open][aria-label=\"Cài đặt\"] nav [aria-current=\"page\"]')?.textContent?.trim() === {name}", $"{section} section selected");
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
            // The shipped shell code (native-shared): the new-window bridge, then the Hub's session file and a one-time ticket.
            WebViewBridge.AttachNewWindowHandler(browser.CoreWebView2, address => externalOpened.Add(address));
            browser.CoreWebView2.NewWindowRequested += (_, link) => { newWindowUris.Add(link.Uri); newWindowRequests.Add((link.IsUserInitiated, link.Uri)); };
            browser.CoreWebView2.Navigate(await SignInUrl());
            await WaitFor("location.hash === '' && Boolean(sessionStorage.getItem('chatmcp.hub-session'))", "page traded the ticket for the session and removed it from the address");
            await WaitFor("document.querySelector('#root header')", "current React root rendered");
            await WaitFor("document.querySelector('[role=dialog][aria-label=\"Thiết lập DatGold\"]')", "fresh onboarding rendered");
            await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('[aria-label=\"Đóng thiết lập\"]').click()");
            await WaitFor("!document.querySelector('[role=dialog][aria-label=\"Thiết lập DatGold\"]')", "onboarding dismiss works");
            await OpenSettingsSection("Kỹ năng");
            await WaitFor("document.querySelector('dialog[open][aria-label=\"Cài đặt\"]')?.innerText.includes('Kỹ năng cho trợ lý')", "Skills settings rendered");
            await WaitFor("performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/plugins/marketplace')) && performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/plugins/registry'))", "Skills API requests completed");
            await browser.CoreWebView2.ExecuteScriptAsync("Array.from(document.querySelectorAll('summary')).find(el => el.textContent === 'Nguồn kỹ năng & tùy chỉnh').click()");
            await browser.CoreWebView2.ExecuteScriptAsync("Array.from(document.querySelectorAll('button')).find(el => el.textContent.includes('Thêm kỹ năng từ URL hoặc tự viết')).click()");
            // A second native dialog opens above Settings.
            var addDialog = "Array.from(document.querySelectorAll('dialog[open]')).find(item => item.getAttribute('aria-label') !== 'Cài đặt')";
            await WaitFor($"{addDialog}?.innerText.includes('Thêm kỹ năng')", "native Skills dialog rendered above Settings without CSP violations");
            await browser.CoreWebView2.ExecuteScriptAsync($"Array.from({addDialog}.querySelectorAll('button')).find(el => el.textContent === 'Hủy').click()");
            await WaitFor("document.querySelectorAll('dialog[open]').length === 1", "native Skills dialog dismissal works");
            await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('dialog[open][aria-label=\"Cài đặt\"] button[aria-label=\"Đóng cài đặt\"]').click()");
            await WaitFor("!document.querySelector('dialog[open]')", "Settings closes");
            // Exercise close/reopen via the same user-facing control as well;
            // selecting a tab must not rely on the panel already being open.
            await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('header button[title=\"Thu gọn Inspector (Ctrl+J)\"]').click()");
            await WaitFor("!document.querySelector('#panel-inspector')", "work panel close works");
            await SelectWorkTab("Tiến độ");
            await WaitFor("document.querySelector('[aria-label=\"Task plan\"]')?.innerText.includes('Chưa có kế hoạch')", "empty plan reports no plan");
            var fabricated = await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('[aria-label=\"Task plan\"]')?.innerText.includes('100%')");
            if (fabricated == "true") throw new InvalidOperationException("Empty plan claimed 100% completion.");
            // The Agents tab is the list of background tasks and nothing else: it renders without a script or CSP error and has no switch to sections that hand out work.
            // Only navigation: no model request is made and no task is created.
            await SelectWorkTab("Tác nhân");
            await WaitFor("document.querySelector('#panel-inspector')?.innerText.includes('Chưa có công việc nền')", "Agents tab lists the background tasks");
            var removedSections = await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('#panel-inspector [role=\"tablist\"][aria-label=\"Các mục của Tác nhân\"]') !== null || /Nhóm trợ lý|Sửa mã/.test(document.querySelector('#panel-inspector')?.innerText ?? '')");
            if (removedSections == "true") throw new InvalidOperationException("Agents tab still offers the removed sections.");
            await CheckNewWindowBridge();
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
