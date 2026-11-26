// `$NAME` in the words, where NAME is a variable this chat has (a key kept out of the chat,
// BLG-965): drawn as a key chip in the box and in sent messages. The words stay `$NAME`: that is
// what the agent reads, and what it uses in its commands. Plain data.

/** `$NAME` as written: a $ and a shell variable's name in capitals. */
const KEY_REF = /\$([A-Z_][A-Z0-9_]{1,63})(?![A-Za-z0-9_])/g;

export type KeyPiece = { readonly text: string } | { readonly raw: string; readonly name: string };

/** The words, with each `$NAME` this chat knows as its own piece. */
export function splitKeyRefs(text: string, names: ReadonlySet<string>): KeyPiece[] {
  if (!names.size || !text.includes('$')) return [{ text }];
  const out: KeyPiece[] = [];
  let last = 0;
  for (const m of text.matchAll(KEY_REF)) {
    const name = m[1]!;
    if (!names.has(name)) continue;
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ raw: m[0], name });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}

/** A key chip's link in a message's Markdown. */
export const KEY_LINK = 'beluga-key:';

/** Markdown with each known `$NAME` a link the message draws as a chip (code and links left alone). */
export function linkKeyRefs(markdown: string, names: ReadonlySet<string>): string {
  if (!names.size || !markdown.includes('$')) return markdown;
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      if (fenced || line.includes('`') || line.includes('](')) return line;
      return splitKeyRefs(line, names)
        .map((p) => ('name' in p ? `[${p.name}](${KEY_LINK}${p.name})` : p.text))
        .join('');
    })
    .join('\n');
}

/** Every name a chat's `$NAME` can mean: its own keys, then its project's and yours (kept for the project, they stay chips). */
export function knownKeyNames(
  keys: { readonly global: readonly string[]; readonly projects: Readonly<Record<string, { readonly keys: readonly string[] }>>; readonly worktrees?: Readonly<Record<string, readonly string[]>> },
  wsId: string | undefined,
  root: string | undefined,
): string[] {
  return [...new Set([...(wsId ? (keys.worktrees?.[wsId] ?? []) : []), ...(root ? (keys.projects[root]?.keys ?? []) : []), ...keys.global])];
}
