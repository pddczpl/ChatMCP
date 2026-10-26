// Static gate for step 3 of the in-app updater (the shell installs the downloaded update and the installer replaces the files). What the code DOES is proved by the native suite
// (scripts/tests/native-lifecycle, run by scripts/tests/Test-NativeLifecycle.ps1) and by the Playwright specs; this suite keeps the build and the source from drifting in ways those cannot see,
// on every platform, in the ordinary Node run:
//   * the two project files that scripts/Build-Installer.ps1 reads as XML hold ONE <PropertyGroup> each (a second one made Project.PropertyGroup an array, and the script, which runs under
//     Set-StrictMode -Version 2.0, failed with "The property 'Version' cannot be found" on the first CI run of this step);
//   * the shell's key list is the file the Hub reads, embedded in the program under the name the shell looks for, and a build can name another one (the end-to-end test of the updater needs two
//     builds that trust a key made for the run); on Windows with a .NET SDK, MSBuild itself is asked what it embeds;
//   * the window of an update has no buttons while it works, no close box, and cannot be closed by the person until it has finished;
//   * the names a setup carries (the product and the description) are the ones the shell checks before it runs a file;
//   * the shell starts the installer with an argument LIST and without a shell, and neither the shell nor the installer takes in a package: no NuGet package beyond WebView2 (BCL only).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hubRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(hubRoot, '..');
const folders = ['desktop-shell', 'native-shared', 'installer', 'scripts'].map((name) => path.join(repo, name));
if (!folders.every((folder) => fs.existsSync(folder))) {
  console.log('CHATMCP_TEST_SKIP: desktop-shell/, native-shared/, installer/ and scripts/ were not found next to CHATMCP-HUB (they ship in the repository, not in the Hub bundle)');
  process.exit(0);
}

