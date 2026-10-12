// Host-only authenticated publication reader. A valid HMAC proves that the
// publisher held the per-run key; it does not prove that project tests are
// sufficient, that guest process isolation succeeded, or that the key was
// inaccessible to all lower-privileged code. The latter requires a real OS
// security gate before any production work can be allowed.
import { fault, validateExecutionReceipt } from './execution-contract.mjs';
import { readAndVerifyExecutionReceipt } from './windows-sandbox-transport.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KEY = /^[a-f0-9]{64}$/i;
export class WindowsSandboxPublisher {
  constructor({ hostAttested = false } = {}) {
    // Host-specific OS evidence and operator approval are prerequisites.
    // The Local Hub constructs its publisher with false until that gate exists.
    // Never accept this setting from model data or an HTTP JSON request.
    this.productionAuthenticated = hostAttested === true;
  }
  async verify({ raw, request, snapshot, instanceId, generation } = {}) {
    if (!raw || !request || !snapshot || !UUID.test(instanceId || '') ||
        !UUID.test(generation || '') || raw.instanceId !== instanceId ||
        raw.generation !== generation || raw.runId !== request.runId ||
        raw.cliExitCode === undefined || !Number.isInteger(raw.cliExitCode) ||
        !KEY.test(raw.expectedAuthKey || '') || !KEY.test(raw.expectedNonce || '')) {
      throw fault('untrusted_publisher_context', 'Missing host-owned instance, run generation, nonce, key or CLI execution outcome.');
    }
    if (typeof raw.exportDirectory !== 'string') {
      throw fault('untrusted_export', 'Host-owned receipt directory is unavailable.');
    }
    const evidence = await readAndVerifyExecutionReceipt({
      exportDirectory: raw.exportDirectory, expectedRunId: request.runId,
      expectedNonce: raw.expectedNonce, expectedAuthKey: raw.expectedAuthKey,
      backend: 'windows-sandbox',
    });
    if (evidence.publisherAuthenticated !== true ||
        evidence.provenance !== 'publisher_authenticated') {
      throw fault('unverified_guest_origin', 'No verified supervisor publisher was observed.');
    }
    // The OS-owned execution result must agree with the signed supervisor
    // receipt: a forged zero exit is never an accepted verification.
    if (evidence.status === 'completed' && (evidence.exitCode !== 0 || raw.cliExitCode !== 0)) {
      throw fault('contradictory_exit', 'Windows CLI and signed receipt disagree about successful completion.');
    }
    if (evidence.status !== 'completed' && raw.cliExitCode === 0) {
      throw fault('contradictory_exit', 'Windows CLI reported success despite signed execution failure.');
    }
    if (!request.snapshotHash || request.snapshotHash !== snapshot.contentHash ||
        !request.checkHash) {
      throw fault('stale_receipt', 'Execution request no longer matches the host-controlled snapshot or check.');
    }
    const receipt = validateExecutionReceipt({
      ...evidence,
      backend: 'windows-sandbox',
      snapshotHash: snapshot.contentHash,
      checkHash: request.checkHash,
    });
    // The snapshot and check identity here are HOST-BOUND facts, not fields
    // supplied by arbitrary guest content. The fresh key/nonce and owned
    // instance must be protected by the host driver.
    return Object.freeze({
      publisherAuthenticated: true,
      testOutcomeVerified: false,
      receipt,
      provenance: 'publisher_authenticated',
    });
  }
}
