// Licence notices that the staged Code Intelligence runtime must carry.
//
// tree-sitter-wasms (Unlicense) ships four compiled grammars. The grammars themselves are built from the upstream tree-sitter-javascript,
// tree-sitter-typescript and tree-sitter-python projects, which are MIT-licensed and require their copyright and permission notice to
// travel with the compiled artefacts. The tree-sitter-wasms package carries none of those texts (its only licence file is its own
// Unlicense), so they are vendored in scripts/intelligence-runtime/licenses/ (see the README there) and stage.mjs copies them to
// licenses/<upstream>/LICENSE in the staged runtime, which Build-Installer.ps1 ships as CHATMCP-HUB/licenses/.
//
// The module has no dependency on node_modules so that tests/verify-notices.mjs can run it against a fixture folder.
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * One entry per upstream grammar project. `grammars` are the .wasm files (tree-sitter-<name>.wasm) compiled from it.
 * `range` is what tree-sitter-wasms 0.1.13 declares in its package.json (devDependencies); the exact build is not recorded upstream.
 */
export const GRAMMAR_NOTICES = Object.freeze([
  { id: 'tree-sitter-javascript', upstream: 'https://github.com/tree-sitter/tree-sitter-javascript', range: '^0.20.3', license: 'MIT', grammars: ['javascript'] },
  { id: 'tree-sitter-typescript', upstream: 'https://github.com/tree-sitter/tree-sitter-typescript', range: '^0.20.5', license: 'MIT', grammars: ['typescript', 'tsx'] },
  { id: 'tree-sitter-python', upstream: 'https://github.com/tree-sitter/tree-sitter-python', range: '^0.21.0', license: 'MIT', grammars: ['python'] },
]);

/** Where each upstream text is kept in the repository (relative to scripts/intelligence-runtime) and where it is staged. */
export const noticeSource = (entry) => `licenses/${entry.id}.LICENSE`;
export const noticeStaged = (entry) => `licenses/${entry.id}/LICENSE`;

/** Files the runtime manifest must list whatever the grammar notices do (checked by verify.mjs). */
export const ALWAYS_REQUIRED_LICENSE_FILES = Object.freeze([
  'licenses/tree-sitter-wasms/LICENSE',
  'runtimes/python/LICENSE.txt',
  'runtimes/ripgrep/LICENSE-MIT',
  'runtimes/ripgrep/UNLICENSE',
]);

/** The marker file that a build with pending notices carries; a release build never has it (see PENDING_ALLOWED_ENV). */
export const PENDING_MARKER = 'licenses/PENDING-NOTICES.txt';
/** Set to "1" by CI builds that are not releases. A release workflow must never set it (tests/verify-notices.mjs checks that). */
export const PENDING_ALLOWED_ENV = 'CHATMCP_ALLOW_PENDING_NOTICES';

/** A grammar notice text is accepted when it carries a copyright line and the MIT permission paragraph. */
export function judgeNoticeText(entry, text) {
  if (typeof text !== 'string' || text.trim().length === 0) return 'the file is empty';
  if (!/\bcopyright\b[^\n]*\d{4}/i.test(text)) return 'it has no copyright line with a year';
  if (entry.license === 'MIT' && !/permission is hereby granted, free of charge/i.test(text)) return 'it does not contain the MIT permission paragraph';
  return null;
}

/**
 * Reads the vendored notice of every grammar upstream.
 * @param {{sourceDirectory: string, allowPending?: boolean}} options sourceDirectory is scripts/intelligence-runtime
 * @returns {Promise<{found: {entry: object, text: string}[], pending: {entry: object, reason: string}[]}>}
 *          Without allowPending a missing or unusable text throws, so a release build cannot go on without it.
 */
export async function readGrammarNotices({ sourceDirectory, allowPending = false }) {
  const found = [];
  const pending = [];
  for (const entry of GRAMMAR_NOTICES) {
    const file = path.join(sourceDirectory, noticeSource(entry));
    let text = null;
    let reason = null;
    try { text = await fs.readFile(file, 'utf8'); } catch (error) { reason = error.code === 'ENOENT' ? 'the file does not exist' : `unreadable (${error.code ?? error.message})`; }
    if (reason === null) reason = judgeNoticeText(entry, text);
    if (reason === null) found.push({ entry, text });
    else pending.push({ entry, reason: `${noticeSource(entry)}: ${reason}` });
  }
  if (pending.length > 0 && !allowPending) {
    throw new Error(`Missing licence notice for the bundled Tree-sitter grammars (${pending.map((item) => item.reason).join('; ')}). `
      + `Vendor the upstream LICENSE file of each project (see scripts/intelligence-runtime/licenses/README.md); `
      + `a build that is not a release may set ${PENDING_ALLOWED_ENV}=1 to stage a PENDING-NOTICES.txt instead.`);
  }
  return { found, pending };
}

/** The text of licenses/PENDING-NOTICES.txt for a build that proceeds without some grammar notices. */
export function pendingNoticeText(pending) {
  return [
    'THIS BUILD IS NOT A RELEASE: it is missing licence notices that a redistribution requires.',
    '',
    ...pending.map(({ entry, reason }) => `- ${entry.id} (${entry.license}, ${entry.upstream}): ${reason}`),
    '',
    'The compiled grammars of these projects are in grammars/. Their copyright and permission notices are not yet shipped.',
    '',
  ].join('\n');
}

/** Paths (relative to the runtime root) that must be in runtime-manifest.json for a runtime whose manifest says `pendingNotices`. */
export function requiredLicenseFiles(pendingIds = []) {
  const pending = new Set(pendingIds);
  const required = [...ALWAYS_REQUIRED_LICENSE_FILES];
  for (const entry of GRAMMAR_NOTICES) if (!pending.has(entry.id)) required.push(noticeStaged(entry));
  if (pending.size > 0) required.push(PENDING_MARKER);
  return required;
}
