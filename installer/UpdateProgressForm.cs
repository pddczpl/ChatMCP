using ChatMCP.Native;
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ChatMCP.Installer
{
    /// <summary>
    /// The window of an update while it works. The shell has closed itself and the person must not look at nothing, so this is a title ("Updating DatGold to x.y.z"), a bar that keeps moving without claiming
    /// a percentage, the step it is on, and NOTHING to press: no buttons, no close box, and it refuses to be closed while it works. When it did not work it says why, in the words of
    /// <see cref="UpdateWords"/>, and gets one button, Close; when the installation needs repair, a second one, Repair now, which puts the window back to working (no button again) until the repair is over.
    /// The old app is already open again by then when it can be, so the person is never held up by this window.
    /// </summary>
    internal sealed class UpdateProgressForm : Form
    {
        private readonly Label _title;
        private readonly ProgressBar _bar;
        private readonly Label _status;
        private readonly List<Button> _buttons = new();
        private bool _allowClose;

        internal UpdateProgressForm(string version)
        {
            Text = "DatGold Studio";
            ClientSize = new Size(480, 150);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            ControlBox = false;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = true;
            TopMost = true;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(17, 24, 39);
            ForeColor = Color.White;
            try { Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath ?? ""); } catch (Exception) { /* the generic icon */ }

            _title = new Label { Text = UpdateWords.Title(version), Font = new Font("Segoe UI", 13, FontStyle.Bold), Location = new Point(24, 22), Size = new Size(432, 30), AutoEllipsis = true };
            _bar = new ProgressBar { Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 30, Location = new Point(24, 66), Size = new Size(432, 18) };
            _status = new Label { Text = UpdateWords.Waiting, Font = new Font("Segoe UI", 9.5f), ForeColor = Color.FromArgb(156, 163, 175), Location = new Point(24, 96), Size = new Size(432, 36), AutoEllipsis = true };
            Controls.Add(_title);
            Controls.Add(_bar);
            Controls.Add(_status);
        }

        /// <summary>Says which step the update is on. Safe to call from the thread that does the work.</summary>
        internal void Report(string status)
        {
            if (!IsHandleCreated || IsDisposed) return;
            try { BeginInvoke(new Action(() => _status.Text = status)); } catch (InvalidOperationException) { /* the window is gone */ }
        }

        /// <summary>
        /// The update is over. After a success the window closes by itself; after a failure it says why and waits for Close. When the installation needs repair it has Repair now as well: that runs
        /// <paramref name="repair"/> (off the thread of the window, with nothing to press meanwhile) and shows how the repair ended in the same way.
        /// </summary>
        internal void Finish(UpdateEnd end, Func<UpdateOutcome, UpdateEnd> repair)
        {
            if (!IsHandleCreated || IsDisposed) return;
            try
            {
                BeginInvoke(new Action(() =>
                {
                    if (end.Outcome.Ok) { _allowClose = true; Close(); return; }
                    ShowFailure(end, repair);
                }));
            }
            catch (InvalidOperationException) { /* the window is gone */ }
        }

        private void RemoveButtons()
        {
            foreach (var button in _buttons) { Controls.Remove(button); button.Dispose(); }
            _buttons.Clear();
        }

        private void ShowFailure(UpdateEnd end, Func<UpdateOutcome, UpdateEnd> repair)
        {
            RemoveButtons();
            _bar.Visible = false;
            _title.Text = UpdateWords.TitleFor(end);
            _status.Text = UpdateWords.EndFor(end);
            _status.AutoEllipsis = false;
            _status.Location = new Point(24, 62);
            _status.Size = new Size(432, 190);
            ClientSize = new Size(480, 300);
            var close = new Button { Text = "Close", Size = new Size(95, 32), Location = new Point(361, 256), FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(55, 65, 81), ForeColor = Color.White };
            close.Click += (_, _) => { _allowClose = true; Close(); };
            Controls.Add(close);
            _buttons.Add(close);
            if (end.Outcome.State == "needs_recovery" && !end.Repaired)
            {
                var again = new Button { Text = "Repair now", Size = new Size(110, 32), Location = new Point(241, 256), FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(0, 200, 220), ForeColor = Color.Black };
                again.Click += (_, _) => StartRepair(end, repair);
                Controls.Add(again);
                _buttons.Add(again);
            }
            AcceptButton = close;
            close.Focus();
        }

        private void StartRepair(UpdateEnd end, Func<UpdateOutcome, UpdateEnd> repair)
        {
            // back to working: nothing to press until the repair is over
            RemoveButtons();
            AcceptButton = null;
            _title.Text = "Repairing DatGold";
            _status.Text = "Putting back the files of the update that stopped halfway...";
            _status.AutoEllipsis = true;
            _status.Location = new Point(24, 96);
            _status.Size = new Size(432, 36);
            _bar.Visible = true;
            ClientSize = new Size(480, 150);
            Task.Run(() =>
            {
                UpdateEnd next;
                try { next = repair(end.Outcome); }
                catch (Exception) { next = end; }
                Finish(next, repair);
            });
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // A person closing it while it works would leave nothing on the screen; windows shutting down, or the process ending, are not stopped.
            if (!_allowClose && e.CloseReason == CloseReason.UserClosing) e.Cancel = true;
            base.OnFormClosing(e);
        }
    }
}
