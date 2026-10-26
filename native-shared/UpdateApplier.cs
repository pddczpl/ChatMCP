using System.Diagnostics;

namespace ChatMCP.Native;

/// <summary>What the shell's side of an update uses from outside itself: the installation it runs from, the Hub's state folder, the keys it was built with, and the things that touch the machine.</summary>
internal sealed class ApplyEnvironment
{
    /// <summary>The folder ChatMCP.exe runs from: what the installer is told to replace.</summary>
    internal string InstalledDirectory { get; set; } = "";
    /// <summary>The Hub's data folder (HubSession.DefaultStateDirectory): the updates it downloaded are under it and the result file goes in it.</summary>
    internal string StateDirectory { get; set; } = "";
    /// <summary>The pid of this shell, which the installer waits for.</summary>
    internal int ShellPid { get; set; }
    internal ReleaseVersion Running { get; set; }
    internal ReleaseKeys Keys { get; set; } = ReleaseKeys.Parse(null);
    /// <summary>Whether a folder is an installed copy: the receipt the installer leaves is in it. A build run from a work tree is not, and never replaces itself.</summary>
    internal Func<string, bool> IsInstalledCopy { get; set; } = _ => false;
    /// <summary>Asks the Hub whether it is doing work and which version it has ready (HubLifecycle.PreflightForUpdate); throws when it cannot.</summary>
    internal Func<Task<UpdatePreflight>> Preflight { get; set; } = () => throw new InvalidOperationException("No Hub to ask.");
    internal Func<string, ReleaseVersion, ReleaseKeys, VerifiedUpdate> Verify { get; set; } = UpdateStaging.Verify;
    /// <summary>Starts the installer and returns its pid; throws when it cannot start.</summary>
    internal Func<ProcessStartInfo, int> Start { get; set; } = info => throw new InvalidOperationException("No way to start a program.");
}

/// <summary>
/// The sequence of the shell when the page asks for the update to be installed, in the order that keeps the person's work and the installation safe: (1) this must be an installed copy; (2) the Hub is asked
/// whether it is doing work, BEFORE anything else, because the installer's own refusal comes after this window is gone; (3) the update is found and verified with the shell's own code, off the thread that
/// draws the window (it hashes a file of 230 MB); (4) the version the Hub says it has ready must be the one that was found, because the page showed the owner that one; (5) the Hub is asked again, because work can
/// start while a file is being hashed; (6) the caller stops what must not run any more (the monitor of the Hub), and the installer is started from the file that was verified, which is held until Process.Start
/// has returned. It returns the pid of the installer; the caller then closes the window, and the installer waits for it. A refusal is an <see cref="UpdateRefused"/> and nothing has been started.
/// </summary>
internal static class UpdateApplier
{
    /// <summary>Where the installer leaves its result and the Hub looks for it: next to the Hub's other data.</summary>
    internal const string ResultFileName = "update-result.json";

    internal static async Task<int> ApplyAsync(ApplyEnvironment environment, Action beforeStart)
    {
        if (!environment.IsInstalledCopy(environment.InstalledDirectory)) throw new UpdateRefused("not_installed", "this copy of DatGold was not made by the installer");
        await CheckHubIsIdle(environment);
        // the work happens on another thread: the window must keep answering while 230 MB are hashed
        var update = await Task.Run(() => environment.Verify(UpdateStaging.RootFor(environment.StateDirectory), environment.Running, environment.Keys));
        using (update)
        {
            var offered = await CheckHubIsIdle(environment);
            if (offered != update.Version.ToString()) throw new UpdateRefused("stale", "the Hub offers " + (offered ?? "nothing") + " and the folder holds " + update.Version);
            beforeStart();
            var start = new ProcessStartInfo(update.InstallerPath) { UseShellExecute = false, WorkingDirectory = update.Folder };
            foreach (var argument in UpdateArguments.Build(environment.InstalledDirectory, environment.ShellPid, Path.Combine(environment.StateDirectory, ResultFileName))) start.ArgumentList.Add(argument);
            try { return environment.Start(start); }
            catch (Exception error) when (error is not UpdateRefused) { throw new UpdateRefused("launch_failed", error.GetType().Name); }
            // the file is let go here, when Start has returned and not before: the program is made from the path
        }
    }

    /// <summary>Asks the Hub; refuses when it is working, or cannot be asked. Returns the version the Hub says is ready.</summary>
    private static async Task<string?> CheckHubIsIdle(ApplyEnvironment environment)
    {
        UpdatePreflight answer;
        try { answer = await environment.Preflight(); }
        catch (Exception error) when (error is not UpdateRefused) { throw new UpdateRefused("hub_unreachable", error.GetType().Name); }
        if (answer.BlockingWork != null) throw new UpdateRefused("tasks_running", answer.BlockingWork);
        return answer.OfferedVersion;
    }
}
