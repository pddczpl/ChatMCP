import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { assessProof } from '../src/lib/proof.ts';

// The strip under a finished turn, when the turn FAILED, and what its "View evidence" button does. Reported on 2026-10-28: the request to the model failed with a gateway 504 (every tool
// call of the turn had succeeded), and the strip said that "one or more tools or checks reported an error" and offered the evidence, a button that went to the Progress tab, which was open already
// and held nothing, because no tool and no check had failed. Nothing happened when it was pressed.
const call = (name, status = 'success') => ({ name, status });
const failed = (overrides = {}) => ({ status: 'failed', toolCalls: [call('local.read_file')], error: 'Gateway HTTP 504: Gateway request timed out Kiểm tra gateway.', ...overrides });

test('a turn that failed on the request, with no tool and no check in error, says that and nothing about tools', () => {
  for (const vi of [true, false]) {
    const proof = assessProof(failed(), [], vi);
    assert.equal(proof.kind, 'failed-turn');
    assert.equal(proof.tone, 'danger');
    assert.match(proof.note, /Gateway HTTP 504/, 'the reason the Hub recorded is in the strip');
    assert.doesNotMatch(proof.note, /công cụ hay kiểm tra báo lỗi|tools or checks reported an error/, 'no tool or check reported an error');
    assert.equal(proof.evidence, false, 'nothing was recorded that the evidence tab could show');
  }
});

test('without a recorded reason the strip still says that the turn stopped before any check', () => {
  const proof = assessProof(failed({ error: undefined }), [], true);
  assert.equal(proof.kind, 'failed-turn');
  assert.match(proof.note, /trước khi Hub ghi nhận kiểm tra nào/);
  assert.match(assessProof(failed({ error: '' }), [], false).note, /before the Hub recorded any check/);
});

test('a long reason is cut, so that the strip stays a strip', () => {
  const proof = assessProof(failed({ error: 'x'.repeat(2000) }), [], false);
  assert.ok(proof.note.length < 400, `the note is ${proof.note.length} characters`);
  assert.match(proof.note, /…$/);
});

test('a tool in error, or a check that failed, still gets the evidence, failed turn or not', () => {
  const toolError = assessProof({ status: 'completed', toolCalls: [call('local.run_command', 'error')] }, [], true);
  assert.equal(toolError.kind, 'errors');
  assert.equal(toolError.evidence, true);
  const checkFailed = assessProof({ status: 'completed', toolCalls: [call('local.run_command')] }, [{ status: 'failed', exitCode: 1 }], true);
  assert.equal(checkFailed.kind, 'errors');
  assert.equal(checkFailed.evidence, true);
  const both = assessProof(failed({ toolCalls: [call('local.edit_file', 'error')] }), [], true);
  assert.equal(both.kind, 'errors', 'a failed turn that also has a tool in error keeps the old words: there IS an error to look at');
  assert.equal(both.evidence, true);
});

test('every other kind keeps its evidence button', () => {
  const kinds = [
    assessProof({ status: 'completed', toolCalls: [call('local.edit_file'), call('local.run_command')] }, [], true),
    assessProof({ status: 'completed', toolCalls: [call('local.run_command')] }, [{ status: 'completed', exitCode: 0, testOutcomeVerified: false }], true),
    assessProof({ status: 'completed', toolCalls: [call('local.run_command')] }, [{ status: 'completed', exitCode: 0, testOutcomeVerified: true }], true),
  ];
  for (const proof of kinds) assert.equal(proof.evidence, true, proof.kind);
});

// ---- the component: the button is there only when there is evidence, and pressing it does something the person can see
const loaded = await bundleTsx(`
  ${renderPrelude}
  import { ProofStrip } from './src/components/conversation/ProofStrip';
  import { useAppStore } from './src/store/useAppStore';
  export { ProofStrip, useAppStore };
`, 'chatmcp-proof-strip-', { recordJsx: true });
after(loaded.dispose);
const toasts = [];
const showToast = (message, type) => { toasts.push([message, type]); };
async function render(task, runs, lang = 'vi') {
  globalThis.__chatmcpJsx = [];
  const html = await loaded.loaded.renderWith(loaded.loaded.ProofStrip, { task: { id: 't1', messages: [], ...task } }, [[['verification-evidence', 't1'], { runs }]], [], { lang, showToast, activeTab: 'plan' });
  return { html, elements: globalThis.__chatmcpJsx.slice() };
}

test('a turn that failed on the request offers no evidence button; a turn with a tool in error does', async () => {
  const request = await render(failed(), []);
  assert.match(request.html, /data-kind="failed-turn"/);
  assert.doesNotMatch(request.html, /Xem bằng chứng/, 'no button to a tab that has nothing to show');
  const tool = await render({ status: 'completed', toolCalls: [call('local.run_command', 'error')] }, []);
  assert.match(tool.html, /data-kind="errors"/);
  assert.match(tool.html, /Xem bằng chứng/);
  const english = await render({ status: 'completed', toolCalls: [call('local.run_command', 'error')] }, [], 'en');
  assert.match(english.html, /View evidence/);
});

test('pressing it brings the evidence into view, and says so when the Hub has recorded no check', async () => {
  const scrolled = [];
  const queries = [];
  globalThis.document = { querySelector: (selector) => { queries.push(selector); return { scrollIntoView: (options) => scrolled.push(options) }; } };
  globalThis.requestAnimationFrame = (callback) => callback(0);
  try {
    for (const lang of ['vi', 'en']) {
      toasts.length = 0; scrolled.length = 0; queries.length = 0;
      const { elements } = await render({ status: 'completed', toolCalls: [call('local.run_command', 'error')] }, [], lang);
      const button = elements.find((element) => element.type === 'button' && typeof element.props.onClick === 'function');
      button.props.onClick();
      assert.deepEqual(queries, ['[data-testid="verification-receipts"]'], `${lang}: it looks for the evidence section of the Progress tab`);
      assert.equal(scrolled.length, 1, `${lang}: and brings it into view, which is what the person sees when the tab was open already`);
      assert.equal(toasts.length, 1, `${lang}: no check is recorded, so it says so instead of doing nothing`);
      assert.equal(toasts[0][1], 'info');
      assert.match(toasts[0][0], lang === 'vi' ? /chưa ghi nhận kiểm tra nào/ : /has not recorded a check/);
    }
    toasts.length = 0; scrolled.length = 0;
    const withCheck = await render({ status: 'completed', toolCalls: [call('local.run_command', 'error')] }, [{ status: 'failed', exitCode: 1, command: 'npm test' }]);
    withCheck.elements.find((element) => element.type === 'button' && typeof element.props.onClick === 'function').props.onClick();
    assert.equal(scrolled.length, 1, 'a recorded check is brought into view too');
    assert.deepEqual(toasts, [], 'and there is nothing to apologise for');
  } finally {
    delete globalThis.document;
    delete globalThis.requestAnimationFrame;
  }
});
