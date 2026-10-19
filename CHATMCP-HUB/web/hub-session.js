/* Per-launch Hub session for the two older dashboards (/classic, /legacy).
 *
 * The Hub requires `Authorization: Bearer <secret>` on every API call. The React dashboard (web/dist) does this itself; the older
 * pages call fetch() and EventSource directly, so this script - loaded first - trades the one-time ticket in the address
 * (#chatmcp-boot=...) for the secret, keeps it in sessionStorage (same key as the React dashboard) and adds the header to
 * same-origin /api/ requests. EventSource cannot send headers, so it is replaced by a small fetch-based equivalent.
 * Without a ticket and without a stored secret it changes nothing. */
(function () {
  'use strict';
  var KEY = 'chatmcp.hub-session';
  var TICKET = /^#chatmcp-boot=([A-Za-z0-9_-]{16,256})$/;
  if (typeof window.fetch !== 'function') return;
  var nativeFetch = window.fetch.bind(window);
  var secret = '';
  try { secret = window.sessionStorage.getItem(KEY) || ''; } catch (error) { /* private mode */ }
  var match = TICKET.exec(window.location.hash);
  if (match) {
    try { window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search); } catch (error) { /* keep going */ }
  }
  if (!match && !secret) return;

  var ready = match
    ? nativeFetch('/api/session/redeem', {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-ChatMCP-Request': 'local-dashboard' },
        body: JSON.stringify({ ticket: match[1] })
      }).then(function (response) {
        return response.ok ? response.json() : response.text().then(function () { return {}; });
      }).then(function (body) {
        if (body && typeof body.secret === 'string' && body.secret) {
          secret = body.secret;
          try { window.sessionStorage.setItem(KEY, secret); } catch (error) { /* in memory only */ }
        }
      }).catch(function () { /* fall back to what the tab already has */ })
    : Promise.resolve();

  function apiTarget(input) {
    try {
      var url = new URL(typeof input === 'string' ? input : (input && input.url) || '', window.location.href);
      return url.origin === window.location.origin && (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/auth/') === 0);
    } catch (error) { return false; }
  }
  function lost() {
    secret = '';
    try { window.sessionStorage.removeItem(KEY); } catch (error) { /* ignore */ }
    if (document.getElementById('chatmcp-session-lost') || !document.body) return;
    var banner = document.createElement('div');
    banner.id = 'chatmcp-session-lost';
    banner.setAttribute('role', 'alert');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;padding:12px 16px;background:#7f1d1d;color:#fff;font:14px system-ui,sans-serif';
    banner.textContent = 'Cần mở lại ChatMCP từ launcher (phiên Hub đã hết hạn) · Reopen ChatMCP from the desktop app or START-CHATMCP-HUB.cmd.';
    document.body.appendChild(banner);
  }

  window.fetch = function (input, init) {
    return ready.then(function () {
      if (!secret || !apiTarget(input)) return nativeFetch(input, init);
      var headers = new Headers((init && init.headers) || (typeof input === 'object' && input && input.headers) || undefined);
      headers.set('Authorization', 'Bearer ' + secret);
      var next = {}; for (var key in (init || {})) next[key] = init[key];
      next.headers = headers;
      return nativeFetch(input, next).then(function (response) {
        if (response.status === 401) response.clone().json().then(function (body) { if (body && body.code === 'hub_auth_required') lost(); }, function () {});
        return response;
      });
    });
  };

  /* Minimal EventSource: onopen / onmessage / onerror / close, reconnecting like the native one. */
  function FetchEventSource(url) {
    var self = this, controller = new AbortController(), closed = false;
    self.url = String(url); self.readyState = 0; self.onopen = null; self.onmessage = null; self.onerror = null;
    self.close = function () { closed = true; self.readyState = 2; controller.abort(); };
    function fire(handler, event) { if (typeof handler === 'function') { try { handler.call(self, event); } catch (error) { /* a handler's problem */ } } }
    function pump(reader) {
      var decoder = new TextDecoder(), buffer = '';
      return (function next() {
        return reader.read().then(function (chunk) {
          if (chunk.done || closed) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          var boundary;
          while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
            var block = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
            var data = [];
            block.split(/\r\n|\n|\r/).forEach(function (line) {
              if (line.indexOf('data:') === 0) data.push(line.slice(5).replace(/^ /, ''));
            });
            if (data.length) fire(self.onmessage, { data: data.join('\n'), type: 'message' });
          }
          return next();
        });
      })();
    }
    function connect() {
      if (closed) return;
      ready.then(function () {
        var headers = { Accept: 'text/event-stream' };
        if (secret) headers.Authorization = 'Bearer ' + secret;
        return nativeFetch(self.url, { headers: headers, cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      }).then(function (response) {
        if (response.status === 401) { lost(); closed = true; self.readyState = 2; fire(self.onerror, { type: 'error' }); return null; }
        if (!response.ok || !response.body) throw new Error('stream refused');
        self.readyState = 1; fire(self.onopen, { type: 'open' });
        return pump(response.body.getReader());
      }).then(function (finished) {
        if (finished === null || closed) return;
        throw new Error('stream ended');
      }).catch(function () {
        if (closed) return;
        self.readyState = 0; fire(self.onerror, { type: 'error' });
        if (!closed) window.setTimeout(connect, 2000);
      });
    }
    connect();
  }
  window.EventSource = FetchEventSource;
})();
