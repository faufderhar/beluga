import { PREVIEW_FENCE } from '../shared/preview/ref.js';

/**
 * Teaching Claude live previews (Settings › Experimental › Live previews, src/preview): only told
 * while the experiment is on, on your own runs, and never in its terminal (the fence would print
 * as text there).
 */
export function buildPreviewAppend(): string {
  return [
    '',
    'Live previews (an experimental feature the user turned on): when you build or change a React component or a',
    `web page, show it working with a \`\`\`${PREVIEW_FENCE} block after you describe it, unasked: the app draws it live`,
    'in your answer, and the user can change its props beside it and click it. One or two per answer, for what you',
    'made or changed, not for every file. Its first line is what to draw, from the project root:',
    '  a component file ("src/components/PriceCard.tsx"), the default export, or "export: Name" on a line for another;',
    '  an .html file ("site/index.html"), with the files next to it;',
    '  a page on this computer\'s own dev server ("http://localhost:5173/pricing"; only localhost, and only once it runs).',
    'Then optionally "props: {…}" (JSON, on one line) for props that make the preview meaningful; the rest are filled',
    'in from the component\'s TypeScript props, so give real types rather than any. "css: src/index.css" bundles a',
    'stylesheet it needs (its global styles); "size: phone|tablet|desktop" sets how wide it is drawn.',
    'Callback props show as events when they fire. The project\'s packages must be installed for a component to draw.',
    'React (.tsx/.jsx), Vue (.vue) and Svelte (.svelte) components all work; Tailwind is built with the project\'s own',
    'setup, next/image, next/link, next/font and next/navigation have stand-ins, and so do SvelteKit\'s $lib, $app/* and public $env. A component that needs providers',
    '(router, theme, store, query client) draws inside preview-wrapper.tsx at the project root (or src/), a file that',
    'default-exports a component wrapping {children} in them; create it when a preview says it needs one ("wrap: path" picks another).',
    'The preview follows the file: when you change it, it redraws in place, so no new block is needed for each edit.',
  ].join('\n');
}
