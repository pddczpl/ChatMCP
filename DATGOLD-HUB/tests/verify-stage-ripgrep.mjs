// The installer stages ripgrep from a pinned official release (scripts/intelligence-runtime/stage-ripgrep.ps1, multi-agent-tools-19). Nothing is downloaded here: the checks
//   1. read the script: the URL, the version and the SHA-256 it pins agree with each other, nothing evaluates downloaded text, and the staging, the manifest check and the
//      Hub's resolver agree on where rg.exe goes;
//   2. run its functions in PowerShell on archives made for the test: the files it takes, the layouts it accepts (a folder of its own, or flat), and everything it must refuse
//      (a path that leaves the folder, a link, two copies of rg.exe, a missing or false license text, rg.exe too deep in the archive);
//   3. run the script itself on a supplied archive (CHATMCP_RIPGREP_ARCHIVE): an archive with another hash is refused before anything is extracted, and an existing destination
//      is refused;
//   4. check a staged binary: one that does not report the pinned version is refused (and the real ripgrep is accepted when this machine has one);
//   5. the acceptance script of the bundled runtime (scripts/intelligence-runtime/test-runtime.mjs), which the installer build runs on the staged files and which only a Windows build can
//      execute, at least parses: a SyntaxError in it stops the build.
// The download itself and the real release archive are not exercised: that is the installer build's job, and it checks the same hash.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ripgrep, bundledRipgrepPath } from '../lib/ripgrep.mjs';
import { powerShellChildEnvironment } from './support/powershell-environment.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const scriptPath = path.join(repo, 'scripts', 'intelligence-runtime', 'stage-ripgrep.ps1');
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

