// Tests for Windows Sandbox Configuration Generator and Security Validator (Phase 1, PR 2).
//
// Verifies:
//  1. XML generation and strict denial policies (Networking, Clipboard, Audio, Video, Printer, VGpu)
//  2. Memory bounds clamping (512 - 8192 MB)
//  3. ProtectedClient toggle
//  4. Logon command XML escaping
//  5. Path validation: traversal rejection, relative paths, ADS, DOS devices
//  6. Directory isolation: write scope checks, home/drive/workspace collision prevention
//  7. Symlink / reparse point rejection
//  8. PowerShell configuration.ps1 script parity

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  escapeXml,
  validateHostMappingPath,
  createSandboxConfiguration,
} from '../lib/windows-sandbox-config.mjs';

let checks = 0;
const ok = (label) => {
  checks += 1;
  console.log(`  ok - ${label}`);
};

setTimeout(() => {
  console.error('FAIL: verify-windows-sandbox-config exceeded time budget');
  process.exit(2);
}, 30_000).unref();

const testBaseDir = path.join(os.tmpdir(), `chatmcp-wsb-cfg-test-${Date.now()}`);
fs.mkdirSync(testBaseDir, { recursive: true });

try {
  const dummyInput = path.join(testBaseDir, 'inputs');
  const dummyOutput = path.join(testBaseDir, 'outputs');
  fs.mkdirSync(dummyInput, { recursive: true });
  fs.mkdirSync(dummyOutput, { recursive: true });

  console.log('# 1. XML Generation and Strict Denial Policies');
  {
    const xml = createSandboxConfiguration({
      inputDirectory: dummyInput,
      exportDirectory: dummyOutput,
      memoryMb: 1024,
    });

    assert.ok(xml.includes('<Configuration>'), 'must start with Configuration tag');
    assert.ok(xml.includes('<VGpu>Disable</VGpu>'), 'vGPU must be disabled');
    assert.ok(xml.includes('<Networking>Disable</Networking>'), 'Networking must be disabled');
    assert.ok(xml.includes('<ClipboardRedirection>Disable</ClipboardRedirection>'), 'Clipboard must be disabled');
    assert.ok(xml.includes('<AudioInput>Disable</AudioInput>'), 'AudioInput must be disabled');
    assert.ok(xml.includes('<VideoInput>Disable</VideoInput>'), 'VideoInput must be disabled');
    assert.ok(xml.includes('<PrinterRedirection>Disable</PrinterRedirection>'), 'Printer must be disabled');
    assert.ok(xml.includes('<MemoryInMB>1024</MemoryInMB>'), 'Memory must be 1024');

    // Mappings
    assert.ok(xml.includes(`<HostFolder>${dummyInput}</HostFolder>`), 'Input directory host folder matches');
    assert.ok(xml.includes('<SandboxFolder>C:\\ChatMCP\\Input</SandboxFolder>'), 'Sandbox input mount matches');
    assert.ok(xml.includes('<ReadOnly>true</ReadOnly>'), 'Input must be read-only');

    assert.ok(xml.includes(`<HostFolder>${dummyOutput}</HostFolder>`), 'Output directory host folder matches');
    assert.ok(xml.includes('<SandboxFolder>C:\\ChatMCP\\Output</SandboxFolder>'), 'Sandbox output mount matches');
    assert.ok(xml.includes('<ReadOnly>false</ReadOnly>'), 'Output must be writable');

    assert.ok(xml.includes('<ProtectedClient>Enable</ProtectedClient>'), 'ProtectedClient enabled by default');
    assert.ok(!xml.includes('<LogonCommand>'), 'LogonCommand omitted when empty');
    ok('Strict denial policies and mappings generated in .wsb XML');
  }

  console.log('# 2. Memory Bounds Clamping');
  {
    const lowXml = createSandboxConfiguration({
      inputDirectory: dummyInput,
      exportDirectory: dummyOutput,
      memoryMb: 128,
    });
    assert.ok(lowXml.includes('<MemoryInMB>512</MemoryInMB>'), 'Low memory clamped to 512 MB');

    const highXml = createSandboxConfiguration({
      inputDirectory: dummyInput,
      exportDirectory: dummyOutput,
      memoryMb: 16384,
    });
    assert.ok(highXml.includes('<MemoryInMB>8192</MemoryInMB>'), 'High memory clamped to 8192 MB');

    const normXml = createSandboxConfiguration({
      inputDirectory: dummyInput,
      exportDirectory: dummyOutput,
      memoryMb: 2048,
    });
    assert.ok(normXml.includes('<MemoryInMB>2048</MemoryInMB>'), 'Valid memory preserved at 2048 MB');
    ok('Memory values correctly clamped to [512, 8192] MB');
  }

  console.log('# 3. ProtectedClient and LogonCommand Escaping');
  {
    const xml = createSandboxConfiguration({
      inputDirectory: dummyInput,
      exportDirectory: dummyOutput,
      protectedClient: true,
      logonCommand: 'cmd.exe /c "echo <test & \'sandbox\'>"',
    });

    assert.ok(xml.includes('<ProtectedClient>Enable</ProtectedClient>'), 'ProtectedClient enabled');
    assert.ok(xml.includes('&lt;test &amp; &apos;sandbox&apos;&gt;'), 'LogonCommand escaped for XML');
    ok('ProtectedClient and XML escaping verified');
  }

  console.log('# 4. Path Validation: Traversal, Relative Paths, ADS, DOS Devices');
  {
    // Empty or non-string
    assert.throws(() => validateHostMappingPath(''), { code: 'invalid_path' });
    assert.throws(() => validateHostMappingPath(null), { code: 'invalid_path' });

    // Relative path
    assert.throws(() => validateHostMappingPath('relative\\path'), { code: 'invalid_path' });

    // Traversal
    assert.throws(() => validateHostMappingPath('C:\\safe\\..\\escaped'), { code: 'path_traversal' });
    assert.throws(() => validateHostMappingPath('C:\\..\\escaped'), { code: 'path_traversal' });

    // Alternate Data Streams (ADS)
    assert.throws(() => validateHostMappingPath('C:\\safe\\folder:secret'), { code: 'invalid_path' });

    // DOS device names
    assert.throws(() => validateHostMappingPath('C:\\safe\\CON'), { code: 'invalid_path' });
    assert.throws(() => validateHostMappingPath('C:\\safe\\NUL.txt'), { code: 'invalid_path' });
    assert.throws(() => validateHostMappingPath('C:\\safe\\COM1\\data'), { code: 'invalid_path' });
    assert.throws(() => validateHostMappingPath('C:\\safe\\LPT3'), { code: 'invalid_path' });

    ok('Path traversal, relative paths, ADS, and DOS device names rejected');
  }

  console.log('# 5. Directory Isolation: Writable Scopes and Collision Prevention');
  {
    const sysDrive = (process.env.SystemDrive || 'C:').replace(/\\?$/, '\\');
    const userHome = os.homedir();
    const fakeWorkspace = path.join(testBaseDir, 'my-workspace');
    fs.mkdirSync(fakeWorkspace, { recursive: true });

    // Cannot map system drive root as writable
    assert.throws(
      () => validateHostMappingPath(sysDrive, { isWritable: true }),
      { code: 'unsafe_mapping' }
    );

    // Cannot map user home directory as writable
    assert.throws(
      () => validateHostMappingPath(userHome, { isWritable: true }),
      { code: 'unsafe_mapping' }
    );

    // Cannot map workspace directory as writable
    assert.throws(
      () => validateHostMappingPath(fakeWorkspace, { isWritable: true, workspaceRoot: fakeWorkspace }),
      { code: 'unsafe_mapping' }
    );

    // Input and export cannot be the exact same directory
    assert.throws(
      () => createSandboxConfiguration({ inputDirectory: dummyInput, exportDirectory: dummyInput }),
      { code: 'unsafe_mapping' }
    );

    ok('Writable scope collisions with root drive, user profile, and workspace prevented');
  }

  console.log('# 6. Symlink / Reparse Point Rejection');
  {
    const symlinkTarget = path.join(testBaseDir, 'real-folder');
    const symlinkPath = path.join(testBaseDir, 'symlinked-folder');
    fs.mkdirSync(symlinkTarget, { recursive: true });

    let canTestSymlink = false;
    try {
      fs.symlinkSync(symlinkTarget, symlinkPath, 'junction');
      canTestSymlink = true;
    } catch {
      // Symlink creation might require privileges on older Windows without Developer Mode
    }

    if (canTestSymlink) {
      assert.throws(
        () => validateHostMappingPath(symlinkPath, { isWritable: false }),
        { code: 'unsafe_mapping' }
      );
      ok('Reparse point / directory junction rejected as unsafe mapping');
    } else {
      ok('Symlink test skipped (insufficient OS permissions for mklink on test path)');
    }
  }

  console.log('# 7. PowerShell configuration.ps1 Parity');
  {
    const psScript = path.resolve('CHATMCP-HUB/windows/sandbox/configuration.ps1');
    if (process.platform === 'win32' && fs.existsSync(psScript)) {
      const outConfig = path.join(testBaseDir, 'generated.wsb');
      const stdout = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          psScript,
          '-InputDirectory',
          dummyInput,
          '-ExportDirectory',
          dummyOutput,
          '-MemoryMb',
          '2048',
          '-OutputFile',
          outConfig,
        ],
        { encoding: 'utf8', windowsHide: true }
      );

      assert.ok(fs.existsSync(outConfig), 'OutputFile generated by configuration.ps1');
      const psGeneratedXml = fs.readFileSync(outConfig, 'utf8');
      assert.ok(psGeneratedXml.includes('<Networking>Disable</Networking>'), 'PS script disables Networking');
      assert.ok(psGeneratedXml.includes('<MemoryInMB>2048</MemoryInMB>'), 'PS script sets MemoryInMB');
      assert.ok(psGeneratedXml.includes('<ReadOnly>true</ReadOnly>'), 'PS script sets Input ReadOnly');
      assert.ok(psGeneratedXml.includes('<ReadOnly>false</ReadOnly>'), 'PS script sets Output writable');

      // Test path traversal rejection in PowerShell script
      let psTraversalFailed = false;
      try {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            psScript,
            '-InputDirectory',
            'C:\\safe\\..\\escaped',
            '-ExportDirectory',
            dummyOutput,
          ],
          { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        );
      } catch {
        psTraversalFailed = true;
      }
      assert.ok(psTraversalFailed, 'PowerShell script rejected path traversal');
      ok('PowerShell configuration.ps1 script parity and traversal rejection verified');
    } else {
      ok('PowerShell configuration.ps1 check skipped (file not found)');
    }
  }


  console.log('# 8. Nested mapping, workspace subtree and ancestor link refusal');
  {
    const nested = path.join(dummyInput, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    assert.throws(
      () => createSandboxConfiguration({inputDirectory: dummyInput, exportDirectory: nested}),
      {code:'unsafe_mapping'}
    );
    assert.throws(
      () => createSandboxConfiguration({inputDirectory: dummyInput, exportDirectory: dummyOutput, protectedClient:false}),
      {code:'unsafe_configuration'}
    );
    assert.throws(
      () => createSandboxConfiguration({inputDirectory: dummyInput, exportDirectory: dummyOutput, workspaceRoot:testBaseDir}),
      {code:'unsafe_mapping'}
    );
    const alias = path.join(testBaseDir,'ancestor-alias');
    const target = path.join(testBaseDir,'actual-parent');
    fs.mkdirSync(target, {recursive:true});
    try {
      fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const child = path.join(alias,'subdir');
      fs.mkdirSync(path.join(target,'subdir'),{recursive:true});
      assert.throws(() => validateHostMappingPath(child), {code:'unsafe_mapping'});
      console.log('  ancestor symlink verified');
    } catch(error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
      console.log('  BLOCKED: cannot create ancestor junction with current OS permissions');
    }
    ok('Nested mappings, unsafe workspace exports and unprotected configurations refused');
  }

  console.log(`\nAll ${checks} Windows Sandbox configuration checks PASSED (source/config only, NOT guest isolation).`);
} finally {
  try {
    fs.rmSync(testBaseDir, { recursive: true, force: true });
  } catch {
    // Ignore temp cleanup errors
  }
}
