// A stand-in for GitHub's release feed, on a loopback port, for the tests of the update notice (lib/update-check.mjs), of the signature on the manifest (lib/release-signature.mjs) and of the
// download (lib/update-download.mjs).
//
// It speaks HTTP the way the real answer does: https://github.com/<repo>/releases/latest/download/RELEASE-MANIFEST.json answers 302 to the file of the release (on github.com)
// and that answers 302 to a signed address on another host, which answers 200 with the file (tests/probe of 2026-10-26: two redirects, 568 bytes, application/octet-stream).
// A file of a release (the signature RELEASE-MANIFEST.json.sig, the installer) is asked for at https://github.com/<repo>/releases/download/v<version>/<name> and goes the same way. The stand-in keeps
// every hop on its own origin. It records every request it is sent (method, address and the names and values of the headers), so a test can say exactly what the Hub asked for and, with a mode that
// answers badly, what the Hub does with a bad answer. Nothing here is a copy of the code under test: it is a server.
import http from 'node:http';
import { signatureFor } from '../support/release-keys.mjs';

/** The manifest the publish workflow writes (publish-v3.10.2.yml), with the installer name of the next release. Extra keys on purpose: the real file has some the Hub does not use. */
export function feedManifest(overrides = {}) {
  return {
    version: '3.10.3',
    companionVersion: '1.5.2',
    commit: '0123456789abcdef0123456789abcdef01234567',
    workflowRun: '40197824899',
    assets: [
      { name: 'DatGoldSetup.exe', sha256: 'b'.repeat(64), bytes: 232753314 },
      { name: 'DatGold-Browser-Companion.zip', sha256: 'c'.repeat(64), bytes: 48568 },
    ],
    signedInEdgeVerified: false,
    authenticodeSigned: false,
    ...overrides,
  };
}

const FIRST_HOP = '/pddczpl/ChatMCP/releases/latest/download/RELEASE-MANIFEST.json';
const TAG_BASE = (version) => `/pddczpl/ChatMCP/releases/download/v${version}`;
const CDN = '/github-production-release-asset';
const SIGNED_QUERY = '?X-Amz-Signature=SIGNED-QUERY-MUST-NOT-BE-KEPT&X-Amz-Expires=300';
const CHUNK = 64 * 1024;

/**
 * @param {{manifest?: object, text?: string, key?: object}} [options] `text` is the exact body to serve (a BOM, a broken document); otherwise the manifest is serialised the way PowerShell does.
 *   `key` (a pair from tests/support/release-keys.mjs) is the owner's key: with it every manifest that is served has a signature, made over the exact bytes served, at the address a release
 *   file has; without it the signature is not there (404), as before the owner has signed.
 *
 * Modes of the manifest (set with `feed.mode(name, options)`):
 *   chain          the three hops of GitHub, ending in 200 (default)
 *   chain-500      the same, but the last hop (the one with the signed query) answers 500
 *   direct         200 at the first address
 *   status         answers `{status}` with a short body (404, 500 ...)
 *   redirect       302 to `{target}` (a full address) at the first address; with `{target: null}` the 302 has no Location header
 *   loop           302 to itself, forever
 *   stall          takes the request and never answers
 *   trickle        200, then one byte every 40 ms for ever
 *   declared-huge  200 that declares a body of `{bytes}` and sends a little
 *   endless        200 that never stops sending
 *   html           200 with an HTML page
 *
 * A release file (`feed.signature`, `feed.installer`) has its own modes, set with `.mode(name, options)`:
 *   chain          GitHub's way: 302 at the tag address, 302 to a signed address, 200 (default)
 *   direct         200 at the tag address
 *   missing        404 at the tag address (a file that was not uploaded)
 *   status         answers `{status}`
 *   redirect       302 to `{target}`; `{target: null}` has no Location header
 *   stall          takes the request and never answers
 *   endless        200 that never stops sending
 *   declared-huge  200 that declares `{bytes}` and sends a little
 * and, for the body of an installer (the options of any mode that answers 200): `pauseAfter: n` stops after n bytes (0: after the headers, before any byte of the body) until `resume()`, `stallAfter: n` stops there for good, `resetAfter: n`
 * breaks the connection there, `endAfter: n` ends the response there although it declared more (a body that stops short of its length), `chunked: true` sends no length (the client has to count).
 */
