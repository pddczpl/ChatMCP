using ChatMCP.Native;
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ChatMCP.Desktop
{
    public partial class MainWindow : Form
    {
        private readonly WebView2 _webView;
        private readonly Label _statusLabel;
        private Process? _hubProcess;
        private HubSessionInfo? _session;
        private readonly System.Windows.Forms.Timer _hubMonitor = new() { Interval = 3000 };
        private bool _monitorBusy;
        private const int HubPort = 3007;
        private readonly string _hubUrl = $"http://127.0.0.1:{HubPort}/";
        private readonly string _repoRoot;

        public MainWindow(string repoRoot)
        {
            _repoRoot = repoRoot;

            // Form properties
            Text = "DatGold Studio " + HubLifecycle.Version + " - AI Coding Agent";
            Size = new Size(1366, 850);
            MinimumSize = new Size(960, 600);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(11, 15, 25); // #0B0F19
            ForeColor = Color.White;

            // Load Icon
            try
            {
                var iconPath = Path.Combine(_repoRoot, "assets", "icons", "chatmcp.ico");
                if (File.Exists(iconPath))
                {
                    Icon = new Icon(iconPath);
                }
            }
            catch
            {
                // Fallback to default form icon
            }

            // Status label during boot
            _statusLabel = new Label
            {
                Text = "Starting DatGold Studio Engine...",
                Font = new Font("Segoe UI", 12, FontStyle.Regular),
                ForeColor = Color.FromArgb(0, 242, 254), // Neon cyan
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Dock = DockStyle.Fill
            };
            Controls.Add(_statusLabel);

            // WebView2 control
            _webView = new WebView2
            {
                Dock = DockStyle.Fill,
                Visible = false
            };
            Controls.Add(_webView);

            FormClosing += MainWindow_FormClosing;
            Shown += async (s, e) => await InitializeStudioAsync();
            _hubMonitor.Tick += async (s, e) => await MonitorHubAsync();
        }

        private async Task InitializeStudioAsync()
        {
            try
            {
                // Check the installed files, not the terminal's working directory.
                using (var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(_repoRoot, "CHATMCP-HUB", "package.json"))))
                    if (manifest.RootElement.GetProperty("version").GetString() != HubLifecycle.Version)
                        throw new InvalidOperationException("The installed desktop and Hub files have different versions. Run the matching installer again; no Hub was started.");
                if (File.Exists(Path.Combine(_repoRoot, ".chatmcp-update-pending.json")))
                    throw new InvalidOperationException("An interrupted installation needs recovery. Keep the installation backup and inspect the installer log before reopening.");
                _statusLabel.Text = "Connecting to DatGold Hub " + HubLifecycle.Version + "...";
                var isRunning = await CheckHubHealthAsync();
                if (!isRunning)
                {
                    if (HubLifecycle.ListenerPid() == null)
                    {
                        _statusLabel.Text = "Booting background Hub daemon...";
                        StartHubProcess();
                    }
                    var started = false;
                    for (int i = 0; i < 60; i++)
                    {
                        await Task.Delay(500);
                        if (_hubProcess?.HasExited == true)
                            throw new InvalidOperationException("Hub exited during startup (exit " + _hubProcess.ExitCode + "). Inspect the local Hub log; no task was replayed.");
                        if (await CheckHubHealthAsync()) { started = true; break; }
                    }
                    if (!started) throw new InvalidOperationException("Hub did not become ready in 30 seconds. Close this window and inspect the local Hub log.");
                }

                // The Hub publishes a per-launch secret in <state dir>\run\hub-session.json (readable by this Windows account only).
                // Whether this window started the Hub or attached to one that was already running, sign the dashboard in with a
                // one-time ticket: the secret never appears in a URL, a command line or the page's history.
                _statusLabel.Text = "Reading the Hub session...";
                _session = await WaitForSessionAsync();

                // 2. Initialize WebView2
                _statusLabel.Text = "Initializing Desktop Studio UI...";
                var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                var userDataFolder = Path.Combine(localAppData, "ChatMCP", "webview2-data");
                Directory.CreateDirectory(userDataFolder);

                var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
                await _webView.EnsureCoreWebView2Async(env);

                // Configure WebView2 settings
                _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
#if DEBUG
                _webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
#else
                // WebView2 enables DevTools by default; a release build must not hand a page-inspection console to anyone at the keyboard.
                _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
#endif
                // Desktop-native selection belongs to the visible WinForms
                // window, NOT to an invisible PowerShell child process.
                // Requests from any page other than our exact localhost UI
                // are ignored before parsing message data. The same gate lets
                // the page ask for the downloaded update to be installed.
                _webView.CoreWebView2.WebMessageReceived += HandleWebMessage;

                // Intercept new window requests: keep everything inside ChatMCP app. The address goes to the page as a JSON web
                // message (http/https only), never as text inside a script.
                WebViewBridge.AttachNewWindowHandler(_webView.CoreWebView2);

                // Show WebView2 as soon as DOM is ready or navigation completes
                _webView.CoreWebView2.DOMContentLoaded += (s, e) =>
                {
                    _statusLabel.Visible = false;
                    _webView.Visible = true;
                    _webView.BringToFront();
                };

                _webView.NavigationCompleted += (s, e) =>
                {
                    if (e.IsSuccess)
                    {
                        _statusLabel.Visible = false;
                        _webView.Visible = true;
                        _webView.BringToFront();
                    }
                    else
                    {
                        _statusLabel.Text = $"Failed to load Studio UI: {e.WebErrorStatus}";
                        _statusLabel.ForeColor = Color.FromArgb(239, 68, 68);
                    }
                };

                // Navigate to Studio, signed in by the ticket in the fragment. The ticket lives 60 seconds and is requested only now:
                // creating the WebView2 environment (first run, runtime update) can take a long time.
                string ticket;
                using (var client = HubLifecycle.Client()) ticket = await HubSession.RequestTicket(client, HubLifecycle.Origin, _session.Secret);
                _webView.Source = new Uri(HubSession.DashboardUrl(HubLifecycle.Origin, ticket));
                _hubMonitor.Start();
            }
            catch (Exception ex)
            {
                _statusLabel.Text = $"Error: {ex.Message}";
                _statusLabel.ForeColor = Color.FromArgb(239, 68, 68);
            }
        }

        // The one handler of messages from the page. What may be a message (the origin, the type, the id) is decided by PageMessage, which the native tests run; this only dispatches.
        private void HandleWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!PageMessage.IsDashboard(e.Source, HubPort)) return;
            var json = e.WebMessageAsJson;
            if (!PageMessage.TryParse(json, out var type, out var requestId)) return;
            if (type == PageMessage.ApplyUpdate) { _ = ApplyUpdateAsync(requestId); return; }
            HandleFolderRequest(json, requestId);
        }

        private void HandleFolderRequest(string json, string requestId)
        {
            string? initial = null;
            try
            {
                using var doc = JsonDocument.Parse(json);
                var value = doc.RootElement;
                if (value.TryGetProperty("initialPath", out var start) &&
                    start.ValueKind == JsonValueKind.String)
                {
                    var suggested = start.GetString();
                    if (!string.IsNullOrWhiteSpace(suggested) && suggested.Length <= 4096 &&
                        Path.IsPathFullyQualified(suggested) && Directory.Exists(suggested))
                        initial = Path.GetFullPath(suggested);
                }
            }
            catch (JsonException) { return; }

            string? folder = null;
            string? error = null;
            try
            {
                using var dialog = new FolderBrowserDialog
                {
                    Description = "DatGold - Select a workspace folder",
                    ShowNewFolderButton = true,
                    AutoUpgradeEnabled = true,
                };
                if (initial != null) dialog.SelectedPath = initial;
                // The actual visible ChatMCP window owns the modal picker.
                // This is reliable even if the background Hub has no console.
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    var selected = dialog.SelectedPath;
                    if (!Directory.Exists(selected))
                        throw new IOException("Selected folder is unavailable.");
                    folder = Path.GetFullPath(selected);
                }
            }
            catch (Exception ex)
            {
                // Do not disclose local paths or sensitive exception payloads.
                error = "Native Windows folder picker failed (" + ex.GetType().Name + "). " +
                        "You can still paste the absolute folder path in Settings.";
            }
            _webView.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = "chatmcp.folder-result", id = requestId, path = folder, error,
            }));
        }

        private Task<bool> CheckHubHealthAsync() => HubLifecycle.IsReady(HubLifecycle.Version);

        private static async Task<HubSessionInfo> WaitForSessionAsync()
        {
            // /api/health reports "initialized" only after the Hub wrote its session file, so this normally returns at once.
            for (int i = 0; i < 40; i++)
            {
                var session = HubSession.ReadForListener(HubSession.DefaultStateDirectory(), HubPort);
                if (session != null) return session;
                await Task.Delay(250);
            }
            throw new InvalidOperationException("The Hub did not publish a readable session file (run\\hub-session.json in its data folder). Close this window, stop the Hub with STOP-CHATMCP-HUB.cmd and reopen DatGold; no task was replayed.");
        }

        private async Task MonitorHubAsync()
        {
            if (_monitorBusy || IsDisposed || Disposing) return;
            _monitorBusy = true;
            try
            {
                if (!await CheckHubHealthAsync()) throw new IOException("Hub is not ready.");
                // A restarted Hub has a new secret: the signed-in page is stale even though the port answers again.
                var current = HubSession.Read(HubSession.DefaultStateDirectory(), HubPort);
                if (_session != null && (current == null || current.Pid != _session.Pid || current.Secret != _session.Secret))
                    throw new IOException("The Hub restarted since this window signed in.");
                if (IsDisposed || Disposing) return;
                _statusLabel.Visible = false;
                _webView.Visible = true;
                _webView.BringToFront();
            }
            catch (Exception)
            {
                if (IsDisposed || Disposing) return;
                _webView.Visible = false;
                _statusLabel.Text = "Hub disconnected or version changed. Close and reopen DatGold to reconnect.\nNo task or prompt was automatically restarted.";
                _statusLabel.ForeColor = Color.FromArgb(239, 68, 68);
                _statusLabel.Visible = true;
                _statusLabel.BringToFront();
            }
            finally { _monitorBusy = false; }
        }

        private void StartHubProcess()
        {
            var hubScript = Path.Combine(_repoRoot, "CHATMCP-HUB", "hub.mjs");
            if (!File.Exists(hubScript))
            {
                throw new FileNotFoundException($"Hub entrypoint not found: {hubScript}");
            }

            var bundledNode = Path.Combine(_repoRoot, "runtimes", "node", "node.exe");
            var nodeExe = File.Exists(bundledNode) ? bundledNode : "node.exe";

            var psi = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = $"\"{hubScript}\" --port {HubPort} --no-open",
                WorkingDirectory = Path.Combine(_repoRoot, "CHATMCP-HUB"),
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            psi.EnvironmentVariables["PORT"] = HubPort.ToString();
            psi.EnvironmentVariables["CHATMCP_NO_OPEN"] = "1";

            // Synchronize process creation with installer replacement, including
            // an installer launched while this window was awaiting /api/health.
            using var upgrade = HubLifecycle.AcquireUpdateLock(_repoRoot);
            try
            {
                if (File.Exists(Path.Combine(_repoRoot, ".chatmcp-update-pending.json")))
                    throw new InvalidOperationException("Installation is incomplete. Hub was not started.");
                if (HubLifecycle.ListenerPid() != null) return;
                _hubProcess = Process.Start(psi) ?? throw new IOException("Could not start the bundled Hub.");
            }
            finally { upgrade.ReleaseMutex(); }
        }

        private void MainWindow_FormClosing(object? sender, FormClosingEventArgs e)
        {
            // The Hub belongs to the user session, not this window. Closing a
            // window must not kill active tools or another client's connection.
            // Explicit Hub shutdown and installer preflight own its termination.
            _hubMonitor.Stop();
            _hubMonitor.Dispose();
            _hubProcess?.Dispose();
            _hubProcess = null;
        }
    }
}
