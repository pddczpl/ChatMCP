// The environment of a Windows PowerShell (powershell.exe, 5.1) that the Hub starts.
//
// PowerShell 7 (pwsh) puts its own module folders first in PSModulePath, and node hands that on to everything it starts, so a Hub that was started
// from a pwsh session passes it to every child. Windows PowerShell then finds PowerShell 7's Microsoft.PowerShell.Utility 7.0.0.0, which it cannot load,
// before its own 3.1.0.0, and loses what that module defines as script functions: Get-FileHash, New-Guid, New-TemporaryFile, Format-Hex,
// Import-PowerShellDataFile and ConvertFrom-SddlString. The cmdlets that are compiled in (ConvertFrom-Json, Add-Type, New-Object ...) keep working, which
// is why nothing fails loudly. pwsh takes its folders out when IT starts powershell.exe directly; when anything sits in between (node, cmd.exe, Python) it
// does not. Microsoft's own advice for that case (about_PSModulePath, "Starting Windows PowerShell from PowerShell 7") is to remove PSModulePath from
// the environment of the child, so that Windows PowerShell works out its default module path at startup: the modules of Windows PowerShell for the
// user and for all users and its own, which is what a window opened from the Start menu has.
//
// What is lost: a folder that was added to PSModulePath only for the one process that started the Hub (a profile is never read, the Hub starts PowerShell
// with -NoProfile). A folder saved in the user or machine PSModulePath, or installed where Windows PowerShell looks, is found as before.
//
// Every place in lib/ that starts powershell.exe gives the child `env: powerShellChildEnvironment(...)`; tests/verify-source-lint.mjs fails when a file does not.

/** `base` (the environment of this process) without PSModulePath, in any letter case, and then `extra` on top. `base` is not changed. */
export function powerShellChildEnvironment(extra = {}, base = process.env) {
  const environment = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && name.toLowerCase() !== 'psmodulepath') environment[name] = value;
  return Object.assign(environment, extra);
}
