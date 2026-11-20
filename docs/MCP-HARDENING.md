# MCP client hardening

Roadmap phase P2 (MCP client behind the permission gate), plan task ext-13. Slice C1 wrote three pure modules (plain data in, plain data out, no MCP SDK);
slice C2 wired them into the client manager (`lib/mcp/client-manager.mjs`) and added the owner's launch approval: see "Wired into the client manager" below.

| Module | What it is for |
|---|---|
| [`lib/mcp/sanitize.mjs`](../DATGOLD-HUB/lib/mcp/sanitize.mjs) | What of a server's tool, prompt and resource lists may reach the model or an approval dialog |
| [`lib/mcp/fingerprint-pins.mjs`](../DATGOLD-HUB/lib/mcp/fingerprint-pins.mjs) | The rug-pull defence: a pin per approved server, `needs_review` with a diff when its lists change |
| [`lib/mcp/result-limits.mjs`](../DATGOLD-HUB/lib/mcp/result-limits.mjs) | A tool result bounded before it reaches the model; a bounded collector for a server's stderr |
| [`tests/fixtures/mcp-malicious-server.mjs`](../DATGOLD-HUB/tests/fixtures/mcp-malicious-server.mjs) | A hostile stdio MCP server, written without the SDK, driven by flags (listed at the top of the file) |

## sanitize.mjs

Guarantees (each one is a test in `tests/verify-mcp-sanitize.mjs`):

- **Total.** Every export answers garbage (null, numbers, 5 MB strings, 100,000-deep objects, throwing getters, proxies, `__proto__` keys) with a refusal
  and a reason, never an exception. Only own properties are read, so a polluted `Object.prototype` adds nothing.
- **Names** match `[A-Za-z0-9_.-]`, are 1 to 128 characters long (the MCP tool-name rule; 256 in C1, lowered in C2 so that the client manager and the
  sanitizer have one rule) and are not `__proto__`, `constructor` or `prototype`. A bad name is **refused, never
  rewritten**: a rewritten name would ask the server for something other than what the owner approved. The refusal carries an ASCII preview in which a
  hidden character is spelled `\u{200B}`.
- **Descriptions and titles**: the hidden characters are removed first, then the text is cut to 2,048 UTF-8 bytes at a code point (never half of a
  surrogate pair), and a marker such as `[DatGold: invisible or control characters removed; cut to 2048 bytes]` says what happened; the marker fits
  inside the limit. Hidden means every Cc and Cf code point except tab and newline (C0, DEL, C1, soft hyphen, bidirectional marks, embeddings, overrides
  and isolates, zero-width characters, word joiner, invisible operators, BOM, interlinear annotation, tag characters), every Default_Ignorable_Code_Point
  (the invisible fillers, the variation selectors, U+2065, U+FFF0-U+FFF8 and the whole block U+E0000-U+E0FFF, assigned or not) and lone surrogates. A CRLF
  becomes LF and U+2028 / U+2029 become a newline, without a marker. A sweep checks that all 4,174 Default_Ignorable code points of Node 24's Unicode
  tables are removed.
- **Input schemas**: plain JSON, at most 32 levels and 64 KB, both counted while walking, so a 50 MB string, an object that contains itself or a graph of
  shared references ends early; no `__proto__` key; no hidden character in a key or a value (descriptions and titles inside the schema are cleaned and
  cut instead); `$ref`, `$dynamicRef` and `$recursiveRef` must be local (`#...`) and `$id` must not be an absolute URI (it would move the base of every
  reference under it); `$schema` is not checked, because it only names a dialect and is never fetched. No reference is resolved, so a cycle of them
  cannot hang anything. The top level must be `type: "object"`.
- **Annotations**: only `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`, only as own booleans; the rest is named as dropped.
- **Lists**: at most 1,000 items are read; the first of two items with one name (or URI) wins; at most 100 refusals are listed, all are counted.
- Sanitizing twice changes nothing (500 random dirty tools). Property test: seed `0x5eed2c1`, 6,000 random texts of random Unicode (astral characters,
  lone surrogates, every removed class): never throws, never over the limit, always well-formed, no removed class left, always a prefix of the cleaned
  text. Timing budget, asserted: 10,000 calls on 2 KB inputs in 2.5 s and a 1 MB input in 300 ms (measured on the development machine: about 500-600 ms
  and at most 35 ms).

It does not:

- strip hidden characters from tool **results**; a file that a server reads back must stay what it is (see `result-limits.mjs` below);
- map a name to what a model provider accepts (some providers refuse a dot); that is the catalog's job in C2;
- resolve or validate `$ref` targets, or validate a schema against the JSON Schema meta-schema;
- keep `outputSchema`, `_meta`, `icons` or `annotations.title`; a later slice may add `outputSchema`.

## fingerprint-pins.mjs

