# Review API (Hub side)

What the Hub tells a client about the work of one task, and the one thing a client may undo without a checkpoint. It is the data the Review tab (a later slice) and an editor over ACP read; of all this the page uses only the events of a tool call so far. Everything here is behind the per-launch bearer ([Hub authentication](HUB-AUTH.md)), and a POST also needs the page's Origin, request marker and CSRF token. Tests: `tests/verify-task-review.mjs` (the code, on a real `HubManager`), `tests/verify-e2e-review.mjs` (a real Hub process), `tests/verify-studio-http.mjs` (the text save).

## Events of a tool call

`tool_start`, `tool_result` and `tool_error` (in `task.events`, in `task.json`, in the live event stream and in `transcript.jsonl`) carry, besides the fields they always had:

| Field | On | Meaning |
| --- | --- | --- |
| `callId` | all three | the id the model gave the call (`call_id` in the transcript, `pendingCall.callId`). A model may make several calls to one tool in one turn, so the name of the tool does not pair a start with its result; `callId` does. A `tool_error` for a call the Hub refused to dispatch (an unknown function) has a `callId` and no start. |
| `input` | start, result | `{ path?, paths?, source?, destination?, command?, truncated? }`: what the call is about, taken from an allow-list of its arguments (`lib/tool-event-input.mjs`). Strings only; a path is cut at 300 characters, a command at 500, a list at 20 paths, and `truncated: true` says so. The text of a file, an edit or a patch is never in it. Absent when the call has nothing to announce. |
| `checkpointId` | result, error | the checkpoint the Hub made for THIS call before it ran (a call that changes files has one; a read has none). It is not inherited from an earlier call. |

The sentence of the event (`Đang gọi <tool>.` and the first 900 characters of the arguments) is unchanged. Older `task.json` files, which have none of these fields, load as they are.

How the page reads them (`ui/src/lib/task-view.ts`, `ui/src/lib/tool-labels.ts`): a `tool_result` or `tool_error` that has a `callId` settles the call whose start has that id, in the same run and only if that call has no result yet, and no other call: two calls of one tool in one turn keep their own results and their own `checkpointId`. A result whose id no start has (the refused call above) is an entry of its own. A result without an id (a task saved before the Hub sent ids; the browser transport, which sends none) is paired as it always was, by tool name: the last call of that name in the run that has no result yet. A receipt names a call by its `input` (the path, the command, `source → destination`, the list of paths, a `…` after it when `truncated`) and shows the sentence of the event only for a call that announced nothing.

## Checkpoints

`GET /api/studio/checkpoints` answers with `taskId` (null for a checkpoint a person asked for), `absentCount` and `seq` besides the old fields, and `POST /api/studio/checkpoint` with `taskId` and `absent`. A request can give a label and nothing else: which task a checkpoint belongs to and which files it covers are the Hub's own record of a tool call. A call that only creates files now has a checkpoint too (with `fileCount: 0`, because there was nothing to copy); restoring such a checkpoint answers `empty_checkpoint`, as it does for any empty one.

A checkpoint (`<state>/studio/checkpoints/<id>/meta.json`) records, for a call that names files (`write_file`, `edit_file`, `files_write_batch`, `move_path`, `delete_path`, ...), a copy of each file that exists and, in `absent`, each path the call is about to create (including the files that appear when a folder is moved). Paths are stored under the name the file has on disk (a Windows 8.3 short name or another spelling of the case is the same file), and a protected name is refused after that resolution. A call that can touch anything (`run_command`, `git_checkout`, ...) gets a snapshot of the source files of the workspace instead, shared only within the task that made it. `seq` numbers the checkpoints of a process: the clock has millisecond resolution and a long task makes several in one.

## `GET /api/studio/task-review?taskId=<uuid>`

For each file the task touched, the earliest checkpoint of the task that knows it is the baseline. The checkpoints are found by the task id in each `meta.json`, not through the list above (which stops at 100), so a task with 105 checkpoints still has its first as the baseline.

```json
{
  "taskId": "…",
  "checkpoints": { "total": 3, "targeted": 2, "broad": 1 },
  "files": [{
    "path": "src/app.py",
    "status": "modified",
    "change": "modified",
    "baselineText": "…", "currentText": "…",
    "baselineSha": "…", "currentSha": "…",
    "partial": false, "accepted": false,
    "baselineSource": "checkpoint", "checkpointId": "…", "rejectable": false
  }],
  "truncated": false,
  "omitted": { "protected": 0 },
  "limitations": [{ "code": "…", "message": "…" }]
}
```

- `change` is `modified`, `created` or `deleted`; `status` is the same, except `binary` for a file that has no text. A text is the file's bytes and nothing else: `Buffer.from(text)` is the file, a BOM is the first character, line endings are as they are. A binary file, or one that is not UTF-8, has no text (`textUnavailable: "binary"` or `"not_utf8"`); over 300 KB a side there is none either (`"too_large"`); other reasons are `checkpoint_corrupt`, `budget` (8 MiB of text in all) and `baseline_unavailable`. The shas are always there when the file is.
- `partial` is false only when the baseline is a copy made just before a tool that named the file. It is true when the baseline comes from the snapshot taken before a command, or from the last commit (`baselineSource: "git_head"`, read the way the working tree has it, line-ending conversion applied). A file that no checkpoint holds and that a command wrote is found through `git status` among the files written since the first snapshot of the task, and before the task stopped when the task has stopped; what the person writes while the task runs cannot be told apart.
- `rejectable` is true only for a file that the checkpoint of the call that created it recorded as absent. `accepted` is true when `POST /api/studio/accept` recorded this very sha for the file in a review of one of the task's checkpoints.
- Secrets (`.env`, keys, `.git`) never come back, even when tracked; `omitted.protected` counts them.
- `limitations` says what the answer cannot see. A task with no checkpoint on record gets `no_checkpoints`: an empty list then is not "no changes". Checkpoints of a task that ran in another folder or agent (a second conversation, a spawned agent, a coding worker keep their own state folder) are not found here.

