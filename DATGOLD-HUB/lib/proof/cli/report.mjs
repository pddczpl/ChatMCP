// `chatmcp verify show --pack <file>` (P5 pod-30, docs/PROOF-CLI.md, "show"; docs/PROOF-RENDER.md): a pack file as a report people read, in
// Markdown or in one HTML file, in the language of --lang. The pack is checked whole first, as `check` checks it: a pack that does not verify
// renders nothing. Nothing is run, no state folder is used, and the one file written is the one --out names, never over another.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '../ledger.mjs';
import { renderHtml } from '../render/html.mjs';
import { renderMarkdown } from '../render/md.mjs';
import { buildReport } from '../render/model.mjs';
import { readPackBytes, readPackFile } from './check.mjs';
import { stop } from './codes.mjs';

export async function reportCommand(ctx) {
  const { pack, format, out, vnd } = ctx.args.options;
  const file = path.resolve(ctx.cwd, pack);
  const read = readPackFile(await readPackBytes(file));
  const report = buildReport({ ...read, packChecked: true }, { lang: ctx.lang, packName: path.basename(file), vnd });
  const { text, truncated = false } = format === 'html' ? renderHtml(report) : renderMarkdown(report);
  const target = out === null ? null : path.resolve(ctx.cwd, out);
  const data = { pack: { file, digest: read.digest }, format, verdict: report.verdict, truncated, out: target, bytes: Buffer.byteLength(text), sha256: sha256Hex(text), text: null };
  if (target === null) return { code: 'report_printed', data: { ...data, text }, stdout: text, quiet: true };
  try { await fs.writeFile(target, text, { flag: 'wx' }); } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'EISDIR') throw stop('report_exists', { file: target });
    throw error;
  }
  return { code: 'report_written', data, params: { file: target, verdict: report.verdict } };
}
