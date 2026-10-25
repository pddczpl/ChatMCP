// Licence notices that the staged Code Intelligence runtime must carry.
//
// tree-sitter-wasms (Unlicense) ships four compiled grammars. The grammars themselves are built from the upstream tree-sitter-javascript,
// tree-sitter-typescript and tree-sitter-python projects, which are MIT-licensed and require their copyright and permission notice to
// travel with the compiled artefacts. The tree-sitter-wasms package carries none of those texts (its only licence file is its own
// Unlicense), so they are vendored in scripts/intelligence-runtime/licenses/ (see the README there) and stage.mjs copies them to
// licenses/<upstream>/LICENSE in the staged runtime, which Build-Installer.ps1 ships as CHATMCP-HUB/licenses/.
//
// rg.exe (ripgrep, staged from its official archive by stage-ripgrep.ps1) is linked with PCRE2 and with Rust crates. The archive carries the texts of
// ripgrep itself only, so the texts of the rest are vendored in scripts/intelligence-runtime/licenses/ripgrep: MANIFEST.json is the inventory and
// stage.mjs copies it and the texts to licenses/ripgrep/ in the staged runtime (see the section on ripgrep at the end of this module).
//
// The module has no dependency on node_modules so that tests/verify-notices.mjs can run it against a fixture folder.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  required.push(...RIPGREP_NOTICE_FILES.map((file) => file.staged)); // never pending: there is no CI exception for these
  if (pending.size > 0) required.push(PENDING_MARKER);
  return required;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// ripgrep: what is compiled INTO rg.exe
//
// scripts/intelligence-runtime/licenses/ripgrep/MANIFEST.json lists the components of the official build that stage-ripgrep.ps1 pins (PCRE2, from
// the sources that the pcre2-sys crate bundles, and the Rust crates of the Cargo.lock of that release that Cargo links for x86_64-pc-windows-msvc),
// and for each of them the license texts that its upstream repository carries at the commit of that version, with the SHA-256 and the git blob id
// of every text. The list is derived from sources (licenses/README.md says how); it is not read from the binary, except for the PCRE2 version, which
// the installer build compares with what rg.exe reports (checkReportedPcre2).
//
// Unlike the grammar notices there is no "pending" way around these: the texts are in the repository, so staging stops without them.

export const RIPGREP_NOTICES_DIRECTORY = 'licenses/ripgrep';
export const RIPGREP_MANIFEST_FILE = `${RIPGREP_NOTICES_DIRECTORY}/MANIFEST.json`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** The id git gives the file as a blob: anyone can compare it with github.com/<repository>/blob/<commit>/<path>. */
const blobId = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/**
 * What a vendored text must say, by kind. The judge reads words, not line breaks, and asks for no copyright line: the MIT texts of several crates
 * (anyhow, serde, zmij ...) have none upstream. [pattern, what it looks for] on the text with every run of white space squeezed to one space.
 */