Errors: `400 bad_task_id`; `409 workspace_missing`.

## `POST /api/studio/review/reject-created`

`{ taskId, file, expectedSha }`. Moves a file that the task created to `<state>/studio/undo/<id>/files/<path>` (with a `meta.json`; the copy is verified before the original goes; nothing is deleted without one). Only a `rejectable` file, only while its sha is `expectedSha`. The file is renamed next to itself first, so that what is checked and copied is exactly what leaves. Answer: `{ ok, path, sha256, undoId, undoBackup }`.

Errors: `409 revision_required` (no sha), `409 stale_review` (the file is not the one reviewed, or is not the task's), `409 not_rejectable`, `409 task_in_progress` (a task is running), `403` under sandbox-only, `423 file_locked`.

## The text save

`GET /api/studio/file?file=…` and `POST /api/studio/file/save` (`{ file, content, expectedSha }`) handle text up to **300,000 bytes** (not characters). The file must be UTF-8: a file with NUL bytes (UTF-16 text) is `415 binary_file`, any other file whose text would not go back to the same bytes (UTF-16 without NUL bytes, Windows-1252) is `415 not_utf8`, and a save of either is refused too. `read` says `encoding` (`utf8` or `utf8-bom`) and `eol`. A save writes exactly `content` as UTF-8, nothing normalized; a lone surrogate is `400 invalid_unicode`; a text over the limit is `413 too_large` (the message gives the size and the limit); a file over it is `413 file_too_large`. A UTF-8 BOM belongs to the file: if `content` no longer starts with it the Hub puts it back (`bomRestored: true`), and it never doubles one. The file as it was is saved first in a checkpoint of that file (any extension), the revision is checked again after the checkpoint, and the answer carries `sha256` of the bytes now on disk. A save is refused with `409` while a task runs.

## Hunks on the page

`ui/src/lib/review-hunks.ts` is what the page does with the two texts of a file in `task-review` (`baselineText`, `currentText`), and it needs nothing from the page: plain functions that never throw. `ui/src/lib/review-source.ts` holds only types: the file and the answer above as the page reads them, and `ReviewSource` (`task-checkpoint` is the source the Review tab will use; `git-head` and `worker-run` are names for sources to come, nothing implements them). Tests: `ui/tests/review-hunks.test.mjs` (`npm run test:unit` in `ui/`); its mutation list is `tests/mutation/review-hunks.json`.

- **Lines.** A text is cut after every line feed into lines that keep their own terminator (`"abc\r\n"`). A last line without one is a line, a lone `\r` is part of its line (as Git has it), and a BOM stays in the first line. A text is put back together by concatenating lines, never by joining them with `\n`, so CRLF, mixed endings, a missing final newline and a BOM come back as they were.
- **Hunks.** The lines the two texts share at the start and at the end are left out, the rest is compared with `diffArrays` (the `diff` package the page has), and the changes are grouped: two changes with **six unchanged lines or fewer** between them are one hunk, and each hunk shows up to **three lines of context** on each side. A hunk says which baseline lines (`baselineStart`..`baselineEnd`) the current lines (`currentStart`..`currentEnd`) replace, how many lines were `removed` and `added`, and its `rows` (`context`, `removed` or `added`, each a whole line with its terminator). `invisibleOnly` is true when every changed line says the same in both texts once its terminator and a leading BOM are put aside (CRLF against LF, a final newline, a BOM): the tab can say so instead of showing two lines that look alike.
- **Undoing.** `rejectHunks(diff, [indexes])` is the current text with those hunks replaced by the baseline's lines, assembled from the original line strings; an index that is not a hunk is ignored. Undoing every hunk gives the baseline's bytes and undoing none gives the current bytes; the tests check this for CRLF, LF, mixed endings, no final newline, a BOM, an empty file, identical texts, a file that is new or gone, adjacent hunks, the first and the last line, and 400 random pairs of texts. The page then sends the result through `POST /api/studio/file/save` with the `currentSha` of the review as `expectedSha`.
- **A limit.** The search gives up at 1,000 changed lines (`MAX_EDIT_LENGTH`: lines added plus lines taken away): the changes of a file that differs more than that become **one** hunk, from the first changed line to the last. Its bytes are still exact; it is only less fine. The slowest cases measured (a file of 100,000 lines with nothing in common with its baseline) took about 140 ms.
- **Accepting.** A hunk has a `fingerprint` (16 hex digits, FNV-1a over what it changes and where in the baseline it is). `acceptHunk` and `acceptHunks` return a set of fingerprints and never change the one they are given; `pendingHunks` is what has not been accepted. Nothing is stored here: where the marks are kept, and when they are dropped, is the page's decision.
