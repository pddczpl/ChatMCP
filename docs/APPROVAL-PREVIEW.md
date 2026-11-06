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
| `files[]` | at most 20: `path`, `action` (`create`, `overwrite`, `edit`), `baseSha` (sha256 of the bytes the card was made from, null for a file that was not there), `additions`, `deletions`, `unchanged`, `oldUnreadable`, `hiddenKeyRows` (only when above 0: how many of the rows shown were hidden as private key material), `hunks[]`, `shownRows`, `hiddenRows`, `truncated` |
| `hunks[]` | `baselineStart`, `baselineEnd`, `currentStart`, `currentEnd`, `removed`, `added`, `invisibleOnly` (only line endings or a byte order mark differ), `rows[]` of `{kind: context | removed | added, text, omitted?}`, `cut` when rows were left out |
| `fileCount`, `hiddenFiles`, `truncated` | how many files the call has, how many are not on the card |
| `error` | `{code, message}` when the call would be refused when it runs (not found, ambiguous, a stale sha, file exists, a protected file in a batch ...): the card says why and shows no file |
| `privateKeys` | the call touches private key material (a body between two frames, a key that begins and ends in one line, or text of a key on a line that holds a frame); the words the model wrote are then left out of the card |

Bounds: 20 files, 200 rows of a file, a line cut at 400 characters (with `omitted`, never inside a character), 120,000 characters of rows for the whole card. What is left out is counted, never dropped silently.

## What is kept off the card

- A protected file (`.env`, private keys, `.git` ...) never has content on the card, as in `git_diff`. A single-file call on one is refused before anyone is asked; a batch that names one gets a card with
  `error.code = protected_path` and nothing else, and the request of a batch lists paths and sizes, never content.
