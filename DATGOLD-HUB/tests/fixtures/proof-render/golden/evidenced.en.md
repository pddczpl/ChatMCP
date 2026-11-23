## Proof report

**✅ Every criterion is evidenced or accepted by the owner (2 evidenced, 1 accepted).**

Criteria by status: ✅ Evidenced 2; 👤 Accepted by the owner 1

The pack file was checked when this report was made: its schema, its digest, its files and its ledger agree, and the results of the checks follow from that ledger. What the owner accepted, the changes to the checks and whether the acceptance file was trusted are taken from the statement as it says them. The pack is not signed, so this says that it is whole, not who made it.

This report is a reading aid made from a proof pack. It is not evidence itself, and anyone can edit it: check the pack with the commands at the end.

### What was changed, and by what

- **Agent:** `DatGold`, version `3.12.0`
- **Model:** `nhà cung cấp mẫu` / `mô-hình-1`
- **Profile revision:** not recorded in this pack
- **Base commit:** `752b556a42ff0d908a4cb28c6ee18d36ad0693d5`
- **Tree before:** `79ebfc4279196a5ecd3e7b36569209217e59d40b` (`git-pinned-v1`, `sha1`; files: 1,234, bytes: 5,678,901)
- **Final tree:** `f3ef6ce42152415b9cbc552a192c34b8f9b56212` (`git-pinned-v1`, `sha1`; files: 1,235, bytes: 5,678,901)
- **Patch (sha256):** `71376f6fd0a391c4a5680da50a229e072233d9aabdb4c1b6f7a62a5d7228eb44`
- **Statement digest:** `3276dcef03af58a754cffa015df1c1f53e0927a289ccf73bdeac7e4f7f9b1bc5`
- **Acceptance file (sha256):** `20a660e79e70b325b5fd5e88650df7d3574769e63874e8be104c5dd75f409480`: trusted by the maker of the pack

### Criteria

| Criterion | Status | What it asks | Checks passed |
| --- | --- | --- | --- |
| `kiem-thu` | ✅ Evidenced | `Các kiểm thử đơn vị đều đạt, chạy hai lần liên tiếp` | 1/1 |
| `lint` | ✅ Evidenced | `Không còn cảnh báo lint; mã thoát của bộ kiểm là 3 như tài liệu ghi` | 2/2 |
| `giao-dien` | 👤 Accepted by the owner | `Màn hình đăng nhập hiển thị đúng dấu tiếng Việt: ắ ằ ẳ ẵ ặ, ố ồ ổ ỗ ộ, ứ ừ ử ữ ự, đ Đ` | – |

The checks of each criterion, and the runs that count for the final tree:

| Criterion | Check | Command | Folder | Expected exit | Runs that count | Result | Receipts |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `kiem-thu` | 1 | `node --test` | `.` | `0` | 2/2 | ✅ Passed | 6, 7 |
| `lint` | 1 | `npm run lint` | `packages/ui` | `0` | 1/1 | ✅ Passed | 8 |
| `lint` | 2 | `node lint.mjs` | `.` | `3` | 1/1 | ✅ Passed | 9 |

- `giao-dien`, for a person to look at: `src/đăng-nhập.mjs`
- `giao-dien`, note of the acceptance file: `Xem ở cỡ chữ 200 %`

Why a criterion has its status:

| Criterion | Check | Reason | Detail |
| --- | --- | --- | --- |
| `giao-dien` | – | The owner accepted it for the final tree. | `by Nguyễn Thị Ánh at 2026-11-23T09:30:00Z` |

### Receipts

