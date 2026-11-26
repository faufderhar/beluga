import { useEffect, useMemo, useState } from 'react';
import type { Excerpt } from '@beluga/workspaces/excerpt.js';
import { type CodeRef, langOf, parseCodeRef, refWindow } from '@beluga/shared/code-ref.js';
import { Icon } from '../Icon.js';
import { ActionsContext, type ActionItem } from '../SpecMenu.js';
import { Button, IconButton, Tip } from '../ui.js';
import { copyText } from '../../lib/copy.js';
import { toast, useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { quoteInBox } from '../../chat/message-menu.js';
import { goToCode } from '../../lib/go-to-code.js';
import { CodeLines } from './CodeLines.js';
import s from './code.module.css';
import { openCodeThere } from '../../lib/remote-open.js';

/** "src/a.ts:12-18" for lines `from`…`to`. */
export const where = (path: string, from?: number, to?: number): string => (from ? `${path}:${from}${to && to !== from ? `-${to}` : ''}` : path);

/** Picked line numbers as ranges: [12, 13, 14, 20] → "12-14, 20". */
function ranges(lines: readonly number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const n of [...lines].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/** The workspace a chat block's paths are in: the one whose conversation this is. */
function useWorkspaceHere(): string | undefined {
  return useApp((st) => (st.view.kind === 'workspace' ? st.view.id : undefined));
}

/**
 * A ```beluga-code block (shared/code-ref.ts): those lines of the worktree, read live, with the
 * highlighted ones marked. The path goes to the file at the first marked line (or your editor,
 * beside it); a click on line numbers picks lines (Shift for a range) to quote in your reply.
 */
export function CodeRefBlock({ code }: { code: string }) {
  const ref = useMemo(() => parseCodeRef(code), [code]);
  const wsId = useWorkspaceHere();
  if (!ref) return <pre className={s.refProblem}>{code}</pre>;
  return <CodeRefView ref_={ref} wsId={wsId} />;
}

export function CodeRefView({ ref_: ref, wsId }: { ref_: CodeRef; wsId: string | undefined }) {
  const api = useApi();
  const { client, ui } = useBeluga();
  const [excerpt, setExcerpt] = useState<Excerpt>();
  const [problem, setProblem] = useState<string>();
  const [picked, setPicked] = useState<number[]>([]);
  const [anchor, setAnchor] = useState<number>();
  const win = refWindow(ref);
  useEffect(() => {
    if (!wsId) {
      setProblem('Lines from a worktree show in its own conversation');
      return;
    }
    let alive = true;
    void api.workbench.excerpt(wsId, ref.path, win.from, win.to).then((out) => {
      if (!alive || !out) return;
      if (out.ok) {
        setExcerpt(out.excerpt);
        setProblem(undefined);
      } else setProblem(out.message);
    });
    return () => {
      alive = false;
    };
  }, [api, wsId, ref.path, win.from, win.to]);

  const marked = new Set(ref.highlight);
  const rows = excerpt?.lines.map((text, i) => ({ text, n: excerpt.from + i, marked: marked.has(excerpt.from + i) })) ?? [];
  const lang = langOf(ref.path);
  const first = ref.highlight[0] ?? excerpt?.from ?? ref.from;
  // The path goes straight to the file at that line, across the center; the editor is a button away.
  const goTo = (): void => {
    if (wsId) void goToCode(client, wsId, ref.path, first);
  };
  const open = (): void => {
    if (wsId) void openCodeThere(client, wsId, ref.path, first);
  };
  const lineText = (n: number): string => excerpt?.lines[n - excerpt.from] ?? '';
  const quote = (lines: readonly number[]): void => {
    const parts = ranges(lines).map(([a, b]) => {
      const body = Array.from({ length: b - a + 1 }, (_, i) => lineText(a + i)).join('\n');
      return `${where(ref.path, a, b)}\n\`\`\`${lang ?? ''}\n${body}\n\`\`\``;
    });
    quoteInBox(ui, parts.join('\n\n'));
    setPicked([]);
  };
  const pick = (n: number, range: boolean): void => {
    if (range && anchor !== undefined) {
      const [a, b] = [Math.min(anchor, n), Math.max(anchor, n)];
      setPicked(Array.from({ length: b - a + 1 }, (_, i) => a + i));
      return;
    }
    setAnchor(n);
    setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));
  };
  const say = (text: string): void => toast(client, text, 'success');
  const all = excerpt ? excerpt.lines.join('\n') : '';
  const items: ActionItem[] = [
    { label: 'Go to File', icon: 'file', disabled: !wsId, onSelect: goTo },
    { label: 'Open in Editor', icon: 'external', disabled: !wsId, onSelect: open },
    { label: 'Copy Code', icon: 'copy', separate: true, onSelect: () => void copyText(all).then(() => say('Copied the code')) },
    { label: 'Copy Path', onSelect: () => void copyText(where(ref.path, first)).then(() => say('Copied the path')) },
    { label: 'Quote in Reply', icon: 'chat', separate: true, disabled: !excerpt, onSelect: () => quote(excerpt ? rows.map((r) => r.n) : []) },
  ];
  return (
    <ActionsContext items={items}>
      <figure className={s.ref} data-code-ref={ref.path}>
        <figcaption className={s.refHead}>
          <Tip label={wsId ? 'Go to this line in the file' : ref.path}>
            <button type="button" className={s.refPath} data-go-to-code={ref.path} onClick={goTo} disabled={!wsId}>
              <Icon name="file" size={12} />
              <span>{ref.path}</span>
              {excerpt ? <em className={s.refLines}>{where('', excerpt.from, excerpt.to).slice(1)}</em> : null}
            </button>
          </Tip>
          <span className={s.grow} />
          <IconButton size="small" icon="copy" label="Copy the code" disabled={!excerpt} onClick={() => void copyText(all).then(() => say('Copied the code'))} />
          <IconButton size="small" icon="external" label="Open in Editor" disabled={!wsId} onClick={open} />
        </figcaption>
        {ref.note ? <div className={s.refNote}>{ref.note}</div> : null}
        {problem ? (
          <div className={s.refProblem}>
            <Icon name="info" size={11} /> {problem}
          </div>
        ) : excerpt ? (
          <div className={s.refBody}>
            <CodeLines rows={rows} {...(lang ? { lang } : {})} picked={new Set(picked)} onPick={pick} />
          </div>
        ) : (
          <div className={s.refProblem}>Reading {where(ref.path, win.from, win.to)}…</div>
        )}
        {picked.length ? (
          <div className={s.refPicked}>
            {picked.length === 1 ? `Line ${picked[0]}` : `${picked.length} lines`} picked
            <span className={s.grow} />
            <Button size="small" variant="quiet" onClick={() => setPicked([])}>
              Clear
            </Button>
            <Button size="small" icon="chat" onClick={() => quote(picked)}>
              Quote in Reply
            </Button>
          </div>
        ) : null}
      </figure>
    </ActionsContext>
  );
}