- Everything on the card is masked by `maskSecrets` like every other word of the request. What it covers, spelling by spelling (`tests/verify-mask-secrets.mjs` is the table: the 49 spellings of a secret and the
  47 lines of ordinary code that the audit of PR #103 probed, and a line for every word of every list below):
  - **Names.** `DB_PASSWORD=...`, `"password": "..."`, `clientSecret = '...'`, and the words `api_key`, `access_key`, `private_key`, `ssh_key` (also `sshKey`), `secret`, `passwd`, `pwd`, `passphrase`, `token` and
    `credentials`, with a prefix and one of the endings `_key`, `token`, `value`, `hash`, `id`, `string`: `tokenCount`, `passwordInput` and `tokenizer` talk about secrets and are not one. A value in quotes is masked
    whatever it says; a bare value is masked from six characters.
  - **A bare value that stays readable.** The type of the name (`token: string;`, `password: Optional[str]`, `secret: SecretStr`, `private_key: Uint8Array`), a read of the environment or of a variable
    (`process.env.X`, `import.meta.env.X`, `os.environ["X"]`, `$_ENV[..]`, `$_SERVER[..]`, `ENV[..]`, `$env:X`, `$X`, `%X%`), a placeholder (`changeme`, `replace-me`, `your-api-key`, `xxxxxxxx`, `********`), the
    plain name of a secret (`password=password`, `this.password = password;`, `token: Token`, `secret = secretKey`) and a member read that ends in one (`this.token`, `config.password`, `settings.db_password`);
    and, in quotes, the three words of fetch's `credentials` option (`include`, `omit`, `same-origin`). Each has to be the WHOLE value: `string1Hunter`, `changeme123`, `password123` and
    `process.environment.X` are masked.
  - **Tokens by their shape.** The common providers' (OpenAI and Anthropic `sk-`, GitHub, AWS, Google, Slack, Stripe, npm, GitLab, Hugging Face, SendGrid, PyPI), JWTs, `Authorization:` and `Bearer`, URLs with a password.
  - **Commands.** The value of `--password`, `--passwd`, `--passphrase`, `--pass`, `--pwd`, `--token`, `--secret`, `--api-key`, `--access-key`, `--secret-key` and of the same with a prefix (`--github-token`) given after a
    space, bare or in quotes, from four characters (the flags that say there is none, `--no-password`, `--ask-password` ..., take no value); `curl -u user:secret` (also `--user`, `--proxy-user`, and `curl.exe`);
    `mysql -psecret` (and mysqldump, mysqladmin, mysqlimport, mysqlcheck, mysqlshow, mysqlpump, mariadb); `sshpass -p secret`; `docker login -p secret` (also podman, nerdctl, buildah, skopeo). A value read from a
    variable (`"$PASSWORD"`, `%PASSWORD%`) stays. `-u`, `--user` and `--proxy-user` are a user and a password wherever they stand (curl, any other client that takes `user:password`, a script, a file of notes; `-u` can have its user glued to it, `curl -uadmin:secret`,
    and a flag can stand right after a quote, `CURL_OPTS='-u admin:secret'`, `echo "-u admin:secret"`), but for two things that
    are a user and a group: the flags of a command that STARTS with a container client (docker, podman, nerdctl, buildah) and stand BEFORE its image (`docker run -u node:node img`, `sudo docker exec -u root:root web sh`,
    `docker compose run --rm --user app:app svc`; the subcommand is run, exec, create or config),
    decided on the COMMAND that holds the flag (the text from the last `;`, `&`, `|` or line ending to the flag, which must hold no `curl` and no `://` and must start outside every quote and substitution), and a numeric pair
    (`-u 1000:1000`, `--user=1000:1000`), which is judged by its shape alone and so needs more: **no `curl` and no `://` anywhere in the text before the flag**. `docker exec web curl -u admin:secret` (the flag is
    curl's), `docker pull x; tool -u admin:secret` (another command), `tool -u admin:secret` (no client), `curl -u 5551234567:123456` (a pair of numbers, but curl's), `curl 'https://x?a=1&b=2' -u 5551234567:7391824`
    (a `&`, `;` or `|` or a line ending inside a quote or a URL looks like the start of a command, and a rule that read only the command would not see the curl), `curl -d 'cmd=ls; docker ps' -u admin:secret` and
    `curl $(echo a | docker run img) -u admin:secret` (the same character, then a container word: what closes the string or the substitution stands before the flag, so the "command" began inside it), `docker run img tool -u admin:secret https://…` (the flag is the flag of the program that runs
    in the container, it stands after the image) and `docker login -u admin:secret` (the user name of a registry) are masked. A secret fails safe: what is not known to be a user and a group is masked, and so is every client that is not on the list (`ctr` takes
    `-u user:password` as the credentials of a registry, and skopeo, kubectl, oc, crictl, lxc and incus are not exempted either). A drive path is no user and password under the same rule as a numeric pair (`diff -u C:\a\old.txt C:\a\new.txt` stays; `curl -u c:/secret` is masked).
    The `-p` of the clients above is the lower-case one: `mysql -P3306` (a port) and `sshpass -P assword` (a prompt) stay.
  - **XML.** `<password>secret</password>` (an element named like a secret, with attributes or with a prefix: `<db-password encrypted="false">`), `<add key="ApiKey" value="secret"/>` and
    `<property name="password" value="secret"/>`.
- A private key: PEM (`BEGIN ... PRIVATE KEY`), OpenSSH and PGP (`BEGIN PGP PRIVATE KEY BLOCK`). A line of a key's body looks like any base64, so its place tells where to look, and its shape tells what to hide.
  **The frames tell where; the shape tells what.** A model can write a BEGIN frame in front of anything, and a card that hid whatever follows a frame would let it hide its code from the owner. So what is hidden
  between the frames (the rows, the rest of the line of a frame, the text of a key written on one line) is base64, and only that:
  - every RUN of 16 characters or more of base64 (`A-Z a-z 0-9 + /`, and `_ -` for base64url, with up to two `=` after it) is replaced by `[REDACTED]` where it stands, and every other character of the row
    stays. The decoration of a key is not what is hidden: a comment sign (`-- `, `REM `, `::`, `#`), quotes, `echo "..." >> key`, `printf`, `Add-Content`, `b"...\n"`, a dot or an ampersand that joins strings, a
    table bar, XML tags, and the `\n`, the PowerShell backtick-n, the `%0A`, the `\x0a` and the `&#10;` of a one-line key. A list of decorations is never complete, so it must not be what decides secrecy (the
    fourth audit of PR #103 found the whole body of a real key on the card in 23 of 31 shapes when it did);
  - a row of a body that is ONE short token (the last line of a key: four characters or more with a capital, a digit or a sign), or the checksum line of PGP (`=ab12`), is hidden whole, and so is a part of a row
    (the rest of the line of a frame, a key in one line) that is nothing but tokens of base64 (`looksLikeKey`).

  Code, commands, URLs, words, the armour headers of PGP (`Comment: ...`, `Version: ...`, `Proc-Type: ...`) and blank lines have no run of 16 characters: they stay on the card, between the frames or not
  (`-----BEGIN PRIVATE KEY-----`, `rm -rf /var/lib/app`, `-----END PRIVATE KEY-----` shows all three). A long word in the middle of a command IS a run: `rm -rf /usr/local/share/very-long-directory-name` shows as
  `rm -rf [REDACTED]` between two frames, and the card counts the row.
  The card masks the rows between the frames by their place in the old and in the new text, wherever it shows them (kept, taken away, put in; a PGP checksum line too), what is base64 in them, and keeps
  the frame lines, the row kinds and the real counts. **It says how many it hid**: a file of the card has `hiddenKeyRows`, and the page writes "N rows hidden as private key material" next to the path, so a file
  that hides rows it should not is seen, not trusted. A key that begins and ends in ONE line (a service-account file keeps the whole key in one line, its line breaks written `\n`) has no body lines: it is hidden
  inside its line, before the row is cut to 400 characters (the key is longer than that, and a cut row has lost its END frame), the fields after it stay readable, and the row stays one row.
  The history keeps the request without the rows.
  A frame line can carry text of the key as well: the start of the body after the BEGIN frame (`key: "-----BEGIN PRIVATE KEY-----MIIE...`), the end of it before the END frame (`...Zm9v-----END PRIVATE KEY-----"`),
  or both (a one-line key that an editor wrapped). That text is hidden too (the runs of base64 in it, or all of it when it is nothing else), the frames and the words around it (`key: "`, `"`) stay, the line
  ending (Unix or Windows) stays, and the call says it touches a key.
  One reading of the text finds all of it (`lib/approval-preview.mjs`: the frames in the order they come, the parts of the text that are key material, then the lines): the masker, the rows of the card and the
  answer of `edit_file` use the same functions, and a line of a megabyte of BEGIN frames is read once, not once from every frame (that took 16 seconds in the answer of `edit_file`). A text is read by itself: the
  masker (`hideKeyBlocks`) hides the keys that begin and end in the text, and leaves the start of a body that goes on beyond it and the end of one that began before it to the card, which knows them by their place
  in the file.
- The answer of `edit_file` and `files_apply_patch` to the model shows the lines around the edit (the model gets them back so that it can check its work). A secret in them is hidden in that answer in the same two
  ways (by spelling, with the registered secrets of the Hub, and the body of a private key by its place, with the text of a key on a frame line cut out), the answer says that something was hidden, and the file keeps it:
  `tests/verify-edit-plans.mjs` (section 5) and `ui/e2e/approval-changes.spec.mjs` (the model's requests are watched for the secret after an approval).

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
- It is a pattern mask. A secret in a spelling nobody listed shows on the card; a protected file never does. The edges of what is listed above, so that nobody is surprised by them:
  - the card masks a file line by line: a flag on a continuation line away from its command (`mysql \` and, on the next line, `-psecret`) is not seen, while `--password secret` is seen wherever it stands; the
    program of a `-p` is looked for within 200 characters before it on the same line (for `sshpass`, the `-p` has to follow it directly);
  - `-u`, `--user` and `--proxy-user` are masked everywhere but for the flags of a command that starts with docker, podman, nerdctl or buildah and stand before its image, a numeric pair and a drive path. The COMMAND is the text from the last `;`, `&`,
    `|`, carriage return or line ending to the flag; a backslash, a caret or a backtick at the end of a line, then the line ending, joins two lines (and counts as one character). Only 200 characters of it are
    looked at, and when its start is not found within them the flag is masked. The flag is a user and a group (of a container command) when (1) the FIRST word of the command is the client (a path and `.exe` are fine: `/usr/bin/docker`,
    `docker.exe`; so are `sudo`, `doas`, `env`, `time`, `nohup`, their flags and `VAR=x` before it; any other prefix is a first word that is none, so `- docker run -u node:node` of a YAML list, `$ docker …`,
    `RUN docker …` and `# docker …` are masked: it fails safe), (2) the text before the flag holds no `curl` (any case, `curl.exe`) and no `://`, (3) **the start of the command is proven to be outside every quote,
    substitution and group**, and (4) **the flag stands before the image**. A `;`, `&`, `|` or line ending INSIDE a string, a substitution (`$( | )`) or a parameter expansion cuts the command where there is none, and what stands after the cut can be a container
    word (`curl -d 'cmd=ls; docker ps' -u admin:secret`, `curl $(echo a | docker run img) -u admin:secret`, `curl "$(echo "a; docker ps")" -u admin:secret`, `curl -d a\;docker ps -u admin:secret`): the "command" is then
    the tail of a string, and the exemption must not be given to it. So the command is read from its start as if that start stood outside, and it must close nothing that it did not open and leave nothing open. What is
    not proven fails the reading and the flag is masked: a quote that does not pair up (a `'` or a `"` that closes before the flag and was never opened in the command); a `)` or a `}` with no `(` or `{` of its own kind
    before it (the closing parenthesis of a substitution is no quote); a `(` or a `{` still open at the flag; a quote inside a group (nested quoting is not read); a backtick anywhere (the quote of a substitution in sh,
    the escape of PowerShell; a backtick that continues a line is skipped first, outside quotes); a backslash or a `$` before a single quote outside quotes (`\'`, `$'...'`: in a single quote a backslash is a character and
    the quote after it closes the string, and nobody can tell where a `$'...'` string ends); and a `;`, `&` or `|` that is escaped with a backslash, a caret or a backtick, which separates nothing. A backslash escapes the
    next character outside single quotes, and a quote of the other kind inside a quote is a character like any other: `docker run -e "NAME=O'Brien" -u node:node img` and `docker run -v $(pwd):/app -u node:node img` stay.
    **What (3) proves is that the text between the cut and the flag is a plain command, not the tail of a string. It proves no more**: it is a reading of the text, not a shell, so a contrived mix of nested quotes and
    escapes that only one shell reads that way can still fool it (a fuzz of valid-by-construction curls with nested quoting found none in 1.8 million), a flag inside
    a quoted string is a flag of that string and is shown (`curl -d 'cmd=ls; docker ps -u admin:secret'`: the limit of a flag inside a quoted string, below), and a here-document or a comment is not read. The edges of (3),
    all on the side of masking: a `;` inside quotes ends the command too (`docker run -e 'A=b;c' -u node:node img` is masked, a limit); a double-quoted path that ends in a backslash (`docker run -v "C:\data\":/data
    -u node:node img`), and a `;` after a path that ends in a backslash (`cd C:\work\; docker run -u node:node img`, the backslash is taken for an escape); a quote inside a substitution (`-e "T=$(cat 'f')"`), a backtick
    substitution (``-e A=`date` ``), a `\'` or a `$'...'` string and a bracket that is not closed inside double quotes (`--label "a :)"`) fail the reading too (everyday container commands stay readable: `-v $(pwd):/app`,
    `-e "A=b"`, `-e "H=${HOME}"`, a PowerShell command over several lines with a backtick at the end of each line); a URL before the flag (`docker -H tcp://127.0.0.1:2375 run -u node:node img`) or a word `curl` anywhere
    before it (`docker run curlimages/curl -u a:b`) masks it; `docker run -v /data:/data -u node:node img` holds no URL and stays; a container command keeps its place after a curl or a URL EARLIER in the text
    (`curl https://x -o f; docker run -u 1000:1000 img` stays). **(4) The flag stands before the image.** `docker run [flags] IMAGE [COMMAND] [ARGS]`: what follows the image belongs to the program that runs in the container, so `docker run img tool -u admin:secret https://…`, `docker run --rm img -u admin:secret`
    and `docker exec web mytool -u admin:secret` are masked, and so is a flag after the container of `exec` or the service of `compose run`. The words between the client and the flag must be the subcommand (`run`, `exec`, `create` or `config`; `compose`, `container` or
    `service` may come first: `docker compose run --rm -u node:node app`) and flags with their values. A long flag takes the word after it unless it is one of the fifteen that take none (`--rm`, `--init`, `--privileged`, `--read-only`, `--detach`,
    `--interactive`, `--tty`, `--publish-all`, `--quiet`, `--no-healthcheck`, `--no-deps`, `--build`, `--service-ports`, `--remove-orphans`, `--help`); a short flag takes it only if its letter is one of `e v p w l h m c a f u n` (`-it`, `-d`, `-k` take none), and a value glued
    to the flag (`-p80:80`, `--name=web`) is its own. Any other subcommand has no user and group in its `-u` (`docker login -u admin:secret` is a user name; `docker pull`, `docker build`), and a command with no subcommand at all is masked. This only narrows what is
    readable: it cannot show what the rules before it mask. What remains: a long flag that takes no value and is not on the list swallows the image (`docker run --some-flag img --user a:b` shows). **A numeric pair and a drive path look at the whole text, not at the command**, because a separator inside a quote or a URL (`curl -H 'Accept: text/html; q=0.9'
    -u 5551234567:7391824`, `curl 'https://x?a=1&b=2' -u ...`, a JSON body over several lines and then `-u`) cuts the command where there is none and hides the curl: a user and a password that are both numbers up
    to ten digits long (`-u 1234:5678`), and a user of ONE letter with a password that starts with a slash (`-u c:/x`, read as a drive path), are exempt only with no `curl` and no `://` anywhere before the flag
    (`curl -u 5551234567:123456` is masked on purpose, though it is numbers). The one over-mask that remains: the numeric pair or the drive path of an unknown tool is masked when a `curl` or a `://` stands EARLIER in
    the same text (`tool -u 1234:5678` under a curl example). A URL after the flag does not count (`tool -u 1000:1000 https://x` stays). The three spellings that the rule did not see are decided like this: the user glued to `-u` (`curl -uadmin:secret`) and a flag right after a quote
    (`CURL_OPTS='-u admin:secret'`, `echo "-u admin:secret"`, and every string value of the JSON text of a call, which starts after a quote) are masked like the flag with a blank, with the same two exemptions (a quote that is open at the flag fails the reading
    of a container command: `docker run img '-u node:node'` is masked); a flag after the program of a container is masked by (4). What remains is a flag DEEPER inside a quoted string: it is a flag of the command that the string spells, and the card cannot tell a string of data from a
    command, so `curl -d 'cmd=ls; docker run -u admin:secret img'` shows (`docker ps -u …` in the same place is masked, `ps` has no user and group);
  - **the arguments of a tool call are masked as the strings they hold, not as JSON.** The prompt of a tool that is not local, and the `arguments` of a local tool that has no card of its own (`tasks_run`, `git_commit` ...), are the JSON of the arguments.
    In JSON a double quote is `\"`, a line break `\n` and a tab `\t`, and no rule decodes that, so `previewArguments` (`lib/permissions.mjs`) masks the DECODED strings first (the rules of the command of a local `run_command` card, the registered secrets of the Hub)
    and only then writes the JSON; the text is then masked once more for what only the text shows, the name of a key next to its value (`"passwd":"…"`, `pwd`, `credentials`, `access_key`) and the other fields of the call (a `curl` in one field makes a pair of numbers
    in the next a password). Before this a double-quoted credential was masked by no rule (`--user \"admin:S\"`, `--password \"S\"`, `mysql -p\"S\"`, `export API_KEY=\"S\"`: 8 of 13 shapes of the audit's probe), a container word after a cut inside such a
    string looked as if it stood outside it (`curl -d \"cmd=ls; docker ps\" -u admin:secret`), `curl` after `\n` had a letter in front of it and was no word (`{"command":"cd /app\ncurl -u 5551234567:7391824 https://x"}`), and a registered secret that holds a quote or a
    backslash was never found in the text of the card, because JSON writes it differently. What stays: the strings are cut at 700 characters before they are masked, as the card always did (a secret that straddles the cut shows its first characters; a quoted one with no closing quote in what is left is not masked at all); an argument
    list (`["curl","-u","admin:S"]`) is one string per word, and a flag and its value in two strings are not read together; `curl -u token:` (the secret in the user slot, an empty password) is not seen; and the card of a FILE is drawn line by line as it is,
    so a command inside a string of another language IN A FILE (a `package.json` script, a YAML `run: "…"`, a Python string, a YAML, PowerShell or SQL string that doubles its quotes) is read as text. For that text a quote written `\"` (or `\'`) is a quote
    for the rules of a value in quotes (`--user \"admin:S\"`, `--password \"S\"`, `mysql -p\"S\"`, `export API_KEY=\"S\"`, `password: \"S\"`) and a bare value does not start with one; and three fail-safes mask what the reading cannot prove: `curl` after
    a backslash and n, r or t is curl; a `\"` outside quotes that can close something (it is followed by a blank, `)`, `}`, `]`, `,` or `:`, or it stands right before the flag) fails the proof that a container command starts outside every quote; so does a doubled
    quote glued to the word before it (`ps''`), which an empty argument after a blank (`--entrypoint ''`) does not. The price is a container command written that way (`docker run -e A='' -u node:node img` is masked). The shell-aware fuzz of the audit puts a
    generated command (curl, a container client, another program; quotes, substitutions and separators in its arguments) inside a JSON string, a YAML double-quoted `run`, a Python string and a YAML or PowerShell string that doubles its quotes: 4,915 to 6,612 of
    100,000 flags leaked before and none leaks now when the credential carries no quotes; with quoted credentials too (the fuzz writes two of its seven spellings of the flag that way) the JSON, YAML double-quoted and Python wraps went from
    12,433 to none in three seeds, and the two wraps that double their quotes from 13,998 to 8,329. What is left there is a credential in quotes INSIDE a string that doubles its quotes (`'curl -u ''admin:S'' https://x'`): to the rules `''admin:S''` is an empty
    string, a name and another empty string; a doubled quote is not read as a quote, because `--token ''; echo ''` would then lose what stands between. What else a reading cannot do: tell `\n` from a line end in a script that a file keeps as ONE string (the walk back to the start of a command stops at a real
    line end only, so a container command on an earlier line of such a string could lend its exemption to a later program; the image rule makes the fuzz find none, and nothing proves that there is none), and read a secret NAME written with escaped quotes
    (`\"password\":\"x\"`: a JSON document inside a string of a file);
  - a private key pasted WITHOUT its frames is not recognised (a line of base64 looks like any other, and only the place between two frames tells); the body of a DER key (it starts with `MII`) is masked by its shape;
  - what is hidden between two frames is a run of 16 characters or more of base64, and a row that is ONE short token. The edges of that, so that nobody is surprised by them:
    - a last line of a key that is decorated AND shorter than 16 characters shows (`echo "t2R23QrNfeo=" >> key`, `-- t2R23QrNfeo=`): the last line of a key can be one to 64 characters, there is no run in a
      short one, and the decoration keeps it from being a row of one token. A last line of a body that is shorter than four characters (the end of an OpenSSH key can be one or two characters: `==`) and a
      short last line of letters only are shown as well;
    - a key cut into pieces of fewer than 16 characters (a space or another character every eight: `MIIEvQIB ADANBgkq hkiG9w0B ...`) has no run and shows: the mask looks for the runs of a real key and
      cannot tell a cut one from words. A model that has a key can write it in any form: the mask stops the common ways of writing one, not a model that works at getting round it;
    - a line of ONE token behind a BEGIN frame is hidden whole when it looks like the last line of a key (four characters or more with a capital, a digit or a sign: `Stop-Computer`, `Restart-Computer`,
      `/sbin/reboot`, `SHUTDOWN`), and the card counts the row. A command with arguments (`Stop-Service nginx`, `rm -rf /var/lib/app`) and a word in lower case (`reboot`) stay;
    - a long word in a command (`rm -rf /usr/local/share/very-long-directory-name`, `deploy-all-the-things`) is a run: it is hidden by itself, the command around it stays, and the card counts the row;
    - a BEGIN frame inside a key is a part of that key: the outer frames stay, the base64 on both sides of the inner one is hidden where it stands, and the dashes of the inner frame that touch it go with it;
    - the armour headers of PGP and blank lines between the frames are shown on purpose;
  - a value of fewer than four characters after a flag or in an XML element, and an XML entry whose `value` does not directly follow its `key` (or `name`), are not masked;
  - a bare value that is the name of another variable with a prefix and no dot (`password = MyPassword`, `jwt_secret = supersecret`) or a member read that does not end in a secret word
    (`password = form.password.data`) is masked: a word of letters cannot be told from a weak password by its shape;
  - `ssh_key = "~/.ssh/id_ed25519"` (a path) is masked too: the name says key, not which.
- `read_file`, `search_files` and the other tools that show the model the content of an ordinary (not protected) file are as they were: a secret in such a file reaches the model when the model reads that file.
  Only the card and the answer of an edit were changed here.
- A registered secret that spans several lines is masked line by line, so it is not masked as one.
- A file that changes between the check and the rename is caught by the re-hash in `writeFileAtomic` (`stale_revision`), not by the guard.

Tests: `tests/verify-line-diff.mjs`, `tests/verify-edit-plans.mjs`, `tests/verify-approval-preview.mjs`, `tests/verify-mask-secrets.mjs` (the last three share the 31 shapes of a key and the edges of a run in
`tests/support/key-shapes.mjs`), `tests/verify-permissions-modes.mjs` (the prompt of a tool that is not local and the `arguments` of a local tool with no card, 95 calls through the gate; the shapes are shared with the mask suite in
`tests/support/json-text-shapes.mjs`), `ui/tests/change-preview.test.mjs` (how the page reads the request),
`ui/tests/approval-changes.test.mjs` (the real components), `ui/tests/change-preview-vs-review.test.mjs` (the hunks of the card are those of the Review tab) and `ui/e2e/approval-changes.spec.mjs`.

Mutation lists (`node tests/mutation/run-mutations.mjs tests/mutation/<list>.json`): `line-diff.json`, `edit-plans.json` (the planners), `approval-guard.json` (the guard, the gate, the manager), `approval-preview.json`
(the card: bounds, a cut line, the runs of base64 and where they are hidden, the state machine that finds the frames, the count of hidden rows), `mask-secrets.json` (every rule, every word of every list,
the command that holds a flag of the user and where its image stands, the runs of base64 of a key, previewArguments), `approval-arguments.json` (how the gate uses previewArguments) and `change-preview.json` (the page's reader): 1013 mutations, 988 killed,
25 equivalent with the reason written in the list, 0 survived.
