(() => {
  'use strict';

  if (location.origin !== 'https://chatgpt.com' || window.top !== window) return;
  if (globalThis.__chatmcpButtonFixInstalled) return;
  globalThis.__chatmcpButtonFixInstalled = true;

  const VERSION = '1.2.0';
  // Observed directly in the user's Elements screenshot, 2026-10-09.
  const OBSERVED_SELECTOR = 'button[data-composer-navigation-target="add-context"]';
  // The existing MCP SuperAssistant ChatGPT adapter searches this attribute.
  const LEGACY_VALUE = 'composer-plus-btn';
  const SCAN_SELECTOR = OBSERVED_SELECTOR + ', button[data-testid="composer-plus-btn"]';
  const ownedButtons = new WeakSet();
  let appliedCount = 0;

  function prepareButton(button) {
    // React may reuse the same node for another role. Remove only our own
    // unchanged alias when that node ceases to be a composer-add button.
    if (ownedButtons.has(button) && (!button.isConnected || !button.matches(OBSERVED_SELECTOR))) {
      ownedButtons.delete(button);
      if (button.getAttribute('data-testid') === LEGACY_VALUE) {
        button.removeAttribute('data-testid');
      }
      return;
    }
    if (!button.isConnected || !button.matches(OBSERVED_SELECTOR)) return;
    // Preserve any attribute already owned by ChatGPT or another extension.
    if (button.hasAttribute('data-testid')) {
      if (button.getAttribute('data-testid') !== LEGACY_VALUE) ownedButtons.delete(button);
      return;
    }

    button.setAttribute('data-testid', LEGACY_VALUE);
    ownedButtons.add(button);
    appliedCount += 1;

    // MCP SuperAssistant observes childList, not attribute changes. A temporary
    // comment wakes that observer after the anchor is ready, even if its first
    // check ran earlier. The original button and its event handlers stay intact.
    const parent = button.parentNode;
    if (parent) {
      const signal = document.createComment('ChatMCP: composer anchor ready');
      parent.appendChild(signal);
      parent.removeChild(signal);
    }
  }

  function scan(root) {
    if (root.nodeType === Node.ELEMENT_NODE && (root.matches(SCAN_SELECTOR) || ownedButtons.has(root))) {
      prepareButton(root);
    }
    if (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE) {
      root.querySelectorAll(SCAN_SELECTOR).forEach(prepareButton);
    }
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        prepareButton(record.target);
      } else if (record.type === 'childList') {
        for (const node of record.addedNodes) scan(node);
        for (const node of record.removedNodes) scan(node);
      }
    }
  });

  // Observing document works before document.body exists at document_start.
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-composer-navigation-target', 'data-testid']
  });
  scan(document);

  function routeCategory() {
    if (location.pathname === '/') return 'root';
    if (location.pathname.startsWith('/c/')) return 'conversation';
    if (location.pathname.startsWith('/g/')) return 'custom-gpt';
    return 'other';
  }

  function getStatus() {
    // Mirror the four URL patterns in the inspected upstream adapter. Return
    // only a Boolean/category: no full URL, conversation ID, query or fragment.
    const inspectedAdapterPatterns = [
      /^https:\/\/chatgpt\.com\/$/,
      /^https:\/\/chatgpt\.com\/c\/.*/,
      /^https:\/\/chatgpt\.com\/g\/.*/,
      /^https:\/\/chatgpt\.com\/\?.*/
    ];
    const popover = document.getElementById('mcp-popover-container');
    const button = popover?.querySelector('button');
    const rect = button?.getBoundingClientRect();
    return {
      version: VERSION,
      routeCategory: routeCategory(),
      inspectedAdapterUrlMatch: inspectedAdapterPatterns.some((pattern) => pattern.test(location.href)),
      observedAnchors: document.querySelectorAll(OBSERVED_SELECTOR).length,
      compatibleAnchors: document.querySelectorAll('[data-testid="composer-plus-btn"]').length,
      appliedCount,
      popoverContainers: document.querySelectorAll('#mcp-popover-container').length,
      popoverHasButton: Boolean(button),
      popoverButtonHasSize: Boolean(rect && rect.width > 0 && rect.height > 0),
      toolCards: document.querySelectorAll('.function-block').length,
      preBlocks: document.querySelectorAll('pre').length,
      bridge: typeof globalThis.__chatmcpBridgeStatus === 'function' ? globalThis.__chatmcpBridgeStatus() : null
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === 'CHATMCP_BUTTON_FIX_STATUS') sendResponse(getStatus());
    else if (message?.type === 'CHATMCP_BRIDGE_SESSION') {
      sendResponse(typeof globalThis.__chatmcpBridgeSession === 'function' ? globalThis.__chatmcpBridgeSession() : null);
    } else if (message?.type === 'CHATMCP_BRIDGE_SET_AUTO' && typeof message.enabled === 'boolean') {
      sendResponse(typeof globalThis.__chatmcpBridgeSetAuto === 'function' ? globalThis.__chatmcpBridgeSetAuto(message.enabled) : null);
    } else if (message?.type === 'CHATMCP_BRIDGE_BIND_HUB') {
      sendResponse(typeof globalThis.__chatmcpBridgeBindHub === 'function'
        ? globalThis.__chatmcpBridgeBindHub(message.binding, message.callIdPrefix) : { ok: false });
    } else if (message?.type === 'CHATMCP_INSERT_INSTRUCTIONS') {
      sendResponse(typeof globalThis.__chatmcpInsertInstructions === 'function'
        ? globalThis.__chatmcpInsertInstructions(message.text) : { ok: false, reason: 'insertion_unsupported' });
    }
    return false;
  });
})();