A pin is, for every item of the **sanitized** lists, a SHA-256 of each field (`title`, `description`, `inputSchema`, `annotations` of a tool; `title`,
`description`, `arguments` of a prompt; `name`, `title`, `description`, `mimeType` of a resource) over a canonical JSON of this module's own (keys sorted
by UTF-16 code units, never by locale). `check(serverId, snapshot)` answers `unpinned` (never approved), `pinned` (the same) or `needs_review` with a
diff: which items were added, removed or changed, and in which field. `approve(serverId, snapshot, {expectedFingerprint})` pins; with the fingerprint the
owner was shown, a snapshot that has changed since is refused (`fingerprint_mismatch`).

Not a change (noise that would otherwise quarantine a server for nothing): the order of items and of object keys; runs of whitespace and NFC versus NFD in
descriptions and titles (also inside schemas); the order of `required`, of a `type` list, of `enum` members and of prompt arguments; annotations written out
at their MCP defaults or left out; whatever the sanitizer removes or drops (more or fewer hidden characters once the marker is there, text beyond the
2 KB cut, `_meta`, `icons`, `outputSchema`, a resource's `size`, refused items).

A change: any other change of a word (letters, case, two words joined), of a title, of a schema (a parameter added or removed, a new required parameter,
a changed type, `enum` member, default or nested description), of an annotation's effective value (a flipped `destructiveHint`), hidden characters
where there were none (the marker appears), an added or removed item. A server that puts a timestamp into a description is quarantined on every change:
there is no telling a timestamp from an instruction. A whitespace change in a description longer than 2 KB moves the cut and can count as a change.

The store is one JSON file (`mcp-pins.json`) under a directory it is given, written whole through a temporary file and a rename. It holds hashes, not
the descriptions. A corrupt file is an empty store (every server must be approved again, which fails closed), logged once and copied aside as
`mcp-pins.json.corrupt`; a file that cannot be **read** refuses `check` and `approve`, so the pins in it are never replaced by an empty store. Calls are
served one after the other in the order they were made. Not handled: two Hubs writing one store at the same time (the Hub's instance lock prevents that).

## result-limits.mjs

`limitToolResult(raw, {taskId, toolName, optimize, limits})`:

- One ceiling of 8 MiB for what is kept of a result, shared in order by the text of text blocks and embedded text resources, the base64 of images and
  audio, the strings of resource links and the JSON of `structuredContent` (which gets what the content left). 4 KiB of it are kept for the note that
  tells the model what was cut or dropped (`[DatGold limited this result: text cut: 44044288 of 52428800 bytes not shown (ceiling 8388608 bytes)]` for a 50 MiB text). A text is cut at a code
  point.
- Images: 8 at most, 5 MiB each (decoded), base64 data of a type the model providers accept: `image/png`, `image/jpeg`, `image/gif` or `image/webp`
  (`PROVIDER_IMAGE_TYPES`; C2). Any other image type (`image/svg+xml`, `image/bmp` ...), also as the blob of an embedded resource, is dropped and the note
  names its type: it never reaches the model as an image block. Audio: 2 clips, 5 MiB each, `audio/*`. 256 content items at most. Unknown
  content types are dropped, and the note names them (escaped, five at most). `isError` is kept exactly when it is `true`; a result that is not an object
  is an error.
- Then the model-facing cap of `lib/token-optimization.mjs` `optimizeToolResult`, when a task is given. The agent loop (`lib/agent.mjs`) calls
  `optimizeToolResult` on every tool result itself, so a caller whose result goes on through that path passes `optimize: false`.

It does not:

- cap what the model sees below 8 MiB for most MCP tools: `optimizeToolResult` compacts only the tool names it knows (`run_command`, `git_*`, `test_*`,
  `web_*` ...), so a result of any other tool reaches the model at up to the ceiling. **Still open after C2** (no decision was asked for in C2): a
  model-facing cap for MCP results, or a rule in `optimizeToolResult`;
- bound what is **read** from the transport: the 8 MiB is applied to a result that was already parsed. The stdio reader of the client manager stops at a
  ceiling of its own (64 MiB per message, C2, below);
- remove hidden characters from result text, or validate `structuredContent` against the tool's `outputSchema`.

`createStderrCollector({maxBytes})` keeps at most `maxBytes` (default 64 KiB) of a server's stderr, the first half and the most recent half, counts what it
dropped and returns whole UTF-8 characters with hidden characters removed.

## Wired into the client manager (slice C2)

What `McpClientManager` does with these modules, and the approvals it adds. Until the screen and the HTTP routes of slice D (ext-14) exist, the
approvals are given only by code (the tests, `scripts/Verify-McpRuntime.mjs`): on an installed Hub no server is started or offered yet.

- **Launch approval (stdio).** `launchRecord(id)` gives `{required, approved, fingerprint, record}`; the record is the command, the arguments and the
  working folder once their `${NAME}` references are expanded, with every secret value replaced by `[secret]`, the NAMES of the env map (never a value),
  the executable the Hub will start (resolved on the PATH the server gets, with PATHEXT on Windows, as a real path) and the sha256 of that file. Its
  fingerprint is a sha256 of the record's canonical JSON. `connect` spawns nothing until `approveLaunch(id, {expectedFingerprint})` was given that
  fingerprint (`mcp_launch_not_approved`, 409, state `needs_launch_approval`), and any change of the record (an argument, an env name, other bytes in the
  executable) asks again; the Hub then spawns the file it hashed. A stale `expectedFingerprint` is `mcp_launch_changed`; none, or the key
  `{fingerprint}`, is `mcp_fingerprint_required`. Kept in `mcp-approvals.json` beside `mcp-servers.json` (no secret in it). HTTP servers have no launch
  record: the https-only rule (http only to a loopback address) stays, and a cross-origin redirect is not followed, so the `Authorization` header never
  reaches another origin (`redirectPolicy: 'same-origin'`, tested).
- **Lists.** Every tools, prompts and resources list goes through `sanitizeList` before anything else sees it: the catalog, the instructions, the
  approval card and `toolReview`. One name rule for the Hub, 1-128 characters, per item (the client manager no longer refuses a whole list for a name);
  the count of refused items is `status().servers[].refused`.
- **Pins.** Tools and prompts are pin-checked (`createPinStore`, `mcp-pins.json`) at connect and at every task preflight (`prepare`). Unpinned or
  changed lists make the server `needs_review` (the status carries the diff of `diffEntries`): its tools are absent from `catalogGroups()` and a call is
  refused with `mcp_needs_review` before anything is sent. `toolReview(id)` shows what was checked; `approveTools(id, {expectedFingerprint})` pins it and
  refuses a stale fingerprint (`mcp_fingerprint_mismatch`). Resources are NOT pinned: a resource list is data that changes (files, records); only its
  `uri`, `name` and `mimeType` are offered, never a description or a title.
- **Results.** Every `callTool` result goes through `limitToolResult` (`optimize: false`: the agent loop optimizes it once). Prompt and resource answers
  are bounded copies (`copyJson`, 8 MiB).
- **Reading stdio.** The client manager reads the newline-delimited JSON itself (`LineReader`), not with the SDK's `ReadBuffer` (which copies its whole
  buffer on each chunk and caps the buffer at 10 MiB in all, not per message): one message over 64 MiB (`MAX_MESSAGE_BYTES`) closes the connection
  before it is parsed, with `mcp_message_too_large` in the status and on the call. 64 MiB lets a 50 MB result be read and then cut to the 8 MiB ceiling.
- **Listings** are refused whole past 10,000 items or 16 MiB in all pages (`mcp_list_too_large`), before anything is sanitized.
- **Preflight** waits 3 s in all and backs off a server whose connect failed (1, 2, 5, 15 minutes; `retryAt`), so a server that is down does not
  hold every task start for its connect timeout.
- **stderr** goes into `createStderrCollector` (64 KiB, `status().servers[].stderr` has its counts); the first 200 lines also go to the Hub log, masked.
- **Calls.** A hung call ends at its timeout and is never sent again; a caller's abort after the request went out is `mcp_call_aborted` with
  `executed: 'unknown'` (an abort before anything was sent rejects with the signal's reason).
- **Never read**: a workspace `.mcp.json`.

## Tests

| Suite | What it proves |
|---|---|
| `tests/verify-mcp-sanitize.mjs` | names, text, schemas, annotations, lists, totality, properties (seed `0x5eed2c1`), timing |
| `tests/verify-mcp-fingerprint-pins.mjs` | every kind of noise listed above keeps a pin, every listed change does not and the diff names the item and the field; the store, corrupt and unreadable files, concurrency |
| `tests/verify-mcp-result-limits.mjs` | the ceiling, structured content, media, unknown types, `isError`, `optimizeToolResult`, the stderr collector, totality |
| `tests/verify-mcp-malicious-fixture.mjs` | the fixture over real stdio with a few lines of JSON-RPC: 1 MB description to 2 KB, changed description to `needs_review`, 50 MB result capped, a hung call counted once, a 5 MB stderr flood, a repeated cursor, a `$ref` cycle |
| `tests/verify-mcp-hardening.mjs` | the wiring above through the real client manager and the fixture: launch approval, pins and quarantine, the 1 MB description, the 50 MB result, the read limit, stderr, hung and aborted calls, the cross-origin redirect, `.mcp.json`, no process left after `HubManager.shutdown()` |

Mutation lists: `tests/mutation/mcp-sanitize.json`, `mcp-fingerprint-pins.json`, `mcp-result-limits.json`, `mcp-hardening.json` (C2).
