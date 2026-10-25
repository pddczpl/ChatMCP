// The environment of a PowerShell child that a test or a build script starts from node.
//
// The release workflows run their steps in PowerShell 7 (`defaults.run.shell: pwsh`). PowerShell 7 puts its own module folders first in PSModulePath, and node
// hands that on to everything it starts. Windows PowerShell 5.1 (powershell.exe) then finds PowerShell 7's Microsoft.PowerShell.Utility 7.0.0.0, which it cannot
// load, before its own 3.1.0.0, and loses what that module defines as script functions: Get-FileHash, New-Guid, New-TemporaryFile, Format-Hex,
// Import-PowerShellDataFile and ConvertFrom-SddlString. The cmdlets that are compiled in (ConvertFrom-Json, Add-Type, New-Object ...) keep working, which is why only
// the suite that needed Get-FileHash failed in the first publish run of v3.10.0. pwsh cleans the variable when IT starts powershell.exe; node does not.
// Without PSModulePath a PowerShell works out the default module path of the machine, which is what a person's own window has.
//
// Every node call that starts powershell.exe from a test or a script passes `env: powerShellChildEnvironment(...)`; tests/verify-source-lint.mjs fails when a file does not.

/** `base` (the environment of this process) without PSModulePath, in any letter case, and then `extra` on top. `base` is not changed. */
export function powerShellChildEnvironment(extra = {}, base = process.env) {
  const environment = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && name.toLowerCase() !== 'psmodulepath') environment[name] = value;
  return Object.assign(environment, extra);
}
