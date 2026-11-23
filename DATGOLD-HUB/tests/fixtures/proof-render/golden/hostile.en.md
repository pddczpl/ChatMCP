## Proof report

**❌ Not evidenced: 1 of 11 criteria failed.**

Criteria by status: ✅ Evidenced 1; 👤 Accepted by the owner 1; ❔ Unverified 5; ❌ Failed 1; ⏳ Stale 2; 🚩 Checks modified 1

The pack file was checked when this report was made: its schema, its digest, its files and its ledger agree, and the results of the checks follow from that ledger. What the owner accepted, the changes to the checks and whether the acceptance file was trusted are taken from the statement as it says them. The pack is not signed, so this says that it is whole, not who made it.

This report is a reading aid made from a proof pack. It is not evidence itself, and anyone can edit it: check the pack with the commands at the end.

### What was changed, and by what

- **Agent:** `<script>alert(1)</script>`, version `1.0 | [x](javascript:alert(1))`
- **Model:** `"><img src=x onerror=alert(1)>` / `![x](https://evil.example/pixel.png)`
- **Profile revision:** `safe⟦U+202E⟧gpj.exe⟦U+202C⟧ ⟦U+2066⟧iso⟦U+2069⟧ ⟦U+200E⟧⟦U+200F⟧⟦U+061C⟧`
- **Base commit:** not recorded in this pack
- **Commit of the change:** `511d4c4145e3821c34533031e5f46069993dddd6`
- **Tree before:** `6a7ed406029bfc3414f392251fe2452665a77d12` (`git-pinned-v1`, `sha1`; files: 1,234, bytes: 5,678,901)
- **Final tree:** `d19628601d7ad9a739350a1a6874a20599f0938d` (`git-pinned-v1`, `sha1`; files: 1,234, bytes: 5,678,901)
- **Patch (sha256):** `621b7d15134c911ef566a775910e124adee8a93f74160ea4cb22add9139de28b`
- **Statement digest:** `c1ed4404310221bbd8476419845d99964a20f2faa749ef99c8ade9aad668fd8c`
- **Acceptance file (sha256):** `82b944007cbd0298ed998a0706065686e00498b177ef4a9262b37d9db233b6ba`: trusted by the maker of the pack

### Criteria

| Criterion | Status | What it asks | Checks passed |
| --- | --- | --- | --- |
| `xss` | ❌ Failed | `<script>alert(1)</script>` | 0/1 |
| `attr` | ⏳ Stale | `"><img src=x onerror=alert(1)>` | 0/1 |
| `link` | 🚩 Checks modified | `[x](javascript:alert(1)) ![x](https://evil.example/pixel.png)` | 1/1 |
| `fence` | ❔ Unverified | ````` ```` ``` ` fenced ````` | 0/1 |
| `pipes` | ❔ Unverified | `⟦U+005C⟧\| \⟦U+005C⟧\| \\⟦U+005C⟧\| end\` | 0/1 |
| `short` | ❔ Unverified | `@octocat @org/team #1 GH-1 pddczpl/ChatMCP#1` | 0/1 |
| `ok` | ✅ Evidenced | ``*a* _b_ ~~c~~ **d** $x$ $`y`$ :smile:`` | 2/2 |
| `unrun` | ❔ Unverified | `</style></code></td></table><script src=//evil.example/x.js></script>` | 0/1 |
| `look` | ❔ Unverified | `\| a \| b \|` | – |
| `accepted` | 👤 Accepted by the owner | `' onmouseover='alert(1)` | – |
| `moved` | ⏳ Stale | `&lt;script&gt; &#60; &amp; &copy;` | – |

The checks of each criterion, and the runs that count for the final tree:

| Criterion | Check | Command | Folder | Expected exit | Runs that count | Result | Receipts |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `xss` | 1 | `echo "<script>alert('xss')</script>" \| tee out.txt` | `.` | `0` | 0/1 | ❌ Failed | 9 |
| `attr` | 1 | `node -e "\"><img src=x onerror=alert(1)>"` | `.` | `0` | 0/1 | ⏳ Stale | 10 |
| `link` | 1 | `open "javascript:alert(1)" [x](javascript:alert(1)) ![i](https://evil.example/p.png)` | `.` | `0` | 1/1 | ✅ Passed | 11 |
| `fence` | 1 | ````` printf '```' \| cat `` ` ```` ````` | `.` | `0` | 0/1 | ⚪ Not run | – |
| `pipes` | 1 | `a \|\| b \| c ⟦U+005C⟧\| d \⟦U+005C⟧\| e \` | `.` | `0` | 0/1 | ❔ Tree unknown | 12 |
| `short` | 1 | `mail @octocat #1 https://evil.example` | `src/<b>x</b>` | `0` | 1/2 | 🔁 Too few runs | 13 |
| `ok` | 1 | `echo "*bold* _it_ ~~s~~ &lt;b&gt;"` | `.` | `0` | 1/1 | ✅ Passed | 14 |
| `ok` | 2 | `true` | `.` | `0` | 1/1 | ✅ Passed | 15 |
| `unrun` | 1 | `</code></td></tr></table><h1>fake verdict</h1>` | `.` | `0` | 0/1 | ⚪ Not run | – |

