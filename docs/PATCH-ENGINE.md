# The patch engine (`lib/patch-apply.mjs`)

Plan task multi-agent-tools-20 (phase P5). A pure module that reads a patch and works out the new text of every file it touches.
**Nothing calls it yet.** The `apply_patch` tool (multi-agent-tools-21) will wrap it with the file reads and writes, the checkpoint,
the permissions and the receipts. Until then the agent edits files with `edit_file` / `files_apply_patch` in `lib/local-tools.mjs`, unchanged.

The module has no import, no file access, no process, no clock and no randomness (the suite checks its source for each). The caller
hands in the text of the files; the engine hands back what to write and what to delete, or one refusal. It never writes half a patch:
`applyPatch` is all or nothing.

## API

```js
import { applyPatch, parsePatch, applyFilePatch, patchPaths, checkPatchPath, PatchError, PATCH_LIMITS, FUZZ_LEVELS } from './lib/patch-apply.mjs';

const parsed = parsePatch(text);              // { format: 'unified' | 'envelope', files: FilePatch[] } or throws PatchError
const { reads, writes } = patchPaths(parsed); // the paths to read first (text, or null when missing) and the paths it may write or delete
const result = applyPatch(text, files);       // files: { path: text | null } or a Map; never throws
// { ok: true, format, changes: [{ path, action: 'create' | 'modify' | 'delete', text, mode }], reports: [{ kind, oldPath, newPath, hunks }] }
// { ok: false, error: { code, message, file, hunk } }
```

Every hunk report gives `line` (where its old lines start in the original file, 1-based), `expectedLine` and `offset` (unified diffs
only), `fuzz` and `fuzzName` (the rung of the ladder below), `matchedLines` (always every old line of the hunk) and `anchorLines`
(envelope `@@` anchors). Options: `maxFuzz` (0 to 3, default 3) and `limits` (a caller may lower a limit, never raise one).

Error codes: `too_large`, `too_many_files`, `too_many_hunks`, `malformed`, `empty`, `binary`, `unsafe_path`, `unsupported_mode`,
`file_exists`, `file_missing`, `context_mismatch`, `ambiguous`, `no_context`, `not_at_eof`, `delete_not_empty`. A refusal about a hunk names
the file and the hunk in `file`, `hunk` and the message. `internal_error` would mean a bug of the engine; the fuzz test fails on it.

## Formats accepted

**Unified diffs**, as `git diff` writes them and as plain `diff -u` does: several files in one patch; text before, between and after the
files is ignored (an e-mail of `git format-patch`, a commit message, a diffstat, the `-- ` signature).

- `diff --git` headers with `new file mode`, `deleted file mode`, `old mode` / `new mode`, `index` (its mode is reported),
  `similarity index`, `rename from` / `rename to`, `copy from` / `copy to`, and `---` / `+++` with `/dev/null`.
- File names quoted the way git quotes them (`"a/na\303\257ve file.txt"`: `\a \b \t \n \v \f \r \" \\` and octal bytes, read as UTF-8).
  `a/` and `b/` are taken off; a plain diff keeps names that have no such prefix. A timestamp after a TAB is dropped.
- `\ No newline at end of file`, on either side or on a context line (both sides).
- An empty line inside a hunk is an empty context line, as git reads it.

**The envelope** that coding models are trained to write:

```
*** Begin Patch
*** Add File: path          (+ lines; zero lines make an empty file)
*** Delete File: path
*** Update File: path
*** Move to: new/path       (optional, right after Update File)
@@ optional anchor line     (several @@ lines in a row are nested anchors: a class, then a method)
 context / -removed / +added
*** End of File             (optional: this section must match at the end of the file)
*** End Patch
```

Written from the format, not from any implementation. The first section of an update may come without `@@`. CR before LF is dropped
everywhere in an envelope; a file it adds gets LF line ends.

## Where a hunk goes

All lines are compared without their line end (LF-normalised); every old line of a hunk (context and removed) must match. The
**fuzz ladder** is tried rung by rung, and the first rung that finds a place wins:

| `fuzz` | rung | two lines match when |
|---|---|---|
| 0 | `exact` | they are equal |
| 1 | `trailing-whitespace` | they are equal without trailing white space |
| 2 | `trimmed` | they are equal without leading and trailing white space |
| 3 | `unicode-punctuation` | as 2, after mapping dashes (U+2010 to U+2015, U+2212) to `-`, curly quotes to `'` and `"`, and non-breaking and other wide spaces to a space |

On a rung, the place is taken when it is **the line the diff names** (shifted by the offset of the hunk before, as git does), or else
when it is **the only match** after the hunk before. **Two matches are `ambiguous`**, no match is `context_mismatch`: nothing is guessed.
Hunks are placed in order and never overlap. Like git, a hunk that names line 1 must match at the start of the file, and a hunk without
trailing context must match at its end. A hunk with no old line at all goes only at the start of a file (line 0) or at its end
(`no_context` otherwise).

