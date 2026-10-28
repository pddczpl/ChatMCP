// Real Windows Sandbox Guest Isolation, Security Hardening, and Feasibility Suite (Phase 1, PR 2)
//
// Strictly requires real Windows 11 host with Windows Sandbox and wsb CLI.
// Launches an owned, hardened Windows Sandbox instance, executes GuestSupervisor
// inside the guest, collects and verifies authenticated cryptographic execution receipts,
// and enforces real negative isolation boundaries (canary, filesystem, network).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import {
  probeWindowsSandboxPreflight,
} from '../../lib/windows-sandbox-probe.mjs';
import {
  createSandboxConfiguration,
} from '../../lib/windows-sandbox-config.mjs';
import { probeOwnedSandboxCliStdout } from '../../lib/windows-sandbox-cli-channel-probe.mjs';
import { probeOwnedFramedExitCodes } from '../../lib/windows-sandbox-exitcode-channel.mjs';
import {
  prepareExecutionRequest,
  readAndVerifyExecutionReceipt,
} from '../../lib/windows-sandbox-transport.mjs';

let checks = 0;
const ok = (label) => {
  checks += 1;
  console.log(`  ok - ${label}`);
};

const DANGEROUS_ADMIN_PRIVILEGES = new Set([
  'sedebugprivilege',
  'setcbprivilege',
  'seloaddriverprivilege',
  'sebackupprivilege',
  'serestoreprivilege',
  'setakeownershipprivilege',
  'seassignprimarytokenprivilege',
  'seimpersonateprivilege',
  'secreatetokenprivilege',
  'sesecurityprivilege',
  'sesystemenvironmentprivilege',
]);

/**
 * Parses whoami /priv table output by column, strictly validating that no dangerous
 * administrative privilege is in the Enabled state.
 */
export function parseAndVerifyChildPrivileges(stdout) {
  if (typeof stdout !== 'string') {
    throw new Error('whoami /priv stdout must be a string');
  }

  const lines = stdout.split(/\r?\n/);
  const parsedPrivs = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('===') || trimmed.startsWith('---') || trimmed.startsWith('Privilege Name')) {
      continue;
    }
    // Match line: PrivilegeName   Description   State
    const match = /^(Se[A-Za-z0-9_]+)\s+(.+?)\s+(Enabled|Disabled)\s*$/i.exec(trimmed);
    if (match) {
      parsedPrivs.push({
        name: match[1],
        description: match[2].trim(),
        state: match[3].toLowerCase(),
      });
    }
  }

  const enabledDangerous = parsedPrivs.filter(
    (p) => DANGEROUS_ADMIN_PRIVILEGES.has(p.name.toLowerCase()) && p.state === 'enabled'
  );

  if (enabledDangerous.length > 0) {
    throw new Error(
      `Child token security violation: Dangerous administrative privilege(s) ENABLED: ${enabledDangerous.map((p) => p.name).join(', ')}`
    );
  }

  return { verified: true, parsedCount: parsedPrivs.length };
}

/**
 * Parses whoami /groups table output, ensuring Administrators group is deny-only if present.
 */
export function parseAndVerifyChildGroups(stdout) {
  if (typeof stdout !== 'string') {
    throw new Error('whoami /groups stdout must be a string');
  }
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (/administrators|s-1-5-32-544/i.test(line)) {
      if (!/deny\s*only/i.test(line)) {
        throw new Error(`Child token security violation: Administrators group is not Deny-Only: ${line}`);
      }
    }
  }
  return { verified: true };
}

let journalPath = null;
let ownedSandboxId = null;
let activeWsbCli = null;

const watchdogTimer = setTimeout(() => {
  console.error('FAIL: real-guest test suite exceeded time budget (180s)');
  if (journalPath && fs.existsSync(journalPath)) {
    try {
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      if (journal.status === 'running' && journal.sandboxId && journal.wsbCli) {
        console.error(`Emergency watchdog stopping owned sandbox ${journal.sandboxId}...`);
        execFileSync(journal.wsbCli, ['stop', '--id', journal.sandboxId, '--raw'], { encoding: 'utf8', timeout: 15_000 });
        journal.status = 'terminated_by_watchdog';
        fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), 'utf8');
      }
    } catch (e) {
      console.error('Emergency stop error:', e.message);
    }
  }
  process.exit(2);
}, 180_000);
watchdogTimer.unref();

function updateJournal(status, extra = {}) {
  if (!journalPath) return;
  try {
    const data = {
      status,
      sandboxId: ownedSandboxId,
      wsbCli: activeWsbCli,
      updatedAt: new Date().toISOString(),
      ...extra,
    };
    fs.writeFileSync(journalPath, JSON.stringify(data, null, 2), 'utf8');
  } catch {}
}

