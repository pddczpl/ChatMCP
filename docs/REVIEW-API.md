# Review API (Hub side)

What the Hub tells a client about the work of one task, and the one thing a client may undo without a checkpoint. It is the data the Review tab (see "The Review tab" below) and an editor over ACP read. Everything here is behind the per-launch bearer ([Hub authentication](HUB-AUTH.md)), and a POST also needs the page's Origin, request marker and CSRF token. Tests: `tests/verify-task-review.mjs` (the code, on a real `HubManager`), `tests/verify-e2e-review.mjs` (a real Hub process), `tests/verify-studio-http.mjs` (the text save).

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
- **Hunks.** The lines the two texts share at the start and at the end are left out, the rest is compared with `diffArrays` (the `diff` package the page has), and the changes are grouped: two changes with **six unchanged lines or fewer** between them are one hunk, and each hunk shows up to **three lines of context** on each side. A hunk says which baseline lines (`baselineStart`..`baselineEnd`) the current lines (`currentStart`..`currentEnd`) replace, how many lines were `removed` and `added`, and its `rows` (`context`, `removed` or `added`, each a whole line with its terminator). `invisibleOnly` is true when every block of the hunk (a run of lines taken away and the lines put in their place) puts back as many lines as it takes away, and each says the same as the line it replaces once its terminator and a leading BOM are put aside (CRLF against LF, a final newline, a BOM): the tab can say so instead of showing two lines that look alike. It is judged block by block, never by pairing the lines of different blocks, so a line that moved is a visible change.
- **Undoing.** `rejectHunks(diff, [indexes])` is the current text with those hunks replaced by the baseline's lines, assembled from the original line strings; an index that is not a hunk is ignored. Undoing every hunk gives the baseline's bytes and undoing none gives the current bytes; the tests check this for CRLF, LF, mixed endings, no final newline, a BOM, an empty file, identical texts, a file that is new or gone, adjacent hunks, the first and the last line, and 400 random pairs of texts. The page then sends the result through `POST /api/studio/file/save` with the `currentSha` of the review as `expectedSha`.
- **A limit.** The search gives up at 1,000 changed lines (`MAX_EDIT_LENGTH`: lines added plus lines taken away): the changes of a file that differs more than that become **one** hunk, from the first changed line to the last. Its bytes are still exact; it is only less fine. The slowest cases measured (a file of 100,000 lines with nothing in common with its baseline) took about 140 ms.
- **Accepting.** A hunk has a `fingerprint` (16 hex digits, FNV-1a over what it changes and where in the baseline it is). `acceptHunk` and `acceptHunks` return a set of fingerprints and never change the one they are given; `pendingHunks` is what has not been accepted. Nothing is stored here: where the marks are kept, and when they are dropped, is the page's decision (next section).

## The Review tab

`ui/src/components/inspector/ReviewTab.tsx` is the page's use of everything above: the work-panel tab **Xem lại thay đổi** (en: **Review changes**; not just "Review", which is already the name of a permission mode). The rules it follows are plain code with their own tests (`ui/src/lib/review-rules.ts`, `review-actions.ts`, `review-accepted.ts`, `review-source-task.ts`, `review-offer.ts`; mutation list `tests/mutation/review-state.json`), and `ui/e2e/review.spec.mjs` checks the bytes on disk against the real Hub.

- **Where it comes from.** `GET /api/studio/task-review` for the selected conversation, through the `task-checkpoint` `ReviewSource`. It is read when the tab opens, when the conversation's state changes (a run ends), after what the tab does itself, and when **Reload** (vi: **Tải lại**) is pressed. It is **not polled** (an answer can carry megabytes of text) and **not read again when the window gets the focus**, so the review on screen is the one the sha of a write refers to.
- **What is offered.** By how the file is reviewed (`fileMode`): a text file by hunk; a **new** file as a whole (accept, or move it to the undo folder through `reject-created` if the Hub recorded its creation); a **deleted** file read-only, because `POST /api/studio/file/save` only overwrites a file that exists and neither `save` nor `restore` can create one; a **binary** file, a file that is not UTF-8 and a file the Hub sent no text for (too large, `budget`, a damaged checkpoint, no baseline) listed with the reason, to be accepted and not undone. A file that ends up equal to its baseline is no longer in the answer, so it leaves the list.
- **What is refused is not offered.** The Hub refuses `save` and `reject-created` while **any** task runs (`agent.activeTaskId` of the state, not the task on screen) and refuses `save`, `accept` and `reject-created` under `executionPolicy: "sandbox-only"` (403, no code). The tab mirrors that (`writeState`) and says why. The Hub still decides: an error is told by its status and code (`stale_revision`, `stale_review`, `bad_revision`, `revision_required` = the file changed; a 409 with no code or `task_in_progress` = a task runs; 403 with no code = sandbox-only; 423 `file_locked`; 413; 415).
- **Rejecting a hunk** is `save` of the current text with that hunk replaced by the baseline's lines, with `expectedSha` = the `currentSha` that was reviewed. A `409` means the file changed behind the page: nothing is written, the review is read again and the tab says so. A save makes one `Before manual edit …` checkpoint; `reject-created` and `accept` make none. The baseline stays the task's (the checkpoint of a save has no task).
- **Accepting a hunk** writes nothing. The mark is kept in `localStorage` (`chatmcp:review-accepted`, at most 200 entries, the oldest go first) by conversation, path, sha of the file and the hunk's fingerprint, and read back after a reload. A different sha of the file starts again, **except** after the tab's own *reject*: the hunks that are still there keep their marks (the fingerprint does not depend on where in the file a hunk is, only on what it changes and where in the baseline), so rejecting a neighbour does not undo the work of reviewing. With storage blocked the marks last until the page is closed. **Accepting a file** is `POST /api/studio/accept` with its checkpoint and sha.
- **Accept all / Reject all** act on the **whole review**, ask first, and say in numbers what they would do (files rewritten and hunks put back; new files moved away; files left as they are). Reject all writes file by file, one after the other, and goes on past a file that fails; it never touches a deleted, binary or text-less file. Accept all marks every pending hunk of the text files and records the files the Hub can record.
- **The dialog is the project's own `<dialog>` (the `Modal` component, `role="alertdialog"`), not Radix `AlertDialog`.** The Hub serves `style-src 'self'`; Radix's scroll lock (`react-remove-scroll`) inserts a `<style>` element, which that policy blocks: a bare `AlertDialog` opened under the Hub's exact header produced one `securitypolicyviolation` (`style-src-elem`, blocked `inline`) and one console error. Loosening the policy is the owner's decision (it is not made here); the native dialog needs none, has the focus on **Cancel** when it opens and closes with Escape, and `e2e/review.spec.mjs` asserts zero violations while it is used.
- **Keys**, only while the focus is inside the hunks and never with Ctrl, Alt or Meta, in a field or with the dialog open: `j`/`k` move between hunks, `a` accepts, `r` puts the hunk back. A key that would write does nothing while writing is not allowed.
- **Long hunks** show their first 200 rows and a button for the rest; a file is shown only as hunks (the unchanged lines between them are not), so no virtual list is needed.
- **The way in.** Under a finished turn, from the edits the Hub recorded (not from what the model said): the number of files and a button. Beside the receipt of an edit that went through with a checkpoint of its own: a link that opens the tab on that file (the path the model wrote is matched to the file of the review, whatever slash, case or absolute form it used).
- **Every word** of the tab is in the dictionary in both languages (`review_*` in `ui/src/lib/i18n.ts`); the Hub's own sentence is shown only for a limitation the page has no text for.
