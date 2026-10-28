(() => {
  'use strict';
  // One allowlist is shared by the isolated content script, service worker,
  // local Node runner and dashboard. The path wrapper is not chat identity.
  const SEGMENT = '[A-Za-z0-9_-]{1,256}';
  const CHAT = new RegExp('^/(?:c|chat)/(' + SEGMENT + ')/?$');
  const SCOPED_CHAT = new RegExp('^/g/' + SEGMENT + '/c/(' + SEGMENT + ')/?$');
  const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  // ChatGPT assigns this local identifier before saving a new conversation.
  // Decode only this observed delimiter, never arbitrary percent-encoded IDs.
  const LOCAL_CHAT = new RegExp('^/c/local-chatgpt(?::|%3[Aa])(' + UUID + ')/?$');

  function parse(value) {
    if (typeof value !== 'string' || !value || /[\\\u0000-\u0020\u007f]/.test(value)) return null;
    try {
      const url = new URL(value);
      if (url.origin !== 'https://chatgpt.com' || url.username || url.password) return null;
      const raw = /^https:\/\/[^/?#]+([^?#]*)/i.exec(value);
      if (!raw || (raw[1] || '/') !== url.pathname) return null;
      if (url.pathname === '/') return { kind: 'home', conversationId: null, path: '/', url: url.origin + '/' };
      const local = LOCAL_CHAT.exec(url.pathname);
      if (local) {
        const id = local[1].toLowerCase();
        const pathname = '/c/local-chatgpt%3A' + id;
        return { kind: 'chat', provisional: true, conversationId: 'local-chatgpt:' + id, path: pathname, url: url.origin + pathname };
      }
      const match = CHAT.exec(url.pathname) || SCOPED_CHAT.exec(url.pathname);
      if (!match) return null;
      const pathname = url.pathname.replace(/\/$/, '');
      return { kind: 'chat', conversationId: match[1], path: pathname, url: url.origin + pathname };
    } catch { return null; }
  }

  function normalize(value) { return parse(value)?.url || null; }
  function sameConversation(left, right) {
    const a = parse(left && typeof left === 'object' ? left.url : left);
    const b = parse(right && typeof right === 'object' ? right.url : right);
    if (!a || !b || a.kind !== b.kind) return false;
    return a.kind === 'home' || (a.conversationId !== null && a.conversationId === b.conversationId);
  }

  globalThis.__chatmcpChatRoute = Object.freeze({ parse, normalize, sameConversation });
})();
