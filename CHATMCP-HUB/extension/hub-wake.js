(() => {
  'use strict';
  if (location.origin !== 'http://127.0.0.1:3007' || window.top !== window || location.pathname !== '/') return;
  const wake = () => chrome.runtime.sendMessage({ type: 'CHATMCP_BROWSER_WAKE' }).catch(() => {});
  window.addEventListener('message', event => {
    if (event.source === window && event.origin === location.origin && event.data?.type === 'CHATMCP_HUB_BROWSER_WAKE') wake();
  });
  // A wake is only a hint. The background fetches authenticated, queued work;
  // arbitrary page-supplied text/URLs/commands are never relayed.
  wake();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
})();
