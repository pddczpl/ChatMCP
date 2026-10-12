// Grant-bound isolated worker checks: no host command, model-supplied shell,
// credential access, path expansion, arbitrary Git write or publication.
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { fault, validateExecutionRequest, validateExecutionReceipt } from './execution-contract.mjs';
import { createExecutionSnapshot } from './execution-snapshots.mjs';
import { hashCheck, recordVerificationAttempt } from './verification-receipt.mjs';
const hash = s => createHash('sha256').update(s).digest('hex');
const trustedWorker = w => w && typeof w.id === 'string' && typeof w.workspace === 'string' && Array.isArray(w.files);
const now = () => Date.now();
export class WorkerTestBroker {
  constructor({ resolveWorker, registry, authorizeGrant, snapshotFactory = createExecutionSnapshot, clock = now } = {}) {
    if (typeof resolveWorker !== 'function' || !registry || typeof authorizeGrant !== 'function') {
      throw new TypeError('Broker requires authoritative worker registry, ExecutionRegistry and grant authorizer.');
    }
    this.resolveWorker = resolveWorker;
    this.registry = registry;
    this.authorizeGrant = authorizeGrant;
    this.snapshotFactory = snapshotFactory;
    this.clock = clock;
    this.descriptors = new Map();
    this.grants = new Map();
    this.attempts = new Map();
  }
  async #worker(id) {
    const w = await this.resolveWorker(id);
    if (!trustedWorker(w) || w.id !== id) throw fault('unknown_worker', 'Worker must be resolved from trusted Hub records.', 404);
    return w;
  }
  #policy(worker) {
    // These fields originate ONLY from the trusted server-side worker record.
    if (worker.revoked || worker.parentPolicy === 'readonly' || worker.capabilities?.checksRun !== true) {
      throw fault('worker_permission_denied', 'Parent authority does not allow isolated worker test execution.', 403);
    }
  }
  async discoverChecks({ workerId } = {}) {
    const worker = await this.#worker(workerId);
    const suggestions = await worker.checks(); // trusted workspace discovery reads untrusted repository metadata
    const commands = suggestions?.suggested || [];
    // Each discovered command is deliberately fixed to a well-known project
    // configuration file. Hash the actual configuration bytes as well as the
    // command: a package script changing under the same 'npm test' name must
    // invalidate the previous approval. Reading test configuration never
    // executes it, and link/special files fail closed.
    const checkFiles = new Set(['package.json','pyproject.toml','pytest.ini','Cargo.toml','go.mod','Makefile']);
    const configHashes = [];
    for (const check of commands) {
      if (!checkFiles.has(check.from) || !worker.files.includes(check.from)) {
        throw fault('unsafe_check_source','Registered test definition is not owned by the selected worktree.');
      }
      const full=path.join(worker.workspace,check.from);
      const stat=await fs.lstat(full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024*1024) {
        throw fault('unsafe_check_source','Check source file is linked, special or oversized.');
      }
      const nofollow=process.platform==='win32'?0:(constants.O_NOFOLLOW||0);
      const file=await fs.open(full,constants.O_RDONLY|nofollow);
      try {
        const opened=await file.stat();
        if (!opened.isFile() || opened.nlink!==1 || opened.size!==stat.size ||
            opened.mtimeMs!==stat.mtimeMs || opened.ino!==stat.ino || opened.dev!==stat.dev) {
          throw fault('stale_check','Check configuration changed while being read.');
        }
        const bytes=await file.readFile();
        const after=await file.stat();
        if (bytes.length!==stat.size || after.size!==stat.size || after.mtimeMs!==stat.mtimeMs) {
          throw fault('stale_check','Check configuration changed while being hashed.');
        }
        configHashes.push({from:check.from,sha256:hash(bytes)});
      } finally {await file.close();}
    }
    const sourceHash = hash(JSON.stringify({commands,configHashes}));
    const descriptors = commands.slice(0, 30).filter(x =>
      typeof x.command === 'string' && x.command.trim() && x.command.length <= 2048
    ).map(({ command, from }) => {
      const info = { workerId, sourceHash, command, cwd: '.', toolchain: 'offline-node-pinned', policy: 'windows-sandbox' };
      const checkHash = hashCheck(info);
      return Object.freeze({
        id: checkHash.slice(0, 28), checkHash, ...info, from: String(from || '').slice(0, 250),
      });
    });
    this.descriptors.set(workerId, descriptors);
    return descriptors.map(x => ({ ...x }));
  }
  async issueGrant({ workerId, checkId, maxAttempts = 3, expiresInMs = 20 * 60 * 1000 } = {}) {
    const worker = await this.#worker(workerId);
    this.#policy(worker);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 ||
        !Number.isSafeInteger(expiresInMs) || expiresInMs < 1000 || expiresInMs > 20 * 60 * 1000) {
      throw fault('invalid_grant', 'Check grants have strictly bounded retry count and lifetime.');
    }
    const descriptor = (this.descriptors.get(workerId) || []).find(x => x.id === checkId);
    if (!descriptor) throw fault('unknown_check', 'Check must be discovered under the current worker.', 404);
    const granted = await this.authorizeGrant({ worker, descriptor, maxAttempts, expiresInMs });
    if (granted?.approved !== true) throw fault('grant_denied', 'Authoritative human or parent policy declined this check.', 403);
    const id = randomUUID();
    this.grants.set(id, {
      id, workerId, checkId, checkHash: descriptor.checkHash, sourceHash: descriptor.sourceHash,
      expiresAt: this.clock() + expiresInMs, maxAttempts, attempts: 0, revoked: false,
    });
    return { id, workerId, checkId, expiresAt: this.grants.get(id).expiresAt, maxAttempts };
  }
  revokeGrant(id) { const g = this.grants.get(id); if (!g) return false; g.revoked = true; return true; }
  listAttempts({ workerId }) { return [...(this.attempts.get(workerId) || [])]; }
  async requestCheck({ workerId, checkId, grantId, signal } = {}) {
    const worker = await this.#worker(workerId);
    this.#policy(worker);
    signal?.throwIfAborted();
    const grant = this.grants.get(grantId);
    if (!grant || grant.revoked || grant.workerId !== workerId || grant.checkId !== checkId ||
        grant.expiresAt <= this.clock() || grant.attempts >= grant.maxAttempts) {
      throw fault('stale_grant', 'Check grant expired, revoked, mismatched or exhausted.', 403);
    }
    const oldDescriptor = (this.descriptors.get(workerId) || []).find(x => x.id === checkId);
    if (!oldDescriptor || grant.checkHash !== oldDescriptor.checkHash || grant.sourceHash !== oldDescriptor.sourceHash) {
      throw fault('stale_check', 'Check definition changed since authorization.', 409);
    }
    const fresh = await this.discoverChecks({ workerId });
    const descriptor = fresh.find(x => x.id === checkId);
    if (!descriptor || descriptor.sourceHash !== grant.sourceHash || descriptor.checkHash !== grant.checkHash) {
      throw fault('stale_check', 'Repository test definitions changed: obtain a new grant.', 409);
    }
    grant.attempts += 1; // reserve attempt BEFORE any async launch
    signal?.throwIfAborted();
    const snapshot = await this.snapshotFactory({
      workspace: worker.workspace, files: [...worker.files], baseSha: worker.baseSha || null, signal,
    });
    if (worker.revoked) throw fault('worker_permission_denied', 'Worker was revoked before guest execution.', 403);
    const runId = randomUUID();
    const request = validateExecutionRequest({
      runId, snapshotId: snapshot.snapshotId, checkId: descriptor.id,
      backend: 'windows-sandbox', isolationRequired: true,
      command: descriptor.command, cwd: '.', shell: 'auto', snapshotHash: snapshot.contentHash,
      checkHash: descriptor.checkHash, requiredLimits: ['timeoutSeconds','maxOutputBytes'],
      limits: { timeoutSeconds: 120, maxOutputBytes: 100 * 1024 },
    });
    const backend = this.registry.get('windows-sandbox');
    if (!backend) throw fault('backend_unavailable', 'Windows Sandbox backend not registered.', 503);
    // A private, host-owned grant is authoritative for this tool. Do not call a
    // model-supplied PermissionGate or reclassify this as an unisolated host shell.
    const capability = await backend.probe();
    let receipt;
    if (!capability.available || !capability.osIsolated ||
        !request.requiredLimits.every(limit => capability.enforcedLimits.includes(limit))) {
      const at = new Date().toISOString();
      receipt = validateExecutionReceipt({
        runId, status: 'isolation_unavailable', exitCode: null, stdout: '', stderr: '',
        startedAt: at, completedAt: at, durationMs: 0, backend: 'windows-sandbox',
        snapshotHash: snapshot.contentHash, checkHash: descriptor.checkHash,
        truncated: false, evidencePath: null,
        reasons: [...(capability.reasons || []), 'Isolated check was not run; no host fallback.'],
      });
    } else {
      // Only the pre-registered OS-isolated provider, never ShellRunner.
      receipt = await backend.execute(request, { signal });
    }
    const bound = recordVerificationAttempt({
      descriptor: { ...descriptor, runId }, snapshot, execution: receipt, attempt: grant.attempts, grantId,
    });
    this.attempts.set(workerId, [...(this.attempts.get(workerId) || []), bound].slice(-100));
    return bound;
  }
}
