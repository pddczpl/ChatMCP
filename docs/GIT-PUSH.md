# The `git_push` tool

The agent can publish a branch. Before this tool it could commit and merge but not push (a push had to go through `run_command`, which a person had to approve without seeing what would be sent). `git_push` is built to be **dangerous by default**: it sends commits out of the machine, so it asks every time, in every mode, and it refuses what it can tell is wrong before it asks.

Code: `DATGOLD-HUB/lib/git-push.mjs` (the rules and the Git steps), wired in `lib/local-tools.mjs` (the tool) and `lib/permissions.mjs` (the question). Card: `ui/src/components/approval/GitPushPreview.tsx`.

## Arguments

| Argument | Meaning |
|---|---|
| `remote` | the **name** of a remote that is already configured (default `origin`). Never an address, a path or an option. |
| `branch` | the local branch to push (default: the current one). A plain branch name. |
| `set_upstream` | make the remote branch the upstream of the local one. Default: only when the branch has none. |

There is no other argument: the schema has `additionalProperties: false`, so `force`, `force_with_lease`, `delete`, `mirror`, `all`, `tags`, `prune`, `refspec`, `url` ... are refused as invalid arguments before anything is asked. A `branch` or `remote` value that is not a plain name (`+main`, `--force`, `a:b`, `HEAD:main`, `refs/heads/x`, a wildcard, an address ...) is refused the same way. The command that runs is always `git push --porcelain --no-verify --no-follow-tags --recurse-submodules=no [--set-upstream] <remote> refs/heads/<b>:refs/heads/<b>`: one branch, spelled out in full.

## Permission

`git_push` has the category `dangerous`.

| Mode / policy | What happens |
|---|---|
| Review, Autonomous, **Full Access** | the owner is asked, every time, with the card below. Neither Autonomous nor Full Access waives it (the name is also on the list of operations that Full Access never waives). |
| Read Only | refused without asking |
| `sandbox-only` | refused without asking: it is Git on the host sending commits out, which that policy does not allow (`docs/PHASE1-DESIGN.md`) |
| a coding worker, an agent that a model spawned | refused at once: nobody can answer |
| a push that the checks below refuse | refused **without a question**, in every mode: an approval cannot override it |

The Full Access banner ("Dangerous actions (deleting data, push, merge, release) still ask") stays true.

## What is checked before the owner is asked (local Git only, no network)

In this order; each refusal has a code the model reads:

1. the arguments are plain names (`invalid_arguments`);
2. the folder is a Git repository whose root is the workspace, and Git can run in it (`not_git_repo`, `git_root_mismatch`, `git_config_untrusted`, `git_missing`);
3. the repository's own configuration (`.git/config` only) names no program for the network and does not reroute the connection: `credential.helper`, `core.sshCommand`, `core.askPass`, `core.gitProxy`, `remote.<n>.receivepack`, `uploadpack`, `proxy`, `vcs`, and the HTTP transport settings `http.proxy`, `http.<url>.proxy`, `proxyAuthMethod`, `sslVerify`, `sslCAInfo`, `sslCAPath`, `sslCert`, `sslKey`, `pinnedPubKey`, `extraHeader`, `cookieFile` (a proxy of the repository's own together with a switched-off certificate check would let the author of the folder read the push) (`push_untrusted_repo`; the setting is named, never its value; the settings that the runner refuses for every command, such as a clean filter or a configuration too large to read, are `git_config_untrusted`). The person's global and system configuration is theirs and is used;
4. the remote is configured (`remote_not_found`), and it has exactly **one** effective push address (after `insteadOf`; with several, `git push` would go to every one while the card shows one), which is not a helper (`ext::...`, `x::y`) and does not start with `-` (`push_bad_remote`);
5. the branch exists (`branch_not_found`) and HEAD is on a branch when none was named (`detached_head`);
6. it is not `main`, `master` or the remote's default branch (`origin/HEAD`), compared without regard to case (`push_protected_branch`: "use a feature branch and a pull request"; the owner can push those by hand);
7. the remote-tracking branch, if there is one, is an ancestor of the branch: otherwise the push would need a force (`push_not_fast_forward`);
8. there is something to send (`nothing_to_push`);
9. none of the commits that **would be sent** (those the remote has not got, by the last fetch) adds a protected file (`.env`, private keys, `credentials`, `.npmrc` ... the same rule as `git_add`) or text that the outbound scanner of the Companion safeguards (`lib/outbound-redaction.mjs`) takes for a secret (`push_protected_file`, `push_secret_found`). The refusal names the kind, the file and the commit, never the text. Only added lines are read, in every commit of the range (a secret that a later commit removes was still in the history), not lines the remote already has. A range that cannot be read whole is refused too (`push_scan_incomplete`).

