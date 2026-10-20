// A small reader for the HTML that React renders on the server, so that a test can ask what a screen reader would be told: the accessible
// name of a control, whether an id is used twice, which element a label points at. It is not a browser: it knows the markup React produces
// (well formed, double-quoted attributes, void elements without a slash) and nothing else.

const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'wbr']);
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&nbsp;': ' ' };
const decode = (text) => text.replace(/&(?:amp|lt|gt|quot|nbsp|#x27|#39);/g, (entity) => ENTITIES[entity]);

class Node {
  constructor(tag, attrs, parent) { this.tag = tag; this.attrs = attrs; this.parent = parent; this.children = []; }
  /** The text inside, children in order; an element that is not rendered for a reader (aria-hidden) contributes nothing. */
  get text() {
    return this.children.map((child) => (typeof child === 'string' ? child : child.attrs['aria-hidden'] === 'true' ? '' : child.text)).join('');
  }
  descendants() { return this.children.flatMap((child) => (typeof child === 'string' ? [] : [child, ...child.descendants()])); }
}

export function parseHtml(html) {
  const root = new Node('#root', {}, null);
  let current = root;
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g;
  for (let match = token.exec(html); match; match = token.exec(html)) {
    if (match[0].startsWith('<!--')) continue;
    if (match[1]) {
      // a closing tag ends the nearest open element of that name
      for (let node = current; node && node !== root; node = node.parent) {
        if (node.tag === match[1].toLowerCase()) { current = node.parent; break; }
      }
    } else if (match[2]) {
      const attrs = {};
      for (const attribute of (match[3] || '').matchAll(/\s+([^\s=>/]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[attribute[1].toLowerCase()] = decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
      const node = new Node(match[2].toLowerCase(), attrs, current);
      current.children.push(node);
      if (!VOID.has(node.tag) && !match[0].endsWith('/>')) current = node;
    } else if (match[4]) {
      current.children.push(decode(match[4]));
    }
  }
  return root;
}

export const all = (root) => root.descendants();
export const byTag = (root, ...tags) => all(root).filter((node) => tags.includes(node.tag));
export const byRole = (root, role) => all(root).filter((node) => node.attrs.role === role);
export const byId = (root, id) => all(root).find((node) => node.attrs.id === id);
export const normalise = (text) => text.replace(/\s+/g, ' ').trim();

/** The name a screen reader announces for a control: aria-labelledby, aria-label, a label that points at it or wraps it, its own text, its title. */
export function accessibleName(root, node) {
  if (node.attrs['aria-labelledby']) {
    return normalise(node.attrs['aria-labelledby'].split(/\s+/).map((id) => byId(root, id)?.text ?? '').join(' '));
  }
  if (node.attrs['aria-label']) return normalise(node.attrs['aria-label']);
  if (node.attrs.id) {
    const label = byTag(root, 'label').find((item) => item.attrs.for === node.attrs.id);
    if (label) return normalise(label.text);
  }
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.tag === 'label') return normalise(parent.text);
  }
  if (['button', 'summary', 'a'].includes(node.tag) || node.attrs.role === 'tab') return normalise(node.text) || normalise(node.attrs.title ?? '');
  return normalise(node.attrs.title ?? '');
}

/** Ids used by more than one element (the attribute must be unique in a page, and a label or aria-controls would point at the wrong one). */
export function duplicateIds(root) {
  const ids = all(root).map((node) => node.attrs.id).filter(Boolean);
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
}

/** Controls a person has to name (buttons, links to act on, text boxes, selects, summaries) that have no accessible name. */
export function unnamedControls(root) {
  return all(root)
    .filter((node) => ['button', 'select', 'textarea', 'summary'].includes(node.tag) || (node.tag === 'input' && !['hidden'].includes(node.attrs.type)))
    .filter((node) => !accessibleName(root, node))
    .map((node) => `${node.tag}${node.attrs.id ? `#${node.attrs.id}` : ''}`);
}

/** Every aria-controls / aria-labelledby / for that points at an id that is not in the page. */
export function brokenReferences(root) {
  const ids = new Set(all(root).map((node) => node.attrs.id).filter(Boolean));
  const broken = [];
  for (const node of all(root)) {
    for (const attribute of ['aria-controls', 'aria-labelledby', 'aria-describedby', 'for']) {
      for (const id of (node.attrs[attribute] || '').split(/\s+/).filter(Boolean)) if (!ids.has(id)) broken.push(`${node.tag}[${attribute}=${id}]`);
    }
  }
  return broken;
}
