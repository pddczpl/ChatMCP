// A strict reader of tar archives (corpus/SANDBOX.md, "Archives"): the repository tarball of a task and its hidden test archive.
//
//   readTar(bytes, {maxEntries, maxBytes})  -> [{path, mode: '100644' | '100755', data: Buffer}] in archive order
//
// Read in memory, written nowhere. Regular files and folders only: links, devices and FIFOs are refused, and so is every path that
// is not a plain relative path that works on Windows and POSIX alike (no `..`, no absolute path, drive, backslash or `:`, no `.git`
// part, no Windows device name or reserved character, no hidden or control character). ustar (POSIX and GNU magic), the ustar prefix
// field, GNU long names (`L`) and pax `path` records are understood; a gzip stream (magic 1f 8b) is unpacked first. Every refusal is a
// TarError with a code (TAR_CODES).
import zlib from 'node:zlib';

export const TAR_LIMITS = Object.freeze({ maxEntries: 20_000, maxBytes: 512 * 1024 * 1024 });
export const TAR_CODES = Object.freeze(['bad_gzip', 'truncated', 'bad_checksum', 'not_ustar', 'unsupported_entry', 'bad_pax', 'unsafe_path',
  'duplicate_path', 'path_conflict', 'empty_archive', 'too_large']);

export class TarError extends Error {
  constructor(code, message) {
    super(`${message} [${code}]`);
    this.name = 'TarError';
    this.code = code;
  }
}

const BLOCK = 512;
// Control and format characters, line and paragraph separators, noncharacters and lone surrogates: what a path must never hold.
const HIDDEN = /\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}|\p{Noncharacter_Code_Point}|\p{Cs}/u;
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const RESERVED = /[<>:"|?*\\]/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The text of a NUL-terminated field. */
function field(header, at, length) {
  const bytes = header.subarray(at, at + length);
  const end = bytes.indexOf(0);
  return end < 0 ? bytes : bytes.subarray(0, end);
}

function octal(header, at, length, what) {
  const text = field(header, at, length).toString('latin1').trim();
  if (!/^[0-7]+$/.test(text)) throw new TarError('not_ustar', `the ${what} field ${JSON.stringify(text)} is not an octal number`);
  return Number.parseInt(text, 8);
}

function decodeName(bytes) {
  try { return utf8.decode(bytes); } catch { throw new TarError('unsafe_path', 'a path is not valid UTF-8'); }
}

/** The one spelling of a path of the archive, or a TarError: plain relative parts that every file system of the benchmark accepts. */
export function checkArchivePath(raw) {
  let name = raw;
  while (name.startsWith('./')) name = name.slice(2);
  if (name.endsWith('/')) name = name.slice(0, -1);
  const refuse = (why) => { throw new TarError('unsafe_path', `the path ${JSON.stringify(raw)} ${why}`); };
  if (!name) refuse('is empty');
  if (name.startsWith('/')) refuse('is absolute');
  if (HIDDEN.test(name)) refuse('holds a hidden or control character');
  for (const part of name.split('/')) {
    if (!part || part === '.' || part === '..') refuse('has an empty, "." or ".." part');
    if (RESERVED.test(part)) refuse('has a character that Windows refuses (< > : " | ? * or a backslash)');
    if (/^\.git$/i.test(part) || /^git~\d+$/i.test(part)) refuse('has a .git part');
    if (DEVICE.test(part)) refuse('names a Windows device');
    if (/[. ]$/.test(part)) refuse('has a part that ends with a dot or a space');
  }
  return name;
}

/** Reads the pax records "<length> <key>=<value>\n"; returns a Map. */
function paxRecords(data) {
  const records = new Map();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const length = space > at ? Number.parseInt(data.subarray(at, space).toString('latin1'), 10) : Number.NaN;
    if (!Number.isInteger(length) || length <= space - at || at + length > data.length || data[at + length - 1] !== 0x0a) {
      throw new TarError('bad_pax', 'a pax record has a wrong length');
    }
    const record = data.subarray(space + 1, at + length - 1);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw new TarError('bad_pax', 'a pax record has no key');
    records.set(record.subarray(0, equals).toString('utf8'), record.subarray(equals + 1));
    at += length;
  }
  return records;
}

