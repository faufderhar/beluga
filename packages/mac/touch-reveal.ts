import type { Declaration, Plugin, Rule } from 'postcss';
import postcss from 'postcss';

/**
 * A touch screen has no hover (BLG-6: the app in a phone's browser): what a pointer reveals by
 * hovering a parent (a message's actions, a row's buttons, a code block's tools) would never show.
 * This pass copies each such rule into `@media (hover: none)` with the parent's `:hover` always
 * true, so a finger sees them at once. A Mac (a pointer that hovers) never matches the copy.
 *
 * Copied: a selector whose `:hover` is on a parent (more selector follows it, past a combinator),
 * and only the declarations that show or hide something. `:hover` becomes `:is(:hover, *)`: it
 * matches every element and counts as `:hover` does, so the copy wins wherever the hover rule did.
 */

const REVEAL = new Set(['opacity', 'visibility', 'display', 'pointer-events']);
export const TOUCH_MEDIA = '(hover: none)';
const ALWAYS = ':is(:hover, *)';

/** Where a `:hover` outside any parentheses is, or -1. */
function topLevelHover(selector: string): number {
  let depth = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && selector.startsWith(':hover', i) && !/[\w-]/.test(selector[i + 6] ?? '')) return i;
  }
  return -1;
}

/** Whether a combinator (space, >, +, ~) outside parentheses follows: the hovered one is a parent. */
function combinatorFollows(rest: string): boolean {
  let depth = 0;
  for (const ch of rest.trimEnd()) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /[\s>+~]/.test(ch)) return true;
  }
  return false;
}

/** The selector with its parent's hover always true, or undefined when it doesn't reveal a child. */
export function touchSelector(selector: string): string | undefined {
  const at = topLevelHover(selector);
  if (at < 0 || !combinatorFollows(selector.slice(at + 6))) return undefined;
  return `${selector.slice(0, at)}${ALWAYS}${selector.slice(at + 6)}`;
}

function touchCopy(rule: Rule): Rule | undefined {
  const selectors = rule.selectors.map(touchSelector).filter((sel): sel is string => sel !== undefined);
  if (!selectors.length) return undefined;
  const decls = (rule.nodes ?? []).filter((node): node is Declaration => node.type === 'decl' && REVEAL.has(node.prop.toLowerCase()));
  if (!decls.length) return undefined;
  return postcss.rule({ selectors, nodes: decls.map((decl) => decl.clone()) });
}

export function touchReveal(): Plugin {
  return {
    postcssPlugin: 'beluga-touch-reveal',
    OnceExit(root) {
      const copies: Rule[] = [];
      // Only top-level rules: one already inside a media query (or keyframes) is left as it is.
      root.each((node) => {
        if (node.type !== 'rule') return;
        const copy = touchCopy(node);
        if (copy) copies.push(copy);
      });
      if (copies.length) root.append(postcss.atRule({ name: 'media', params: TOUCH_MEDIA, nodes: copies }));
    },
  };
}
touchReveal.postcss = true;
