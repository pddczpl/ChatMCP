import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHub } from '../../tests/e2e/hub-process.mjs';
import { makeCalcProject, gitInit } from '../../tests/e2e/fixtures.mjs';

const allowUnavailable = process.argv.includes('--allow-unavailable');
function unavailable(reason) {
  console[allowUnavailable ? 'log' : 'error'](`${allowUnavailable ? 'SKIP' : 'FAIL'}: WebView2 smoke unavailable: ${reason}`);
  process.exitCode = allowUnavailable ? 0 : 1;
}

async function run(file, args, { cwd, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const timer = setTimeout(() => {
      // This PID belongs to the harness we just launched; terminate only its tree.
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => child.kill());
      reject(new Error(`${path.basename(file)} timed out after ${timeoutMs} ms\n${output}`));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

if (process.platform !== 'win32') {
  unavailable('Windows is required; Chromium E2E does not replace this smoke test.');
} else {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-webview2-smoke-'));
  let hub;
  try {
    const sdk = await run('dotnet', ['--list-sdks']).catch((error) => {
      if (error.code === 'ENOENT') return { code: 77, output: 'The .NET SDK is not installed.' };
      throw error;
    });
    if (sdk.code === 77 || !/^10\./m.test(sdk.output)) {
      unavailable('.NET SDK 10 is required.');
    } else {
      const source = fileURLToPath(new URL('./windows-webview2/', import.meta.url));
      const harness = path.join(scratch, 'harness');
      await fs.cp(source, harness, { recursive: true });
      const built = await run('dotnet', ['build', path.join(harness, 'Smoke.csproj'), '--configuration', 'Release', '--nologo', '--output', path.join(scratch, 'bin')]);
      assert.equal(built.code, 0, `WebView2 harness build failed:\n${built.output}`);
      const project = path.join(scratch, 'workspace');
      makeCalcProject(project);
      gitInit(project, scratch);
      hub = await startHub({ scratch, project });
      const html = await (await fetch(hub.origin)).text();
      assert.match(html, /assets\/index-[^" ]+\.js/, 'Hub must serve the current Vite build');
      const viewports = [
        { name: 'desktop', width: 1600, height: 1000 },
        { name: 'compact', width: 900, height: 700 },
      ];
      for (const viewport of viewports) {
        const result = await run(path.join(scratch, 'bin', 'Smoke.exe'), [
          hub.origin, path.join(scratch, `webview-profile-${viewport.name}`), String(viewport.width), String(viewport.height),
        ], { timeoutMs: 120_000 });
        if (result.code === 77) { unavailable(result.output.trim()); break; }
        assert.equal(result.code, 0, `${viewport.name} viewport:\n${result.output}`);
        const report = JSON.parse(result.output.trim().split(/\r?\n/).at(-1));
        assert.equal(report.result, 'PASS');
        assert.equal(report.errors.length, 0);
        if (viewport.name === 'compact') assert.equal(report.viewport.compact, true, 'Compact smoke must exercise the compact layout');
        // Headless CI desktops can constrain a requested wide native window.
        // Report the real viewport instead of assuming WinForms honored its size.
        assert.ok(report.viewport.width > 0 && report.viewport.height > 0, 'WebView2 must report a real viewport');
        assert.equal((await hub.state()).agent.tasks.length, 0, 'Smoke navigation must not create an AI task');
        console.log(JSON.stringify(report, null, 2));
        console.log(`PASS: Windows WebView2 ${viewport.name} smoke, temporary Hub/profile, no AI requests or tasks.`);
      }
    }
  } catch (error) {
    console.error(`FAIL: WebView2 smoke: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await hub?.stop();
    const resolved = await fs.realpath(scratch);
    const temp = await fs.realpath(os.tmpdir());
    if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('chatmcp-webview2-smoke-')) throw new Error('Unsafe WebView2 cleanup path');
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 });
  }
}
