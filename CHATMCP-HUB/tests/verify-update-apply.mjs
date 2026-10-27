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
import { powerShellChildEnvironment } from './support/powershell-environment.mjs';

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
check(/\$shellKeysFile = if \(\$ReleaseKeysFile -ne ''\) \{ \$ReleaseKeysFile \} else \{ Join-Path \$repoRoot 'CHATMCP-HUB\\lib\\release-keys\.json' \}/.test(buildScript) && /\$shellKeysArgument = ConvertTo-InstallerMsbuildValue -Value \$shellKeysFile/.test(buildScript) && /"-p:ReleaseKeysFile=\$shellKeysArgument"/.test(buildScript) && !/@shellKeys\b/.test(buildScript),
  'scripts/Build-Installer.ps1 ALWAYS names the key list the shell is built with, written so that MSBuild reads the path back as it is (MSBuild reads an environment variable called ReleaseKeysFile as a property: left to the default of the project, it would be the list the program trusts)');
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
  // MSBuild spells a path in full while a temporary folder is often spelled with a short name (C:\Users\RUNNER~1\...): both sides are asked for their real name where the file exists.
  const real = (file) => { try { return fs.realpathSync.native(file); } catch { return path.resolve(file); } };
  const same = (a, b) => real(a).toLowerCase() === real(b).toLowerCase();
  const standard = evaluate([]);
  check(standard.items.length === 1 && same(standard.items[0].FullPath, path.join(hubRoot, 'lib', 'release-keys.json')), 'MSBuild: by default the one embedded resource is the Hub\'s key file', standard.items.map((item) => item.FullPath).join());
  check(standard.items[0].LogicalName === resourceName, 'MSBuild: under the name the shell reads');
  // The folder is made (and its long name asked for) because MSBuild spells a path in full, and the temporary folder of a runner is often spelled with a short name (RUNNER~1).
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'update apply '));
  try {
    const other = path.join(fs.realpathSync.native(scratch), 'keys made for a run.json');
    const named = evaluate([`-p:ReleaseKeysFile=${other}`]);
    check(named.items.length === 1 && same(named.items[0].FullPath, other) && named.items[0].LogicalName === resourceName, 'MSBuild: a build that names its own key file embeds that one, under the same name', named.items.map((item) => item.FullPath).join());
    // A repository can be anywhere: in C:\My Repos, Inc\ or C:\a;b\. MSBuild splits a property on the command line at ';' and ',' and reads '%' as an escape, so the build script writes the path the way its
    // helper does (the real helper is asked here), and MSBuild must give the very same path back. Unescaped it refuses (MSB1006): the regression a review found, kept as a negative control.
    const strange = path.join(fs.realpathSync.native(scratch), "a;b, c%d (e) $f 'g' @h", 'keys made for a run.json');
    const escaped = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `. '${path.join(repo, 'scripts', 'InstallerPayload.ps1').replaceAll("'", "''")}'; ConvertTo-InstallerMsbuildValue -Value '${strange.replaceAll("'", "''")}'`], { encoding: 'utf8', timeout: 60000, env: powerShellChildEnvironment() }).trim();
    check(escaped !== strange && !/[;,]/.test(escaped), 'the helper of the build script escapes the characters MSBuild splits at', escaped);
    const viaBuildScript = evaluate([`-p:ReleaseKeysFile=${escaped}`]);
    check(viaBuildScript.items.length === 1 && same(viaBuildScript.items[0].FullPath, strange) && viaBuildScript.items[0].LogicalName === resourceName, 'MSBuild: a key file in a folder with ; , % ( ) $ \' and @ in its name is read back as the same path through the escaping of the build script', viaBuildScript.items.map((item) => item.FullPath).join());
    let refusedUnescaped = false;
    try { evaluate([`-p:ReleaseKeysFile=${strange}`]); } catch { refusedUnescaped = true; }
    check(refusedUnescaped, 'negative control: the same path, not escaped, is refused by MSBuild (the build would fail for such a repository)');
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

