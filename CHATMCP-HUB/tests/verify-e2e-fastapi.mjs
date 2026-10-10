// End-to-end scenario 1: build a small FastAPI service from nothing, test-first, and keep going on it.
//
// The project starts as a README and a .gitignore. A scripted model writes the tests first, runs them (they must fail: there is no
// app yet), writes the app, runs them again (they must pass), and in a second task, in Autonomous mode, adds an endpoint and its
// test and runs pytest again without a single question. What the suite looks at is what is true afterwards, not what the model
// says: the files on disk, a pytest run and a real uvicorn server started by this suite itself, the approvals that were asked,
// and the evidence the Hub kept (a failing run is not verification; a passing one is).
//
// It needs a Python with fastapi, httpx, pytest and uvicorn. Where there is none it reports SKIP, with the exact steps to make one:
//   python -m venv deploy/.generated/venv-e2e
//   deploy/.generated/venv-e2e/bin/pip install -r CHATMCP-HUB/tests/requirements-e2e.txt   (from the repository root; Windows: ...\Scripts\pip.exe)
// or point CHATMCP_E2E_PYTHON at any interpreter that has them. The scripted model proves the Hub, its tools and its permission
// gate work together on a Python project; it does not prove that any real model writes a good FastAPI service.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { runScenario } from './e2e/harness.mjs';
import { HUB_ROOT, answerApprovals, connectModel, freePort, setMode, sleep, startTask, waitFor } from './e2e/hub-process.mjs';
import { exists, git, gitInit, read, writeFiles } from './e2e/fixtures.mjs';
import { call, exitedZero, sequence, shaOf, toolText } from './e2e/scenarios.mjs';

const REQUIRED = ['fastapi', 'httpx', 'pytest', 'uvicorn'];
const COMMAND = 'python -m pytest -q';

// ---- the project the model starts from, and the files it writes ---------------------------------------------------------------
const START = {
  'README.md': '# Todo API\n\nMột dịch vụ nhỏ để thử agent.\n',
  '.gitignore': '__pycache__/\n.pytest_cache/\n.venv/\n',
};
const REQUIREMENTS = 'fastapi\nuvicorn\nhttpx\npytest\n';
const TESTS = `from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_create_and_read_todo():
    created = client.post("/todos", json={"title": "write tests"})
    assert created.status_code == 201
    body = created.json()
    assert body["title"] == "write tests"
    assert body["done"] is False
    fetched = client.get(f"/todos/{body['id']}")
    assert fetched.status_code == 200
    assert fetched.json() == body


def test_missing_todo_is_404():
    assert client.get("/todos/999999").status_code == 404


def test_title_is_required():
    assert client.post("/todos", json={}).status_code == 422
`;
const INIT = '"""Todo API."""\n';
const MAIN = `"""A small in-memory todo API."""
import itertools

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Todo API")

_todos = {}
_ids = itertools.count(1)


class TodoIn(BaseModel):
    title: str


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/todos", status_code=201)
def create_todo(item: TodoIn) -> dict:
    todo_id = next(_ids)
    todo = {"id": todo_id, "title": item.title, "done": False}
    _todos[todo_id] = todo
    return todo


@app.get("/todos/{todo_id}")
def read_todo(todo_id: int) -> dict:
    if todo_id not in _todos:
        raise HTTPException(status_code=404, detail="todo not found")
    return _todos[todo_id]
`;
const DELETE_ENDPOINT = `    return _todos[todo_id]


@app.delete("/todos/{todo_id}")
def delete_todo(todo_id: int) -> dict:
    if _todos.pop(todo_id, None) is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return {"deleted": todo_id}`;
const DELETE_TEST = `    assert client.post("/todos", json={}).status_code == 422


def test_delete_todo():
    created = client.post("/todos", json={"title": "to delete"}).json()
    assert client.delete(f"/todos/{created['id']}").json() == {"deleted": created["id"]}
    assert client.get(f"/todos/{created['id']}").status_code == 404
    assert client.delete(f"/todos/{created['id']}").status_code == 404`;

