// End-to-end scenario 3: work on a branch, commit, and publish only with the person's say-so.
//
// Autonomous mode lets the agent edit files and make commits by itself, because both can be undone. Publishing cannot: a push
// leaves the machine. This suite runs the whole flow against a real local project and a bare repository standing in for GitHub
// (so a push really happens, with no network and no account), and checks on disk and in the remote that
//   - the branch, the edit, the test run, the staging and the commit all happened without a single question,
//   - the push was put to the person even in Autonomous mode, classed dangerous, and a refused push left the remote untouched,
//   - an approved push put exactly the local commit on the remote branch, and nothing else moved,
//   - a force push that would rewrite the remote branch was a separate question and, refused, changed nothing,
//   - Git bookkeeping (branch, add, commit) is not counted as editing files in the workflow evidence.
// Opening a pull request needs a GitHub account and network access, so that last step is reported as BLOCKED, not faked; what
// can be checked offline is that `gh pr create` would be put to the person too.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { runScenario } from './e2e/harness.mjs';
import { answerApprovals, connectModel, continueTask, setMode, startTask } from './e2e/hub-process.mjs';
import { branchesOf, git, gitInit, makeBareRemote, makeCalcProject, slashes } from './e2e/fixtures.mjs';
import { call, sequence, shaOf, wasRefused } from './e2e/scenarios.mjs';

const BRANCH = 'fix/add-sum';
const COMMIT_SUBJECT = 'fix: add() must add';

