// Host-only publication reader. Production approves specific native-graded
// checks over the SYSTEM-sealed channel. Legacy HMAC is retained for diagnostic
// fixtures and supplies no authenticated Node test-outcome authority.
import { fault, validateExecutionReceipt } from './execution-contract.mjs';
import { readAndVerifyExecutionReceipt } from './windows-sandbox-transport.mjs';
import { SEALED_PROTOCOL, verifySealedCollection } from './windows-sandbox-sealed-receipt.mjs';
import { BLACKBOX_KIND, BLACKBOX_COMMAND } from './native-blackbox-contract.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KEY = /^[a-f0-9]{64}$/i;
export class WindowsSandboxPublisher {
  constructor({ hostAttested = false, attestedCheckKinds = [] } = {}) {
    // Reviewed OS evidence is a prerequisite for each allowed check kind.
    // Shipping assembly keeps the unrestricted diagnostic flag false.
    // Never accept this setting from model data or an HTTP JSON request.
    if(!Array.isArray(attestedCheckKinds) || attestedCheckKinds.some(kind=>kind!==BLACKBOX_KIND))
      throw fault('invalid_attested_check_kind','Only the reviewed native black-box check can receive scoped attestation.');
    this.attestedCheckKinds=Object.freeze([...new Set(attestedCheckKinds)]);
    this.diagnosticHostAttested=hostAttested===true;
    this.productionAuthenticated = this.diagnosticHostAttested || this.attestedCheckKinds.length>0;
  }
  supportsRequest(request) {
    // hostAttested is retained for explicitly injected diagnostic fixtures;
    // shipping assembly opts into specific reviewed kinds instead.
    return this.diagnosticHostAttested || (this.attestedCheckKinds.includes(request.checkKind) &&
      request.checkKind===BLACKBOX_KIND && request.command===BLACKBOX_COMMAND);
  }
  async verify({ raw, request, snapshot, instanceId, generation } = {}) {
    if(request?.checkKind===BLACKBOX_KIND && raw?.publicationProtocol!==SEALED_PROTOCOL)
      throw fault('unverified_guest_origin','Black-box grading requires native sealed publication.');
    if (raw?.publicationProtocol === SEALED_PROTOCOL) {
      return verifySealedCollection({ raw, request, snapshot, instanceId, generation });
    }
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