- `look`, note of the acceptance file: `<svg/onload=alert(1)> <iframe srcdoc="<b>"> <!-- c --> <![CDATA[x]]> <?php ?> {{7*7}} ${7*7} @octocat @org/team #1 GH-1 pddczpl/ChatMCP#1`
- `accepted`, for a person to look at: `docs/<i>x</i>.md`
- `moved`, note of the acceptance file: `x`

Why a criterion has its status:

| Criterion | Check | Reason | Detail |
| --- | --- | --- | --- |
| `xss` | 1 | A run on the final tree did not pass. | `exit 1, expected 0` |
| `attr` | 1 | No run counts for the final tree: it ran on another tree, or changed the tree it ran on. | `ran on tree 7adb9aaaf2067fd501b7f6077cd4b6f6e6af0a8a, not the final tree` |
| `link` | – | A file the checks depend on was changed during the task. | – |
| `fence` | 1 | No receipt of this check is in the ledger. | – |
| `pipes` | 1 | It ran on a tree that cannot be compared with the final tree. | `ran on a tree that cannot be compared with the final tree` |
| `short` | 1 | Fewer runs passed on the final tree than the check asks for. | `1 of 2 runs passed on the final tree` |
| `unrun` | 1 | No receipt of this check is in the ledger. | – |
| `look` | – | A person has to look at it, and the owner has not accepted it. | – |
| `accepted` | – | The owner accepted it for the final tree. | `by [x](javascript:alert(1)) at 2026-11-23T09:30:00Z` |
| `moved` | – | The owner accepted it, but for another tree than the final one. | `by <script>alert(1)</script> at 2026-11-23T09:31:00Z` |

### Receipts

| Receipt | Command | Outcome | Tree | Duration | Time | Check it is listed by |
| --- | --- | --- | --- | --- | --- | --- |
| 9 | `echo "<script>alert('xss')</script>" \| tee out.txt`, shell `bash` | exit `1` | `d19628601d7a` (the final tree) | 1,234.567 s | `2026-11-23T08:00:09.000Z` | `xss` (1) |
| 10 | `node -e "\"><img src=x onerror=alert(1)>"`, shell `bash` | exit `0` | `7adb9aaaf206` (another tree) | 7 ms | `2026-11-23T08:00:10.000Z` | `attr` (1) |
| 11 | `open "javascript:alert(1)" [x](javascript:alert(1)) ![i](https://evil.example/p.png)`, shell `bash` | exit `0` | `d19628601d7a` (the final tree) | 7 ms | `2026-11-23T08:00:11.000Z` | `link` (1) |
| 12 | `a \|\| b \| c ⟦U+005C⟧\| d \⟦U+005C⟧\| e \`, shell `bash` | exit `0` | `fa0d0f4689f4` (cannot be compared with the final tree) | 7 ms | `2026-11-23T08:00:12.000Z` | `pipes` (1) |
| 13 | `mail @octocat #1 https://evil.example` in `src/<b>x</b>`, shell `bash` | exit `0` | `d19628601d7a` (the final tree) | 7 ms | `2026-11-23T08:00:13.000Z` | `short` (1) |
| 14 | `echo "*bold* _it_ ~~s~~ &lt;b&gt;"`, shell `bash` | exit `0` | `d19628601d7a` (the final tree) | 7 ms | `2026-11-23T08:00:14.000Z` | `ok` (1) |
| 15 | `true`, shell `sh` | exit `0` | `d19628601d7a` (the final tree) | 7 ms | `2026-11-23T08:00:15.000Z` | `ok` (2) |
| 16 | `nul⟦U+0000⟧ esc⟦U+001B⟧[31m bel⟦U+0007⟧ cr⟦U+000D⟧ lf⟦U+000A⟧ tab⟦U+0009⟧ del⟦U+007F⟧ c1⟦U+0085⟧⟦U+009B⟧` in `safe⟦U+202E⟧gpj.exe⟦U+202C⟧ ⟦U+2066⟧iso⟦U+2069⟧ ⟦U+200E⟧⟦U+200F⟧⟦U+061C⟧`, shell `<b>sh</b>` | timed out | `d19628601d7a` (the final tree); changed it to `7adb9aaaf206` | 7 ms | `2026-11-23T08:00:16.000Z` | – |
| 17 | `safe⟦U+202E⟧gpj.exe⟦U+202C⟧ ⟦U+2066⟧iso⟦U+2069⟧ ⟦U+200E⟧⟦U+200F⟧⟦U+061C⟧`, shell `bash` | cancelled | not recorded | 7 ms | `2026-11-23T08:00:17.000Z` | – |
| 18 | ```` ```⟦U+000A⟧# heading⟦U+000A⟧``` ````, shell `bash` | ended by signal `<b>KILL` | `6a7ed406029b` (another tree) | 7 ms | `2026-11-23T08:00:18.000Z` | – |
| 19 | ````` `` ` ``` ```` xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx ````` (the first 300 of 4,096 characters), shell `bash` (cut in the pack) | exit `2` | `6a7ed406029b` (another tree); changed it to `d19628601d7a` | 7 ms | `2026-11-23T08:00:19.000Z` | – |

