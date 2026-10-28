// File helpers shared by the local tool server: text decoding that refuses to corrupt files,
// line-ending handling and an atomic replace that notices concurrent edits.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { delay } from './runtime.mjs';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * Where a path inside a workspace really points once symlinks, junctions and Windows 8.3 short
 * names are resolved. A path that does not exist yet is resolved through its nearest existing
 * parent, so a symlinked folder cannot be used to create a file somewhere protected.
 *
 * Fails closed: any error other than "does not exist" is thrown. A name-based safety rule must never
 * treat "I could not tell" as "safe".
 *
 * (fs/promises.realpath already has the native semantics; fs/promises.realpath.native does not exist.)
 * @returns {Promise<{inside: boolean, relative: string}>} relative is "/"-separated and empty when outside
 */
export async function canonicalRelative(rootAbsolute, absolute) {
  const root = await fs.realpath(rootAbsolute);
  const tail = [];
  let probe = absolute;
  for (let hops = 0; hops < 256; hops += 1) {
    try {
      const real = await fs.realpath(probe);
      const relative = path.relative(root, tail.length ? path.join(real, ...tail) : real).replaceAll('\\', '/');
      const inside = relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative);
      return { inside, relative: inside ? relative : '' };
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
  throw Object.assign(new Error('Đường dẫn quá sâu hoặc có vòng symlink.'), { code: 'bad_path', statusCode: 400 });
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/** True for names Windows treats specially (devices, trailing dot/space, forbidden characters). */
export function isUnsafeWindowsName(name) {
  const text = String(name);
  if (!text || text === '.' || text === '..') return false;
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f]/.test(text)) return true;
  if (/[. ]$/.test(text)) return true;
  return WINDOWS_RESERVED.test(text);
}

export function detectEol(text) {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 13) {
      if (text.charCodeAt(i + 1) === 10) { crlf += 1; i += 1; } else cr += 1;
    } else if (code === 10) lf += 1;
  }
  if (!crlf && !lf && !cr) return 'none';
  if (crlf && !lf && !cr) return 'crlf';
  if (lf && !crlf && !cr) return 'lf';
  return 'mixed';
}

export const toLf = (text) => text.replace(/\r\n/g, '\n');
/** Re-applies a file's dominant line ending to text that may contain either style. */
export const applyEol = (text, eol) => (eol === 'crlf' ? toLf(text).replace(/\n/g, '\r\n') : text);

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Decodes a file only when that is lossless: UTF-8 (with or without BOM) and UTF-16LE with BOM.
 * Everything else is reported, never guessed, so an edit can never silently corrupt a legacy file.
 */
export function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    const body = buffer.subarray(2);
    if (body.length % 2) return { ok: false, reason: 'not_utf8' };
    const text = body.toString('utf16le');
    return { ok: true, text, encoding: 'utf16le', eol: detectEol(text) };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return { ok: false, reason: 'utf16be' };
  let start = 0;
  let encoding = 'utf8';
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) { start = 3; encoding = 'utf8-bom'; }
  const body = buffer.subarray(start);
  if (body.subarray(0, 8000).includes(0)) return { ok: false, reason: 'binary' };
  let text;
  try { text = strictUtf8.decode(body); } catch { return { ok: false, reason: 'not_utf8' }; }
  return { ok: true, text, encoding, eol: detectEol(text) };
}

export function encodeText(text, encoding = 'utf8') {
  if (typeof text.isWellFormed === 'function' && !text.isWellFormed()) {
    throw Object.assign(new Error('Nội dung chứa ký tự Unicode không hợp lệ (surrogate đơn lẻ).'), { code: 'invalid_unicode', statusCode: 400 });
  }
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (encoding === 'utf8-bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  return Buffer.from(text, 'utf8');
}

/** Splits text into lines without inventing an empty last line for a trailing newline. */
export function splitLines(text) {
  if (!text) return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

const RENAME_RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * Writes `data` next to `file` and renames it into place. When `expectedSha` is given, the current
 * content is re-hashed right before the rename so an edit made in the meantime is never overwritten.
 */
let newFileMode = 0o644;
/**
 * The mode asked for when a file did not exist before (the process umask still trims it). The public server, where another account
 * shares the workspace through a group, asks for 0o666 and runs with umask 002, so new files are group-writable (0664).
 */
export function setNewFileMode(mode) { newFileMode = mode & 0o777; }

export async function writeFileAtomic(file, data, { mode, expectedSha = null, createOnly = false } = {}) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, data, { flag: 'wx', mode: mode === undefined ? newFileMode : mode & 0o777 });
    if (expectedSha) {
      const current = await fs.readFile(file).catch(() => null);
      if (!current || sha256(current) !== expectedSha) {
        throw Object.assign(new Error('File đã bị thay đổi trong lúc ghi; chưa ghi đè. Đọc lại rồi thử lại.'), { code: 'stale_revision', statusCode: 409 });
      }
    }
    if (createOnly) {
      // The caller saw no file here; one that appeared since must not be replaced. link() refuses an existing target atomically.
      const appeared = () => Object.assign(new Error('File đã được tạo trong lúc ghi; chưa ghi đè. Đọc lại rồi thử lại.'), { code: 'stale_revision', statusCode: 409 });
      try { await fs.link(temp, file); return; } catch (error) {
        if (error.code === 'EEXIST') throw appeared();
        // A file system without hard links: fall back to a plain check just before the rename.
        if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EINVAL', 'ENOSYS', 'EACCES'].includes(error.code)) throw error;
        if (await fs.lstat(file).then(() => true, () => false)) throw appeared();
      }
    }
    for (let attempt = 0; ; attempt += 1) {
      try { await fs.rename(temp, file); break; }
      catch (error) {
        // Windows: an editor, indexer or antivirus may hold the file for a moment.
        if (!RENAME_RETRYABLE.has(error.code) || attempt >= 4) {
          throw RENAME_RETRYABLE.has(error.code)
            ? Object.assign(new Error(`Không ghi được file vì đang bị chương trình khác khóa (${error.code}). Đóng chương trình đang mở file rồi thử lại.`), { code: 'file_locked', statusCode: 423 })
            : error;
        }
        await delay(60 * (attempt + 1));
      }
    }
  } finally { await fs.unlink(temp).catch(() => {}); }
}
