using ChatMCP.Native;
using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

namespace ChatMCP.Desktop
{
    // The part of the window that installs the update the Hub downloaded, when the page asks (chatmcp.apply-update). The page sends an id and nothing else; everything that matters is decided here, by
    // native-shared/UpdateApplier.cs (tested without a window): this is an installed copy, the Hub is idle, the update proves itself with the keys this program was built with, the Hub offered that
    // one, and then the installer is started from the file that was checked and this window closes itself so that the installer can replace the files.
    public partial class MainWindow
    {
        private bool _applyingUpdate;
        // The installer, as the Process that Start returned, kept open until the look at it is over: once an installer has ended its id is free, and another program could be given it within the five seconds, so
        // the look is at this handle and never at an id.
        private Process? _installer;

        private void ReplyToPage(string requestId, bool ok, string code)
        {
            try { _webView.CoreWebView2?.PostWebMessageAsJson(PageMessage.UpdateResultJson(requestId, ok, code)); }
            catch (Exception) { /* the page is gone or navigating: nothing to tell */ }
        }

        private async Task ApplyUpdateAsync(string requestId)
        {
            // One update at a time: a second click while the first is being looked at is told so and does nothing.
            if (_applyingUpdate) { ReplyToPage(requestId, false, "busy"); return; }
            _applyingUpdate = true;
            var monitorStopped = false;
            try
            {
                var installDirectory = Path.GetDirectoryName(Environment.ProcessPath) ?? "";
                var environment = new ApplyEnvironment
                {
                    InstalledDirectory = installDirectory,
                    StateDirectory = HubSession.DefaultStateDirectory(),
                    ShellPid = Environment.ProcessId,
                    Running = ReleaseVersion.TryParse(HubLifecycle.Version, out var running) ? running : throw new InvalidOperationException("This program has no release version."),
                    Keys = ShellKeys.Embedded(),
                    // the folder this program runs from must be the one the installer owns (the receipt), and the one this window found its Hub files in
                    IsInstalledCopy = directory => InstalledCopy.Is(directory) && string.Equals(Path.GetFullPath(directory).TrimEnd('\\'), Path.GetFullPath(_repoRoot).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase),
                    Preflight = async () =>
                    {
                        var session = _session ?? throw new InvalidOperationException("This window has no Hub session.");
                        using var client = HubLifecycle.Client();
                        return await HubLifecycle.PreflightForUpdate(client, HubLifecycle.Origin, session.Secret);
                    },
                    Start = info =>
                    {
                        _installer = Process.Start(info) ?? throw new IOException("The installer did not start.");
                        return _installer.Id;
                    },
                };
                // the monitor of the Hub is stopped only when everything has been checked and the installer is about to start: it would otherwise tell the person that the Hub went away
                var installerPid = await UpdateApplier.ApplyAsync(environment, () => { _hubMonitor.Stop(); monitorStopped = true; });
                // The installer waits for this process to exit, so one that has already ended did not start well and replaced nothing (it could not read its arguments, say): this window stays open and says so,
                // and the monitor is started again below. Otherwise the installer is given a few seconds to put its own window on the screen, so that the person never looks at an empty desktop.
                var seen = await UpdateApplier.WaitForInstaller(() => LookAtInstaller(installerPid), TimeSpan.FromSeconds(5), TimeSpan.FromMilliseconds(100), Task.Delay);
                _installer?.Dispose(); _installer = null;
                if (seen == InstallerSighting.Exited) throw new UpdateRefused("launch_failed", "the installer ended before this window closed");
                ReplyToPage(requestId, true, "launched");
                // The installer waits for this process to exit; the Hub is left running, as when the window is closed by hand, and the installer stops it itself.
                Close();
            }
            catch (UpdateRefused refused)
            {
                _installer?.Dispose(); _installer = null;
                if (monitorStopped && !IsDisposed) _hubMonitor.Start();
                ReplyToPage(requestId, false, refused.Code);
                _applyingUpdate = false;
            }
            catch (Exception)
            {
                _installer?.Dispose(); _installer = null;
                if (monitorStopped && !IsDisposed) _hubMonitor.Start();
                ReplyToPage(requestId, false, "launch_failed");
                _applyingUpdate = false;
            }
        }

        /// <summary>What the installer that was started is doing now (a look at its handle, which is still open, and not at its id): its window is up, it has ended, or neither (null: running, no window yet, or it cannot be looked at).</summary>
        private InstallerSighting? LookAtInstaller(int processId)
        {
            var installer = _installer;
            if (installer == null || installer.Id != processId) return null;
            try
            {
                installer.Refresh();
                if (installer.HasExited) return InstallerSighting.Exited;
                return installer.MainWindowHandle != IntPtr.Zero ? InstallerSighting.Window : null;
            }
            catch (Exception) { return null; }
        }
    }
}
