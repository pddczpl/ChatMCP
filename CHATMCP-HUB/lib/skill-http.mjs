// Single-hop, DNS-pinned outbound transport for untrusted skill resources.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const failure = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const peer = (value) => {
  const ip = String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
  return ip.startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
};

/**
 * DNS policy is enforced by the caller. The approved address is bound to the
 * actual TCP connection; TLS certificate verification uses the original host.
 * Redirects are returned for revalidation, never followed implicitly.
 */
export async function fetchPinnedSkillResponse(url, { ip, timeoutMs = 8000, maxBytes = 512 * 1024 } = {}) {
  const target = new URL(url);
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(ip);
  if (!['http:', 'https:'].includes(target.protocol) || !family) throw failure('invalid_transport', 'Expected HTTP(S) and a validated IP.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw failure('invalid_download_limit', 'Invalid download limits.');
  }
  return await new Promise((resolve, reject) => {
    let done = false;
    let timer;
    const finish = (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(result);
    };
    // Refuse an oversized response by settling FIRST, then destroying the request. Destroying drains the response, and when the whole body
    // had already arrived its 'end' can fire before the request's 'error': with the rejection left to that 'error', the 'end' handler
    // resolved an empty body as a success (a body sent in one write, or in two chunks on a fast loopback, was never refused).
    const tooLarge = (message) => {
      const error = failure('response_too_large', message, 413);
      finish(error);
      request.destroy(error);
    };
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, {
      method: 'GET',
      agent: false,
      headers: {
        'User-Agent': 'ChatMCP-Skills/2.3',
        'Accept': 'application/json, text/markdown, text/plain, */*',
        'Accept-Encoding': 'identity',
      },
      lookup(_name, opts, callback) {
        if (opts?.all) callback(null, [{ address: ip, family }]);
        else callback(null, ip, family);
      },
      ...(target.protocol === 'https:' && net.isIP(hostname) === 0 ? { servername: hostname, rejectUnauthorized: true } : {}),
    }, (res) => {
      const announced = Number(res.headers['content-length']);
      if (Number.isFinite(announced) && announced > maxBytes) {
        tooLarge('Content-Length exceeds download limit.');
        return;
      }
      const chunks = [];
      let count = 0;
      res.on('data', (chunk) => {
        count += chunk.length;
        if (count > maxBytes) {
          tooLarge('Streaming response exceeds download limit.');
          return;
        }
        chunks.push(chunk);
      });
      res.once('error', (err) => finish(err));
      res.once('end', () => {
        const buffer = Buffer.concat(chunks, count);
        finish(null, {
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: { get: (key) => {
            const value = res.headers[String(key).toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : value ?? null;
          } },
          text: async () => buffer.toString('utf8'),
          buffer,
        });
      });
    });
    request.once('socket', (socket) => {
      socket.once('connect', () => {
        if (peer(socket.remoteAddress) !== peer(ip)) {
          request.destroy(failure('peer_mismatch', 'Connected peer differs from approved IP.', 403));
        }
      });
    });
    request.once('error', (err) => finish(err));
    timer = setTimeout(() => request.destroy(failure('fetch_timeout', 'Skill download timed out.', 408)), timeoutMs);
    timer.unref?.();
    request.end();
  });
}
