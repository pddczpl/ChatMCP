// A stand-in for GitHub's release feed, on a loopback port, for the tests of the update notice (lib/update-check.mjs).
//
// It speaks HTTP the way the real answer does: https://github.com/<repo>/releases/latest/download/RELEASE-MANIFEST.json answers 302 to the file of the release (on github.com)
// and that answers 302 to a signed address on another host, which answers 200 with the file (tests/probe of 2026-10-26: two redirects, 568 bytes, application/octet-stream).
// The stand-in keeps the three hops on its own origin. It records every request it is sent (method, address and the names and values of the headers), so a test can say exactly what
// the Hub asked for and, with a mode that answers badly, what the Hub does with a bad answer. Nothing here is a copy of the code under test: it is a server.
import http from 'node:http';

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

/**
 * @param {{manifest?: object, text?: string}} [options] `text` is the exact body to serve (a BOM, a broken document); otherwise the manifest is serialised the way PowerShell does.
 * Modes (set with `feed.mode(name, options)`):
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
 */
export async function startUpdateFeed({ manifest = feedManifest(), text = null } = {}) {
  const requests = [];
  const open = new Set();
  const settings = { mode: 'chain', status: 404, target: '', bytes: 0 };
  let body = text ?? `${JSON.stringify(manifest, null, 2)}\r\n`;
  const timers = new Set();

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
        case 'chain-500': return redirect(`/pddczpl/ChatMCP/releases/download/v${manifest.version}/RELEASE-MANIFEST.json`);
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
    if (chained && path === `/pddczpl/ChatMCP/releases/download/v${manifest.version}/RELEASE-MANIFEST.json`) {
      // The last hop carries a signed query, as the real one does: the Hub must never log or save it.
      return redirect('/github-production-release-asset/1413019619/24765420?X-Amz-Signature=SIGNED-QUERY-MUST-NOT-BE-KEPT&X-Amz-Expires=300');
    }
    if (chained && path === '/github-production-release-asset/1413019619/24765420') {
      if (settings.mode === 'chain-500') { response.writeHead(500, { 'content-type': 'text/plain' }); return response.end('no'); }
      return serve();
    }
    // Anything else is not on the feed: an installer, a page, a guess.
    response.writeHead(404, { 'content-type': 'text/plain' });
    return response.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    /** The address of the feed (what the Hub is told to read). */
    url: `${origin}${FIRST_HOP}`,
    firstHop: FIRST_HOP,
    requests,
    /** Requests to the first address: one per check, whatever the number of hops. */
    checks: () => requests.filter((entry) => entry.url.split('?')[0] === FIRST_HOP).length,
    /** Answers that are still open (a stalled one, an endless one): zero once the Hub has given up on them. */
    openCount: () => open.size,
    mode(name, options = {}) { Object.assign(settings, { status: 404, target: '', bytes: 0 }, options, { mode: name }); },
    /** Serve another document (a newer release, a document with a BOM). */
    publish(next, { bom = false, raw = null } = {}) {
      if (next) manifest = next;
      body = raw ?? `${bom ? '\uFEFF' : ''}${JSON.stringify(manifest, null, 2)}\r\n`;
    },
    async close() {
      for (const timer of timers) clearInterval(timer);
      for (const response of open) response.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