if (!await fs.stat(scriptPath).catch(() => null)) {
  console.log('CHATMCP_TEST_SKIP: scripts/intelligence-runtime/stage-ripgrep.ps1 was not found next to DATGOLD-HUB (the staging checks need the whole repository)');
  process.exit(0);
}
const script = (await fs.readFile(scriptPath, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

// ------------------------------------------------------------------------------------------------------------------------------- 5. the acceptance script of the bundled runtime parses
{
  const acceptance = path.join(repo, 'scripts', 'intelligence-runtime', 'test-runtime.mjs');
  const parsed = spawnSync(process.execPath, ['--check', acceptance], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(parsed.status, 0, `test-runtime.mjs does not parse: ${parsed.stderr}`);
  const text = (await fs.readFile(acceptance, 'utf8')).replace(/\r\n/g, '\n');
  assert.match(text, /stage-ripgrep\.ps1/, 'it reads the version that the staging script pins');
  assert.match(text, /new Ripgrep\(\{ hubDirectory: hubRoot/, 'and asks the Hub\'s own class for the binary in the installed layout');
  ok('the acceptance script of the bundled runtime parses and checks the staged ripgrep through the Hub\'s own class');
}

// ------------------------------------------------------------------------------------------------------------------------------- 1. what the script pins
{
  const url = script.match(/^\$source = '([^']+)'$/m)?.[1];
  const sha = script.match(/^\$expected = '([0-9a-f]{64})'$/m)?.[1];
  const version = script.match(/^\$expectedVersion = '(\d+\.\d+\.\d+)'$/m)?.[1];
  assert.ok(url && sha && version, 'the script pins a URL, a SHA-256 and a version');
  assert.equal(url, `https://github.com/BurntSushi/ripgrep/releases/download/${version}/ripgrep-${version}-x86_64-pc-windows-msvc.zip`, 'the URL is the official release of the pinned version, and nothing else');
  assert.ok(!/Invoke-Expression|\biex\b|Start-Process|DownloadString|-EncodedCommand/i.test(script), 'nothing downloaded is evaluated or started other than the check of rg.exe itself');
  assert.ok(/^[\x00-\x7f]*$/.test(script), 'the script is ASCII only (Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page)');
  assert.match(script, /\$env:CHATMCP_RIPGREP_ARCHIVE/, 'an approved offline build may supply the archive');
  assert.match(script, /\$actual -ne \$expected\) \{ throw 'ripgrep archive SHA-256 mismatch/, 'a different hash stops the build before anything is extracted');
  assert.ok(script.indexOf('SHA-256 mismatch') < script.indexOf('Expand-RipgrepArchive -ArchivePath'), 'the hash is checked first');
  assert.match(script, /\$required = @\('rg\.exe', 'LICENSE-MIT', 'UNLICENSE'\)/, 'rg.exe and both license texts are required');
  assert.match(script, /Permission is hereby granted, free of charge/);
  assert.match(script, /free and unencumbered software released into the public domain/);
  assert.match(script, /\$InvocationName -ne '\.'|\$MyInvocation\.InvocationName -ne '\.'/, 'dot-sourcing the file defines the functions and runs nothing');
  // the staging, the manifest check and the Hub's resolver agree on the place
  const stage = (await fs.readFile(path.join(repo, 'scripts', 'intelligence-runtime', 'stage.mjs'), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(stage, /path\.join\(destination, 'runtimes', 'ripgrep'\)/);
  assert.match(stage, /stage-ripgrep\.ps1/);
  assert.match(stage, /recordStaged\(ripgrepOutput, 'runtimes\/ripgrep'\)/, 'every staged file is in the manifest with its hash');
  const verify = await fs.readFile(path.join(repo, 'scripts', 'intelligence-runtime', 'verify.mjs'), 'utf8');
  assert.match(verify, /'runtimes\/ripgrep\/rg\.exe'/, 'the installed payload is refused without rg.exe');
  assert.equal(bundledRipgrepPath('HUB', 'win32').replaceAll('\\', '/').endsWith('HUB/runtimes/ripgrep/rg.exe'), true, 'the Hub looks where the installer puts it');
  const runtimeTest = await fs.readFile(path.join(repo, 'scripts', 'intelligence-runtime', 'test-runtime.mjs'), 'utf8');
  assert.match(runtimeTest, /bundled ripgrep/, 'the installer build runs the bundled ripgrep once');
  const builder = await fs.readFile(path.join(repo, 'scripts', 'Build-Installer.ps1'), 'utf8');
  assert.match(builder, /Copy-Item -Path \(Join-Path \$intelligenceStage 'runtimes\\\*'\)/, 'whatever is staged under runtimes (ripgrep too) is copied into the payload');
  ok(`the script pins ripgrep ${version} to its official URL and a SHA-256, checks the hash before extracting, evaluates nothing and agrees with stage.mjs, verify.mjs and the Hub on where rg.exe goes`);
}

// ------------------------------------------------------------------------------------------------------------------------------- 2-4. the functions, in PowerShell
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const probe = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', windowsHide: true, env: powerShellChildEnvironment() });
if (probe.error || probe.status !== 0) {
  console.log(`  skip - ${powershell} is not available: the PowerShell checks were not run`);
} else {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-stage-rg-'));
  try {
    const MIT = `The MIT License (MIT)\n\nCopyright (c) 2015 Andrew Gallant\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software.\n`;
    const UNLICENSE = `This is free and unencumbered software released into the public domain.\n\nAnyone is free to copy, modify, publish, use, compile, sell, or\ndistribute this software, either in source code form or as a compiled\nbinary, for any purpose, commercial or non-commercial, and by any means.\n`;
    const top = 'ripgrep-15.2.0-x86_64-pc-windows-msvc';
    const full = [
      { name: `${top}/rg.exe`, text: 'MZ fake binary' }, { name: `${top}/COPYING`, text: 'Both licenses apply.\n' }, { name: `${top}/LICENSE-MIT`, text: MIT }, { name: `${top}/UNLICENSE`, text: UNLICENSE },
      { name: `${top}/README.md`, text: '# ripgrep\n' }, { name: `${top}/CHANGELOG.md`, text: 'x\n' }, { name: `${top}/doc/rg.1`, text: 'man\n' }, { name: `${top}/complete/_rg.ps1`, text: 'completion\n' },
      { name: `${top}/doc/`, text: '' },
    ];
    const without = (list, leaf) => list.filter((entry) => !entry.name.endsWith(`/${leaf}`) && entry.name !== leaf);
    const flat = full.filter((entry) => entry.name.split('/').length === 2 && !entry.name.endsWith('/')).map((entry) => ({ ...entry, name: entry.name.split('/')[1] }));
    let counter = 0;

    /** Runs PowerShell code with the script dot-sourced; returns { status, stdout, stderr }. The child gets the module path of the machine (see tests/support/powershell-environment.mjs). */
    const run = (code, env = {}) => {
      counter += 1;
      const driver = path.join(folder, `driver-${counter}.ps1`);
      return fs.writeFile(driver, `$ErrorActionPreference = 'Stop'\n. '${scriptPath.replaceAll("'", "''")}'\n${code}\n`).then(() => {
        const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver], { encoding: 'utf8', windowsHide: true, env: powerShellChildEnvironment(env), timeout: 120_000 });
        return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
      });
    };
    const zipCode = (entries, zipPath) => `
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$spec = ConvertFrom-Json '${JSON.stringify(entries).replaceAll("'", "''")}'
$stream = [IO.File]::Create('${zipPath.replaceAll("'", "''")}')
$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
foreach ($item in $spec) {
  $entry = $archive.CreateEntry($item.name)
  if ($item.PSObject.Properties.Name -contains 'symlink' -and $item.symlink) { $entry.ExternalAttributes = -1577123840 }
  if (-not $item.name.EndsWith('/')) { $writer = New-Object IO.StreamWriter($entry.Open()); $writer.Write($item.text); $writer.Dispose() }
}
$archive.Dispose(); $stream.Dispose()`;
    const expand = async (entries, label) => {
      const zip = path.join(folder, `${label}.zip`);
      const target = path.join(folder, `out-${label}`);
      const answer = await run(`${zipCode(entries, zip)}\nExpand-RipgrepArchive -ArchivePath '${zip}' -Target '${target}'\n'done'`);
      const taken = await fs.readdir(target).catch(() => null);
      return { ...answer, taken: taken?.sort() ?? null, target, zip };
    };

    // a folder of its own, or flat: only the four files, nothing else
    const nested = await expand(full, 'nested');
    assert.equal(nested.status, 0, `${nested.stderr}${nested.stdout}`);
    assert.deepEqual(nested.taken, ['COPYING', 'LICENSE-MIT', 'UNLICENSE', 'rg.exe'], 'the binary and the license texts, not the docs, the changelog or the completions');
    assert.equal((await fs.readFile(path.join(nested.target, 'rg.exe'), 'utf8')), 'MZ fake binary');
    const flatRun = await expand(flat, 'flat');
    assert.equal(flatRun.status, 0, `${flatRun.stderr}${flatRun.stdout}`);
    assert.deepEqual(flatRun.taken, ['COPYING', 'LICENSE-MIT', 'UNLICENSE', 'rg.exe']);
    const noCopying = await expand(without(full, 'COPYING'), 'no-copying');
    assert.equal(noCopying.status, 0, 'COPYING is optional: LICENSE-MIT and UNLICENSE are the two texts');
    assert.deepEqual(noCopying.taken, ['LICENSE-MIT', 'UNLICENSE', 'rg.exe']);
    ok('a folder of its own or a flat archive gives rg.exe, LICENSE-MIT, UNLICENSE and COPYING; documentation, changelog and completions are left in the archive');

    // what is refused
    const refused = async (entries, label, message) => {
      const result = await expand(entries, label);
      assert.notEqual(result.status, 0, `${label} must be refused`);
      assert.match(`${result.stderr}${result.stdout}`, message, label);
      assert.equal(result.taken, null, `${label}: nothing is extracted`);
    };
    await refused(without(full, 'UNLICENSE'), 'no-unlicense', /Missing ripgrep component: UNLICENSE/);
    await refused(without(full, 'LICENSE-MIT'), 'no-mit', /Missing ripgrep component: LICENSE-MIT/);
    await refused(without(full, 'rg.exe'), 'no-binary', /Missing ripgrep component: rg\.exe/);
    await refused([...without(full, 'rg.exe'), { name: `${top}/bin/deep/rg.exe`, text: 'x' }], 'too-deep', /Missing ripgrep component: rg\.exe/);
    await refused([...full, { name: 'other-folder/rg.exe', text: 'decoy' }], 'two-binaries', /more than one rg\.exe/);
    await refused([...full, { name: '../evil.txt', text: 'x' }], 'traversal', /Unexpected archive path/);
    await refused([...full, { name: `${top}/../../evil.txt`, text: 'x' }], 'traversal-inside', /Unexpected archive path/);
    await refused([...full, { name: '/etc/evil.txt', text: 'x' }], 'rooted', /Unexpected archive path/);
    await refused([...full, { name: 'C:/evil.txt', text: 'x' }], 'drive', /Unexpected archive path/);
    await refused([...full, { name: `${top}/link`, text: 'rg.exe', symlink: true }], 'symlink', /symbolic link/);
    await refused(full.map((entry) => (entry.name.endsWith('/LICENSE-MIT') ? { ...entry, text: 'All rights reserved. '.repeat(30) } : entry)), 'false-mit', /not the MIT licence text/);
    await refused(full.map((entry) => (entry.name.endsWith('/LICENSE-MIT') ? { ...entry, text: '' } : entry)), 'empty-mit', /not the MIT licence text/);
    await refused(full.map((entry) => (entry.name.endsWith('/UNLICENSE') ? { ...entry, text: 'Do what you want. '.repeat(30) } : entry)), 'false-unlicense', /not the Unlicense text/);
    await refused(full.map((entry) => (entry.name.endsWith('/LICENSE-MIT') ? { ...entry, text: 'Permission is hereby granted, free of charge' } : entry)), 'short-mit', /not the MIT licence text/);
    await refused(full.map((entry) => (entry.name.endsWith('/UNLICENSE') ? { ...entry, text: 'free and unencumbered software released into the public domain' } : entry)), 'short-unlicense', /not the Unlicense text/);
    ok('refused: a missing binary or license text, a binary too deep to be the one, two binaries, a path that leaves the folder, is rooted or names a drive, a link, a license text that is empty or is not the license');

    // the script itself, on a supplied archive
    const suppliedZip = path.join(folder, 'supplied.zip');
    const makeSupplied = await run(zipCode(full, suppliedZip));
    assert.equal(makeSupplied.status, 0, makeSupplied.stderr);
    const target = path.join(folder, 'stage-target');
    const mismatch = await run(`& '${scriptPath}' -Destination '${target}'`, { CHATMCP_RIPGREP_ARCHIVE: suppliedZip });
    assert.notEqual(mismatch.status, 0);
    assert.match(`${mismatch.stderr}${mismatch.stdout}`, /SHA-256 mismatch; refusing to package/, 'an archive with another hash is refused');
    assert.equal(await fs.stat(target).catch(() => null), null, 'and nothing is extracted');
    const missingSupplied = await run(`& '${scriptPath}' -Destination '${target}'`, { CHATMCP_RIPGREP_ARCHIVE: path.join(folder, 'nowhere.zip') });
    assert.match(`${missingSupplied.stderr}${missingSupplied.stdout}`, /Supplied ripgrep archive does not exist/);
    const existing = path.join(folder, 'already-there');
    await fs.mkdir(existing);
    const exists = await run(`& '${scriptPath}' -Destination '${existing}'`, { CHATMCP_RIPGREP_ARCHIVE: suppliedZip });
    assert.match(`${exists.stderr}${exists.stdout}`, /must be absent before download/, 'a destination that exists is refused (never merged with stale files)');
    const none = await run(`& '${scriptPath}'`);
    assert.match(`${none.stderr}${none.stdout}`, /-Destination folder is required/);
    ok('the script refuses an archive with another hash before extracting, a missing supplied archive, an existing destination and a missing -Destination');

    // the binary
    const notRipgrep = await run(`Test-RipgrepBinary -Executable '${process.execPath.replaceAll("'", "''")}' -Version '15.2.0'`);
    assert.notEqual(notRipgrep.status, 0);
    assert.match(`${notRipgrep.stderr}${notRipgrep.stdout}`, /does not report ripgrep 15\.2\.0/, 'a program that is not the pinned ripgrep is refused');
    if (process.platform === 'win32') {
      // a program that prints what ripgrep prints, to tell the exact version from a near one
      const fake = (line) => fs.writeFile(path.join(folder, 'fake-rg.cmd'), `@echo off\r\necho ${line}\r\n`).then(() => path.join(folder, 'fake-rg.cmd'));
      const accepts = async (line, version) => (await run(`Test-RipgrepBinary -Executable '${await fake(line)}' -Version '${version}'`)).status === 0;
      assert.equal(await accepts('ripgrep 15.2.0 (rev 0123456789)', '15.2.0'), true, 'the pinned version is accepted');
      assert.equal(await accepts('ripgrep 15.2.0', '15.2.0'), true, 'with or without the revision');
      assert.equal(await accepts('ripgrep 15.2.1 (rev 0123456789)', '15.2.0'), false, 'another patch version is refused');
      assert.equal(await accepts('ripgrep 15.2.0 (rev 0123456789)', '15.2'), false, 'a prefix of the version is not the version');
      assert.equal(await accepts('ripgrep 15.2.01', '15.2.0'), false, 'nor is a longer number');
      assert.equal(await accepts('not ripgrep 15.2.0', '15.2.0'), false, 'the program must say ripgrep first');
    }
    const real = new Ripgrep();
    const info = await real.info();
    if (info) {
      const accepted = await run(`Test-RipgrepBinary -Executable '${info.path.replaceAll("'", "''")}' -Version '${info.version}'`);
      assert.equal(accepted.status, 0, `${accepted.stderr}${accepted.stdout}`);
      assert.match(accepted.stdout, /ripgrep verified: ripgrep /);
      const wrongVersion = await run(`Test-RipgrepBinary -Executable '${info.path.replaceAll("'", "''")}' -Version '0.0.1'`);
      assert.notEqual(wrongVersion.status, 0, 'the version must be the pinned one');
      ok(`a staged binary must report the pinned version (checked against the real ripgrep ${info.version} of this machine, and refused for another version)`);
    } else {
      console.log(`  skip - no ripgrep on this machine (${real.problem}): the acceptance of a real binary was not run`);
      ok('a program that is not the pinned ripgrep is refused');
    }
  } finally {
    await fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
}

console.log(`\nPASS: ${checks} ripgrep staging checks`);