export async function startUpdateFeed({ manifest = feedManifest(), text = null, key = null } = {}) {
  const requests = [];
  const open = new Set();
  const settings = { mode: 'chain', status: 404, target: '', bytes: 0 };
  let body = text ?? `${JSON.stringify(manifest, null, 2)}\r\n`;
  let ownedSignature = null;
  let pinnedTag = null;
  /** The version whose tag the files are served under: the manifest's own unless a test pins another (GitHub keeps the files of every tag; this stand-in holds one release). */
  const tagVersion = () => pinnedTag ?? manifest.version;
  const timers = new Set();
  const gates = new Set();

  /** A release file: what is served (`bytes`), at which tag address (`name`) and how. */
  const asset = (name) => ({ name, bytes: null, behavior: { mode: key || name !== 'RELEASE-MANIFEST.json.sig' ? 'chain' : 'missing' }, cdn: null, firstHits: 0, sent: 0, open: 0, gate: null });
  const signature = asset('RELEASE-MANIFEST.json.sig');
  const installer = asset('DatGoldSetup.exe');
  installer.behavior = { mode: 'missing' };
  signature.cdn = `${CDN}/1413019619/24765421`;
  installer.cdn = `${CDN}/1413019619/24765422`;
  const signatureBytes = () => ownedSignature ?? (key ? signatureFor(Buffer.from(body), key) : null);
  const assetBytes = (entry) => (entry === signature ? signatureBytes() : entry.bytes);

  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: { ...request.headers }, rawHeaders: [...request.rawHeaders] });
    open.add(response);
    response.on('close', () => open.delete(response));
    const path = request.url.split('?')[0];
    const redirect = (location) => { response.writeHead(302, location === null ? {} : { location }); response.end(); };
    const serve = () => { response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(body) }); response.end(body); };

    if (path === FIRST_HOP) {
      switch (settings.mode) {
        case 'chain':
        case 'chain-500': return redirect(`${TAG_BASE(tagVersion())}/RELEASE-MANIFEST.json`);
        case 'direct': return serve();
        case 'status': response.writeHead(settings.status, { 'content-type': 'text/plain' }); return response.end('no');
        case 'redirect': return redirect(settings.target);
        case 'loop': return redirect(FIRST_HOP);
        case 'stall': return undefined;
        case 'trickle': {
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          const timer = setInterval(() => response.write(' '), 40);
          timers.add(timer);
          response.on('close', () => { clearInterval(timer); timers.delete(timer); });
          return undefined;
        }
        case 'declared-huge': response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': settings.bytes }); response.write('{'); return undefined;
        case 'endless': {
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          const chunk = ' '.repeat(16 * 1024);
          const timer = setInterval(() => response.write(chunk), 2);
          timers.add(timer);
          response.on('close', () => { clearInterval(timer); timers.delete(timer); });
          return undefined;
        }
        case 'html': response.writeHead(200, { 'content-type': 'text/html' }); return response.end('<!doctype html><title>Releases</title><p>Not the manifest.</p>');
        default: response.writeHead(500); return response.end();
      }
    }
    const chained = settings.mode === 'chain' || settings.mode === 'chain-500';
    // the manifest of the tag: the second hop of the feed (and, for the download, the address a release file is asked for by tag)
    if (path === `${TAG_BASE(tagVersion())}/RELEASE-MANIFEST.json`) {
      if (chained) return redirect(`${CDN}/1413019619/24765420${SIGNED_QUERY}`); // the last hop carries a signed query, as the real one does: the Hub must never log or save it
      if (settings.mode === 'direct') return serve();
    }
    if (chained && path === `${CDN}/1413019619/24765420`) {
      if (settings.mode === 'chain-500') { response.writeHead(500, { 'content-type': 'text/plain' }); return response.end('no'); }
      return serve();
    }

    // the files of a release
    for (const entry of [signature, installer]) {
      if (path === `${TAG_BASE(tagVersion())}/${entry.name}`) { entry.firstHits += 1; return respondFirstHop(entry, response, redirect); }
      if (path === entry.cdn) return respondBody(entry, response);
    }
    // Anything else is not on the feed: a page, a guess.
    response.writeHead(404, { 'content-type': 'text/plain' });
    return response.end('not found');
  });

  function respondFirstHop(entry, response, redirect) {
    const behavior = entry.behavior;
    switch (behavior.mode) {
      case 'chain': return assetBytes(entry) === null ? plain(response, 404) : redirect(`${entry.cdn}${SIGNED_QUERY}`);
      case 'missing': return plain(response, 404);
      case 'status': return plain(response, behavior.status ?? 500);
      case 'redirect': return redirect(behavior.target ?? null);
      case 'stall': return undefined;
      case 'direct': case 'endless': case 'declared-huge': return respondBody(entry, response);
      default: return plain(response, 500);
    }
  }

  function plain(response, status) { response.writeHead(status, { 'content-type': 'text/plain' }); response.end('no'); }

  /** The 200: the bytes of the file, as the mode says. Streams in chunks so that a test can stop it half way. */
  function respondBody(entry, response) {
    const behavior = entry.behavior;
    const bytes = assetBytes(entry);
    if (behavior.mode === 'endless') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      const timer = setInterval(() => response.write(Buffer.alloc(16 * 1024, 0x20)), 2);
      timers.add(timer);
      response.on('close', () => { clearInterval(timer); timers.delete(timer); });
      return;
    }
    if (behavior.mode === 'declared-huge') { response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': behavior.bytes ?? 0 }); response.write('{'); return; }
    if (bytes === null) { plain(response, 404); return; }
    response.writeHead(200, { 'content-type': 'application/octet-stream', ...(behavior.chunked ? {} : { 'content-length': bytes.length }) });
    response.flushHeaders(); // on the wire before the first byte of the body: `pauseAfter: 0` holds the body back and the client still sees the length it declares
    entry.open += 1;
    response.on('close', () => { entry.open -= 1; });
    void (async () => {
      let offset = 0;
      while (offset < bytes.length) {
        if (response.destroyed) return;
        if (behavior.resetAfter !== undefined && offset >= behavior.resetAfter) { response.destroy(); return; }
        if (behavior.endAfter !== undefined && offset >= behavior.endAfter) { response.end(); return; }
        if (behavior.stallAfter !== undefined && offset >= behavior.stallAfter) return;
        if (behavior.pauseAfter !== undefined && offset >= behavior.pauseAfter && !entry.released) {
          entry.gate = entry.gate ?? new Promise((resolve) => { entry.release = resolve; });
          gates.add(entry);
          await entry.gate;
          if (response.destroyed) return;
        }
        const limit = [behavior.resetAfter, behavior.stallAfter, behavior.pauseAfter, behavior.endAfter].filter((value) => value !== undefined && value > offset).reduce((least, value) => Math.min(least, value), bytes.length);
        const slice = bytes.subarray(offset, Math.min(offset + CHUNK, limit, bytes.length));
        entry.sent += slice.length;
        offset += slice.length;
        if (!response.write(slice)) {
          await new Promise((resolve) => {
            const done = () => { response.off('drain', done); response.off('close', done); resolve(); };
            response.on('drain', done);
            response.on('close', done);
          });
        }
      }
      if (!response.destroyed) response.end();
    })();
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const controls = (entry) => ({
    /** Sets how this file is served (see the modes above); everything else about it stays. */
    mode(name, options = {}) { entry.behavior = { ...options, mode: name }; entry.released = false; entry.gate = null; },
    /** Lets a body that was told `pauseAfter` go on. */
    resume() { entry.released = true; entry.release?.(); },
    /** The tag address of the file, and how many requests came to it (not counting the signed hop). */
    path: () => `${TAG_BASE(tagVersion())}/${entry.name}`,
    hits: () => entry.firstHits,
    /** Bytes written to the client so far, over all requests. */
    sent: () => entry.sent,
    /** Responses still open. */
    openCount: () => entry.open,
  });

  return {
    origin,
    /** The address of the feed (what the Hub is told to read). */
    url: `${origin}${FIRST_HOP}`,
    firstHop: FIRST_HOP,
    requests,
    /** Requests to the first address: one per check, whatever the number of hops. */
    checks: () => requests.filter((entry) => entry.url.split('?')[0] === FIRST_HOP).length,
    /** Requests that asked for the manifest of the tag (the second hop of a check, or a download looking at the release by its tag). */
    tagManifestRequests: () => requests.filter((entry) => entry.url.split('?')[0] === `${TAG_BASE(tagVersion())}/RELEASE-MANIFEST.json`).length,
    /** Answers that are still open (a stalled one, an endless one): zero once the Hub has given up on them. */
    openCount: () => open.size,
    mode(name, options = {}) { Object.assign(settings, { status: 404, target: '', bytes: 0 }, options, { mode: name }); },
    /** Serve another document (a newer release, a document with a BOM). */
    publish(next, { bom = false, raw = null } = {}) {
      if (next) manifest = next;
      body = raw ?? `${bom ? '﻿' : ''}${JSON.stringify(manifest, null, 2)}\r\n`;
    },
    /** Serve the files of a release under the tag of this version whatever the manifest says (null: the manifest's own). */
    pinTag(version) { pinnedTag = version; },
    /** The bytes that are served as the manifest. */
    manifestBytes: () => Buffer.from(body),
    /** RELEASE-MANIFEST.json.sig: served for the manifest that is served (made with the key given to startUpdateFeed), or as the test says. */
    signature: {
      ...controls(signature),
      /** Serve exactly these bytes as the signature (an old one, a wrong one, nothing); null goes back to a signature of the manifest that is served. */
      set(bytes) { ownedSignature = bytes; },
      current: () => signatureBytes(),
    },
    /** The installer: `set` gives its name and its bytes. */
    installer: {
      ...controls(installer),
      set({ name, bytes }) { installer.name = name; installer.bytes = bytes; installer.behavior = { mode: 'chain' }; },
      current: () => installer.bytes,
    },
    async close() {
      for (const timer of timers) clearInterval(timer);
      for (const entry of gates) entry.release?.();
      for (const response of open) response.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