// The lifecycle script (it runs only on a disposable hosted runner) asks the real setup for the same two names, and drives it with the flags of the contract and no others.
const lifecycle = read('scripts/tests/Test-NativeLifecycle.ps1');
check(new RegExp(`ProductName -ceq '${expectedProduct}'`).test(lifecycle) && new RegExp(`FileDescription -ceq '${expectedDescription}'`).test(lifecycle), 'scripts/tests/Test-NativeLifecycle.ps1 checks the real setup for the names the shell expects');
const contractFlags = [...(/new\[\] \{([^}]*)\}/.exec(strip(read('native-shared/UpdateContract.cs')))?.[1] ?? '').matchAll(/"(--[a-z-]+)"/g)].map((match) => match[1]);
const scriptFlags = [...(/function Update-Arguments[\s\S]*?\n\}/.exec(lifecycle)?.[0] ?? '').matchAll(/'(--[a-z-]+)'/g)].map((match) => match[1]);
check(contractFlags.length === 6 && scriptFlags.length === 6, 'both the contract and the lifecycle script name six flags of the update mode', `${contractFlags} / ${scriptFlags}`);
check([...scriptFlags].sort().join() === [...contractFlags].sort().join(), 'and they are the same six: --quiet --update --install-dir --wait-pid --relaunch --result', `${contractFlags} / ${scriptFlags}`);

