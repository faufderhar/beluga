import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { touchReveal } from '../packages/mac/touch-reveal.js';

const run = (css: string): string => postcss([touchReveal()]).process(css, { from: 'x.module.css' }).css;
/** The rules the pass added for touch screens, as one line each. */
const touchRules = (css: string): string[] => {
  const out: string[] = [];
  postcss.parse(run(css)).walkAtRules('media', (media) => {
    if (media.params !== '(hover: none)') return;
    media.walkRules((rule) => {
      out.push(`${rule.selector} { ${rule.nodes.map((d) => d.toString()).join('; ')} }`);
    });
  });
  return out;
};

describe('touch screens see what a pointer reveals on hover (BLG-6)', () => {
  it('shows a child the parent reveals on hover', () => {
    expect(touchRules('.message .hoverActions { opacity: 0 } .message:hover .hoverActions { opacity: 1 }')).toEqual(['.message:is(:hover, *) .hoverActions { opacity: 1 }']);
  });

  it('keeps the other selectors of the list (focus-within already works on touch)', () => {
    expect(touchRules('.row:hover .acts, .row:focus-within .acts { visibility: visible; pointer-events: auto }')).toEqual(['.row:is(:hover, *) .acts { visibility: visible; pointer-events: auto }']);
  });

  it('handles a child combinator and :hover after other pseudo-classes', () => {
    expect(touchRules('.tab:not(.on):hover > .close { display: flex }')).toEqual(['.tab:not(.on):is(:hover, *) > .close { display: flex }']);
  });

  it('leaves rules that only restyle the hovered element itself', () => {
    expect(touchRules('.row:hover { background: red } .row:hover .name { color: blue }')).toEqual([]);
  });

  it('copies only the reveal declarations of a mixed rule', () => {
    expect(touchRules('.card:hover .tools { opacity: 1; background: red; transform: none }')).toEqual(['.card:is(:hover, *) .tools { opacity: 1 }']);
  });

  it('skips rules already inside a media query, and keyframes', () => {
    expect(touchRules('@media (min-width: 900px) { .a:hover .b { opacity: 1 } } @keyframes x { from { opacity: 0 } }')).toEqual([]);
  });

  it('keeps the hover rule\'s specificity, so a more specific resting rule never wins', () => {
    // :is() counts as its most specific argument (:hover); * matches every element.
    expect(touchRules('.a:hover .b { opacity: 1 }')[0]).toContain(':is(:hover, *)');
  });

  it('skips a :hover inside parentheses, which may not be a parent', () => {
    expect(touchRules('.a:not(:hover) .b { opacity: 0 }')).toEqual([]);
  });

  it('leaves the original rule in place for pointers', () => {
    expect(run('.a:hover .b { opacity: 1 }')).toContain('.a:hover .b');
  });
});