export async function runRealGuestTests() {
  let publisherKeyGate='NOT_VERIFIED';
  let childUserSidGate='NOT_VERIFIED';
  console.log('=== CHATMCP PHASE 1: REAL WINDOWS SANDBOX GUEST VALIDATION ===\n');

  // [A] Host Preflight & Ownership Initialization
  console.log('--- [A] Host Preflight & Ownership Initialization ---');

  // Regression test first (Section 4): Deliberately dangerous fixture MUST fail validation
  assert.throws(
    () => parseAndVerifyChildPrivileges('SeDebugPrivilege       Debug programs       Enabled'),
    /Dangerous administrative privilege.*SeDebugPrivilege/i,
    'Regression test failed: validator must reject SeDebugPrivilege Enabled'
  );
  ok('[A] Child token privilege validator regression test passed: dangerous Enabled fixture correctly rejected');

  const preflight = await probeWindowsSandboxPreflight();
  assert.equal(preflight.supported, true, 'Host must support Windows Sandbox');
  assert.equal(preflight.available, true, 'Windows Sandbox must be available on this host');
  assert.ok(preflight.details.cliPath, 'wsb CLI path must be resolved');
  assert.equal(preflight.details.featureState, 'Enabled', 'Feature must be Enabled');
  assert.equal(preflight.blockers.length, 0, 'No preflight blockers permitted for real guest test');
  ok(`[A] Preflight passed: Windows 11 ${preflight.details.osArch} build ${preflight.details.osBuild}, CLI: ${preflight.details.cliPath}`);

  const wsbCli = preflight.details.cliPath;
  activeWsbCli = wsbCli;

  const listBefore = JSON.parse(execFileSync(wsbCli, ['list', '--raw'], { encoding: 'utf8' }));
  const existingEnvs = listBefore.WindowsSandboxEnvironments || [];
  if (existingEnvs.length > 0) {
    throw new Error(`Another Windows Sandbox instance is already running (${existingEnvs.map((e) => e.Id).join(', ')}). Aborting.`);
  }
  ok('[A] Clean concurrency verified: no active sandbox instances present');

  const runId = 'real-guest-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const ownershipGeneration=crypto.randomUUID();
  const baseDir = path.join(os.tmpdir(), `chatmcp-sandbox-${runId}`);
  journalPath = path.join(baseDir, 'ownership-journal.json');
  const inputDir = path.join(baseDir, 'input');
  const outputDir = path.join(baseDir, 'output');
  const canaryDir = path.join(baseDir, 'canary');

  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(canaryDir, { recursive: true });

  updateJournal('initializing', { baseDir, generation:ownershipGeneration });

  // Create host canary outside mapped folders
  const canarySecret = `CHATMCP_CANARY_SECRET_${crypto.randomBytes(16).toString('hex')}`;
  const canaryPath = path.join(canaryDir, 'host-canary.txt');
  fs.writeFileSync(canaryPath, canarySecret, 'utf8');

  // Copy published self-contained GuestSupervisor.exe to input folder
  const supervisorSource = path.resolve('DATGOLD-HUB/windows/sandbox/GuestSupervisor/publish/win-x64/GuestSupervisor.exe');
  assert.ok(fs.existsSync(supervisorSource), 'GuestSupervisor.exe must be published before real test');
  const supervisorDest = path.join(inputDir, 'GuestSupervisor.exe');
  fs.copyFileSync(supervisorSource, supervisorDest);

  const supervisorHash = crypto.createHash('sha256').update(fs.readFileSync(supervisorDest)).digest('hex');
  ok(`[A] Staged GuestSupervisor.exe in read-only input (SHA-256: ${supervisorHash.slice(0, 16)}...)`);
  ok(`[A] Staged host canary outside mappings at ${canaryPath}`);

  const wsbXml = createSandboxConfiguration({
    inputDirectory: inputDir,
    exportDirectory: outputDir,
    memoryMb: 4096,
    protectedClient: true,
  });
  assert.ok(wsbXml.includes('<Networking>Disable</Networking>'));
  assert.ok(wsbXml.includes('<ProtectedClient>Enable</ProtectedClient>'));
  ok('[A] Hardened .wsb isolation configuration generated');

  try {
    // [B] Guest Lifecycle & CLI Smoke
    console.log('\n--- [B] Guest Lifecycle & CLI Smoke ---');
    updateJournal('starting');
    const startOutputRaw = execFileSync(
      wsbCli,
      ['start', '-c', wsbXml, '--raw'],
      { encoding: 'utf8', timeout: 30_000 }
    );
    const startOutput = JSON.parse(startOutputRaw);
    ownedSandboxId = startOutput.Id;
    assert.ok(ownedSandboxId, 'Sandbox start must return valid Id');
    assert.match(ownedSandboxId, /^[0-9a-fA-F-]{36}$/, 'Sandbox ID must be UUID');

    updateJournal('running', { sandboxId: ownedSandboxId, generation:ownershipGeneration });

    const listDuring = JSON.parse(execFileSync(wsbCli, ['list', '--raw'], { encoding: 'utf8' }));
    const runningIds = (listDuring.WindowsSandboxEnvironments || []).map((e) => e.Id);
    assert.ok(runningIds.includes(ownedSandboxId), `Running list must contain owned Sandbox ID ${ownedSandboxId}`);
    ok(`[B] Owned Windows Sandbox launched and journaled (ID: ${ownedSandboxId})`);

    const smoke1Raw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', 'cmd.exe /c echo CHATMCP_GUEST_ONLINE', '--raw'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const smoke1 = JSON.parse(smoke1Raw);
    assert.equal(smoke1.ExitCode, 0);
    ok('[B] Guest built-in command executed successfully (exit code 0)');

    const smoke2Raw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', 'cmd.exe /c exit 13', '--raw'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const smoke2 = JSON.parse(smoke2Raw);
    assert.equal(smoke2.ExitCode, 13);
    ok('[B] Guest non-zero exit code propagated faithfully (exit code 13)');
    // G4 experimental CLI response feasibility; no secret is sent.
    // The owned UUID/generation is from this exact diagnostic's start journal.
    const channel=await probeOwnedSandboxCliStdout({
      owned:{instanceId:ownedSandboxId,generation:ownershipGeneration},
      runCli:async args=>execFileSync(wsbCli,args,{
        encoding:'utf8',timeout:15000,maxBuffer:128*1024,
      }),
    });
    console.log('[G4] Owned wsb exec --raw stdout channel: '+channel.status+
      '; stdoutField='+channel.hasStdout+'; exit0='+channel.exitCodeObserved+
      '; fields='+JSON.stringify(channel.reportedFields)+
      '; publisherAuthenticated=FALSE');
    if(channel.status==='CLI_PROCESS_STDOUT_OBSERVED') {
      console.warn('[G4] Fixed public guest echo observed via CLI; authenticity of a pinned SUPERVISOR process is NOT established.');
    } else {
      console.warn('[G4] CLI direct stdout channel unavailable or unproven; do not enable authenticated publication.');
    }


    // Optional independent native feasibility observation: Windows Sandbox
    // may or may not round-trip high positive process ExitCodes. No secret,
    // model, project script or extra Sandbox is involved.
    //
    // To run from PowerShell:
    //   $env:CHATMCP_PROBE_FRAMED_EXITS='1'
    //   node DATGOLD-HUB/tests/windows-sandbox/real-guest.mjs
    //   Remove-Item Env:CHATMCP_PROBE_FRAMED_EXITS
    //
    // This NEVER clears G4, including when both high values round-trip.
    if(process.env.CHATMCP_PROBE_FRAMED_EXITS==='1'){
      const ranged=await probeOwnedFramedExitCodes({
        owned:{instanceId:ownedSandboxId,generation:ownershipGeneration},
        runCli:async args=>execFileSync(wsbCli,args,{
          encoding:'utf8',timeout:15000,maxBuffer:128*1024,
        }),
      });
      console.log('[G4] Native framed ExitCode range: '+ranged.status+
        '; matching='+ranged.observedMatches+'/'+ranged.expectedProbes+
        '; publisherAuthenticated=FALSE');
      if(ranged.status!=='CLI_FRAMED_EXIT_RANGE_OBSERVED')
        console.warn('[G4] This CLI cannot presently carry framed exit-code digest words; candidate is blocked.');
      else
        console.warn('[G4] Exit-code framing is feasible; pinned supervisor origin/private guest seal is STILL unverified.');
    }

    // [C] Restricted Token & Native Containment
    console.log('\n--- [C] Restricted Token & Native Containment ---');

    // Conflicting flags rejection inside sandbox
    const contradictoryRaw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', 'C:\\ChatMCP\\Input\\GuestSupervisor.exe --host-fixture --guest-fixture', '--raw'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const contradictoryExec = JSON.parse(contradictoryRaw);
    assert.equal(contradictoryExec.ExitCode, 3);
    ok('[C] GuestSupervisor in Sandbox rejected conflicting flags (--host-fixture + --guest-fixture) with exit code 3');

    function clearReceipts(dir) {
      for (const name of ['receipt.json', 'receipt.sha256', 'receipt.sig']) {
        try { fs.rmSync(path.join(dir, name), { force: true }); } catch {}
      }
    }

    function writeAuthKeyFile(dir, key, keyName = '.auth_key') {
      clearReceipts(dir);
      const filePath = path.join(dir, keyName);
      const fd = fs.openSync(filePath, 'w', 0o600);
      try {
        fs.writeFileSync(fd, key);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return keyName;
    }

    // Prepare execution request with cryptographic authKey
    const req1 = await prepareExecutionRequest({
      inputDirectory: inputDir,
      runId: 'exec-priv-' + crypto.randomBytes(4).toString('hex'),
      command: 'cmd.exe',
      args: ['/c', 'echo HELLO_RESTRICTED && whoami && echo ---USER--- && whoami /user && echo ---PRIV--- && whoami /priv && echo ---GROUPS--- && whoami /groups'],
      timeoutSeconds: 20,
      maxOutputBytes: 40960,
    });

    const keyFile1 = writeAuthKeyFile(outputDir, req1.authKey, `.auth_key_${req1.runId}`);
    const supExecRaw = execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', `C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output --auth-key-file C:\\ChatMCP\\Output\\${keyFile1}`,
        '--raw'
      ],
      { encoding: 'utf8', timeout: 25_000 }
    );
    const supExec = JSON.parse(supExecRaw);
    assert.equal(supExec.ExitCode, 0, 'GuestSupervisor execution must exit 0');

    // Verify receipt with publisher authentication
    const receipt1 = await readAndVerifyExecutionReceipt({
      exportDirectory: outputDir,
      expectedRunId: req1.runId,
      expectedNonce: req1.nonce,
      expectedAuthKey: req1.authKey,
      backend: 'windows-sandbox',
    });

    assert.equal(receipt1.status, 'completed');
    assert.equal(receipt1.exitCode, 0);
    assert.equal(receipt1.publisherAuthenticated, true);
    assert.equal(receipt1.provenance, 'publisher_authenticated');
    ok(`[C] GuestSupervisor executed under Job Object with verified publisher signature (${receipt1.durationMs}ms)`);

    const rawReceipt1 = JSON.parse(fs.readFileSync(path.join(outputDir, 'receipt.json'), 'utf8'));
    assert.equal(rawReceipt1.isGuestExecution, true);
    assert.equal(rawReceipt1.restrictedChild, true);
    assert.equal(rawReceipt1.jobObjectAttached, true);
    assert.ok(rawReceipt1.childPid > 0);
    ok(`[C] Native containment verified: Child PID ${rawReceipt1.childPid} in Job Object under restricted token`);

    // Verify token privileges table by column
    const privResult = parseAndVerifyChildPrivileges(receipt1.stdout);
    assert.ok(privResult.parsedCount > 0, 'Must have parsed child token privileges');
    parseAndVerifyChildGroups(receipt1.stdout);
    const userRegion=receipt1.stdout.split('---USER---')[1]?.split('---PRIV---')[0] || '';
    const reportedChildSid=userRegion.match(/\bS-1-[0-9-]+\b/)?.[0];
    assert.ok(reportedChildSid,'Guest must expose an independently parsed child User SID.');
    childUserSidGate=(reportedChildSid && reportedChildSid!=='S-1-5-18')?'PASS':'FAIL';
    if(childUserSidGate==='FAIL'){
      console.error('    [G3 SECURITY FAIL] Project test child retains SYSTEM User SID S-1-5-18.');
    }
    ok(`[C] Child privileges/groups audited; SID=${reportedChildSid}; G3=${childUserSidGate}`);

    const reqInspect = await prepareExecutionRequest({
      inputDirectory: inputDir,
      runId: 'inspect-' + crypto.randomBytes(4).toString('hex'),
      command: 'C:\\ChatMCP\\Input\\GuestSupervisor.exe',
      args: [
        '--child-probe',
        'C:\\ChatMCP\\Output'
      ],
      timeoutSeconds: 60,
      maxOutputBytes: 16384,
    });

    const keyFileInspect = writeAuthKeyFile(outputDir, reqInspect.authKey, `.auth_key_${reqInspect.runId}`);
    const supExecInspectRaw = execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', `C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output --auth-key-file C:\\ChatMCP\\Output\\${keyFileInspect}`,
        '--raw'
      ],
      { encoding: 'utf8', timeout: 70_000 }
    );
    const supExecInspect = JSON.parse(supExecInspectRaw);
    if (supExecInspect.ExitCode !== 0) {
      console.error('    [Child Inspection] Supervisor exited with code:', supExecInspect.ExitCode, supExecInspect);
      if (fs.existsSync(path.join(outputDir, 'debug_err.txt'))) {
        console.error('    [Child Inspection] debug_err.txt:', fs.readFileSync(path.join(outputDir, 'debug_err.txt'), 'utf8'));
      }
    }

    const receiptInspect = await readAndVerifyExecutionReceipt({
      exportDirectory: outputDir,
      expectedRunId: reqInspect.runId,
      expectedNonce: reqInspect.nonce,
      expectedAuthKey: reqInspect.authKey,
      backend: 'windows-sandbox',
    });
    console.log('    [Audit Observation] Child Inspection Findings:');
    for (const line of receiptInspect.stdout.trim().split(/\r?\n/)) {
      console.log('      ' + line);
    }
    const audit=receiptInspect.stdout;
    const wmiStatus=audit.match(/PARENT_WMI_STATUS=(EMPTY|VISIBLE_COMMANDLINE|QUERY_ERROR|PARENT_NOT_FOUND|PROBE_[A-Z_]+)/)?.[1];
    assert.ok(wmiStatus==='EMPTY'||wmiStatus==='VISIBLE_COMMANDLINE',
      'Security probe must obtain actual WMI evidence; unsupported or denied query is NOT VERIFIED ('+String(wmiStatus||'NO_RESULT')+')');
    const keyVisible=audit.includes('PARENT_AUTH_KEY_VISIBLE=True');
    const keyHidden=audit.includes('PARENT_AUTH_KEY_VISIBLE=False');
    assert.ok(keyVisible||keyHidden,'Guest WMI probe did not return a definitive boolean key observation.');
    assert.ok(audit.includes('PARENT_PID='),'No reliable supervisor parent-process reference');
    assert.ok(audit.includes('OPEN_ALL_ACCESS_ERR=5'),'Child must be denied PROCESS_ALL_ACCESS to parent');
    assert.ok(audit.includes('OPEN_QUERY_ERR=5'),'Child must be denied PROCESS_QUERY_INFORMATION to parent');
    assert.ok(audit.includes('OPEN_VMREAD_ERR=5'),'Child must be denied PROCESS_VM_READ to parent');
    assert.ok(audit.includes('OPEN_WINSTA_WRITE_DAC_ERR=5'),'Child must be denied WRITE_DAC on WindowStation');
    assert.ok(audit.includes('OPEN_DESK_WRITE_DAC_ERR=5'),'Child must be denied WRITE_DAC on Desktop');
    assert.ok(audit.includes('AUTH_KEY_EXISTS_AFTER_SHRED=False'),'.auth_key must be shredded and removed before child execution');
    ok('[C] Least-privilege Windows object boundaries verified: all child elevation and parent tampering attempts denied with Win32 error 5');

    // [C-ACL] Native NTFS & Redirector ACL audit on Output directory & staged secret
    console.log('\n--- [C-ACL] Native Windows ACL Audit & Key Exposure Probes ---');
    const synthSecretPath = path.join(outputDir, '.synthetic_key_probe');
    fs.writeFileSync(synthSecretPath, 'SYNTHETIC_TEST_SECRET_DO_NOT_LEAK', { flag: 'wx', mode: 0o600 });
    if (process.platform === 'win32') {
      try {
        const username = process.env.USERNAME || 'CURRENT_USER';
        execFileSync('icacls.exe', [
          synthSecretPath,
          '/inheritance:r',
          '/grant:r', '*S-1-5-18:(R,W)',
          '/grant:r', '*S-1-5-32-544:(R,W)',
          '/grant:r', `${username}:(F)`,
        ], { stdio: 'pipe', timeout: 5000 });
      } catch {}
    }

    const aclProbeFile = path.join(outputDir, 'acl_probe.txt');
    try {
      execFileSync(
        wsbCli,
        [
          'exec',
          '--id', ownedSandboxId,
          '-r', 'System',
          '-c', 'cmd.exe /c (icacls C:\\ChatMCP\\Output & echo ---SYNTHETIC--- & icacls C:\\ChatMCP\\Output\\.synthetic_key_probe) > C:\\ChatMCP\\Output\\acl_probe.txt',
          '--raw'
        ],
        { encoding: 'utf8', timeout: 15_000 }
      );
    } catch {}

    let aclText = '';
    if (fs.existsSync(aclProbeFile)) {
      aclText = fs.readFileSync(aclProbeFile, 'utf8');
      try { fs.unlinkSync(aclProbeFile); } catch {}
    }
    console.log('    [Audit Observation] Guest icacls Output:');
    for (const line of aclText.trim().split(/\r?\n/)) {
      console.log('      ' + line);
    }

    // Attempt to read the staged synthetic secret as the restricted child (WDAGUtilityAccount)
    const reqSynthRead = await prepareExecutionRequest({
      inputDirectory: inputDir,
      runId: 'synth-read-' + crypto.randomBytes(4).toString('hex'),
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          '$readSuccess = $false;',
          '$readErr = 0;',
          'try {',
          '  $c = [System.IO.File]::ReadAllText("C:\\ChatMCP\\Output\\.synthetic_key_probe");',
          '  if (-not [string]::IsNullOrEmpty($c)) { $readSuccess = $true; }',
          '} catch {',
          '  $readErr = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error();',
          '}',
          'Write-Output "SYNTHETIC_KEY_READ_SUCCESS=$readSuccess";',
          'Write-Output "SYNTHETIC_KEY_READ_ERR=$readErr";',
        ].join(' ')
      ],
      timeoutSeconds: 20,
      maxOutputBytes: 1024,
    });

    const keyFileSynth = writeAuthKeyFile(outputDir, reqSynthRead.authKey, `.auth_key_${reqSynthRead.runId}`);
    execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', `C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output --auth-key-file C:\\ChatMCP\\Output\\${keyFileSynth}`,
        '--raw'
      ],
      { encoding: 'utf8', timeout: 25_000 }
    );

    const receiptSynth = await readAndVerifyExecutionReceipt({
      exportDirectory: outputDir,
      expectedRunId: reqSynthRead.runId,
      expectedNonce: reqSynthRead.nonce,
      expectedAuthKey: reqSynthRead.authKey,
      backend: 'windows-sandbox',
    });
    console.log('    [Audit Observation] Staged Key Read Probe Findings:');
    for (const line of receiptSynth.stdout.trim().split(/\r?\n/)) {
      console.log('      ' + line);
    }
    try { fs.unlinkSync(synthSecretPath); } catch {}

    const synthReadAllowed = receiptSynth.stdout.includes('SYNTHETIC_KEY_READ_SUCCESS=True');
    // Per Round 4 & Issue #14:
    // Shared folder mapping across the host<->guest VM boundary is serviced in host user context,
    // so host NTFS ACLs cannot establish physical separation between guest SYSTEM and guest standard users
    // while a file exists in the shared folder.
    // Therefore, production publisher attestation remains honestly BLOCKED until an isolated transport is implemented.
    if (synthReadAllowed) {
      console.warn('    [G4 Transport Observation] While .synthetic_key_probe exists in shared folder, guest standard user could open it.');
    } else {
      console.warn('    [G4 Transport Observation] One synthetic file read denied. This does NOT prove cross-VM key-file confidentiality.');
    }
    // A negative WMI argv probe and a single synthetic read are not
    // sufficient to authenticate a key staged in a writable mapped folder.
    // Only an independently reviewed transport attestation may clear G4.
    publisherKeyGate = keyVisible ? 'FAIL' : 'BLOCKED';
    ok(`[C-ACL] Native Windows ACL audited; child access recorded; G4 production publisher attestation = ${publisherKeyGate}`);

    // [C-NEG] Negative Key Channel Fail-Closed Cases
    console.log('\n--- [C-NEG] Negative Key Channel Fail-Closed Cases ---');
    // Case 1: Missing .auth_key file -> Supervisor must fail closed (exit code 3), zero children run
    const negMissingRaw = execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', 'C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output',
        '--raw'
      ],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const negMissing = JSON.parse(negMissingRaw);
    assert.equal(negMissing.ExitCode, 3, 'Supervisor must exit 3 when .auth_key is missing');
    ok('[C-NEG] Missing .auth_key correctly rejected with exit code 3 (no child executed)');

    // Case 2: Guest --auth-key passed on command line -> Supervisor must fail closed (exit code 3)
    const negArgvRaw = execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', 'C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output --auth-key 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        '--raw'
      ],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const negArgv = JSON.parse(negArgvRaw);
    assert.equal(negArgv.ExitCode, 3, 'Supervisor must exit 3 when --auth-key is passed on argv');
    ok('[C-NEG] Guest argv --auth-key correctly rejected with exit code 3 (no child executed)');

    // Case 3: Malformed / truncated .auth_key file -> Supervisor must fail closed (exit code 3)
    const keyFileMalformed = writeAuthKeyFile(outputDir, 'deadbeef_truncated_key', '.auth_key_malformed');
    const negMalformedRaw = execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', `C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output --auth-key-file C:\\ChatMCP\\Output\\${keyFileMalformed}`,
        '--raw'
      ],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const negMalformed = JSON.parse(negMalformedRaw);
    assert.equal(negMalformed.ExitCode, 3, 'Supervisor must exit 3 when .auth_key is malformed/truncated');
    try { fs.unlinkSync(path.join(outputDir, keyFileMalformed)); } catch {}
    ok('[C-NEG] Malformed .auth_key correctly rejected with exit code 3 (no child executed)');

    // Timeout containment under Job Object
    const reqTimeout = await prepareExecutionRequest({
      inputDirectory: inputDir,
      runId: 'timeout-' + crypto.randomBytes(4).toString('hex'),
      command: 'powershell.exe',
      args: ['-NoProfile', '-Command', 'Start-Sleep -Seconds 15'],
      timeoutSeconds: 3,
      maxOutputBytes: 1024,
    });

    const keyFileTimeout = writeAuthKeyFile(outputDir, reqTimeout.authKey, `.auth_key_${reqTimeout.runId}`);
    execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', `C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output --auth-key-file C:\\ChatMCP\\Output\\${keyFileTimeout}`,
        '--raw'
      ],
      { encoding: 'utf8', timeout: 25_000 }
    );

    const receiptTimeout = await readAndVerifyExecutionReceipt({
      exportDirectory: outputDir,
      expectedRunId: reqTimeout.runId,
      expectedNonce: reqTimeout.nonce,
      expectedAuthKey: reqTimeout.authKey,
      backend: 'windows-sandbox',
    });
    assert.equal(receiptTimeout.status, 'timed_out');
    assert.equal(receiptTimeout.exitCode, null);
    ok('[C] Timeout enforcement in guest verified: runaway child terminated under Job Object');

    // [D] Publisher Authentication & Anti-Spoofing
    console.log('\n--- [D] Publisher Authentication & Anti-Spoofing ---');

    // 1. Unauthenticated receipt rejected when authKey is not provided and fixture bypass is absent
    await assert.rejects(
      () => readAndVerifyExecutionReceipt({
        exportDirectory: outputDir,
        expectedRunId: reqTimeout.runId,
        expectedNonce: reqTimeout.nonce,
        backend: 'windows-sandbox',
      }),
      { code: 'unverified_guest_origin' }
    );
    ok('[D] Unauthenticated receipt rejected with unverified_guest_origin when fixture bypass is absent');

    // 2. An untrusted guest attempts to write a receipt, followed by an
    // independent HOST-SIDE fully-rehashed tamper. The second half only proves
    // the host HMAC reader rejects altered bytes; it does NOT demonstrate
    // the guest child cannot inspect the supervisor's argv/HMAC key.
    // A genuine guest-auth-key secrecy test is still a production blocker.
    const forgedRunId = 'forged-' + crypto.randomBytes(4).toString('hex');
    const forgeReq = await prepareExecutionRequest({
      inputDirectory: inputDir,
      runId: forgedRunId,
      command: 'cmd.exe',
      args: [
        '/c',
        `echo {"version":1,"runId":"${forgedRunId}","nonce":"TAMPERED_BY_CHILD","status":"completed","exitCode":0,"stdout":"PWNED"} > C:\\ChatMCP\\Output\\receipt.json`
      ],
      timeoutSeconds: 10,
      maxOutputBytes: 1024,
    });

    // Execute through supervisor with legitimate authKey, but child tampered output
    const keyFileForge = writeAuthKeyFile(outputDir, forgeReq.authKey, `.auth_key_${forgeReq.runId}`);
    execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', `C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output --auth-key-file C:\\ChatMCP\\Output\\${keyFileForge}`,
        '--raw'
      ],
      { encoding: 'utf8', timeout: 25_000 }
    );

    // Host-side tampering simulation: intentionally rewrite both files after guest finishes.
    const receiptJsonPath = path.join(outputDir, 'receipt.json');
    const childForgedJson = JSON.stringify({
      version: 1,
      runId: forgedRunId,
      nonce: forgeReq.nonce,
      status: 'completed',
      exitCode: 0,
      stdout: 'FORGED_BY_MALICIOUS_CHILD',
      stderr: '',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 10,
    });
    fs.writeFileSync(receiptJsonPath, childForgedJson, 'utf8');
    const childSha = crypto.createHash('sha256').update(Buffer.from(childForgedJson, 'utf8')).digest('hex');
    fs.writeFileSync(path.join(outputDir, 'receipt.sha256'), `${childSha}  receipt.json\n`, 'utf8');

    // Host verifier MUST reject because child cannot forge supervisor HMAC in receipt.sig
    await assert.rejects(
      () => readAndVerifyExecutionReceipt({
        exportDirectory: outputDir,
        expectedRunId: forgedRunId,
        expectedNonce: forgeReq.nonce,
        expectedAuthKey: forgeReq.authKey,
        backend: 'windows-sandbox',
      }),
      { code: 'invalid_publisher_signature' }
    );
    ok('[D] Host-side fully-rehashed receipt tampering rejected by HMAC');

    // 3. Genuine in-guest child receipt forgery attempt:
    // Malicious child tries to write fake receipt.json and fake receipt.sha256 in C:\ChatMCP\Output,
    // and forge receipt.sig with random HMAC bytes, attempting to fool the host.
    const inGuestForgeRunId = 'in-guest-forge-' + crypto.randomBytes(4).toString('hex');
    const fakeJson = JSON.stringify({
      version: 1,
      runId: inGuestForgeRunId,
      nonce: 'FORGED_NONCE_VALUE_00000000000000000000000000000000000000000000000000',
      status: 'completed',
      exitCode: 0,
      stdout: 'GUEST_CHILD_SPOOFED_ZERO_EXIT',
      stderr: '',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 5,
    });
    const fakeSha = crypto.createHash('sha256').update(fakeJson).digest('hex');
    const fakeSig = crypto.randomBytes(32).toString('hex');

    const reqInGuestForge = await prepareExecutionRequest({
      inputDirectory: inputDir,
      runId: inGuestForgeRunId,
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          `Set-Content -LiteralPath 'C:\\ChatMCP\\Output\\receipt.json' -Value '${fakeJson.replace(/'/g, "''")}' -Encoding Ascii;`,
          `Set-Content -LiteralPath 'C:\\ChatMCP\\Output\\receipt.sha256' -Value '${fakeSha}  receipt.json' -Encoding Ascii;`,
          `Set-Content -LiteralPath 'C:\\ChatMCP\\Output\\receipt.sig' -Value '${fakeSig}  receipt.json' -Encoding Ascii;`,
          `exit 42;`,
        ].join(' ')
      ],
      timeoutSeconds: 15,
      maxOutputBytes: 1024,
    });

    const keyFileInGuestForge = writeAuthKeyFile(outputDir, reqInGuestForge.authKey, `.auth_key_${reqInGuestForge.runId}`);
    execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', `C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output --auth-key-file C:\\ChatMCP\\Output\\${keyFileInGuestForge}`,
        '--raw'
      ],
      { encoding: 'utf8', timeout: 25_000 }
    );

    const receiptAfterChildForge = await readAndVerifyExecutionReceipt({
      exportDirectory: outputDir,
      expectedRunId: reqInGuestForge.runId,
      expectedNonce: reqInGuestForge.nonce,
      expectedAuthKey: reqInGuestForge.authKey,
      backend: 'windows-sandbox',
    });
    assert.equal(receiptAfterChildForge.status, 'failed');
    assert.equal(receiptAfterChildForge.exitCode, 42);
    assert.ok(!receiptAfterChildForge.stdout.includes('GUEST_CHILD_SPOOFED_ZERO_EXIT'));
    assert.equal(receiptAfterChildForge.publisherAuthenticated, true);
    ok('[D] In-guest child spoofing attempt failed-closed: authentic supervisor overwritten with real child exitCode (42) and verified HMAC');

    // 4. Descriptor-bound, byte-limited reader negative checks:
    // a) Oversized receipt (> 5 MB)
    const bigReceiptDir = path.join(baseDir, 'test-oversized');
    fs.mkdirSync(bigReceiptDir, { recursive: true });
    const bigBuffer = Buffer.alloc(5 * 1024 * 1024 + 1024, 'A');
    fs.writeFileSync(path.join(bigReceiptDir, 'receipt.json'), bigBuffer);
    fs.writeFileSync(path.join(bigReceiptDir, 'receipt.sha256'), `${crypto.createHash('sha256').update(bigBuffer).digest('hex')}  receipt.json\n`);
    await assert.rejects(
      () => readAndVerifyExecutionReceipt({ exportDirectory: bigReceiptDir, expectedRunId: 'any', expectedNonce: 'any' }),
      { code: 'oversized_receipt' }
    );

    // b) Oversized checksum file (> 256 bytes)
    fs.writeFileSync(path.join(bigReceiptDir, 'receipt.json'), JSON.stringify({ version: 1, runId: 'test', nonce: 'test', status: 'completed', exitCode: 0 }));
    fs.writeFileSync(path.join(bigReceiptDir, 'receipt.sha256'), 'A'.repeat(300));
    await assert.rejects(
      () => readAndVerifyExecutionReceipt({ exportDirectory: bigReceiptDir, expectedRunId: 'test', expectedNonce: 'test' }),
      { code: 'unsafe_receipt' }
    );

    // c) Hard-linked receipt (nlink > 1)
    const hardlinkDir = path.join(baseDir, 'test-hardlink');
    fs.mkdirSync(hardlinkDir, { recursive: true });
    const normalReceipt = JSON.stringify({ version: 1, runId: 'hl-test', nonce: 'hl-nonce', status: 'completed', exitCode: 0 });
    const normalReceiptPath = path.join(hardlinkDir, 'receipt.json');
    fs.writeFileSync(normalReceiptPath, normalReceipt);
    const linkPath = path.join(hardlinkDir, 'receipt-link.json');
    try {
      fs.linkSync(normalReceiptPath, linkPath);
      await assert.rejects(
        () => readAndVerifyExecutionReceipt({ exportDirectory: hardlinkDir, expectedRunId: 'hl-test', expectedNonce: 'hl-nonce' }),
        { code: 'unsafe_receipt' }
      );
    } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'ENOSYS') throw e;
    }
    fs.rmSync(bigReceiptDir, { recursive: true, force: true });
    fs.rmSync(hardlinkDir, { recursive: true, force: true });
    ok('[D] Descriptor-bound reader verified: oversized and multi-linked files rejected fail-closed');
    console.log('\n--- [E] Negative OS Isolation Probes ---');

    // Host Canary Protection (direct guest probe)
    const canaryAttemptRaw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', `cmd.exe /c type "${canaryPath}"`, '--raw'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const canaryAttempt = JSON.parse(canaryAttemptRaw);
    assert.notEqual(canaryAttempt.ExitCode, 0);
    assert.equal(fs.readFileSync(canaryPath, 'utf8'), canarySecret);
    ok('[E] Host canary file protected: guest cannot access unmapped host paths');

    // Restricted Child Canary Probe via Supervisor
    const childCanaryReq = await prepareExecutionRequest({
      inputDirectory: inputDir,
      runId: 'child-canary-' + crypto.randomBytes(4).toString('hex'),
      command: 'cmd.exe',
      args: ['/c', `type "${canaryPath}"`],
      timeoutSeconds: 10,
      maxOutputBytes: 1024,
    });
    const keyFileCanary = writeAuthKeyFile(outputDir, childCanaryReq.authKey, `.auth_key_${childCanaryReq.runId}`);
    execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', `C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output --auth-key-file C:\\ChatMCP\\Output\\${keyFileCanary}`,
        '--raw'
      ],
      { encoding: 'utf8', timeout: 25_000 }
    );
    const childCanaryReceipt = await readAndVerifyExecutionReceipt({
      exportDirectory: outputDir,
      expectedRunId: childCanaryReq.runId,
      expectedNonce: childCanaryReq.nonce,
      expectedAuthKey: childCanaryReq.authKey,
    });
    assert.notEqual(childCanaryReceipt.exitCode, 0);
    assert.ok(!childCanaryReceipt.stdout.includes(canarySecret));
    ok('[E] Restricted child via GuestSupervisor cannot read host canary');

    // Read-Only Input Protection (direct guest probe)
    const writeAttemptRaw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', 'cmd.exe /c echo TAMPER > C:\\ChatMCP\\Input\\tamper.txt', '--raw'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const writeAttempt = JSON.parse(writeAttemptRaw);
    assert.notEqual(writeAttempt.ExitCode, 0);
    assert.equal(fs.existsSync(path.join(inputDir, 'tamper.txt')), false);

    const postTestHash = crypto.createHash('sha256').update(fs.readFileSync(supervisorDest)).digest('hex');
    assert.equal(postTestHash, supervisorHash);
    ok('[E] Read-only input boundary enforced: guest cannot write or tamper with supervisor files');

    // Positive Network Control & Guest Network Denial
    let hostNetworkActive = false;
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '8.8.8.8', port: 53, timeout: 3000 }, () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', reject);
        socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
      });
      hostNetworkActive = true;
    } catch {}

    if (!hostNetworkActive) {
      console.error('BLOCKED / INCONCLUSIVE: Host has no internet connectivity; cannot verify guest network isolation.');
      throw new Error('Host network positive control failed; cannot prove guest isolation.');
    }
    ok('[E] Positive host network control verified (host can reach 8.8.8.8:53)');

    const netAttemptRaw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', 'powershell.exe -NoProfile -Command "try { (New-Object System.Net.Sockets.TcpClient).Connect(\'8.8.8.8\', 53); exit 0 } catch { exit 99 }"', '--raw'],
      { encoding: 'utf8', timeout: 20_000 }
    );
    const netAttempt = JSON.parse(netAttemptRaw);
    assert.notEqual(netAttempt.ExitCode, 0);
    ok('[E] Guest network isolation policy verified: outbound connections rejected in guest while host is connected');

    // [F] Deterministic Native Fault Injections in Guest
    console.log('\n--- [F] Deterministic Native Fault Injections in Guest ---');
    const guestFaultModes = ['identity_fail', 'open_token_fail', 'create_restricted_token_fail', 'assign_job_fail'];
    for (const mode of guestFaultModes) {
      const faultKey=crypto.randomBytes(32).toString('hex');
      const faultKeyName = writeAuthKeyFile(outputDir, faultKey, `.auth_key_fault_${mode}`);
      const faultExecRaw = execFileSync(
        wsbCli,
        [
          'exec',
          '--id', ownedSandboxId,
          '-r', 'System',
          '-c', `C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output --auth-key-file C:\\ChatMCP\\Output\\${faultKeyName} --fault-inject ${mode}`,
          '--raw'
        ],
        { encoding: 'utf8', timeout: 15_000 }
      );
      const faultExec = JSON.parse(faultExecRaw);
      assert.notEqual(faultExec.ExitCode, 0, `Fault injection ${mode} must exit non-zero`);
      const faultReceipt = JSON.parse(fs.readFileSync(path.join(outputDir, 'receipt.json'), 'utf8'));
      assert.equal(faultReceipt.status, 'failed');
      assert.ok(faultReceipt.reasons.length > 0);
      assert.equal(fs.existsSync(path.join(outputDir, faultKeyName)), false,
        'Even a fault-injected guest execution must remove its key before any child launch');
    }
    ok('[F] In-guest deterministic fault injections verified with mandatory one-time HMAC key removal');

  } finally {
    // [G] Lifecycle Termination & Journal Cleanup
    console.log('\n--- [G] Lifecycle Termination & Journal Cleanup ---');
    if (ownedSandboxId) {
      updateJournal('stopping');
      try {
        const stopOutputRaw = execFileSync(
          wsbCli,
          ['stop', '--id', ownedSandboxId, '--raw'],
          { encoding: 'utf8', timeout: 30_000 }
        );
        ok(`[G] Owned Windows Sandbox stopped cleanly (${ownedSandboxId})`);
      } catch (err) {
        console.error(`Warning: Failed to stop sandbox ${ownedSandboxId}:`, err.message);
      }

      const listAfter = JSON.parse(execFileSync(wsbCli, ['list', '--raw'], { encoding: 'utf8' }));
      const remainingIds = (listAfter.WindowsSandboxEnvironments || []).map((e) => e.Id);
      assert.ok(!remainingIds.includes(ownedSandboxId), 'Owned sandbox must be terminated');
      ok('[G] Sandbox termination verified: instance removed from active list');

      updateJournal('terminated');
    }

    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
      ok('[G] Temporary test fixtures cleanly removed from host');
    } catch {}
  }

  if(publisherKeyGate!=='PASS'||childUserSidGate!=='PASS'){
    console.error('PHASE 1 SECURITY GATES G3='+childUserSidGate+' G4='+publisherKeyGate+
      ': supervisor key confidentiality is not independently established. NO MERGE / NO RELEASE.');
    console.log('Functional Windows guest checks completed: '+checks+
      '; this is NOT a passing production security suite.');
    return {success:false,checks,securityGates:{G3:childUserSidGate,G4:publisherKeyGate}};
  }
  console.log(`\nPASS: All ${checks} real Windows Sandbox validation checks SUCCEEDED.`);
  return {success:true,checks,securityGate:'G4',verdict:'PASS'};
}

if(process.argv[1]&&process.argv[1].endsWith('real-guest.mjs')){
  const result=await runRealGuestTests();
  if(!result.success)process.exitCode=1;
}