// ---- how the installer is started ----------------------------------------------------------------------------------------------------------------------------------------------------------
const applier = strip(read('native-shared/UpdateApplier.cs'));
const mainUpdate = strip(read('desktop-shell/MainWindow.Update.cs'));
check(/UseShellExecute\s*=\s*false/.test(applier) && !/UseShellExecute\s*=\s*true/.test(applier + mainUpdate), 'the installer is started without a shell');
check(/ArgumentList\.Add\(/.test(applier) && !/(?<![A-Za-z])Arguments\s*=/.test(applier + mainUpdate) && !/new ProcessStartInfo\([^)]*,/.test(applier + mainUpdate), 'with an argument list, never a command line made by joining text');
check(!/cmd(?:\.exe)?\b|powershell|pwsh|Process\.Start\(\s*"/i.test(applier + mainUpdate), 'and never through cmd or PowerShell');
// The window closes itself only when the installer is still running five seconds after it was started: one that has ended replaced nothing (it waits for this shell), so the window stays and says
// launch_failed; and the page is told `launched` only after that look. (The logic of the look is tested; the window that carries it out is WinForms, and is read here.)
const lookAt = mainUpdate.indexOf('UpdateApplier.WaitForInstaller(');
const exitedAt = mainUpdate.search(/if \(seen == InstallerSighting\.Exited\) throw new UpdateRefused\("launch_failed"/);
const launchedAt = mainUpdate.indexOf('ReplyToPage(requestId, true, "launched")');
const closeAt = mainUpdate.indexOf('Close();', launchedAt);
check(lookAt > 0 && exitedAt > lookAt && launchedAt > exitedAt && closeAt > launchedAt, 'the window looks at the installer, keeps itself open with launch_failed when it has ended, and only then tells the page `launched` and closes');
check(/WaitForInstaller\(\(\) => LookAtInstaller\(installerPid\), TimeSpan\.FromSeconds\(5\), TimeSpan\.FromMilliseconds\(100\), Task\.Delay\)/.test(mainUpdate), 'and gives it five seconds, looking every 100 ms');
// It is looked at through the Process that Start returned, which stays open for the look: an installer that dies early frees its id, and another program could be given it within the five seconds, so a look by
// id could take that program for the installer (and the window would close with nothing on the screen).
// (it is closed after the look and on both ways out of a refusal: three places)
const looksThroughTheHandle = (text) => /_installer\s*=\s*Process\.Start\(info\)/.test(text) && !/GetProcessById/.test(text) && !/using var installer\s*=\s*Process\.Start/.test(text) && (text.match(/_installer\?\.Dispose\(\)/g) ?? []).length === 3;
check(looksThroughTheHandle(mainUpdate), 'the installer is looked at through the Process object that started it (kept open for the look), never through its id');
check(!looksThroughTheHandle(mainUpdate.replace('_installer = Process.Start(info)', 'using var installer = Process.Start(info)')) && !looksThroughTheHandle(`${mainUpdate}\nProcess.GetProcessById(1);`), 'negative control: a look through the id, or a Process that is closed at once, is not accepted');
check(/return await Task\.Run\(\(\) => environment\.Start\(start\)\)/.test(applier) && /RequireReadableByInstaller\(start\);\s*beforeStart\(\);/.test(applier), 'the installer is started off the thread of the window, and the arguments are read the way the installer will read them BEFORE the call that stops the monitor of the Hub');
// The file is hashed through a handle that is held, so the program has to be started from where that handle says the file is, and not from the path that was walked to find it (a link above the folder of
// updates could be pointed somewhere else between the hash and the start). The native tests prove it with a junction; this keeps the two sources from drifting apart.
check(/new VerifiedUpdate\(version, folder, path, FinalPathOf\(stream\.SafeFileHandle\), kid, installer\.Bytes, stream\)/.test(staging) && /new ProcessStartInfo\(update\.StartPath\)/.test(applier) && !/new ProcessStartInfo\(update\.(?:InstallerPath|Folder)\b/.test(applier), 'the installer is started from the final path of the handle that holds the file that was hashed (VerifiedUpdate.StartPath), never from the path that was walked to find it');
check(!/new ProcessStartInfo\(update\.StartPath\)/.test(applier.replace('update.StartPath', 'update.InstallerPath')), 'negative control: a start from the path that was found is not accepted');

// ---- the system browser opens a link only for a person -------------------------------------------------------------------------------------------------------------------------------------------
// Script that runs in the page has no user gesture; a request that WebView2 does not call user-initiated must not start the browser of the person. (Proved with the real WebView2 by ui/e2e/webview2-smoke.mjs.)
const bridge = strip(read('native-shared/WebViewBridge.cs'));
const opensOnlyForAPerson = /if\s*\(\s*e\.IsUserInitiated\s*&&\s*OpenLink\.TryGetExternalLink\(\s*e\.Uri\s*,\s*out\s+var\s+external\s*\)\s*\)\s*\{\s*open\(\s*external\s*\)\s*;\s*return;\s*\}/;
check(opensOnlyForAPerson.test(bridge), 'the new-window handler hands a release page to the system browser only for a request that a person made (IsUserInitiated)');
check(!opensOnlyForAPerson.test(bridge.replace('e.IsUserInitiated && ', '')) && !opensOnlyForAPerson.test(bridge.replace('e.IsUserInitiated &&', 'e.IsUserInitiated ||')), 'negative control: the same condition without the gesture, or with an "or", is not accepted');

// ---- what the transaction puts on the disk before it changes a file is flushed to the disk ------------------------------------------------------------------------------------------------------
// The marker says "keep the backup" and the journal says which file was backed up where; after a power cut the marker can be there with a journal that is empty or zeros (and backups that are only numbered), a
// state nobody can recover from. So the staged files, the backups, the journal and the marker are each flushed to the disk (FileStream.Flush(true)) before the next thing is done. (The behaviour of a
// power cut cannot be tried by a test; the source is held to the shape.)
const transaction = strip(read('installer/InstallTransaction.cs'));
const flushes = (text) => (text.match(/\.Flush\(true\)/g) ?? []).length;
check(flushes(transaction) === 4 && !/File\.WriteAllText\(\s*Path\.Combine\(workspace,\s*"journal\.json"\)/.test(transaction) && /new FileStream\(\s*Path\.Combine\(workspace,\s*"journal\.json"\)/.test(transaction), 'the staged files, the backups, the journal and the marker are each flushed to the disk (four Flush(true)), and the journal is not written with File.WriteAllText');
check(flushes(transaction.replace('journal.Flush(true);', '')) === 3 && /File\.WriteAllText\(\s*Path\.Combine\(workspace,\s*"journal\.json"\)/.test(transaction.replace(/new FileStream\(\s*Path\.Combine\(workspace,\s*"journal\.json"\)[^;]*;/, 'File.WriteAllText(Path.Combine(workspace, "journal.json"), x);')), 'negative control: a journal that is not flushed, or is written with WriteAllText, is not accepted');

// ---- every reason an update can end with is carried by some step --------------------------------------------------------------------------------------------------------------------------
// A code of the closed list (StepCode.Known, which the Hub's list and the page's list repeat) that no step of the installer ever carries is a reason the window and the page have words for and nobody ever
// sees: window_open and payload_invalid were that, until the steps that refuse for them were tagged. A code has a producer when its text stands in a source of the installer or of native-shared other than the
// list itself and the words (UpdateWords.cs).
const sourcesWithProducers = [...fs.readdirSync(path.join(repo, 'installer')).filter((name) => name.endsWith('.cs')).map((name) => `installer/${name}`), ...fs.readdirSync(path.join(repo, 'native-shared')).filter((name) => name.endsWith('.cs')).map((name) => `native-shared/${name}`)]
  .filter((file) => file !== 'installer/UpdateWords.cs')
  .map((file) => strip(read(file)).replace(/internal static readonly IReadOnlySet<string> Known = new HashSet<string>\(StringComparer\.Ordinal\)\s*\{[\s\S]*?\};/, ''));
const producerCount = (code, sources) => sources.filter((text) => text.includes(`"${code}"`)).length;
const reasonCodes = [...(/internal static readonly IReadOnlySet<string> Known = new HashSet<string>\(StringComparer\.Ordinal\)\s*\{([\s\S]*?)\};/.exec(strip(read('native-shared/HubLifecycle.cs')))?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
check(reasonCodes.length === 12 && new Set(reasonCodes).size === 12, 'the closed list of reasons has 12 codes', reasonCodes.join());
for (const code of reasonCodes) check(producerCount(code, sourcesWithProducers) >= 1, `the reason ${code} is carried by a step of the installer (not only listed and worded)`);
check(producerCount('a_reason_nobody_carries', sourcesWithProducers) === 0 && producerCount('window_open', [strip(read('installer/UpdateWords.cs'))]) === 1, 'negative control: a code that stands nowhere has no producer, and the words alone are not one');

// ---- the mutations of the native code (scripts/tests/native-lifecycle/mutations.json, run by run-mutations.mjs): a pattern that no longer occurs exactly once in its file tests nothing, silently
const staleOnes = (list, source) => {
  const problems = [];
  const names = new Set();
  for (const mutation of list.mutations) {
    if (names.has(mutation.name)) problems.push(`${mutation.name}: the name is used twice`);
    names.add(mutation.name);
    for (const patch of mutation.patches) {
      const text = source(patch.file);
      if (text === null) { problems.push(`${mutation.name}: ${patch.file} does not exist`); continue; }
      const occurrences = text.split(patch.old).length - 1;
      if (occurrences !== 1) problems.push(`${mutation.name}: the pattern occurs ${occurrences} times in ${patch.file}, it must occur exactly once`);
    }
  }
  return problems;
};
const sourceOf = (file) => (fs.existsSync(path.join(repo, file)) ? read(file) : null);
const mutationList = JSON.parse(read('scripts/tests/native-lifecycle/mutations.json'));
check(Array.isArray(mutationList.mutations) && mutationList.mutations.length >= 200, `the list of mutations of the native code is there (${mutationList.mutations.length} of them)`);
// In the copy that run-mutations.mjs breaks on purpose, one pattern is gone by design: the list is not read against it there.
if (process.env.CHATMCP_NATIVE_MUTATION_COPY === '1') console.log('NOTE: this is a copy with a mutation in it: the patterns of the list are not compared with its files');
else check(staleOnes(mutationList, sourceOf).length === 0, 'every pattern of every mutation still occurs exactly once in its file', staleOnes(mutationList, sourceOf).slice(0, 3).join('; '));
check(staleOnes({ mutations: [{ name: 'x', patches: [{ file: 'native-shared/OpenLink.cs', old: 'a text that the file does not hold', new: '' }] }] }, sourceOf).length === 1, 'negative control: a pattern that is not in the file is reported');
check(staleOnes({ mutations: [{ name: 'x', patches: [{ file: 'native-shared/OpenLink.cs', old: 'internal', new: '' }] }] }, sourceOf).length === 1, 'and so is one that is in it more than once');
check(staleOnes({ mutations: [{ name: 'x', patches: [{ file: 'native-shared/NoSuchFile.cs', old: 'x', new: '' }] }] }, sourceOf).length === 1, 'and a file that is not there');
check(staleOnes({ mutations: [{ name: 'x', patches: [] }, { name: 'x', patches: [] }] }, sourceOf).length === 1, 'and a name used twice');

console.log(`verify-update-apply: ${checks} checks PASS`);