A pack holds no output of a command, only its sha256 and size; this report leaves those out too.

Receipts in the ledger that this pack does not list: 1.

### Diff stat

Files: 3. Lines added: 3. Lines removed: 3. Binary files: 0.

| Path | Change | Lines added | Lines removed |
| --- | --- | --- | --- |
| `<img src=x onerror=alert(1)>.js` | modified | 2 | 2 |
| `safe⟦U+202E⟧gpj.exe` | added | 1 | 0 |
| ``tài liệu⟦U+0009⟧\|`[x](y)⟦U+000A⟧.md`` | deleted | 0 | 1 |

### Changes to the checks

The check-changes report found changes to the files the checks depend on, for 1 of the criteria:

| Criterion | Finding |
| --- | --- |
| `link` | `assertions_removed tests/[x](javascript:alert(1)).test.mjs` |
| `link` | `test_file_deleted tests/"><img src=x onerror=alert(1)>.mjs` |
| `link` | `protected_path_changed asafe⟦U+202E⟧gpj.exe⟦U+202C⟧ ⟦U+2066⟧iso⟦U+2069⟧ ⟦U+200E⟧⟦U+200F⟧⟦U+061C⟧\|b` |

The acceptance file was edited during the task. The criteria here are those of the file as it was when the task started.

Lockfiles that changed:

| Path | Change | Before | After |
| --- | --- | --- | --- |
| `"><img src=x onerror=alert(1)>.lock` | modified | `ca978112ca1b` | `3e23e8160039` |
| `` new\|`lock` `` | added | – | `2e7d2c03a950` |
| `gone.lock` | deleted | `18ac3e7343f0` | – |

Lockfiles that did not change: 1.

### Permission decisions

Permission records in the ledger: 4.

| Decision | Count |
| --- | --- |
| Expired | 1 |
| Cancelled | 1 |
| Blocked | 1 |
| Other | 1 |

### Uncertain events

| Ledger record | Reason |
| --- | --- |
| 6 | `torn_tail` |

Uncertain events the pack counts but does not list: 1.

### Data sent out (Companion)

Not recorded in this pack: a v0.1 statement has no field for what was sent out of this machine, by the Companion or in another way. That does not say that nothing was sent.

### Cost

Known subtotal: 0.0000125 USD. The pack says that this does not cover every call, so the whole cost is unknown.

No amount in Vietnamese dong: no exchange rate was given, and none is built in or fetched.

Cost per verified criterion: not recorded in this pack. A v0.1 statement holds one cost for the whole run, and it is not divided here.

### Integrity level and limitations

- **Integrity level:** `unconfined`: the agent runs as the same user as the Hub and could rewrite what this pack was made from. The pack records what was observed. It is not a seal against the agent.
- **Ledger:** Records: 19. The whole chain verifies; the hash of its last record is `4ddc253cf0bd35087e8e77d3b6432ed5c0728ab0eb6b12a090ca2ad2d640cb3d`.

The pack is not signed.

Limitations the pack names:

- The statement is not signed: its digest names it, and does not say who made it.
- Nothing confined the agent, so it could have changed the inputs of this pack.
- The end of the ledger is not anchored: lines removed from its end leave a shorter ledger that still verifies.
- Changes under paths that are ignored and not tracked are not seen.
- The heuristics also flag legitimate changes to tests.
- Which tests a command runs is not known, so a change to tests counts for every criterion that runs a command.
- Protected files (secrets and keys) are never read, so changes to them are not seen.
- The file and byte counts are those of the last full snapshot.

What the tree ids leave out:

- protected files (keys, credentials, environment files): 2
- the runs folder: 1
- untracked paths that are ignored, not counted
- the content of nested repositories, which count as their commit: 0

- Why the engine of the final tree fell back: `<script>alert(1)</script>`

### How to verify

This report is about the statement `c1ed4404310221bbd8476419845d99964a20f2faa749ef99c8ade9aad668fd8c`. Run check on the pack file and compare: it prints the same digest, or the report is of another pack.

```text
chatmcp verify check hostile.pack.json
chatmcp verify trust --pack hostile.pack.json
chatmcp verify reproduce hostile.pack.json --base <commit|folder>
```

The commands check the pack, show the commands it would run, and run its checks again. Reproduce runs commands that someone else may have written, so read what trust shows before you trust it.

This pack names no base commit: give the commit or the folder the change was made on.
