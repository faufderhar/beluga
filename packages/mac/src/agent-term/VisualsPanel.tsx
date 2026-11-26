import { useEffect, useState } from 'react';
import { findIssue } from '@beluga/core/board/model.js';
import { TASKS_FENCE } from '@beluga/shared/task-refs.js';
import type { TermVisual } from '@beluga/shared/term-visuals.js';
import { Markdown } from '../chat/Markdown.js';
import { Icon, type IconName } from '../components/Icon.js';
import { IconButton, cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import s from './agent-term.module.css';

/** One thing open beside the terminal: a visual it showed, or a task it named. */
export type Opened = { readonly kind: 'visual'; readonly n: number } | { readonly kind: 'task'; readonly key: string } | { readonly kind: 'image'; readonly path: string };

export const openedId = (o: Opened): string => (o.kind === 'visual' ? `v${o.n}` : o.kind === 'task' ? `t:${o.key}` : `i:${o.path}`);

const ICONS: Record<string, IconName> = { graph: 'graph', table: 'table', chart: 'chartLine', stats: 'gauge', code: 'file', colors: 'palette', gantt: 'gantt', heatmap: 'heat', calendar: 'calendar', tasks: 'task', source: 'file', comments: 'chat', diagram: 'graph', image: 'image', block: 'file' };

/** A visual's block, fetched once per conversation and kept while the view is open. */
const blocks = new Map<string, string | null>();

function VisualBody({ wsId, n }: { readonly wsId: string; readonly n: number }) {
  const api = useApi();
  const id = `${wsId}#${n}`;
  const [block, setBlock] = useState<string | null | undefined>(blocks.get(id));
  useEffect(() => {
    if (blocks.has(id)) return setBlock(blocks.get(id));
    let gone = false;
    void api.agentTerm
      .visual(wsId, n)
      .then((b) => {
        const got = typeof b === 'string' ? b : null;
        blocks.set(id, got);
        if (!gone) setBlock(got);
      })
      .catch(() => !gone && setBlock(null));
    return () => {
      gone = true;
    };
  }, [id]);
  if (block === undefined) return <div className={s.visualLoading} />;
  if (block === null) return <p className={s.visualGone}>This visual isn’t kept any more.</p>;
  return <Markdown text={block} tasks paths localImages />;
}

/**
 * The panel beside the terminal (BLG-535): what its links opened, a tab each, drawn as the chat
 * draws them (a graph you can walk through, a table you can sort and filter). Esc closes it and
 * gives the terminal the keyboard back.
 */
export function VisualsPanel({ wsId, opened, active, onPick, onClose, onCloseAll }: { readonly wsId: string; readonly opened: readonly Opened[]; readonly active: string; readonly onPick: (id: string) => void; readonly onClose: (id: string) => void; readonly onCloseAll: () => void }) {
  const visuals = useApp((st) => st.termVisuals[wsId]);
  const board = useApp((st) => st.board);
  const about = (o: Opened): { title: string; icon: IconName } => {
    if (o.kind === 'task') return { title: o.key, icon: 'task' };
    if (o.kind === 'image') return { title: o.path.split('/').pop() ?? 'Picture', icon: 'image' };
    const v: TermVisual | undefined = visuals?.find((x) => x.n === o.n);
    return { title: v?.title ?? `Visual ${o.n}`, icon: ICONS[v?.kind ?? 'table'] ?? 'table' };
  };
  const current = opened.find((o) => openedId(o) === active) ?? opened[opened.length - 1];
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      // Escape in a field, a menu or a dialog is theirs; in the terminal, the program's.
      if (t?.closest('.xterm, input, textarea, select, [role="dialog"], [role="menu"]')) return;
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"]')) return;
      e.preventDefault();
      onCloseAll();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCloseAll]);
  return (
    <section className={s.visuals} aria-label="Visuals">
      <div className={s.visualTabs} role="tablist" aria-label="Opened from the terminal">
        {opened.map((o) => {
          const id = openedId(o);
          const { title, icon } = about(o);
          const on = current !== undefined && openedId(current) === id;
          return (
            <div key={id} className={cx(s.visualTab, on && s.visualTabOn)}>
              <button type="button" role="tab" aria-selected={on} className={s.visualTabPick} onClick={() => onPick(id)} title={title}>
                <Icon name={icon} size={12} />
                <span className={s.visualTabTitle}>{title}</span>
              </button>
              <button type="button" className={s.visualTabClose} aria-label={`Close ${title}`} onClick={() => onClose(id)}>
                <Icon name="x" size={10} />
              </button>
            </div>
          );
        })}
        <span className={s.flex} />
        <IconButton size="small" icon="x" label="Close the Panel" keys="Esc" onClick={onCloseAll} />
      </div>
      <div className={s.visualBody} role="tabpanel">
        {current?.kind === 'visual' ? <VisualBody key={openedId(current)} wsId={wsId} n={current.n} /> : current?.kind === 'image' ? <Markdown text={`![${current.path.split('/').pop() ?? 'Picture'}](<${current.path}>)`} paths localImages /> : current?.kind === 'task' ? findIssue(board, current.key) ? <Markdown text={'```' + TASKS_FENCE + '\n' + current.key + '\n```'} tasks /> : <p className={s.visualGone}>{current.key} isn’t on your board.</p> : null}
      </div>
    </section>
  );
}