await runScenario({
  name: 'git',
  summary: 'branch, edit, test, add and commit unasked in Autonomous mode; push always asked (dangerous), refused push leaves the remote alone, approved push lands the commit, force push asked separately',
  budgetMs: 120_000,
}, async (t) => {
  const project = path.join(t.scratch, 'calc-app');
  makeCalcProject(project);
  const base = gitInit(project, t.scratch);
  const remote = makeBareRemote(t.scratch, t.scratch);
  git(project, t.scratch, ['remote', 'add', 'origin', slashes(remote)]);
  git(project, t.scratch, ['push', '-q', 'origin', 'main']);
  const head = () => git(project, t.scratch, ['rev-parse', 'HEAD']).stdout;
  const remoteRef = (name) => git(remote, t.scratch, ['rev-parse', '--verify', '-q', `refs/heads/${name}`], { allowFailure: true }).stdout;
  t.equal(branchesOf(remote, t.scratch), ['main'], 'before: the remote has main and nothing else');

  const mock = await t.mock({
    scenario: 'fix-and-push',
    scenarios: {
      'fix-and-push': sequence([
        call('git_status'),
        call('git_branch', { action: 'create', name: BRANCH }),
        call('read_file', { path: 'calc.js' }),
        (ctx) => call('edit_file', { path: 'calc.js', old_string: 'return a - b;', new_string: 'return a + b;', expected_sha256: shaOf(ctx.last) }),
        call('run_command', { command: 'node test.js', description: 'Chạy kiểm thử' }),
        call('git_diff'),
        call('git_add', { paths: ['calc.js'] }),
        call('git_commit', { message: `${COMMIT_SUBJECT}\n\nadd(2, 3) returned -1.` }),
        call('run_command', { command: `git push -u origin ${BRANCH}`, description: 'Đẩy nhánh lên origin' }),
      ], { final: (ctx) => (wasRefused(ctx.last) ? 'Commit đã có trên nhánh cục bộ nhưng push bị từ chối nên chưa đẩy lên origin.' : 'Đã đẩy nhánh lên origin.') }),
      'push-only': sequence([
        call('run_command', { command: `git push -u origin ${BRANCH}` }),
        // The destructive one: make the remote branch point back at main, throwing the fix away.
        call('run_command', { command: `git push --force origin main:${BRANCH}` }),
        call('run_command', { command: 'gh pr create --title "fix: add() must add" --body "add(2, 3) returned -1."' }),
      ], { final: 'Xong các thao tác đẩy mã.' }),
    },
  });
  const hub = await t.hub({ project });
  await connectModel(hub, mock);
  await setMode(hub, 'autonomous');

  // ---- 1. the whole local flow, then a push the person refuses -------------------------------------------------------------
  const started = await startTask(hub, `Sửa lỗi add() trên nhánh ${BRANCH}, chạy test, commit rồi push lên origin.`);
  const refusedPush = [];
  const first = await answerApprovals(hub, started.id, (request) => { refusedPush.push(request); return false; });
  t.equal(first.task.state, 'completed', 'the task ends completed');
  t.equal(first.answered.length, 1, 'branch, edit, test, add and commit ran without a single question: only one question was asked');
  const push = first.answered[0];
  t.check(push?.toolName === 'local.run_command' && push?.category === 'dangerous' && /git push/.test(push?.summary ?? ''), 'and it was the push, classed dangerous', `${push?.toolName} ${push?.category} ${push?.summary}`);
  t.equal(git(project, t.scratch, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout, BRANCH, 'the work is on the new branch');
  t.equal(git(project, t.scratch, ['log', '-1', '--format=%s']).stdout, COMMIT_SUBJECT, 'the commit has the message the model wrote');
  t.equal(git(project, t.scratch, ['log', '-1', '--format=%an <%ae>']).stdout, 'E2E Tester <e2e@example.invalid>', 'and the identity configured in the repository');
  t.equal(git(project, t.scratch, ['show', '--name-only', '--format=', 'HEAD']).stdout, 'calc.js', 'the commit contains exactly calc.js');
  t.equal(git(project, t.scratch, ['rev-list', '--count', 'HEAD']).stdout, '2', 'one commit on top of the initial one');
  t.equal(git(project, t.scratch, ['status', '--porcelain']).stdout, '', 'the working tree is clean afterwards');
  const test = spawnSync(process.execPath, ['test.js'], { cwd: project, encoding: 'utf8', windowsHide: true });
  t.check(test.status === 0 && test.stdout.includes('add() ok'), 'the committed code passes the project test, run independently by this suite', `exit ${test.status}`);
  t.equal(branchesOf(remote, t.scratch), ['main'], 'the refused push left the remote with main only');
  t.equal(remoteRef('main'), base, 'and main on the remote is where it was');
  t.check(/push bị từ chối/.test(first.task.finalText ?? ''), 'the task says honestly that the push did not happen', first.task.finalText);
  const workflow = (await hub.get(`/api/studio/workflow?taskId=${started.id}`)).json;
  t.check(workflow.editsObserved === 1 && workflow.checksObserved === 1 && workflow.verified === true, 'the workflow counts one file edit (branch, add and commit are not file edits) and one passing check', JSON.stringify({ e: workflow.editsObserved, c: workflow.checksObserved, v: workflow.verified }));

  // ---- 2. the person approves the push, refuses the force push and the pull request ----------------------------------------
  mock.setScenario('push-only');
  const localCommit = head();
  await continueTask(hub, started.id, 'Được rồi, hãy push nhánh lên origin.');
  const decisions = [];
  const second = await answerApprovals(hub, started.id, (request) => {
    const allow = /git push -u origin/.test(request.summary ?? '');
    decisions.push(`${allow ? 'allow' : 'deny'}: ${request.summary}`);
    return allow;
  });
  t.equal(second.task.state, 'completed', 'the continued task completes');
  t.equal(second.answered.length, 3, 'three separate questions: the push, the force push, the pull request (approval is per command, not per task)');
  t.check(second.answered.slice(0, 2).every((request) => request.category === 'dangerous'), 'push and force push are both classed dangerous', second.answered.map((request) => request.category).join(','));
  t.check(second.answered[2]?.category === 'execute' && /gh pr create/.test(second.answered[2]?.summary ?? ''), '`gh pr create` is put to the person as well (it leaves the machine and needs their credentials)', `${second.answered[2]?.category} ${second.answered[2]?.summary}`);
  t.equal(second.answered.map((request) => request.approved), [true, false, false], 'only the plain push was approved');
  t.equal(remoteRef(BRANCH), localCommit, 'the remote branch now points at exactly the local commit');
  t.equal(remoteRef('main'), base, 'main on the remote did not move');
  t.equal(branchesOf(remote, t.scratch).sort(), ['main', BRANCH].sort(), 'the remote has main and the new branch, nothing else');
  t.check(remoteRef(BRANCH) !== base, 'the refused force push did not rewrite the remote branch back to main');
  t.equal(git(project, t.scratch, ['rev-parse', `refs/remotes/origin/${BRANCH}`]).stdout, localCommit, 'and the local remote-tracking branch agrees');

  t.blocked('opening a pull request on GitHub', 'needs a GitHub account, a token and network access to github.com; this build has no GitHub integration of its own (the agent would run `gh pr create`, which is always put to the person) and the suite never uses real credentials');
});