// ---- finding a Python that can run it ------------------------------------------------------------------------------------------
function candidates() {
  const list = [];
  if (process.env.CHATMCP_E2E_PYTHON) list.push({ command: process.env.CHATMCP_E2E_PYTHON, prefix: [] });
  const venv = path.resolve(HUB_ROOT, '..', 'deploy', '.generated', 'venv-e2e');
  list.push({ command: path.join(venv, process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python')), prefix: [] });
  if (process.platform === 'win32') list.push({ command: 'python', prefix: [] }, { command: 'py', prefix: ['-3'] });
  else list.push({ command: 'python3', prefix: [] }, { command: 'python', prefix: [] });
  return list;
}

function findPython() {
  const seen = [];
  for (const { command, prefix } of candidates()) {
    const probe = spawnSync(command, [...prefix, '-c', `import importlib.util, sys; missing = [m for m in ${JSON.stringify(REQUIRED)} if importlib.util.find_spec(m) is None]; print(sys.executable); print(sys.version.split()[0]); print(','.join(missing))`], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (probe.error || probe.status !== 0) continue;
    const [executable, version, missing] = probe.stdout.trim().split(/\r?\n/);
    if (!missing) return { command, prefix, executable, version };
    seen.push(`${executable} (Python ${version}) lacks ${missing}`);
  }
  return { missing: seen };
}

/** The same interpreter the Hub's shell will find as `python`: its folder goes first on PATH. */
function pathWith(folder) {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  return { [key]: `${folder}${path.delimiter}${process.env[key] ?? ''}` };
}

const httpCall = (port, method, route, body = null) => new Promise((resolve, reject) => {
  const payload = body === null ? null : JSON.stringify(body);
  const request = http.request({ host: '127.0.0.1', port, method, path: route, timeout: 5000, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
  });
  request.on('error', reject);
  request.on('timeout', () => request.destroy(new Error('timeout')));
  if (payload) request.write(payload);
  request.end();
});

await runScenario({
  name: 'fastapi',
  summary: 'test-first FastAPI service in Review mode (red run, then green run), pytest and a real uvicorn server run by the suite, a second task in Autonomous mode adds an endpoint with no question asked',
  budgetMs: 170_000,
}, async (t) => {
  const python = findPython();
  if (!python.executable) {
    t.skip(`no Python with ${REQUIRED.join(', ')} found${python.missing.length ? ` (${python.missing.join('; ')})` : ''}. Create one: python -m venv deploy/.generated/venv-e2e, then pip install -r CHATMCP-HUB/tests/requirements-e2e.txt into it (from the repository root), or set CHATMCP_E2E_PYTHON.`);
  }
  t.note(`using Python ${python.version} at ${python.executable}`);
  const pythonFolder = path.dirname(python.executable);
  const project = path.join(t.scratch, 'todo-api');
  writeFiles(project, START);
  gitInit(project, t.scratch);

  const results = [];
  const mock = await t.mock({
    scenario: 'build',
    scenarios: {
      build: sequence([
        call('list_directory', {}),
        call('write_file', { path: 'requirements.txt', content: REQUIREMENTS }),
        call('write_file', { path: 'tests/test_main.py', content: TESTS }),
        call('run_command', { command: COMMAND, description: 'Chạy test (chưa có app nên phải đỏ)', timeout_seconds: 120 }),
        call('write_file', { path: 'app/__init__.py', content: INIT }),
        call('write_file', { path: 'app/main.py', content: MAIN }),
        call('run_command', { command: COMMAND, description: 'Chạy lại test (phải xanh)', timeout_seconds: 120 }),
      ], {
        onResult: (index, text) => { results[index] = text; },
        final: (ctx) => (exitedZero(ctx.last) ? 'Đã tạo dịch vụ Todo API: viết test trước (đỏ), thêm app, pytest -q thành công.' : 'pytest vẫn thất bại sau khi thêm app.'),
      }),
      'add-delete': sequence([
        call('read_file', { path: 'app/main.py' }),
        (ctx) => call('edit_file', { path: 'app/main.py', old_string: '    return _todos[todo_id]', new_string: DELETE_ENDPOINT, expected_sha256: shaOf(ctx.last) }),
        call('read_file', { path: 'tests/test_main.py' }),
        (ctx) => call('edit_file', { path: 'tests/test_main.py', old_string: '    assert client.post("/todos", json={}).status_code == 422', new_string: DELETE_TEST, expected_sha256: shaOf(ctx.last) }),
        call('run_command', { command: COMMAND, description: 'Chạy test sau khi thêm DELETE', timeout_seconds: 120 }),
      ], {
        onResult: (index, text) => { results[100 + index] = text; },
        final: (ctx) => (exitedZero(ctx.last) ? 'Đã thêm DELETE /todos/{id} cùng test; pytest -q thành công.' : 'pytest thất bại sau khi thêm DELETE.'),
      }),
    },
  });
  const hub = await t.hub({ project, env: pathWith(pythonFolder) });
  await connectModel(hub, mock);
  await setMode(hub, 'review');

  // ---- A. build it, test first, in Review mode --------------------------------------------------------------------------------
  const started = await startTask(hub, 'Tạo dịch vụ FastAPI quản lý todo: GET /health, POST /todos, GET /todos/{id}. Viết test trước, chạy rồi mới viết app.');
  const decisions = [];
  const first = await answerApprovals(hub, started.id, (request) => { decisions.push(request); return true; }, { timeoutMs: 120_000 });
  t.equal(first.task.state, 'completed', 'the task ends completed');
  t.equal(first.answered.map((request) => request.toolName), ['local.write_file', 'local.write_file', 'local.run_command', 'local.write_file', 'local.write_file', 'local.run_command'], 'Review mode asked for each of the four files and each of the two pytest runs, and not for listing the folder');
  t.check(first.answered.filter((request) => request.toolName === 'local.run_command').every((request) => request.summary?.includes('pytest')), 'the person was shown the pytest command before it ran', first.answered.map((request) => request.summary).join(' | '));

  const red = toolText(results[3]);
  t.check(!exitedZero(results[3]) && /No module named 'app'/.test(red), 'the first pytest run failed, for the right reason: there was no app yet', red.replace(/\s+/g, ' ').slice(0, 200));
  const green = toolText(results[6]);
  t.check(exitedZero(results[6]) && /4 passed/.test(green), 'the second pytest run passed all four tests', green.replace(/\s+/g, ' ').slice(0, 200));

  t.equal(read(project, 'requirements.txt'), REQUIREMENTS, 'requirements.txt is on disk as written');
  t.check(exists(project, 'app', '__init__.py') && read(project, 'app', 'main.py') === MAIN && read(project, 'tests', 'test_main.py') === TESTS, 'app/ and tests/ hold exactly what the model wrote (the Hub created the folders)');
  const untracked = git(project, t.scratch, ['status', '--porcelain', '-uall']).stdout.split('\n').map((line) => line.trim()).sort();
  t.equal(untracked, ['?? app/__init__.py', '?? app/main.py', '?? requirements.txt', '?? tests/test_main.py'], 'Git sees exactly the four new files (caches are ignored)');

  const pytestRun = (cwd) => spawnSync(python.command, [...python.prefix, '-m', 'pytest', '-q'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  const independent = pytestRun(project);
  t.check(independent.status === 0 && /4 passed/.test(independent.stdout), 'pytest, run independently by this suite, passes', `exit ${independent.status} ${independent.stdout.replace(/\s+/g, ' ').slice(-160)}`);

  // The app the agent wrote must really serve HTTP, not only pass its own tests.
  const serve = async (label) => {
    const port = await freePort();
    const server = spawn(python.command, [...python.prefix, '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'], { cwd: project, stdio: 'ignore', windowsHide: true });
    const stop = () => { if (server.exitCode !== null) return; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); else server.kill('SIGKILL'); };
    t.own(stop);
    await waitFor(async () => {
      if (server.exitCode !== null) throw Object.assign(new Error(`uvicorn exited early with code ${server.exitCode}`), { fatal: true });
      const response = await httpCall(port, 'GET', '/health').catch(() => null);
      return response?.status === 200 ? response : null;
    }, { timeoutMs: 40_000, label: `uvicorn (${label}) to answer /health` });
    return { port, stop };
  };
  const firstServer = await serve('built by task 1');
  const healthResponse = await httpCall(firstServer.port, 'GET', '/health');
  t.equal([healthResponse.status, JSON.parse(healthResponse.text)], [200, { status: 'ok' }], 'a real uvicorn server started by this suite answers GET /health');
  t.equal((await httpCall(firstServer.port, 'GET', '/todos/1')).status, 404, 'and answers 404 for a todo that does not exist');
  t.equal((await httpCall(firstServer.port, 'DELETE', '/todos/1')).status, 405, 'DELETE does not exist yet (that is the next task)');
  firstServer.stop();

  const workflowA = (await hub.get(`/api/studio/workflow?taskId=${started.id}`)).json;
  t.check(workflowA.editsObserved === 4 && workflowA.checksObserved === 1 && workflowA.verified === true, 'the workflow counts four file edits and ONE check: the failing run is not verification, the passing run is', JSON.stringify({ e: workflowA.editsObserved, c: workflowA.checksObserved, v: workflowA.verified }));
  const taskA = await hub.task(started.id);
  t.equal(taskA.unverifiedCount, 0, 'no operation is left unverified');

  // ---- B. keep going in Autonomous mode: edits and pytest need no question ----------------------------------------------------
  await setMode(hub, 'autonomous');
  mock.setScenario('add-delete');
  const second = await startTask(hub, 'Thêm DELETE /todos/{id} và test cho nó, rồi chạy pytest.');
  const autonomous = await answerApprovals(hub, second.id, () => true, { timeoutMs: 120_000 });
  t.equal(autonomous.task.state, 'completed', 'the second task ends completed');
  t.equal(autonomous.answered, [], 'Autonomous mode asked nothing: two edits and a pytest run went through on their own');
  t.check(read(project, 'app', 'main.py').includes('def delete_todo') && read(project, 'tests', 'test_main.py').includes('def test_delete_todo'), 'the endpoint and its test are on disk');
  t.check(exitedZero(results[104]) && /5 passed/.test(toolText(results[104])), 'pytest passed all five tests', toolText(results[104]).replace(/\s+/g, ' ').slice(0, 200));
  const again = pytestRun(project);
  t.check(again.status === 0 && /5 passed/.test(again.stdout), 'and so does a run by this suite', `exit ${again.status} ${again.stdout.replace(/\s+/g, ' ').slice(-160)}`);
  const workflowB = (await hub.get(`/api/studio/workflow?taskId=${second.id}`)).json;
  t.check(workflowB.editsObserved === 2 && workflowB.checksObserved === 1 && workflowB.verified === true, 'the workflow counts two edits and one passing check', JSON.stringify({ e: workflowB.editsObserved, c: workflowB.checksObserved, v: workflowB.verified }));
  t.equal((await hub.get(`/api/studio/checkpoints`)).json.filter((item) => /local\.edit_file/.test(item.label) && item.label.includes(second.id)).length, 2, 'a checkpoint was taken before each of the two edits, so both can be reviewed and undone');

  // A fresh server on the final code: the new endpoint works over real HTTP.
  const secondServer = await serve('after task 2');
  const made = await httpCall(secondServer.port, 'POST', '/todos', { title: 'over http' });
  const todo = JSON.parse(made.text);
  t.equal([made.status, todo.title, todo.done], [201, 'over http', false], 'a todo can be created over HTTP');
  const removed = await httpCall(secondServer.port, 'DELETE', `/todos/${todo.id}`);
  t.equal([removed.status, JSON.parse(removed.text)], [200, { deleted: todo.id }], 'the endpoint the agent added in task 2 deletes it over HTTP');
  t.equal((await httpCall(secondServer.port, 'GET', `/todos/${todo.id}`)).status, 404, 'and it is gone');
  secondServer.stop();
  await sleep(200);
});
