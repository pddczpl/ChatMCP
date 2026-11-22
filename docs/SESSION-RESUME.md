# Session resume: the history journal

When you continue a conversation (Tiếp tục, or the Hub's own auto-resume after a restart), the next run starts from the conversation the model really had: the messages, the tool calls and the tool results of the earlier runs, under their own call ids. Until this change a continued run started from a "conversation checkpoint", a text of at most 48,000 characters that summarised the earlier prompts and events; the model lost the real tool results. This page describes how the history is kept and read back (phase P9, task ac-17) and what a continued run shows about the way it started: the `resumed_from_transcript` event, `resumeMode` and the chip on the page (task ac-18, [below](#what-a-continued-run-shows)). The test that kills a real Hub process is ac-19.

## What is written

Every item that enters the model history of a run (the `HistoryLedger`, `DATGOLD-HUB/lib/history-ledger.mjs`) is also written, as one line, into the task's own `transcript.jsonl` in the Hub's data folder (`tasks/<id>/`, the same file that already held the full tool results). The records, version 1:

| record | fields | what it says |
|---|---|---|
| `history_run` | `v`, `run`, `seed`, `counters` | a run starts; `seed.source` is `journal` (replayed from the records below), `checkpoint` (the old checkpoint text, with `seed.reason`) or `none` (a new task); `seed.items`, `seed.bytes`, `seed.dropped` (old items left out for size), `seed.cut` (calls of an interrupted turn left out) |
| `history` | `v`, `run`, `seq`, `role`, `kind`, `batch`, `item`, `counters?` | one item of the run, in order (`seq` 0, 1, 2 ... within the run); `kind` is the ledger's label (`prompt`, `model_output`, `tool_output`, `resume_note`, `stop_hook`, ...), `batch` the model turn |
| `history_end` | `v`, `run`, `items`, `counters` | the run ended having committed `items` items; a run that was killed has none |
| `context_summary` | `v`, `run`, `through`, `item` | reserved for a summary of the history up to an item (ac-7, not scheduled); nothing writes it yet, the loader already applies the latest one |

A tool result is written once. The Hub already writes the whole result of a call as a `tool_result_full` record (a router answer such as `mcp_catalog` as a `catalog_result` record) before the history item; the history item is then only a reference, `{"type":"function_call_output","call_id":"…","output_ref":"tool_result_full"}`, and the output the model saw is made again from that record when the journal is read. An error the runner answers itself (bad arguments, an unknown tool name) has no such record and is written as it is.

`counters` holds the counters a later resume must restore: `hookBlocks` (the Stop / SubagentStop / TaskCompleted budget of the run: `limit`, `used`, `byEvent`), `noticeTurns` (final answers held back for the notice of a background agent) and `doneGate`, which is always `null`: the Hub has no done-gate yet and the field is reserved. A history record carries them only where they changed, so the feedback of a hook and the count it raised are on the same line. ac-17 writes and reads them. Restoring them in a resumed run is not done: a resumed run starts counters of its own (ac-18 built the event and the chip, not this; it is open).

## What is read back

`DATGOLD-HUB/lib/history-journal.mjs` reads the file once, as a stream, and parses only the lines it needs (a `model_response` line is skipped unread). Then:

1. **Damage.** A last line that is truncated or not JSON is skipped: that is what a Hub killed while it wrote leaves. Anything else that does not hold together makes the journal unusable, and the run goes on from the checkpoint text as before: a history line in the middle that is not JSON or records out of order (`corrupt`), a missing or repeated `seq`, a reference whose record is not there, a run that ended with more items than are there, history without the start of its run (`journal_gap`), a record or a kind of reference a newer Hub wrote (`unknown_version`), a journal with no item (`empty`), one too large to fit even its newest turn (`too_large`).
2. **Runs.** The history is the runs in order. A run that began from the checkpoint text, or as a new task, starts the history again; a run that began from the journal follows what came before it.
3. **The interrupted turn.** At the end of every run, a model turn whose calls do not all have their result is cut whole: its text, its calls and the results it has. Anthropic needs the thinking blocks of a tool-use turn that is continued, and thinking blocks are never written (below). The calls cut from the last run are named in the note the model gets.
4. **The skill index** of a run is that run's own: the run that starts writes a new one, so the seed carries none of the earlier ones. The same goes for the text of a skill an earlier run read with `skill_load`: the call stays in the history, and its result is a note that says the text is not repeated (the skill may have changed or been turned off since) and that `skill_load` reads it again.
5. The latest `context_summary` is applied.
6. **Outputs** that are references are made again by the same code that made them (`#modelOutput`), with the token optimiser off: its receipts (`token_restore`) live in memory only and are gone after a restart, so the model gets the whole output where it once got a shortened one.
7. **Opaque reasoning** is left out: Responses reasoning items, Anthropic thinking blocks and their binding, Gemini parts with their `thoughtSignature`, Chat reasoning text. The transcript never held them (it holds a placeholder), and a placeholder sent back would be refused. This is by design: private reasoning stays in memory only.
8. **Masking.** Every string except the bytes of a picture is passed through the masking of the process that loads, with its own list of secrets.
9. **Pairing.** `pairToolCalls` repairs what is left: a call without a result gets an explicit "no result" output, a result without its call is dropped.
10. **Size.** The history must leave room, within the 48 MiB a run may hold, for the run's instructions, its skill index, its prompt and attachments, and 256 KiB more. A history that is larger loses its oldest whole turns and starts with a note that says how many items were left out; one that cannot fit is `too_large`.

The loader only rebuilds what the model is sent. Nothing is run again to rebuild it: a call whose outcome is unknown is never replayed.

## What the resumed run sends

The new run's history is the replayed history, then its own skill index, then a short note that begins `RESUMED CONVERSATION`, then the notices of background agents that stopped, then your message. The note says that the history above is replayed and ran nothing, that it shows the workspace as it was, and lists:

- the **unverified operations**: a call that was running when the Hub stopped and could have changed something (with its tool name, call id and arguments);
- the calls of the **interrupted turn** that were cut, and whether a result had been recorded for each;
- the **prior calls with no recorded result** (`PRIOR CALLS WITH NO RECORDED RESULT`, ac-18), each once with its run: the calls of the cut turn that got none, and the unverified operations whose call id has no result in the journal (or that carry no call id). An unverified operation whose result the journal does hold (a record written by a Hub that died between the two writes) stays in the list of unverified operations but is not named here;
- how many old items were left out for size, and how the previous run ended.

Every value the note prints (a tool name, a call id, a time, a phase, arguments, the error of the previous run) is one line: control characters and line or paragraph separators become a space, so a value can never start a line of its own, and it is cut (names, ids, times and phases at 200 characters, arguments at 600, the error at 1,200). At most ten entries of each list are printed.

A call id that the replayed history already holds is refused if a model hands it out again (`invalid_call_id`), and the call is not run.

A task written before the journal existed (3.11.2 and earlier, v3.9.0 included) has no history records: it goes on from the checkpoint text, exactly as before, and the task gets a `resume_fallback` event that says why (`no_journal`, or the reason of a journal that could not be used). The run that fell back writes a journal of its own, which starts with that checkpoint text, so the run after it resumes from the journal.

## What a continued run shows

(P9 ac-18.) Every run that continues a conversation records how it started, with the loader's own numbers; nothing is estimated.

**The event.** When the journal serves the run, the task gets a `resumed_from_transcript` event before the run's `continuation` event (in its events, in `transcript.jsonl` and on the event stream, for the first chat and for a second chat that runs in its own worktree alike). Its fields:

| field | what it counts |
|---|---|
| `items`, `bytes` | the items of the replayed history and their size as JSON (what `HistoryLedger.byteLength` counts); the same as `seed.items` and `seed.bytes` of the run's `history_run` record |
| `droppedTailItems` | the journal items of the last run's interrupted turn that were cut: its text, its calls and the results it had (`interruptedCalls` is how many of them were calls) |
| `droppedOldItems` | the oldest items left out to fit the size limit (the number the `[HISTORY LEFT OUT` note names) |
| `summaryUsed` | whether a `context_summary` record replaced the items before it (nothing writes one yet, so this is `false` until ac-7) |
| `noResultCalls` | the prior calls with no recorded result, all of them (the note names the last ten) |
| `unverified` | the unverified operations the task carries, all of them (`task.unverifiedOperations`; the note lists the last ten) |

**The task.** `task.resume` holds the same numbers with `mode: 'transcript'`, the run (1-based) and the time; the public task and the payload of `/api/tasks/continue` carry `resume` and `resumeMode`. When the journal could not be used the run starts from the checkpoint text as before, the `resume_fallback` event says why, and `task.resume` is `{mode: 'checkpoint', run, at, reason, bytes, unverified}`, where `bytes` is the size of the checkpoint text in UTF-8; no `resumed_from_transcript` is emitted. A run that is not a continuation, or one that fails before it reads the history, has `resumeMode: null`. A stored mode this Hub does not know is shown as `null`. `task.resume` is saved in `task.json`, so a Hub that loads the task again shows how its last run resumed.

**The report.** The task report (`report.txt`, `/api/tasks/:id/report`) has a line `Resume (latest run): …`: `none`, `transcript` with every number above, or `checkpoint` with the reason, the size of the text and the unverified operations.

**The page.** Beside the model profile under the composer, a chip says `Tiếp tục từ lịch sử đã lưu · 12 mục` / `Resumed from the transcript · 12 items` (and `· 1 call without a result` when there is one), or `Resumed from the checkpoint summary`; every number and the reason are on hover (`DATGOLD-HUB/ui/src/lib/resume-chip.ts`, `components/conversation/ResumeChip.tsx`). It is drawn in the warning tone when a prior call has no recorded result or an operation is unverified, and not at all for a conversation that did not resume.

**Plan mode.** A plan-mode task (docs/PLAN-MODE.md) is resumed like any other and stays read-only: its policy is held on the gate from the start of the run (and by a Hub that loads it, from the moment it loads it), so a write of the resumed run is refused whether it continues after a stop, after a clean reload or after a Hub that died while the plan waited. The `exit_plan_mode` call that waited for an answer is in the cut turn and named as a call with no recorded result. `lib/permissions.mjs` needed no change for this.

## Privacy and what is on disk

- The journal holds the model history as the model saw it, **including your attachments** (pictures as base64, text files) and the messages the Hub wrote. Before this change, attachments were kept in memory only; they are now in `transcript.jsonl` of the task, in the same folder (owner-only permissions) as the full tool results, which were always there (THREAT-MODEL RR-6, RR-44).
- A line is masked with the secrets **the process that wrote it** knew. A line written while a secret was not on the list holds it in clear, and a replay is masked again with the list of **the process that loads it**: a secret neither list knows reaches the model again on resume. Deleting the conversation deletes its folder.
- Thinking blocks, signatures and encrypted reasoning are never written, so they are never replayed.

## What is not verified here

- The test of a real Hub process killed with `kill -9` and restarted (ac-19). `tests/verify-session-resume.mjs` copies the files of a running task while a call that writes is hanging and resumes from the copy in a new runner, which is what a dead Hub leaves; it does not kill a process.
- Restoring the hook budget and the notice turns from the counters: not done (open).
- The chip in a real browser: `ui/tests/resume-chip.test.mjs` renders the real component and its words in both languages and checks that the conversation screen draws it; no end-to-end test of the page clicks through a continued conversation.
- The rewind to step N (truncating the journal and linking the matching code checkpoint) is not built.
- Real providers: the suite runs against the strict mock server (`tests/e2e/mock-model-server.mjs`) on Chat Completions, Responses, Anthropic and Gemini. Whether a real Anthropic model accepts a continued conversation whose last tool-use turn has no thinking block when thinking is on was not tried.
