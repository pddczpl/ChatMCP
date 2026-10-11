using System;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ChatMCP.Installer
{
    public class UninstallForm : Form
    {
        private Panel _headerPanel = null!;
        private Label _titleLabel = null!;
        private Label _subTitleLabel = null!;
        private Panel _contentPanel = null!;
        private readonly string _installDir;

        public UninstallForm(string installDir)
        {
            _installDir = installDir;
            InitializeComponent();
        }

        private void InitializeComponent()
        {
            Text = "ChatMCP Studio - Uninstaller";
            Size = new Size(540, 360);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(17, 24, 39);
            ForeColor = Color.White;

            try
            {
                var iconPath = Path.Combine(_installDir, "assets", "icons", "chatmcp.ico");
                if (File.Exists(iconPath))
                {
                    Icon = new Icon(iconPath);
                }
            }
            catch { }

            _headerPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 75,
                BackColor = Color.FromArgb(11, 15, 25)
            };
            Controls.Add(_headerPanel);

            _titleLabel = new Label
            {
                Text = "Uninstall ChatMCP Studio",
                Font = new Font("Segoe UI", 15, FontStyle.Bold),
                ForeColor = Color.White,
                Location = new Point(25, 14),
                AutoSize = true
            };
            _headerPanel.Controls.Add(_titleLabel);

            _subTitleLabel = new Label
            {
                Text = "Remove ChatMCP and all associated shortcuts from this computer",
                Font = new Font("Segoe UI", 9, FontStyle.Regular),
                ForeColor = Color.FromArgb(239, 68, 68), // Red
                Location = new Point(26, 45),
                AutoSize = true
            };
            _headerPanel.Controls.Add(_subTitleLabel);

            var headerBorder = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 2,
                BackColor = Color.FromArgb(239, 68, 68)
            };
            _headerPanel.Controls.Add(headerBorder);

            _contentPanel = new Panel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(25)
            };
            Controls.Add(_contentPanel);

            ShowConfirmPage();
        }

        private void ShowConfirmPage()
        {
            _contentPanel.Controls.Clear();

            var prompt = new Label
            {
                Text = "Are you sure you want to completely remove ChatMCP Studio?\n\n" +
                       $"Installation directory:\n{_installDir}",
                Font = new Font("Segoe UI", 10),
                Location = new Point(25, 25),
                Width = 470,
                Height = 90
            };
            _contentPanel.Controls.Add(prompt);

            var btnCancel = new Button
            {
                Text = "Cancel",
                Font = new Font("Segoe UI", 9.5f),
                Location = new Point(310, 190),
                Width = 90,
                Height = 32,
                BackColor = Color.FromArgb(55, 65, 81),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            btnCancel.Click += (s, e) => Close();
            _contentPanel.Controls.Add(btnCancel);

            var btnUninstall = new Button
            {
                Text = "Uninstall",
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                Location = new Point(410, 190),
                Width = 95,
                Height = 32,
                BackColor = Color.FromArgb(220, 38, 38),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            btnUninstall.Click += async (s, e) => await StartUninstallAsync();
            _contentPanel.Controls.Add(btnUninstall);
        }

        private async Task StartUninstallAsync()
        {
            _contentPanel.Controls.Clear();

            var statusLabel = new Label
            {
                Text = "Uninstalling ChatMCP Studio...",
                Font = new Font("Segoe UI", 11, FontStyle.Bold),
                Location = new Point(25, 30),
                AutoSize = true
            };
            _contentPanel.Controls.Add(statusLabel);

            var progressBar = new ProgressBar
            {
                Location = new Point(25, 70),
                Width = 470,
                Height = 22,
                Style = ProgressBarStyle.Continuous,
                Value = 0
            };
            _contentPanel.Controls.Add(progressBar);

            var detailLabel = new Label
            {
                Text = "Cleaning up components...",
                Font = new Font("Segoe UI", 9),
                ForeColor = Color.FromArgb(156, 163, 175),
                Location = new Point(25, 105),
                Width = 470
            };
            _contentPanel.Controls.Add(detailLabel);

            await Task.Run(() =>
            {
                InstallerEngine.Uninstall(_installDir, (pct, msg) =>
                {
                    Invoke(new Action(() =>
                    {
                        progressBar.Value = Math.Clamp(pct, 0, 100);
                        detailLabel.Text = msg;
                    }));
                });
            });

            _contentPanel.Controls.Clear();

            var doneLabel = new Label
            {
                Text = "Uninstall Complete",
                Font = new Font("Segoe UI", 14, FontStyle.Bold),
                ForeColor = Color.FromArgb(16, 185, 129),
                Location = new Point(25, 30),
                AutoSize = true
            };
            _contentPanel.Controls.Add(doneLabel);

            var doneMsg = new Label
            {
                Text = "ChatMCP Studio was successfully removed from your computer.",
                Font = new Font("Segoe UI", 10),
                Location = new Point(25, 75),
                Width = 470,
                Height = 60
            };
            _contentPanel.Controls.Add(doneMsg);

            var btnClose = new Button
            {
                Text = "Close",
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                Location = new Point(410, 190),
                Width = 95,
                Height = 32,
                BackColor = Color.FromArgb(55, 65, 81),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            btnClose.Click += (s, e) => Close();
            _contentPanel.Controls.Add(btnClose);
        }
    }
}
