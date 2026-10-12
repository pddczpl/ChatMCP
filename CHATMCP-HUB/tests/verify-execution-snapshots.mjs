import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExecutionSnapshot, verifyExecutionSnapshot, validateSnapshotPath } from '../lib/execution-snapshots.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-pr3-test-'));
const workspace = path.join(dir, 'workspace');
const staging = path.join(dir, 'staging');
try {
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'app.js'), 'export default 1;\n');
  await fs.writeFile(path.join(workspace, '.env'), 'TOKEN=SECRET');
  for (const p of ['../app.js', '/absolute', 'C:/Windows/test', '.git/config', '.env', 'node_modules/a', 'folder/../app.js', 'CON.txt', 'secret.key']) {
    assert.throws(() => validateSnapshotPath(p), /snapshot/i, p);
  }
  console.log('PASS: untrusted paths / private data rejected');
  const sha = 'a'.repeat(40);
  const snap = await createExecutionSnapshot({ workspace, files: ['app.js'], baseSha: sha, outputRoot: staging });
  assert.match(snap.snapshotId, /^[0-9a-f-]{36}$/);
  assert.equal(snap.manifest.files.length, 1);
  assert.ok(await verifyExecutionSnapshot(snap));
  assert.equal(await fs.readFile(path.join(snap.directory, 'app.js'), 'utf8'), 'export default 1;\n');
  await fs.writeFile(path.join(workspace, 'app.js'), 'changed');
  assert.ok(await verifyExecutionSnapshot(snap), 'snapshot unaffected by later workspace edit');
  await fs.chmod(path.join(snap.directory, 'app.js'), 0o600);
  await fs.writeFile(path.join(snap.directory, 'app.js'), 'tampered');
  await assert.rejects(verifyExecutionSnapshot(snap), /changed|size|stale/i);
  await fs.writeFile(path.join(workspace, 'x.txt'), 'a');
  await fs.writeFile(path.join(workspace, 'y.txt'), 'b');
  await assert.rejects(createExecutionSnapshot({ workspace, files: ['x.txt','y.txt'], maxTotalBytes: 1, outputRoot: staging }), /limit/i);
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(workspace, 'x.txt'), path.join(workspace, 'shortcut'));
    await assert.rejects(createExecutionSnapshot({ workspace, files: ['shortcut'], outputRoot: staging }), /linked|special|escape/);
  }
  console.log('PASS: immutable snapshot, mutation detection, limits, symlink denial');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
