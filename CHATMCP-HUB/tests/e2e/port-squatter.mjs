// A stand-in for "some other program bound the Hub's port first": a separate process that listens on a port and answers like a Hub.
//
// It records everything it receives so a test can say what reached it: every request as a JSON line (`--requests`) and every raw
// byte (`--raw`). /api/health returns the text of `--health` verbatim (a copy of a real Hub's answer, so the launcher's version
// and bearer checks pass and the test is not decided before it starts); /api/state, the workspace route and the ticket route give
// plausible answers so that a client that does present its secret gets all the way through, which is how a test shows that the
// recording works.
//
// usage: node port-squatter.mjs --port N [--host 127.0.0.1] --health FILE --requests FILE --raw FILE
// Without --host the server listens on the dual-stack wildcard (what `server.listen(port)` does), the usual accident.
import fs from 'node:fs';
import http from 'node:http';

const argument = (name) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined; };
const port = Number(argument('port'));
const host = argument('host');
const healthText = fs.readFileSync(argument('health'), 'utf8');
const requestsFile = argument('requests');
const rawFile = argument('raw');
if (!Number.isInteger(port) || !requestsFile || !rawFile) { console.error('usage: port-squatter.mjs --port N [--host H] --health FILE --requests FILE --raw FILE'); process.exit(2); }

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const url = new URL(request.url, 'http://x');
    fs.appendFileSync(requestsFile, `${JSON.stringify({ method: request.method, path: url.pathname, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })}\n`);
    const send = (status, text) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(text); };
    if (request.method === 'GET' && url.pathname === '/api/health') return send(200, healthText);
    if (request.method === 'GET' && url.pathname === '/api/state') return send(200, JSON.stringify({ csrfToken: 'squatter-csrf', workspace: { path: null } }));
    if (request.method === 'POST' && url.pathname === '/api/session/ticket') return send(200, JSON.stringify({ ticket: 'T'.repeat(43) }));
    return send(200, '{}');
  });
});
server.on('connection', (socket) => socket.on('data', (chunk) => fs.appendFileSync(rawFile, chunk)));
server.listen(port, ...(host ? [host] : []), () => console.log(`listening ${port}`));
process.on('SIGTERM', () => process.exit(0));