export const RIPGREP_TEXT_KINDS = Object.freeze({
  mit: { phrases: [[/Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files/, 'the MIT permission paragraph'], [/THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/, 'the MIT warranty disclaimer']] },
  'apache-2.0': { phrases: [[/Apache License Version 2\.0, January 2004/, 'the heading "Apache License Version 2.0, January 2004"'], [/TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/, 'the Apache terms'], [/END OF TERMS AND CONDITIONS/, 'the end of the Apache terms']] },
  unlicense: { phrases: [[/This is free and unencumbered software released into the public domain/, 'the Unlicense dedication'], [/For more information, please refer to <https?:\/\/unlicense\.org\/?>/, 'the Unlicense reference']] },
  'bsd-3-clause': { phrases: [[/Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met/, 'the BSD conditions'], [/Neither the name of/, 'the BSD non-endorsement clause'], [/THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"/, 'the BSD disclaimer']] },
  unicode: { phrases: [[/UNICODE, INC\. LICENSE AGREEMENT - DATA FILES AND SOFTWARE/, 'the Unicode license heading'], [/Permission is hereby granted, free of charge, to any person obtaining a copy of the Unicode data files/, 'the Unicode permission paragraph'], [/Except as contained in this notice, the name of a copyright holder shall not be used/, 'the Unicode non-endorsement clause']] },
  pcre2: { phrases: [[/BSD-3-Clause WITH PCRE2-exception/, 'the SPDX line "BSD-3-Clause WITH PCRE2-exception"'], [/University of Cambridge/, 'the University of Cambridge copyright'], [/Redistributions in binary form must reproduce the above copyright notices/, 'the BSD condition for binary redistributions'], [/EXEMPTION FOR BINARY LIBRARY-LIKE PACKAGES/, 'the PCRE2 exemption']] },
  pointer: { maxLength: 600, phrases: [[/dual-licensed|licensed under either of/i, 'a statement that the crate is dual-licensed']] },
  notice: { minLength: 100, phrases: [[/copyright/i, 'the word "copyright"']] },
});

/** Null when `text` is a text of `kind`, else what is wrong with it. */
export function judgeRipgrepText(kind, text) {
  const spec = Object.hasOwn(RIPGREP_TEXT_KINDS, kind) ? RIPGREP_TEXT_KINDS[kind] : null;
  if (!spec) return `unknown kind "${kind}"`;
  if (typeof text !== 'string' || text.trim().length === 0) return 'the file is empty';
  const flat = text.replace(/\s+/g, ' ').trim();
  for (const [pattern, what] of spec.phrases) if (!pattern.test(flat)) return `it does not contain ${what}`;
  if (spec.maxLength && flat.length > spec.maxLength) return `it is longer than a ${kind} text (${flat.length} characters)`;
  if (spec.minLength && flat.length < spec.minLength) return `it is shorter than a ${kind} text (${flat.length} characters)`;
  return null;
}

const LICENSE_KIND = Object.freeze({ MIT: 'mit', 'Apache-2.0': 'apache-2.0', Unlicense: 'unlicense', 'BSD-3-Clause': 'bsd-3-clause' });

/**
 * The kinds of text that a license expression needs: one for every license it names, whether it offers them as alternatives or not (the
 * upstream repository carries each of them and so do we). "BSD-3-Clause WITH PCRE2-exception" is the PCRE2 license file. An identifier that
 * is not listed here is an error: whoever derives the inventory again has to decide what it needs.
 */
export function requiredKindsOf(expression) {
  const kinds = new Set();
  for (const part of String(expression).replace(/[()]/g, ' ').split(/\s+(?:OR|AND)\s+|\//)) {
    const [id, exception, ...rest] = part.trim().split(/\s+WITH\s+|\s+/).filter(Boolean);
    if (exception === 'PCRE2-exception' && id === 'BSD-3-Clause' && rest.length === 0) kinds.add('pcre2');
    else if (Object.hasOwn(LICENSE_KIND, id) && exception === undefined) kinds.add(LICENSE_KIND[id]);
    else throw new Error(`unknown licence identifier "${[id, exception, ...rest].filter(Boolean).join(' ')}" in "${expression}"`);
  }
  return kinds;
}

const READ_FAILURE = (error) => (error.code === 'ENOENT' ? 'the file does not exist' : `unreadable (${error.code ?? error.message})`);

/**
 * Reads MANIFEST.json and every text it lists from `<sourceDirectory>/licenses/ripgrep`, and checks them: the structure, a license text of every
 * kind that each component's license expression names, and for each text its existence, size, SHA-256, git blob id and that it is a text of the
 * kind the inventory gives. Throws one error that names every problem.
 * @param {{sourceDirectory: string, readFile?: (file: string) => Promise<Buffer>}} options sourceDirectory is scripts/intelligence-runtime
 * @returns {Promise<{manifest: object, files: {path: string, source: string, staged: string, kind: string, sha256: string}[]}>} the texts and, last, the inventory
 */
export async function readRipgrepNotices({ sourceDirectory, readFile = (file) => fs.readFile(file) }) {
  const root = path.join(sourceDirectory, ...RIPGREP_NOTICES_DIRECTORY.split('/'));
  const problems = [];
  const fail = (message) => problems.push(message);
  const stop = () => {
    throw new Error(`Licence notices of what is compiled into rg.exe (PCRE2 and Rust crates) are missing or unusable (${problems.join('; ')}). `
      + 'Vendor the texts that scripts/intelligence-runtime/licenses/ripgrep/MANIFEST.json lists (see scripts/intelligence-runtime/licenses/README.md).');
  };

  let manifestBytes = null;
  try { manifestBytes = await readFile(path.join(root, 'MANIFEST.json')); } catch (error) { fail(`${RIPGREP_MANIFEST_FILE}: ${READ_FAILURE(error)}`); stop(); }
  let manifest = null;
  try { manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')); } catch (error) { fail(`${RIPGREP_MANIFEST_FILE}: not valid JSON (${error.message})`); stop(); }

  if (manifest?.schemaVersion !== 1) fail('MANIFEST.json: schemaVersion must be 1');
  const subject = manifest?.subject;
  if (subject?.name !== 'ripgrep' || !/^\d+\.\d+\.\d+$/.test(subject.version ?? '') || typeof subject.archive !== 'string' || !/^[0-9a-f]{64}$/.test(subject.archiveSha256 ?? '')) {
    fail('MANIFEST.json: subject must name ripgrep with its version, the archive and the SHA-256 of the archive');
  }
  const components = Array.isArray(manifest?.components) ? manifest.components : [];
  if (components.length === 0) fail('MANIFEST.json: the inventory lists no components');
  if (!components.some((component) => component?.name === 'PCRE2')) fail('MANIFEST.json: the inventory has no PCRE2 component (rg.exe is built with it)');

  const files = [];
  const seen = new Set();
  for (const component of components) {
    const id = String(component?.id);
    if (typeof component?.id !== 'string' || typeof component.name !== 'string' || typeof component.version !== 'string' || typeof component.license !== 'string') { fail(`component ${id}: id, name, version and license are required`); continue; }
    const entries = Array.isArray(component.files) ? component.files : [];
    if (entries.length === 0) fail(`component ${id}: lists no licence text`);
    try {
      const present = new Set(entries.map((entry) => entry?.kind));
      for (const kind of requiredKindsOf(component.license)) if (!present.has(kind)) fail(`component ${id}: license "${component.license}" needs a text of kind ${kind}, the inventory lists none`);
    } catch (error) { fail(`component ${id}: ${error.message}`); }
    for (const entry of entries) {
      const name = String(entry?.path);
      const relative = `${RIPGREP_NOTICES_DIRECTORY}/${name}`;
      if (typeof entry?.path !== 'string' || !/^[A-Za-z0-9_.+-]+\/[A-Za-z0-9_.+-]+$/.test(entry.path) || entry.path.split('/').some((segment) => /^\.+$/.test(segment))) { fail(`${relative}: the path is not a plain "<folder>/<file>" path`); continue; }
      if (seen.has(entry.path)) { fail(`${relative}: listed twice`); continue; }
      seen.add(entry.path);
      if (!Object.hasOwn(RIPGREP_TEXT_KINDS, entry.kind)) { fail(`${relative}: unknown kind "${entry.kind}"`); continue; }
      if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? '') || !/^[0-9a-f]{40}$/.test(entry.source?.blob ?? '')) { fail(`${relative}: the inventory has no SHA-256 or git blob id for it`); continue; }
      let bytes;
      try { bytes = await readFile(path.join(root, ...entry.path.split('/'))); } catch (error) { fail(`${relative}: ${READ_FAILURE(error)}`); continue; }
      if (bytes.length === 0) { fail(`${relative}: the file is empty`); continue; }
      if (sha256(bytes) !== entry.sha256) { fail(`${relative}: the SHA-256 differs from MANIFEST.json (the text was changed after it was vendored)`); continue; }
      if (blobId(bytes) !== entry.source.blob) { fail(`${relative}: the git blob id differs from MANIFEST.json`); continue; }
      const reason = judgeRipgrepText(entry.kind, bytes.toString('utf8'));
      if (reason !== null) { fail(`${relative}: the file is not a text of kind ${entry.kind} (${reason})`); continue; }
      files.push({ path: entry.path, source: relative, staged: relative, kind: entry.kind, sha256: entry.sha256 });
    }
  }
  if (problems.length > 0) stop();
  files.push({ path: 'MANIFEST.json', source: RIPGREP_MANIFEST_FILE, staged: RIPGREP_MANIFEST_FILE, kind: 'manifest', sha256: sha256(manifestBytes) });
  return { manifest, files };
}

/** The pin in stage-ripgrep.ps1: `$expectedVersion` and the SHA-256 (`$expected`) of the archive. */
export function ripgrepPin(scriptText) {
  const text = String(scriptText).replace(/\r\n/g, '\n');
  return { version: text.match(/^\$expectedVersion = '(\d+\.\d+\.\d+)'$/m)?.[1] ?? null, sha256: text.match(/^\$expected = '([0-9a-f]{64})'$/m)?.[1] ?? null };
}

/** Throws when the inventory was derived for another release (or archive) than the one that stage-ripgrep.ps1 pins. */
export function assertRipgrepPin(manifest, scriptText) {
  const pin = ripgrepPin(scriptText);
  if (!pin.version || !pin.sha256) throw new Error('stage-ripgrep.ps1 pins no ripgrep version and archive SHA-256 that the notices can be compared with.');
  const { subject } = manifest;
  if (pin.version !== subject.version || pin.sha256 !== subject.archiveSha256) {
    throw new Error(`The ripgrep notices (${RIPGREP_MANIFEST_FILE}) were derived for ripgrep ${subject.version} (archive SHA-256 ${subject.archiveSha256}), but stage-ripgrep.ps1 pins ripgrep ${pin.version} `
      + `(archive SHA-256 ${pin.sha256}). Derive the notices again for the new release (scripts/intelligence-runtime/licenses/README.md) before staging it.`);
  }
}

/**
 * Compares the PCRE2 version that the bundled rg.exe reports (`rg --pcre2-version`: "PCRE2 10.46 is available (JIT is available)", or "PCRE2 is not
 * available in this build of ripgrep." with exit code 1) with the one the notice is for. Null when they are the same, else the problem.
 */
export function checkReportedPcre2(manifest, output) {
  const notice = manifest.components.find((component) => component.name === 'PCRE2');
  if (!notice) return 'the ripgrep notice inventory has no PCRE2 component';
  const text = String(output);
  if (/PCRE2 is not available/i.test(text)) return `rg.exe was built without PCRE2, but the shipped notice is for PCRE2 ${notice.version}`;
  const reported = /^PCRE2 (\d+\.\d+) is available/m.exec(text)?.[1];
  if (!reported) return 'rg --pcre2-version did not report a PCRE2 version';
  if (reported !== notice.version) return `rg.exe reports PCRE2 ${reported}, but the shipped notice is for PCRE2 ${notice.version}: ${RIPGREP_MANIFEST_FILE} differs from the binary`;
  return null;
}

/**
 * The files that the vendored inventory requires in a staged runtime, with the SHA-256 each must have (the inventory itself included). Read when
 * the module loads, so that a tree without the inventory stops here and not after a long build.
 */
function loadRipgrepNoticeFiles() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), ...RIPGREP_MANIFEST_FILE.split('/'));
  let bytes;
  let manifest;
  try {
    bytes = readFileSync(file);
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Cannot read scripts/intelligence-runtime/${RIPGREP_MANIFEST_FILE} (${error.code ?? error.message}): the licence notices of what is compiled into rg.exe are required.`);
  }
  const required = [];
  for (const component of manifest.components ?? []) for (const entry of component.files ?? []) required.push(Object.freeze({ staged: `${RIPGREP_NOTICES_DIRECTORY}/${entry.path}`, sha256: entry.sha256 }));
  required.push(Object.freeze({ staged: RIPGREP_MANIFEST_FILE, sha256: sha256(bytes) }));
  return Object.freeze(required);
}
export const RIPGREP_NOTICE_FILES = loadRipgrepNoticeFiles();
