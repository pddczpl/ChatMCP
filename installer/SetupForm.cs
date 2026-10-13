using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ChatMCP.Installer
{
    public class SetupForm : Form
    {
        private Panel _headerPanel = null!;
        private Label _titleLabel = null!;
        private Label _subTitleLabel = null!;
        private Panel _contentPanel = null!;

        // Page 1: Config
        private Label _destLabel = null!;
        private TextBox _destTextBox = null!;
        private Button _browseButton = null!;
        private CheckBox _chkDesktop = null!;
        private CheckBox _chkStartMenu = null!;
        private Button _btnInstall = null!;
        private Button _btnCancel = null!;

        // Page 2: Progress
        private ProgressBar _progressBar = null!;
        private Label _progressLabel = null!;

        // Page 3: Completed
        private Label _doneLabel = null!;
        private CheckBox _chkLaunch = null!;
        private Button _btnFinish = null!;

        public SetupForm()
        {
            InitializeComponent();
        }

        private void InitializeComponent()
        {
            Text = "ChatMCP Studio Setup - Version 3.0.0";
            Size = new Size(620, 460);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(17, 24, 39); // #111827
            ForeColor = Color.White;

            try
            {
                var iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "assets", "icons", "chatmcp.ico");
                if (File.Exists(iconPath))
                {
                    Icon = new Icon(iconPath);
                }
            }
            catch { }

            // 1. Header Panel
            _headerPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 85,
                BackColor = Color.FromArgb(11, 15, 25) // #0B0F19
            };
            Controls.Add(_headerPanel);

            _titleLabel = new Label
            {
                Text = "ChatMCP Studio",
                Font = new Font("Segoe UI", 16, FontStyle.Bold),
                ForeColor = Color.White,
                Location = new Point(25, 15),
                AutoSize = true
            };
            _headerPanel.Controls.Add(_titleLabel);

            _subTitleLabel = new Label
            {
                Text = "Autonomous AI Coding Agent • Commercial Setup Wizard",
                Font = new Font("Segoe UI", 9.5f, FontStyle.Regular),
                ForeColor = Color.FromArgb(0, 242, 254), // Cyan
                Location = new Point(26, 48),
                AutoSize = true
            };
            _headerPanel.Controls.Add(_subTitleLabel);

            // Subtle border under header
            var headerBorder = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 2,
                BackColor = Color.FromArgb(0, 242, 254)
            };
            _headerPanel.Controls.Add(headerBorder);

            // 2. Content Panel
            _contentPanel = new Panel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(25, 20, 25, 20)
            };
            Controls.Add(_contentPanel);

            ShowConfigPage();
        }

        private void ShowConfigPage()
        {
            _contentPanel.Controls.Clear();

            _destLabel = new Label
            {
                Text = "Select Destination Location:",
                Font = new Font("Segoe UI", 10, FontStyle.Bold),
                Location = new Point(25, 20),
                AutoSize = true
            };
            _contentPanel.Controls.Add(_destLabel);

            _destTextBox = new TextBox
            {
                Text = InstallerEngine.GetDefaultInstallDir(),
                Font = new Font("Segoe UI", 9.5f),
                Location = new Point(25, 50),
                Width = 440,
                BackColor = Color.FromArgb(31, 41, 55),
                ForeColor = Color.White
            };
            _contentPanel.Controls.Add(_destTextBox);

            _browseButton = new Button
            {
                Text = "Browse...",
                Font = new Font("Segoe UI", 9),
                Location = new Point(475, 48),
                Width = 95,
                Height = 28,
                BackColor = Color.FromArgb(55, 65, 81),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _browseButton.Click += (s, e) =>
            {
                using var dlg = new FolderBrowserDialog { SelectedPath = _destTextBox.Text };
                if (dlg.ShowDialog() == DialogResult.OK)
                {
                    _destTextBox.Text = dlg.SelectedPath;
                }
            };
            _contentPanel.Controls.Add(_browseButton);

            var optionsLabel = new Label
            {
                Text = "Select Additional Tasks:",
                Font = new Font("Segoe UI", 10, FontStyle.Bold),
                Location = new Point(25, 100),
                AutoSize = true
            };
            _contentPanel.Controls.Add(optionsLabel);

            _chkDesktop = new CheckBox
            {
                Text = "Create a Desktop shortcut (with official brand icon)",
                Font = new Font("Segoe UI", 9.5f),
                Checked = true,
                Location = new Point(30, 130),
                AutoSize = true
            };
            _contentPanel.Controls.Add(_chkDesktop);

            _chkStartMenu = new CheckBox
            {
                Text = "Create a Start Menu folder and shortcut",
                Font = new Font("Segoe UI", 9.5f),
                Checked = true,
                Location = new Point(30, 160),
                AutoSize = true
            };
            _contentPanel.Controls.Add(_chkStartMenu);

            var infoLabel = new Label
            {
                Text = "Space required: ~15.0 MB\nChatMCP will be installed and registered in Windows Apps.",
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = Color.FromArgb(156, 163, 175),
                Location = new Point(25, 205),
                AutoSize = true
            };
            _contentPanel.Controls.Add(infoLabel);

            // Bottom Buttons
            _btnCancel = new Button
            {
                Text = "Cancel",
                Font = new Font("Segoe UI", 9.5f),
                Location = new Point(370, 275),
                Width = 95,
                Height = 32,
                BackColor = Color.FromArgb(55, 65, 81),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _btnCancel.Click += (s, e) => Close();
            _contentPanel.Controls.Add(_btnCancel);

            _btnInstall = new Button
            {
                Text = "Install",
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                Location = new Point(475, 275),
                Width = 95,
                Height = 32,
                BackColor = Color.FromArgb(0, 200, 220),
                ForeColor = Color.Black,
                FlatStyle = FlatStyle.Flat
            };
            _btnInstall.Click += async (s, e) => await StartInstallationAsync();
            _contentPanel.Controls.Add(_btnInstall);
        }

        private async Task StartInstallationAsync()
        {
            var targetDir = _destTextBox.Text.Trim();
            var makeDesktop = _chkDesktop.Checked;
            var makeStartMenu = _chkStartMenu.Checked;

            _contentPanel.Controls.Clear();

            var installingTitle = new Label
            {
                Text = "Installing ChatMCP Studio...",
                Font = new Font("Segoe UI", 12, FontStyle.Bold),
                Location = new Point(25, 30),
                AutoSize = true
            };
            _contentPanel.Controls.Add(installingTitle);

            _progressBar = new ProgressBar
            {
                Location = new Point(25, 75),
                Width = 545,
                Height = 24,
                Style = ProgressBarStyle.Continuous,
                Value = 0
            };
            _contentPanel.Controls.Add(_progressBar);

            _progressLabel = new Label
            {
                Text = "Initializing package extraction...",
                Font = new Font("Segoe UI", 9),
                ForeColor = Color.FromArgb(156, 163, 175),
                Location = new Point(25, 115),
                Width = 545,
                AutoEllipsis = true
            };
            _contentPanel.Controls.Add(_progressLabel);

            try
            {
                await Task.Run(() =>
                {
                    InstallerEngine.Install(targetDir, makeDesktop, makeStartMenu, (pct, status) =>
                    {
                        Invoke(new Action(() =>
                        {
                            _progressBar.Value = Math.Clamp(pct, 0, 100);
                            _progressLabel.Text = status;
                        }));
                    });
                });

                ShowCompletedPage(targetDir);
            }
            catch (Exception ex)
            {
                MessageBox.Show($"Installation encountered an error: {ex.Message}", "Installation Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                ShowConfigPage();
            }
        }

        private void ShowCompletedPage(string targetDir)
        {
            _contentPanel.Controls.Clear();

            _doneLabel = new Label
            {
                Text = "Setup Complete!",
                Font = new Font("Segoe UI", 16, FontStyle.Bold),
                ForeColor = Color.FromArgb(16, 185, 129), // Emerald Green
                Location = new Point(25, 25),
                AutoSize = true
            };
            _contentPanel.Controls.Add(_doneLabel);

            var messageLabel = new Label
            {
                Text = "ChatMCP Studio has been successfully installed on your computer.\n\n" +
                       "You can launch ChatMCP anytime from your Desktop or Start Menu.\n" +
                       $"Installed at: {targetDir}",
                Font = new Font("Segoe UI", 9.5f),
                Location = new Point(25, 70),
                Width = 545,
                Height = 80
            };
            _contentPanel.Controls.Add(messageLabel);

            _chkLaunch = new CheckBox
            {
                Text = "Launch ChatMCP Studio now",
                Font = new Font("Segoe UI", 10, FontStyle.Bold),
                ForeColor = Color.FromArgb(0, 242, 254),
                Checked = true,
                Location = new Point(28, 170),
                AutoSize = true
            };
            _contentPanel.Controls.Add(_chkLaunch);

            _btnFinish = new Button
            {
                Text = "Finish",
                Font = new Font("Segoe UI", 10, FontStyle.Bold),
                Location = new Point(475, 265),
                Width = 95,
                Height = 35,
                BackColor = Color.FromArgb(16, 185, 129),
                ForeColor = Color.Black,
                FlatStyle = FlatStyle.Flat
            };
            _btnFinish.Click += (s, e) =>
            {
                if (_chkLaunch.Checked)
                {
                    var exePath = Path.Combine(targetDir, "ChatMCP.exe");
                    if (File.Exists(exePath))
                    {
                        Process.Start(new ProcessStartInfo(exePath) { UseShellExecute = true });
                    }
                }
                Close();
            };
            _contentPanel.Controls.Add(_btnFinish);
        }
    }
}