let checks = 0;
const check = (condition, label, detail = '') => { assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`); checks += 1; };
const read = (relative) => fs.readFileSync(path.join(repo, relative), 'utf8').replace(/\r\n/g, '\n');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, ''); // C#: comments may name what the code must not do

// ---- the project files -------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Counts the <PropertyGroup> elements of an MSBuild project file, comments left out.
const propertyGroups = (text) => [...text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<PropertyGroup(?=[\s>/])[^>]*>/g)].length;
const packageReferences = (text) => [...text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<PackageReference\s[^>]*Include="([^"]+)"/g)].map((match) => match[1]);

const twoGroups = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <Version>1.0.0</Version>\n  </PropertyGroup>\n  <PropertyGroup Condition="true">\n    <Other>x</Other>\n  </PropertyGroup>\n</Project>\n';
check(propertyGroups(twoGroups) === 2, 'the counter sees a second group (negative control: the shape that broke the build)');
check(propertyGroups(twoGroups.replace('<PropertyGroup Condition="true">', '<!-- <PropertyGroup> --><ItemGroup>').replace('</PropertyGroup>\n</Project>', '</ItemGroup>\n</Project>')) === 1, 'a group named in a comment is not a group, and an ItemGroup is not a PropertyGroup');
check(packageReferences('<ItemGroup><PackageReference Include="A.B" Version="1" /><!-- <PackageReference Include="C" /> --></ItemGroup>').join() === 'A.B', 'the package counter reads the references and not the comments');

const buildScript = read('scripts/Build-Installer.ps1');
check(/\$shellManifest\.Project\.PropertyGroup\.Version/.test(buildScript) && /\$installerManifest\.Project\.PropertyGroup\.Version/.test(buildScript),
  'scripts/Build-Installer.ps1 reads Project.PropertyGroup.Version of both project files (the reason for the next two checks)');
check(/Set-StrictMode -Version 2\.0/.test(buildScript), 'and it runs under strict mode, which refuses a property an array does not have');

const shellProject = read('desktop-shell/ChatMCP.csproj');
const installerProject = read('installer/ChatMCP.Installer.csproj');
check(propertyGroups(shellProject) === 1, 'desktop-shell/ChatMCP.csproj has ONE PropertyGroup (Build-Installer.ps1 reads its Version as one element)', `found ${propertyGroups(shellProject)}`);
check(propertyGroups(installerProject) === 1, 'installer/ChatMCP.Installer.csproj has ONE PropertyGroup', `found ${propertyGroups(installerProject)}`);
check(/<Version>[^<]+<\/Version>/.test(shellProject) && /<Version>[^<]+<\/Version>/.test(installerProject), 'both name their version');

// BCL only: the shell has the one package it always had, the installer none.
check(packageReferences(shellProject).join() === 'Microsoft.Web.WebView2', 'the shell takes in no package but WebView2', packageReferences(shellProject).join());
check(packageReferences(installerProject).length === 0, 'the installer takes in no package at all', packageReferences(installerProject).join());

// ---- the keys the shell trusts ------------------------------------------------------------------------------------------------------------------------------------------------------------
const shellKeys = strip(read('desktop-shell/ShellKeys.cs'));
const resourceName = /const string ResourceName = "([^"]+)"/.exec(shellKeys)?.[1];
const logicalName = /<EmbeddedResource\s+Include="\$\(ReleaseKeysFile\)"\s+LogicalName="([^"]+)"/.exec(shellProject)?.[1];
check(resourceName && resourceName === logicalName, 'the name the shell reads its keys under is the name the project embeds them under', `${resourceName} / ${logicalName}`);
check(/<ReleaseKeysFile Condition="'\$\(ReleaseKeysFile\)' == ''">\$\(MSBuildThisFileDirectory\)\.\.\\CHATMCP-HUB\\lib\\release-keys\.json<\/ReleaseKeysFile>/.test(shellProject),
  'by default the shell embeds the file the Hub reads (CHATMCP-HUB/lib/release-keys.json), and a build can name another with -p:ReleaseKeysFile');
check(/GetManifestResourceStream\(ResourceName\)/.test(shellKeys) && !/\bFile\.|\bDirectory\.|\bPath\.|\bFileStream\b|\bStreamReader\(\s*[a-z]*[Pp]ath/.test(shellKeys),
  'the shell reads its keys from the program and from no file on the disk (nothing added after the build can be trusted)');
check(fs.existsSync(path.join(hubRoot, 'lib', 'release-keys.json')), 'the key file that is embedded exists');

// MSBuild itself is asked what it embeds (Windows with a .NET SDK: the project targets net10.0-windows).
const evaluate = (extra) => {
  const out = execFileSync('dotnet', ['msbuild', path.join(repo, 'desktop-shell', 'ChatMCP.csproj'), '-getProperty:ReleaseKeysFile', '-getItem:EmbeddedResource', ...extra], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  const json = JSON.parse(out);
  return { property: json.Properties.ReleaseKeysFile, items: json.Items.EmbeddedResource };
};
let sdk = process.platform === 'win32';
if (sdk) { try { execFileSync('dotnet', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { sdk = false; } }
if (!sdk) {
  console.log('NOTE: MSBuild was not asked what the shell embeds (needs Windows and a .NET SDK); the project file was checked as text above.');
} else {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const standard = evaluate([]);
  check(standard.items.length === 1 && same(standard.items[0].FullPath, path.join(hubRoot, 'lib', 'release-keys.json')), 'MSBuild: by default the one embedded resource is the Hub\'s key file', standard.items.map((item) => item.FullPath).join());
  check(standard.items[0].LogicalName === resourceName, 'MSBuild: under the name the shell reads');
  // The folder is made (and its long name asked for) because MSBuild spells a path in full, and the temporary folder of a runner is often spelled with a short name (RUNNER~1).
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'update apply '));
  try {
    const other = path.join(fs.realpathSync.native(scratch), 'keys made for a run.json');
    const named = evaluate([`-p:ReleaseKeysFile=${other}`]);
    check(named.items.length === 1 && same(named.items[0].FullPath, other) && named.items[0].LogicalName === resourceName, 'MSBuild: a build that names its own key file embeds that one, under the same name', named.items.map((item) => item.FullPath).join());
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- the window of an update ------------------------------------------------------------------------------------------------------------------------------------------------------------
const form = strip(read('installer/UpdateProgressForm.cs'));
check(/\bControlBox\s*=\s*false\s*;/.test(form) && /\bMaximizeBox\s*=\s*false\s*;/.test(form) && /\bMinimizeBox\s*=\s*false\s*;/.test(form), 'the window has no close box, no maximize and no minimize');
check(/ProgressBarStyle\.Marquee/.test(form) && !/\.(?:Value|Maximum|Minimum|Step)\s*=/.test(form) && !/PerformStep|Percent|%/.test(form), 'its bar keeps moving and claims no percentage');
const buttons = [...form.matchAll(/new\s+Button\b/g)].map((match) => match.index);
const constructorEnd = form.indexOf('internal void Report(');
const failureBranch = form.indexOf('if (outcome.Ok)');
check(constructorEnd > 0 && failureBranch > constructorEnd, 'the source has the shape the next checks read (constructor, Report, Finish)');
check(buttons.length === 1 && buttons[0] > failureBranch, 'the one button, Close, is made only when the update did not go through (no button while it works)', `buttons at ${buttons.join(',')}`);
check(/protected override void OnFormClosing\(FormClosingEventArgs e\)\s*\{[^}]*!_allowClose\s*&&\s*e\.CloseReason\s*==\s*CloseReason\.UserClosing\)\s*e\.Cancel\s*=\s*true/.test(form), 'the person cannot close it while it works (windows shutting down are not stopped)');
check(/if \(outcome\.Ok\)\s*\{\s*_allowClose\s*=\s*true;\s*Close\(\);/.test(form), 'after a success it closes by itself');
check((form.match(/_allowClose\s*=\s*true/g) ?? []).length === 2 && !/Hide\(\)|Visible\s*=\s*false\s*;\s*\n\s*Close/.test(form.replace(/_bar\.Visible\s*=\s*false/g, '')), 'it is let go only after a success and by the Close button');

// ---- the names a setup carries -----------------------------------------------------------------------------------------------------------------------------------------------------------
const staging = strip(read('native-shared/UpdateStaging.cs'));
const expectedProduct = /const string ExpectedProduct = "([^"]+)"/.exec(staging)?.[1];
const expectedDescription = /const string ExpectedDescription = "([^"]+)"/.exec(staging)?.[1];
const product = /<Product>([^<]+)<\/Product>/.exec(installerProject)?.[1];
const title = /<AssemblyTitle>([^<]+)<\/AssemblyTitle>/.exec(installerProject)?.[1];
check(expectedProduct && product === expectedProduct, 'the product the shell expects of a setup is the one the installer project gives (Product -> ProductName)', `${expectedProduct} / ${product}`);
check(expectedDescription && title === expectedDescription, 'the description the shell expects is the title the installer project gives (AssemblyTitle -> FileDescription)', `${expectedDescription} / ${title}`);

// ---- how the installer is started ----------------------------------------------------------------------------------------------------------------------------------------------------------
const applier = strip(read('native-shared/UpdateApplier.cs'));
const mainUpdate = strip(read('desktop-shell/MainWindow.Update.cs'));
check(/UseShellExecute\s*=\s*false/.test(applier) && !/UseShellExecute\s*=\s*true/.test(applier + mainUpdate), 'the installer is started without a shell');
check(/ArgumentList\.Add\(/.test(applier) && !/(?<![A-Za-z])Arguments\s*=/.test(applier + mainUpdate) && !/new ProcessStartInfo\([^)]*,/.test(applier + mainUpdate), 'with an argument list, never a command line made by joining text');
check(!/cmd(?:\.exe)?\b|powershell|pwsh|Process\.Start\(\s*"/i.test(applier + mainUpdate), 'and never through cmd or PowerShell');

console.log(`verify-update-apply: ${checks} checks PASS`);
