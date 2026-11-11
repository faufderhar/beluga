/**
 * Translates the window as it draws (docs/i18n.md): every text node and the attributes people read
 * (title, placeholder, aria-label, alt), looked up in the catalog when they appear or change.
 *
 * What people and agents write is never touched: anything inside `translate="no"` (messages, the
 * markdown reader), code, editors, terminals, and fields you type in. A MutationObserver's callback
 * runs before the next paint, so English never flashes. React keeps working: it compares with its
 * own props, not with the page, and when it writes new English text we translate that again.
 */
import { translated } from './index.js';

const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'aria-description', 'data-tooltip'] as const;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'KBD', 'SAMP', 'svg', 'math', 'NOSCRIPT']);
const SKIP_SELECTOR = '[translate="no"], .notranslate, [contenteditable=""], [contenteditable="true"], .xterm, .cm-editor, .monaco-editor, pre, code';

/** What we wrote into each text node, so our own writes aren't translated again. */
const written = new WeakMap<Node, string>();
/** Elements known to be inside a part we leave alone (or not): cleared when the page changes shape. */
let skipCache = new WeakMap<Element, boolean>();

/**
 * Words someone wrote, in a message or a document (`data-md`, the markdown renderers): its
 * paragraphs, list items, headings, table cells and quotes. What the renderers draw around them
 * (a chart's buttons, a table's search box) is still the app's own, and translated.
 */
const PROSE = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dt, dd, figcaption';
function authored(el: Element): boolean {
  const md = el.closest('[data-md]');
  if (!md) return false;
  // An image's alt text in a document is its author's words too, wherever it sits.
  if (el.tagName === 'IMG') return true;
  const block = el.closest(PROSE);
  return block !== null && md.contains(block);
}

function skipped(el: Element | null): boolean {
  if (!el) return true;
  const known = skipCache.get(el);
  if (known !== undefined) return known;
  const skip = SKIP_TAGS.has(el.tagName) || el.closest(SKIP_SELECTOR) !== null || authored(el);
  skipCache.set(el, skip);
  return skip;
}

function textNode(node: Text): void {
  const data = node.data;
  if (written.get(node) === data) return;
  if (!/[A-Za-z]/.test(data)) return;
  if (skipped(node.parentElement)) return;
  const to = translated(data);
  if (to === undefined || to === data) return;
  written.set(node, to);
  node.data = to;
}

function attribute(el: Element, name: string): void {
  const v = el.getAttribute(name);
  if (!v || !/[A-Za-z]/.test(v)) return;
  const mark = `${name}\u0000${v}`;
  if (written.get(el) === mark) return;
  if (skipped(el) && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
  const to = translated(v);
  if (to === undefined || to === v) return;
  written.set(el, `${name}\u0000${to}`);
  el.setAttribute(name, to);
}

function element(el: Element): void {
  for (const a of ATTRS) if (el.hasAttribute(a)) attribute(el, a);
  // A button-like input shows its value.
  if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes((el as HTMLInputElement).type)) {
    const input = el as HTMLInputElement;
    const to = translated(input.value);
    if (to !== undefined) input.value = to;
  }
}

function subtree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) return textNode(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) {
    const el = root as Element;
    element(el);
    if (SKIP_TAGS.has(el.tagName) || (el.matches(SKIP_SELECTOR) && el.tagName !== 'INPUT')) return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as Element;
        if (SKIP_TAGS.has(el.tagName) || el.matches(SKIP_SELECTOR)) {
          // Still read the attributes people see on it (a field's placeholder), not what's inside.
          element(el);
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) textNode(n as Text);
    else element(n as Element);
  }
}

let observer: MutationObserver | null = null;

/** Start translating this document (and keep at it). Does nothing in English. */
export function translatePage(root: Node = document.body): void {
  if (observer || typeof MutationObserver === 'undefined') return;
  subtree(root);
  translateTitle();
  observer = new MutationObserver((records) => {
    let shaped = false;
    for (const r of records) {
      if (r.type === 'childList') {
        if (!shaped && r.addedNodes.length) {
          // New parts can move a node in or out of a translate="no" part: forget what we knew.
          skipCache = new WeakMap();
          shaped = true;
        }
        r.addedNodes.forEach(subtree);
      } else if (r.type === 'characterData') textNode(r.target as Text);
      else if (r.type === 'attributes' && r.attributeName) attribute(r.target as Element, r.attributeName);
    }
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
  // The window's title (the Dock, Mission Control, the Window menu).
  const title = document.querySelector('title');
  if (title) new MutationObserver(translateTitle).observe(title, { childList: true, characterData: true, subtree: true });
}

function translateTitle(): void {
  const to = translated(document.title);
  if (to !== undefined && to !== document.title) document.title = to;
}
