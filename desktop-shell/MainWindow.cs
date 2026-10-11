using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ChatMCP.Desktop
{
    public class MainWindow : Form
    {
        private readonly WebView2 _webView;
        private readonly Label _statusLabel;
        private Process? _hubProcess;
        private bool _isHubOwner;
        private const int HubPort = 3007;
        private readonly string _hubUrl = $"http://127.0.0.1:{HubPort}/";
        private readonly string _repoRoot;

        public MainWindow(string repoRoot)
        {
            _repoRoot = repoRoot;

            // Form properties
            Text = "ChatMCP Studio - AI Coding Agent";
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
                Text = "Starting ChatMCP Studio Engine...",
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
        }

        private async Task InitializeStudioAsync()
        {
            try
            {
                // 1. Ensure Hub daemon is running
                _statusLabel.Text = "Connecting to ChatMCP Hub Engine...";
                var isRunning = await CheckHubHealthAsync();

                if (!isRunning)
                {
                    _statusLabel.Text = "Booting background Hub daemon...";
                    StartHubProcess();

                    // Wait for hub to respond (up to 15 seconds)
                    var started = false;
                    for (int i = 0; i < 30; i++)
                    {
                        await Task.Delay(500);
                        if (await CheckHubHealthAsync())
                        {
                            started = true;
                            break;
                        }
                    }

                    if (!started)
                    {
                        _statusLabel.Text = "Failed to start ChatMCP Hub. Please check Node.js installation.";
                        _statusLabel.ForeColor = Color.FromArgb(239, 68, 68);
                        return;
                    }
                }

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
                _webView.CoreWebView2.Settings.AreDevToolsEnabled = true;

                // Navigate to Studio
                _webView.Source = new Uri(_hubUrl);

                // Display UI when navigation completes
                _webView.NavigationCompleted += (s, e) =>
                {
                    _statusLabel.Visible = false;
                    _webView.Visible = true;
                };
            }
            catch (Exception ex)
            {
                _statusLabel.Text = $"Error: {ex.Message}";
                _statusLabel.ForeColor = Color.FromArgb(239, 68, 68);
            }
        }

        private async Task<bool> CheckHubHealthAsync()
        {
            try
            {
                using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(800) };
                var res = await client.GetAsync($"http://127.0.0.1:{HubPort}/api/status");
                return res.IsSuccessStatusCode;
            }
            catch
            {
                return false;
            }
        }

        private void StartHubProcess()
        {
            var hubScript = Path.Combine(_repoRoot, "CHATMCP-HUB", "hub.mjs");
            if (!File.Exists(hubScript))
            {
                throw new FileNotFoundException($"Hub entrypoint not found: {hubScript}");
            }

            var psi = new ProcessStartInfo
            {
                FileName = "node.exe",
                Arguments = $"\"{hubScript}\"",
                WorkingDirectory = Path.Combine(_repoRoot, "CHATMCP-HUB"),
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            psi.EnvironmentVariables["PORT"] = HubPort.ToString();

            _hubProcess = Process.Start(psi);
            if (_hubProcess != null)
            {
                _isHubOwner = true;
            }
        }

        private void MainWindow_FormClosing(object? sender, FormClosingEventArgs e)
        {
            if (_isHubOwner && _hubProcess != null && !_hubProcess.HasExited)
            {
                try
                {
                    _hubProcess.Kill(true);
                    _hubProcess.Dispose();
                }
                catch
                {
                    // Ignore shutdown errors
                }
            }
        }
    }
}