Then the owner is asked. **After** the answer, `git_push` is held to what was shown: the branch must still point where it pointed, and the remote must still have the same address, as when the card was made (`plan_changed` otherwise; call again to get a new card), the remote is asked for its default branch (`git ls-remote --symref`) in case `origin/HEAD` said nothing (`push_protected_branch`), and then the push runs with a 90 s timeout and honours Stop (the process tree is killed). A refusal by the remote is `push_rejected`, any other failure `push_failed`, a timeout `push_timeout`.

## The card

Remote name and its address (credentials removed), `local branch -> remote / branch` (and whether the upstream is set), the commits that would be sent (short hash, subject, author, day; oldest first; the newest 50, with the number of older ones that are not listed), the totals and the diffstat (one click). It is shaped by `pushApprovalDetail()` in `lib/git-push.mjs`; the page reads it with `parseGitPushDetail()` (`ui/src/lib/git-push-approval.ts`) and every sentence goes through `t()` in Vietnamese and English.

## Credentials

The user part of an http(s) address (it can be the token itself) and the password of any other address are replaced by `[REDACTED]` on the card, in the history, in the result and in every line of Git's output; token shapes and the secrets the Hub knows are replaced too (`redactPushOutput()`). Hooks of the repository never run (`--no-verify` and the runner's empty hooks folder). Git runs through the hardened runner (`lib/git-runner.mjs`): scrubbed environment (`GIT_TERMINAL_PROMPT=0`, no `GIT_CONFIG_*` injection), no prompts.

## Events and receipts

The events of the call carry `callId` and a bounded `input` with `remote` and `branch` only (`lib/tool-event-input.mjs`). The result is `{pushed, remote, branch, ref, range: {from, to}, commits, setUpstream, upstream, url}`: `from` is what the remote-tracking branch had (null for a new branch), `to` the commit pushed. A push changes no file of the project, so it is not in `mutatesTree` (`lib/agent-progress.mjs`) and does not make the receipts of a test or a review stale. No checkpoint is made.

## What is not verified, and limits

- A push to a real host (GitHub) with the owner's credentials has **not** been run: the tests push to a bare repository on disk. Credentials come from the person's own Git configuration (a credential manager, an ssh agent); the runner keeps `SSH_AUTH_SOCK` and the askpass variables, drops variables that look like tokens, and never prompts, so the first push to a host may fail until the owner has pushed there once by hand.
- The scan is a pattern scan of added text (`docs/COMPANION-PRIVACY.md` says what the scanner is and is not), not a guarantee. It does not read binary files, and it does not read the conflict resolution inside a merge commit (the commits it merges are read).
- The list of commits is as good as the last fetch: with stale remote-tracking branches it can list commits the remote already has (never fewer than would be sent), and a push that the remote rejects because someone else pushed in between is `push_rejected`.
- Not covered, on purpose: pull requests, force, deleting a branch or a tag, pushing tags, pushing main.

Tests: `tests/verify-git-push-logic.mjs`, `tests/verify-git-push.mjs` (mutation lists `tests/mutation/git-push-logic.json`, `git-push.json`), `ui/tests/approval-git-push.test.mjs`, `ui/e2e/git-push.spec.mjs`.
