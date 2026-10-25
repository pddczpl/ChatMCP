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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/** `base` (the environment of this process) without PSModulePath, in any letter case, and then `extra` on top. `base` is not changed. */
export function powerShellChildEnvironment(extra = {}, base = process.env) {
  const environment = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && name.toLowerCase() !== 'psmodulepath') environment[name] = value;
  return Object.assign(environment, extra);
}

/** Windows PowerShell 5.1, the one that every Windows machine has. */
export function windowsPowerShellPath(base = process.env) {
  return path.join(base.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * A stand-in for the module folder of PowerShell 7, so that the trap above can be set without PowerShell 7: `<directory>/Modules` holds a
 * Microsoft.PowerShell.Utility 7.0.0.0 for the Core edition that exports every command Windows PowerShell's own module has (the real one does too). Put the returned folder
 * first in PSModulePath and a Windows PowerShell child loses Get-FileHash, whichever command it ran before and however it was given its code (-File, -Command,
 * -EncodedCommand); on windows-latest under pwsh the Hub's own ShellRunner loses it the same way. Windows only.
 */
export async function powerShell7ModuleStandIn(directory, powershell = windowsPowerShellPath()) {
  const listed = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command -Module Microsoft.PowerShell.Utility).Name'], { encoding: 'utf8', windowsHide: true, env: powerShellChildEnvironment(), timeout: 60_000 });
  const names = String(listed.stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[A-Za-z]+-[A-Za-z]+$/.test(line));
  if (listed.status !== 0 || !names.includes('Get-FileHash')) throw new Error(`Windows PowerShell did not list the commands of Microsoft.PowerShell.Utility: ${listed.stdout}${listed.stderr}`);
  const modules = path.join(directory, 'Modules');
  const folder = path.join(modules, 'Microsoft.PowerShell.Utility', '7.0.0.0');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'Microsoft.PowerShell.Utility.psd1'), [
    '@{', "  GUID = '1da87e53-152b-403e-98dc-74d7b4d63d59'", "  ModuleVersion = '7.0.0.0'", "  CompatiblePSEditions = @('Core')", "  PowerShellVersion = '3.0'",
    "  NestedModules = @('Microsoft.PowerShell.Commands.Utility.dll')", `  CmdletsToExport = @(${names.map((name) => `'${name}'`).join(', ')})`, '}', '',
  ].join('\r\n'));
  return modules;
}