The envelope has no line numbers. The first `@@` anchor of a section must match exactly once after the section before; a nested anchor and
the lines of an anchored section take the first match after the anchor (the anchor stands where line numbers would). A section without
anchor must match exactly once after the section before. A section with no old line is inserted right after its anchor, or appended at the
end. Context lines keep the file's text: under fuzz, only the `+` lines are the patch's.

A search is bounded (`maxSearchSteps`, 100,000,000 line comparisons per file): a long hunk against a long file of nearly equal lines is
refused (`too_large`) instead of running for minutes.

## Line ends, final newline, byte order mark

- The result keeps the file's line ends. A `+` line takes the line end most of the file uses, CRLF in, CRLF out, unless the diff carries
  its own CRs: a diff git wrote from a CRLF file has a CR on its lines, and those are written as given (byte-identical with `git apply`).
  A patch with a CR on **every** line while the lines it matched have none was converted on its way (a CRLF clipboard): its CRs are dropped.
- Only the patch takes a final newline away (`\ No newline at end of file` on the new side). A `+` line always ends with a newline; a
  context line keeps the file's. A line without newline that is no longer last gets one. When the diff says the old last line has no
  newline, the file must agree (`context_mismatch` otherwise).
- A byte order mark at the start of the file is set aside while matching and kept, unless a line of the patch holds one (a diff git
  wrote from such a file), in which case it is matched and written as given.

## What is refused

- Paths: empty, longer than 4096 characters, absolute, a drive letter or any colon (also NTFS streams), a backslash (use `/`), NUL or any
  control character, an empty, `.` or `..` segment, a `.git` segment (and `GIT~1`), a Windows device name (`CON`, `aux.txt`, `COM1`...), a
  segment that ends in a dot or a space. Checked at parse time, after quoted names are decoded, so the I/O wrapper starts from safe paths.
  The wrapper still has to resolve them under its root, fold case on Windows and apply the protected-path list.
- Binary patches (`GIT binary patch`, `Binary files ... differ`, a NUL anywhere in the patch), symbolic links (mode 120000), submodules
  (160000), and modes git never writes for a file.
- Malformed input: a hunk header that cannot be read or starts before line 1, a hunk cut off before its counts are met, a line in a hunk
  that is no hunk line, **lines that look like hunk lines right after a hunk whose header does not count them** (applying the counted part
  would be half the change), a header with nothing to change, a `---`/`+++` without a hunk, a plain diff whose two names differ, an
  envelope without `*** End Patch`, an unknown `***` line, an empty `@@` section.
- State the patch does not match: a new file that exists, a changed file that does not, a rename or copy onto an existing file, a deletion
  that leaves lines behind.
- Limits (`PATCH_LIMITS`): 8 MiB of patch (UTF-8 bytes), 1,000 files, 10,000 hunks, 32 MiB per file, 4096 characters per path, and the
  search bound above.

## Where the engine is stricter or looser than `git apply`, on purpose

Diffs that git writes from a file apply to that file byte-identically (the oracle corpus below). Elsewhere:

- Stricter: a hunk whose context matches in two places that are not the one named is refused (git takes the nearest); hunks are placed in
  order (git searches the whole file for each); a hunk with no line to match is never placed by its line number alone; uncounted
  hunk-like lines after a hunk are refused (git ignores them); a header with nothing to change is refused.
- Looser: the fuzz ladder (git needs exact context unless told to ignore white space), LF-normalised comparison (git compares the CR),
  the byte order mark set aside, a last line without newline matched when the diff does not say so.
- Not done: binary patches, symlinks, `--3way`, `-p` other than `a/` and `b/`, reversing a patch.

## Tests

`tests/verify-patch-apply.mjs` (mutation list `tests/mutation/patch-apply.json`):

- **Oracle corpus**: `tests/fixtures/patches/git-corpus.json`, 69 diffs mined from this repository's own history by
  `tests/support/mine-patch-corpus.mjs` (`git diff -U3 -M` between a commit and its parent; files of 15 extensions and some without one: modifications, renames with and
  without edits, deletions, additions, CRLF blobs, a file without final newline, and multi-file commits). Each is applied with the default
  ladder and with exact matching only, and by `git apply` in a temp folder; all must equal the blobs of the commit, byte for byte.
- **Adversarial unified diffs** written for this suite (git's own `t/` test patches are GPL-2.0 and are not copied): offsets, repeated
  blocks, ambiguity, CRLF, missing final newline, empty files, whitespace-only changes, rename and copy with edits, hunks at the start and
  the end of a file. Each case where the engine and git must agree is run through git too; each deliberate difference says why and checks
  git's own answer.
- **Envelope** cases (add, update with several `@@` sections, delete, move + update, the end-of-file anchor, nested anchors, fuzz) and
  malformed envelopes.
- **Seeded fuzz**: 2,000 mutated patches and files. No exception escapes, an applied hunk is checked again line by line against the
  original at the rung it reports, the new text is the old one with exactly those lines replaced, and the same input gives the same answer.
