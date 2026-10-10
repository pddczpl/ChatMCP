(() => {
  'use strict';

  if (location.origin !== 'https://chatgpt.com' || window.top !== window) return;
  const MAX_INSTRUCTIONS = 1048576;
  const read = element => element.tagName === 'TEXTAREA' ? element.value : element.textContent || '';
  const normalized = text => text.replace(/\r\n/g, '\n').trim();

  function findComposer() {
    // Exact input selectors in the inspected MCP SuperAssistant adapter.
    // No generic contenteditable or generic button fallback is used.
    for (const selector of ['#prompt-textarea', '.ProseMirror[contenteditable="true"]']) {
      const candidates = Array.from(document.querySelectorAll(selector)).filter(element => {
        const validType = element.tagName === 'TEXTAREA' || element.getAttribute('contenteditable') === 'true';
        if (!validType || element.disabled || element.readOnly || element.closest('[hidden],[aria-hidden="true"]')) return false;
        const rectangle = element.getBoundingClientRect();
        return rectangle.width > 0 && rectangle.height > 0;
      });
      if (candidates.length > 1) return { ok: false, reason: 'ambiguous_composer' };
      if (candidates.length === 1) return { ok: true, element: candidates[0] };
    }
    return { ok: false, reason: 'composer_not_found' };
  }

  globalThis.__chatmcpInsertInstructions = text => {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_INSTRUCTIONS) return { ok: false, reason: 'invalid_instructions' };
    const found = findComposer();
    if (!found.ok) return found;
    const element = found.element;
    if (read(element).trim()) return { ok: false, reason: 'composer_not_empty' };
    element.focus();
    try {
      if (element.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (!setter) return { ok: false, reason: 'insertion_unsupported' };
        setter.call(element, text);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        if (typeof document.execCommand !== 'function') return { ok: false, reason: 'insertion_unsupported' };
        const selection = window.getSelection();
        if (!selection) return { ok: false, reason: 'insertion_unsupported' };
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('insertText', false, text);
      }
      if (normalized(read(element)) !== normalized(text)) return { ok: false, reason: 'insertion_unconfirmed' };
      // Deliberately no send-button click, keyboard submit, policy interaction
      // or replacement of an existing draft.
      return { ok: true, reason: 'inserted_review_before_sending' };
    } catch {
      return { ok: false, reason: 'insertion_unsupported' };
    }
  };
})();