/**
 * The files of a tar archive (gzip or not). Folders are not returned (a folder exists through its files); an archive with no file is
 * refused. `maxEntries` counts every header, `maxBytes` the unpacked bytes.
 */
export function readTar(input, { maxEntries = TAR_LIMITS.maxEntries, maxBytes = TAR_LIMITS.maxBytes } = {}) {
  let bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try { bytes = zlib.gunzipSync(bytes, { maxOutputLength: maxBytes + (maxEntries + 2) * BLOCK * 2 }); } catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw new TarError('too_large', `the archive unpacks to more than ${maxBytes} bytes`);
      throw new TarError('bad_gzip', `the gzip stream cannot be read: ${error.message}`);
    }
  }
  const files = [];
  const seen = new Map(); // lower-case path -> 'file' | 'folder'
  let entries = 0;
  let total = 0;
  let longName = null;
  let paxPath = null;
  let at = 0;
  const claim = (name, kind) => {
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/').toLowerCase();
      if (seen.get(parent) === 'file') throw new TarError('path_conflict', `${name} lies under the file ${parts.slice(0, index).join('/')}`);
      if (!seen.has(parent)) seen.set(parent, 'folder');
    }
    const key = name.toLowerCase();
    if (seen.get(key) === 'folder' && kind === 'file') throw new TarError('path_conflict', `${name} is a file and a folder`);
    if (seen.get(key) === 'file') throw new TarError('duplicate_path', `${name} is in the archive twice (paths are compared without case, as on Windows)`);
    seen.set(key, kind);
  };
  for (;;) {
    if (at + BLOCK > bytes.length) throw new TarError('truncated', 'the archive ends inside a header or before its end blocks');
    const header = bytes.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    entries += 1;
    if (entries > maxEntries) throw new TarError('too_large', `the archive has more than ${maxEntries} entries`);
    let sum = 0;
    for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index];
    if (octal(header, 148, 8, 'checksum') !== sum) throw new TarError('bad_checksum', `the header at byte ${at} has a wrong checksum`);
    const magic = header.subarray(257, 263).toString('latin1');
    if (magic !== 'ustar\0' && magic !== 'ustar ') throw new TarError('not_ustar', `the header at byte ${at} is not a ustar header`);
    const size = octal(header, 124, 12, 'size');
    const type = String.fromCharCode(header[156] || 0x30);
    const start = at + BLOCK;
    if (start + size > bytes.length) throw new TarError('truncated', 'the archive ends inside the data of an entry');
    const data = bytes.subarray(start, start + size);
    at = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'g') continue; // a pax global header: nothing a reader of files needs
    if (type === 'x') { paxPath = paxRecords(data).get('path') ?? paxPath; continue; }
    if (type === 'L') { longName = field(data, 0, data.length); continue; }
    if (type !== '0' && type !== '5') throw new TarError('unsupported_entry', `an entry of type ${JSON.stringify(type)} (a link, device, FIFO or other special file) is refused`);
    const prefix = field(header, 345, 155);
    const raw = paxPath ?? longName ?? (prefix.length ? Buffer.concat([prefix, Buffer.from('/'), field(header, 0, 100)]) : field(header, 0, 100));
    paxPath = null;
    longName = null;
    const text = decodeName(raw);
    // the folder entry of the archive's root (`tar -C dir -cf x.tar .` writes "./"): nothing to keep
    if (type === '5' && /^(?:\.\/?)+$/.test(text)) continue;
    const name = checkArchivePath(text);
    if (type === '5') { claim(name, 'folder'); continue; }
    claim(name, 'file');
    total += size;
    if (total > maxBytes) throw new TarError('too_large', `the archive holds more than ${maxBytes} bytes`);
    const mode = octal(header, 100, 8, 'mode');
    files.push({ path: name, mode: mode & 0o111 ? '100755' : '100644', data: Buffer.from(data) });
  }
  if (!files.length) throw new TarError('empty_archive', 'the archive holds no file');
  return files;
}
