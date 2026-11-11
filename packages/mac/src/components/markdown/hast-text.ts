type HastLike = { readonly type: string; readonly value?: string; readonly children?: readonly HastLike[] };

/** The text an element holds, however deep (HTML's `<code><span>…</span></code>` included). */
export function hastText(node: HastLike | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}
