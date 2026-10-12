// Phase 1 PR3 Windows sandbox backend. Production remains unavailable until
// authenticated supervisor publication/OS gates are proven by dedicated hardware.
// Dependency injection exists for deterministic tests, never for model input.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { ExecutionBackend, validateCapabilityReport, validateExecutionReceipt, fault } from './execution-contract.mjs';
import { probeWindowsSandboxPreflight } from './windows-sandbox-probe.mjs';
import { verifyExecutionSnapshot } from './execution-snapshots.mjs';

const reply = (req, status, reasons) => {
  const now = new Date().toISOString();
  return validateExecutionReceipt({
    runId: req.runId, status, exitCode: null, stdout: '', stderr: reasons.join('; '),
    startedAt: now, completedAt: now, durationMs: 0, backend: 'windows-sandbox',
    snapshotHash: req.snapshotHash || null, checkHash: req.checkHash || null,
    truncated: false, evidencePath: null, reasons,
  });
};
export class WindowsSandboxBackend extends ExecutionBackend {
  constructor({ stateDirectory, preflight = probeWindowsSandboxPreflight, driver = null, publisher = null, snapshotLookup = null } = {}) {
    super('windows-sandbox');
    this.stateDirectory = path.resolve(stateDirectory || path.join(process.cwd(), '.chatmcp-sandbox-state'));
    this.preflight = preflight;
    // driver and publisher MUST be injected by trusted Hub code and are never
    // accepted from model/user request JSON. No default privileged CLI driver.
    this.driver = driver;
    this.publisher = publisher;
    this.snapshotLookup = snapshotLookup;
    this.active = new Map();
    this.quarantined = false;
  }
  getStaticCapabilityReport() {
    return validateCapabilityReport({
      backend: this.id, available: false, osIsolated: true, platform: 'win32',
      networkPolicy: 'denied', writeScope: 'guest-ephemeral', concurrency: 1,
      enforcedLimits: [],
      unsupportedLimits: ['timeoutSeconds', 'maxOutputBytes', 'maxMemoryMb', 'maxCpuCores', 'customEnv'],
      reasons: ['Production guest publisher authentication not yet certified; requires Windows hardware gate.'],
      observedAt: new Date().toISOString(),
    });
  }
  async probe() {
    let host;
    try { host = await this.preflight(); }
    catch (e) { host = { available: false, blockers: ['Preflight failure: ' + e.message] }; }
    const verified = this.driver && this.publisher &&
      this.publisher.productionAuthenticated === true && typeof this.publisher.verify === 'function';
    const available = Boolean(host.available && verified && !this.quarantined && this.active.size === 0);
    return validateCapabilityReport({
      backend: this.id, available, osIsolated: true, platform: 'win32',
      networkPolicy: 'denied', writeScope: 'guest-ephemeral', concurrency: 1,
      enforcedLimits: available ? ['timeoutSeconds', 'maxOutputBytes'] : [],
      unsupportedLimits: available ? ['maxMemoryMb', 'maxCpuCores', 'customEnv'] : ['timeoutSeconds', 'maxOutputBytes', 'maxMemoryMb', 'maxCpuCores', 'customEnv'],
      reasons: available ? [] : [
        ...(host.blockers || []),
        ...(verified ? [] : ['Trusted publication and broker-controlled execution have not passed the security gate.']),
        ...(this.quarantined ? ['Owned instance termination unresolved: manual reconciliation required.'] : []),
        ...(this.active.size ? ['Execution slot occupied.'] : []),
      ],
      observedAt: new Date().toISOString(),
    });
  }
  async execute(request, { signal } = {}) {
    const report = await this.probe();
    if (!report.available || !request.isolationRequired || !request.snapshotHash ||
        typeof this.snapshotLookup !== 'function') {
      return reply(request, 'isolation_unavailable', report.reasons.length ? report.reasons : ['An immutable, broker-owned OS-isolated snapshot is required.']);
    }
    if (this.active.size) return reply(request, 'blocked', ['Windows Sandbox single-instance slot is already owned.']);
    signal?.throwIfAborted();
    const snapshot = await this.snapshotLookup(request.snapshotId);
    if (!snapshot || snapshot.contentHash !== request.snapshotHash) {
      return reply(request, 'blocked', ['Snapshot identity or content hash mismatch.']);
    }
    await verifyExecutionSnapshot(snapshot);
    const runGeneration = randomUUID();
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const owner = { runId: request.runId, generation: runGeneration, instanceId: null, state: 'intent' };
    const runDir = path.join(this.stateDirectory, 'runs', runGeneration);
    const ownershipPath = path.join(runDir, 'ownership.json');
    let lock;
    try {
      await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
      lock = await fs.open(path.join(this.stateDirectory, 'active.lock'), 'wx', 0o600);
      await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
      const persist = async () => fs.writeFile(ownershipPath, JSON.stringify(owner), { mode: 0o600 });
      await persist(); // durable launch intent before touching wsb
      this.active.set(request.runId, { owner, controller });
      if (controller.signal.aborted) return reply(request, 'cancelled', ['Cancelled before launch.']);
      owner.state = 'launching'; await persist();
      const started = await this.driver.start({ request, snapshot, generation: runGeneration, signal: controller.signal });
      if (!started || !/^[a-f0-9-]{36}$/i.test(started.instanceId || '')) {
        this.quarantined = true;
        throw fault('unknown_instance', 'Sandbox started without an independently tracked owned UUID.');
      }
      owner.instanceId = started.instanceId; owner.state = 'running'; await persist();
      if (controller.signal.aborted) return reply(request, 'cancelled', ['Cancelled after guest launch.']);
      const raw = await this.driver.execute({ request, snapshot, instanceId: owner.instanceId, generation: runGeneration, signal: controller.signal });
      owner.state = 'collecting'; await persist();
      if (controller.signal.aborted) return reply(request, 'cancelled', ['Cancelled during output collection.']);
      const authenticated = await this.publisher.verify({ raw, request, snapshot, instanceId: owner.instanceId, generation: runGeneration });
      if (!authenticated || authenticated.publisherAuthenticated !== true) throw fault('unauthenticated_output', 'Publisher authentication did not succeed.');
      const receipt = validateExecutionReceipt(authenticated.receipt);
      if (receipt.runId !== request.runId || receipt.snapshotHash !== snapshot.contentHash ||
          receipt.checkHash !== request.checkHash || receipt.backend !== this.id) {
        throw fault('stale_receipt', 'Publisher receipt does not match the requested code/check/backend.');
      }
      return Object.freeze({...receipt,
        publisherAuthenticated:true,
        provenance:'publisher_authenticated'
      });
    } catch (e) {
      if (controller.signal.aborted) return reply(request, 'cancelled', ['Execution cancelled; see ownership reconciliation.']);
      return reply(request, 'error', [String(e.message || e).slice(0, 300)]);
    } finally {
      if (owner.instanceId) {
        try {
          // A driver returning nothing or claiming success without an owned-ID
          // confirmation is not evidence that termination finished.
          const stopped = await this.driver.stop({ instanceId: owner.instanceId, generation: runGeneration });
          if (!stopped || stopped.stopped !== true || stopped.instanceId !== owner.instanceId) {
            throw fault('unconfirmed_stop', 'Owned instance termination is not independently confirmed.');
          }
          owner.state = 'stopped';
        } catch {
          owner.state = 'quarantined'; this.quarantined = true;
        }
      } else if (owner.state === 'launching' || owner.state === 'running') {
        owner.state = 'quarantined'; this.quarantined = true;
      }
      try { if (runDir) await fs.writeFile(ownershipPath, JSON.stringify(owner)); } catch {}
      if (owner.state !== 'quarantined') {
        if (lock) {
          try {
            await lock.close();
            await fs.unlink(path.join(this.stateDirectory, 'active.lock'));
          } catch {
            owner.state = 'quarantined'; this.quarantined = true;
          }
        }
        if (owner.state !== 'quarantined') this.active.delete(request.runId);
      } else {
        await lock?.close().catch(() => {});
      }
      signal?.removeEventListener('abort', onAbort);
      // Override any already-prepared successful receipt when cleanup/ownership
      // cannot be confirmed. Returning success before finally would be a false
      // attestation and might allow the next worker to run in a shared guest.
      if (owner.state === 'quarantined') {
        return reply(request, 'error', ['Owned guest termination or state-lock cleanup is unverified; execution quarantined.']);
      }
    }
  }
  async cancel(runId) {
    const run = this.active.get(runId);
    if (!run) return false;
    run.controller.abort(new Error('Cancelled by owner.'));
    return true;
  }
}
