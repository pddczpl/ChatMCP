# The change on the approval card (Hub side)

When the owner is asked about a call that changes files, the card shows what the call would leave on disk: the hunks, file by file, worked out by the Hub from the files as they are at that moment, and
the call that follows the answer is held to those files. This page is what the Hub sends and what it refuses; the page that draws it is `ui/src/components/approval/ChangePreview.tsx`.

## Which calls

`write_file`, `edit_file` (one edit or a list), `files_apply_patch` and `files_write_batch`, and only when the gate is about to ask: Review mode, and a PreToolUse hook that asks (`forceAsk`).
Which calls ask is unchanged. Autonomous mode, Full Access and Read Only do not ask for these calls, so nothing is previewed and nothing is held there. `move_path`, `delete_path`, shell commands and the
other tools get the card they had.

## One code path

`lib/local-tools.mjs` exports pure planners that say, from the bytes of a file and the arguments of a call, what the call would leave: `planEdit`, `planApplyPatch` (an edit with one edit that is never
`replace_all`), `planWrite` and `planWriteBatch` (the files come from a loader, so a test can answer from memory). A plan holds `baseSha`, `newText`, the encoded `data` and its `sha256`, `hunks`,
`additions`, `deletions`, `unchanged`, and for a file that exists but is not text, `oldUnreadable`. They apply the rules the tools had: CRLF and the other line endings, a byte order mark and UTF-16LE are kept,
`old_string` must be unique unless `replace_all`, a list of edits applies in order and writes nothing when one fails, an existing file is replaced only with `expected_sha256` or `overwrite`.

The tools write what their plan says (a preflight that reads and refuses, then the write), and `LocalTools.previewChanges()` asks the same preflight before the owner answers. So the card cannot drift from the
write: `tests/verify-edit-plans.mjs` runs 600 scripted edits, 240 writes and 120 batches on real files against an oracle written from the rules, and the plan equals the file after the run, byte for byte, with
the same `hunksDigest` as the hunks of what was written. Asking changes nothing: no file is written and no folder is made.

The diff itself is `lib/line-diff.mjs` (the Hub has no runtime dependency): a Myers search bounded at 1000 edits and 4,000,000 steps (past either the change is one hunk from the first changed line to the last,
still exact), lines that keep their terminator, three lines of context, hunks merged when six unchanged lines or fewer lie between them. Its rows are the rows of the Review tab.

## What the request carries

`detail.preview` of the request (the legacy `detail` fields and the text `preview` stay; the text is the card without the rows, so the history and the pending list stay small):

| Field | Meaning |
| --- | --- |
| `files[]` | at most 20: `path`, `action` (`create`, `overwrite`, `edit`), `baseSha` (sha256 of the bytes the card was made from, null for a file that was not there), `additions`, `deletions`, `unchanged`, `oldUnreadable`, `hunks[]`, `shownRows`, `hiddenRows`, `truncated` |
| `hunks[]` | `baselineStart`, `baselineEnd`, `currentStart`, `currentEnd`, `removed`, `added`, `invisibleOnly` (only line endings or a byte order mark differ), `rows[]` of `{kind: context | removed | added, text, omitted?}`, `cut` when rows were left out |
| `fileCount`, `hiddenFiles`, `truncated` | how many files the call has, how many are not on the card |
| `error` | `{code, message}` when the call would be refused when it runs (not found, ambiguous, a stale sha, file exists, a protected file in a batch ...): the card says why and shows no file |
| `privateKeys` | the call touches private key material; the words the model wrote are then left out of the card |

Bounds: 20 files, 200 rows of a file, a line cut at 400 characters (with `omitted`, never inside a character), 120,000 characters of rows for the whole card. What is left out is counted, never dropped silently.

## What is kept off the card

- A protected file (`.env`, private keys, `.git` ...) never has content on the card, as in `git_diff`. A single-file call on one is refused before anyone is asked; a batch that names one gets a card with
  `error.code = protected_path` and nothing else, and the request of a batch lists paths and sizes, never content.
- Everything on the card is masked by `maskSecrets` like every other word of the request. It knows the spellings that code uses (`DB_PASSWORD=`, `"password": "..."`, `clientSecret = '...'`,
  `Authorization: Basic ...`, JWTs, the tokens of the common providers, URLs with a password) and leaves lines that only mention secrets alone (`tokenCount`, `passwordInput`, `SECRET_KEYS = /.../`);
  `tests/verify-mask-secrets.mjs` is the table.
- A line of a private key's body looks like any base64, so only its place tells. The card masks the rows by their place in the old and in the new text, wherever it shows them (kept, taken away, put in), and keeps the
  frame lines, the row kinds and the real counts. The history keeps the request without the rows.
- The answer of `edit_file` and `files_apply_patch` to the model shows the lines around the edit (the model gets them back so that it can check its work). A secret in them is hidden in that answer in the same two
  ways (by spelling, with the registered secrets of the Hub, and the body of a private key by its place), the answer says that something was hidden, and the file keeps it: `tests/verify-edit-plans.mjs` (section 5) and
  `ui/e2e/approval-changes.spec.mjs` (the model's requests are watched for the secret after an approval).

## The call that follows the answer

`PermissionGate.authorize` returns a `guard` with an approval: the tool, a hash of the arguments, and for EVERY file of the call (also the ones past the twenty of the card) the `baseSha` the card was made from.
`HubManager` hands it to `LocalTools.call`, which refuses with `stale_after_approval`, `executed: false` and a message that names the file when:

- the file changed since (its sha256 is not the `baseSha`), appeared (the card was for a new file) or went away;
- the call names a file that was not on the card (a name that leads somewhere else now);
- the tool or the arguments are not those the card was drawn for (a card is for one call).

Nothing is written, and the model gets the refusal as the result of the call (`stale_after_approval: "calc.js" ... nên chưa ghi gì ...`), so it can read again and ask again, which draws a new card of the file as it
is. A "no" is `permission_denied` as before. A call that came without a card (Autonomous, Full Access, no hook) is held to nothing; the write itself still re-hashes the file right before the rename
(`writeFileAtomic`), as it did.

## What this does not cover

- Shell commands, `move_path` and `delete_path`: no preview.
- It is a pattern mask. A secret in a spelling nobody listed shows on the card; a protected file never does.
- `read_file`, `search_files` and the other tools that show the model the content of an ordinary (not protected) file are as they were: a secret in such a file reaches the model when the model reads that file.
  Only the card and the answer of an edit were changed here.
- A registered secret that spans several lines is masked line by line, so it is not masked as one.
- A file that changes between the check and the rename is caught by the re-hash in `writeFileAtomic` (`stale_revision`), not by the guard.

Tests: `tests/verify-line-diff.mjs`, `tests/verify-edit-plans.mjs`, `tests/verify-approval-preview.mjs`, `tests/verify-mask-secrets.mjs`, `ui/tests/change-preview.test.mjs` (how the page reads the request),
`ui/tests/approval-changes.test.mjs` (the real components), `ui/tests/change-preview-vs-review.test.mjs` (the hunks of the card are those of the Review tab) and `ui/e2e/approval-changes.spec.mjs`.

Mutation lists (`node tests/mutation/run-mutations.mjs tests/mutation/<list>.json`): `line-diff.json`, `edit-plans.json` (the planners), `approval-guard.json` (the guard, the gate, the manager), `approval-preview.json`
(the card: bounds, a cut line, key material), `mask-secrets.json` and `change-preview.json` (the page's reader): 262 mutations, 254 killed, 8 equivalent with the reason written in the list, 0 survived.
