import { useMemo } from 'react';
import { type RichFence, richFence } from '@beluga/shared/render/rich-fence.js';
import { FileTree } from './FileTree.js';
import { JsonTree } from './JsonTree.js';
import { Terminal } from './Terminal.js';

/** What a fenced block really is (shared/render/rich-fence.ts), read once per text. */
export function useRichFence(lang: string | undefined, code: string): RichFence | undefined {
  return useMemo(() => richFence(lang, code), [lang, code]);
}

/** A tree, JSON or terminal block; null for the kinds each place draws its own way (math, mermaid). */
export function RichBlock({ fence, code, lang, onQuote, onRun }: { fence: RichFence; code: string; lang?: string | undefined; onQuote?: ((fence: string) => void) | undefined; onRun?: ((command: string) => void) | undefined }) {
  switch (fence.kind) {
    case 'tree':
      return <FileTree tree={fence.tree} code={code} onQuote={onQuote} />;
    case 'json':
      return <JsonTree doc={fence.doc} code={code} onQuote={onQuote} />;
    case 'terminal':
      return <Terminal code={code} lang={lang} onQuote={onQuote} onRun={onRun} />;
    default:
      return null;
  }
}