| Receipt | Command | Outcome | Tree | Duration | Time | Check it is listed by |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | `node --test`, shell `bash` | exit `0` | `f3ef6ce42152` (the final tree) | 1.840 s | `2026-11-23T08:00:06.000Z` | `kiem-thu` (1) |
| 7 | `node --test`, shell `bash` | exit `0` | `f3ef6ce42152` (the final tree) | 1.795 s | `2026-11-23T08:00:07.000Z` | `kiem-thu` (1) |
| 8 | `npm run lint` in `packages/ui`, shell `bash` | exit `0` | `f3ef6ce42152` (the final tree) | 912 ms | `2026-11-23T08:00:08.000Z` | `lint` (1) |
| 9 | `node lint.mjs`, shell `bash` | exit `3` | `f3ef6ce42152` (the final tree) | 61.007 s | `2026-11-23T08:00:09.000Z` | `lint` (2) |
| 10 | `git status --short`, shell `bash` | exit `0` | `79ebfc427919` (another tree) | 33 ms | `2026-11-23T08:00:10.000Z` | – |

A pack holds no output of a command, only its sha256 and size; this report leaves those out too.

### Diff stat

Files: 5. Lines added: 4. Lines removed: 2. Binary files: 1.

| Path | Change | Lines added | Lines removed |
| --- | --- | --- | --- |
| `src/tính-tổng.mjs` | modified | 2 | 1 |
| `docs/huong dan.md` | added | 2 | 0 |
| `old.txt` | deleted | 0 | 1 |
| `logo.bin` | modified | binary | binary |
| `run.sh` | modified | 0 | 0 |

### Changes to the checks

The check-changes report found no change to the files the checks depend on.

The acceptance file was not edited during the task.

No lockfile in the report changed (looked at: 1).

### Permission decisions

Permission records in the ledger: 4.

| Decision | Count |
| --- | --- |
| Approved | 2 |
| Denied | 1 |
| Decided by the policy | 1 |

### Uncertain events

The ledger of this pack holds no uncertain record. That is what was written down, not a proof that nothing uncertain happened.

### Data sent out (Companion)

Not recorded in this pack: a v0.1 statement has no field for what was sent out of this machine, by the Companion or in another way. That does not say that nothing was sent.

### Cost

1,234.5678 USD for the whole run. The pack says that this covers every call.

In Vietnamese dong: 31,358,022 VND, at the rate given by whoever made this report: 1 USD = 25,400 VND on 2026-11-20, source `Vietcombank, tỷ giá bán ra`. The rate was not checked.

Cost per verified criterion: not recorded in this pack. A v0.1 statement holds one cost for the whole run, and it is not divided here.

### Integrity level and limitations

- **Integrity level:** `unconfined`: the agent runs as the same user as the Hub and could rewrite what this pack was made from. The pack records what was observed. It is not a seal against the agent.
- **Ledger:** Records: 11. The whole chain verifies; the hash of its last record is `d117fe6dfc11db1bfe0cb6eedc948c54e35c25ba5c04c0bd14c0e321c5f0c0d0`.

The pack is not signed.

Limitations the pack names:

- The statement is not signed: its digest names it, and does not say who made it.
- Nothing confined the agent, so it could have changed the inputs of this pack.
- The end of the ledger is not anchored: lines removed from its end leave a shorter ledger that still verifies.
- Changes under paths that are ignored and not tracked are not seen.
- The heuristics also flag legitimate changes to tests.
- Which tests a command runs is not known, so a change to tests counts for every criterion that runs a command.
- Protected files (secrets and keys) are never read, so changes to them are not seen.

What the tree ids leave out:

- protected files (keys, credentials, environment files): 2
- the runs folder: 1
- untracked paths that are ignored, not counted
- the content of nested repositories, which count as their commit: 0

### How to verify

This report is about the statement `3276dcef03af58a754cffa015df1c1f53e0927a289ccf73bdeac7e4f7f9b1bc5`. Run check on the pack file and compare: it prints the same digest, or the report is of another pack.

```text
chatmcp verify check evidenced.pack.json
chatmcp verify trust --pack evidenced.pack.json
chatmcp verify reproduce evidenced.pack.json --base 752b556a42ff0d908a4cb28c6ee18d36ad0693d5
```

The commands check the pack, show the commands it would run, and run its checks again. Reproduce runs commands that someone else may have written, so read what trust shows before you trust it.
