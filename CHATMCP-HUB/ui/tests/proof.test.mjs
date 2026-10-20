import test from 'node:test';
import assert from 'node:assert/strict';
import { assessProof } from '../src/lib/proof.ts';

const call = (name, status = 'success') => ({ name, status });
const base = (overrides = {}) => ({ status: 'completed', toolCalls: [], ...overrides });

test('a turn that only read and answered has nothing to prove', () => {
  assert.equal(assessProof(base({ toolCalls: [call('local.read_file'), call('local.list_directory')] }), [], true), null);
});

test('the Hub saying "ready" is not evidence: with no recorded check the strip is never green', () => {
  // verificationOutcome.ready is also true when no verification was required at all ("No complex task graph required").
  const proof = assessProof(base({
    toolCalls: [call('local.edit_file'), call('local.run_command')],
    verificationOutcome: { ready: true, missing: [], reason: 'No complex task graph required' },
  }), [], true);
  assert.equal(proof.tone, 'warning');
  assert.equal(proof.kind, 'no-evidence');
  assert.match(proof.note, /Phản hồi của model không phải bằng chứng/);
});

test('exit code 0 without a verified test outcome stays amber and says so', () => {
  const proof = assessProof(base({ toolCalls: [call('local.run_command')] }), [{ status: 'completed', exitCode: 0, testOutcomeVerified: false }], false);
  assert.equal(proof.tone, 'warning');
  assert.equal(proof.kind, 'unverified-run');
  assert.match(proof.title, /test outcome not verified/i);
});

test('a check whose outcome the Hub verified turns green, and the note keeps the limit of what that proves', () => {
  const proof = assessProof(base({ toolCalls: [call('local.edit_file'), call('local.run_command')] }),
    [{ status: 'completed', exitCode: 0, testOutcomeVerified: true, snapshotHash: 'a1b2c3d4e5f6a7b8' }], true);
  assert.equal(proof.tone, 'success');
  assert.equal(proof.kind, 'checks-verified');
  assert.deepEqual(proof.chips, ['1 tệp đã sửa', '1 lệnh đã chạy', '1 kiểm tra đã xác minh', 'bản chụp a1b2c3d4']);
  assert.match(proof.note, /chưa chứng minh mọi yêu cầu đã đạt/);
});

test('a verified check does not outvote a missing piece of evidence the Hub still lists', () => {
  const proof = assessProof(base({ toolCalls: [call('local.edit_file')], verificationOutcome: { ready: false, missing: ['No independently recorded Git diff review'] } }),
    [{ status: 'completed', exitCode: 0, testOutcomeVerified: true }], false);
  assert.equal(proof.tone, 'warning');
  assert.equal(proof.kind, 'incomplete');
  assert.match(proof.note, /Git diff review/);
});

test('any tool error, failed check or failed task is red, whatever else is true', () => {
  assert.equal(assessProof(base({ toolCalls: [call('local.run_command', 'error')] }), [], true).tone, 'danger');
  assert.equal(assessProof(base({ toolCalls: [call('local.run_command')] }), [{ status: 'completed', exitCode: 1, testOutcomeVerified: true }], true).tone, 'danger');
  assert.equal(assessProof(base({ status: 'failed' }), [], true).tone, 'danger');
  // verified earlier, failed later: still red
  assert.equal(assessProof(base({ toolCalls: [call('local.run_command')] }), [{ status: 'completed', exitCode: 0, testOutcomeVerified: true }, { status: 'failed', exitCode: 2 }], true).tone, 'danger');
});

test('objectives the owner accepted against fresh receipts are shown as accepted, in the owner’s words', () => {
  const proof = assessProof(base({ toolCalls: [call('local.edit_file')], completionOutcome: { execution: 'answered', requirements: 'verified', verification: 'owner_accepted_with_fresh_receipts', unresolvedObjectiveIds: [], missingChecks: [] } }), [], true);
  assert.equal(proof.tone, 'success');
  assert.equal(proof.kind, 'accepted');
});

test('only a model-reported completion (no check, no acceptance) never produces success', () => {
  for (const verificationOutcome of [undefined, { ready: true, missing: [] }]) {
    const proof = assessProof(base({ toolCalls: [call('local.write_file')], verificationOutcome, completionOutcome: { execution: 'answered', requirements: 'unverified', verification: 'not_applicable', unresolvedObjectiveIds: ['o1'], missingChecks: [] } }), [], true);
    assert.notEqual(proof.tone, 'success');
  }
});
