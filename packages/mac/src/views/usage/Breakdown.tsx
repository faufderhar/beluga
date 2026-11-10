import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import type { AppState } from '@beluga/core/store.js';
import { cacheHitPct, sessionCache } from '@beluga/shared/context-usage.js';
import { formatBytes } from '@beluga/shared/format.js';
import { activityOf, stateOf } from '@beluga/ui/workspace-models.js';
import { Icon } from '../../components/Icon.js';
import { ProjectIcon } from '../../components/ProjectIcon.js';
import { ActionsContext } from '../../components/SpecMenu.js';
import { Dot, IconButton, Segmented, cx } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { useBeluga } from '../../lib/beluga.js';
import { workspaceItems } from '../../layout/Sidebar.js';
import { Bar, Shimmer, slotColor } from './parts.js';
import { projectAnchor } from './StorageCard.js';
import { type ProjectRow, type SortKey, type WsRow, ago, compact, formatCost } from './usage-model.js';
import s from './usage.module.css';
import { revealLabel } from '../../lib/os-words.js';

const SORTS: ReadonlyArray<{ value: SortKey; label: string; hint: string }> = [
  { value: 'size', label: 'Size', hint: 'Biggest on disk first' },
  { value: 'tokens', label: 'Tokens', hint: 'Most agent tokens first' },
  { value: 'recent', label: 'Recent', hint: 'Most recently active first' },
];

interface Scale {
  readonly projectDisk: number;
  readonly projectTokens: number;
  readonly disk: number;
  readonly tokens: number;
}

const CLAUDE = 'var(--claude)';
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const stop = (e: MouseEvent): void => e.stopPropagation();

function Tokens({ tokens, cost, max, cache }: { tokens: number; cost: number; max: number; cache?: number }) {
  return (
    <span className={s.metric}>
      <Bar value={tokens} max={max} color={CLAUDE} />
      <span className={s.metricValue}>{tokens ? `${compact(tokens)} · ${formatCost(cost)}${cache !== undefined ? ` · cache ${cache}%` : ''}` : '–'}</span>
    </span>
  );
}

function Disk({ bytes, max, color, measured }: { bytes: number | undefined; max: number; color: string; measured: boolean }) {
  if (bytes === undefined && !measured) {
    return (
      <span className={s.metric}>
        <Shimmer />
      </span>
    );
  }
  return (
    <span className={s.metric}>
      <Bar value={bytes ?? 0} max={max} color={color} />
      <span className={s.metricValue}>{bytes ? formatBytes(bytes) : '–'}</span>
    </span>
  );
}

/** The last cell: when it was last active; on hover (or focus) the row's actions take its place. */
function Trailing({ when, children }: { when: string; children: ReactNode }) {
  return (
    <span role="cell" className={s.trailing}>
      <span className={s.when}>{when}</span>
      <span className={s.actions} onClick={stop}>
        {children}
      </span>
    </span>
  );
}

function Row({ r, state, scale, color, measured, now }: { r: WsRow; state: AppState; scale: Scale; color: string; measured: boolean; now: number }) {
  const actions = useActions();
  const { client } = useBeluga();
  const w = r.ws;
  const st = stateOf(state, w, 0, now);
  const running = activityOf(state.log, `ws:${w.id}`).running;
  const open = (): void => actions.run({ type: 'open_ws', id: w.id });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && e.target === e.currentTarget) open();
  };
  const main = w.kind === 'main';
  return (
    <ActionsContext items={() => workspaceItems(client.store.getState(), w, actions.run, client)}>
      <div role="row" tabIndex={0} aria-label={main ? 'Main folder' : w.name} className={s.row} onClick={open} onKeyDown={onKey}>
        <span role="cell" className={s.nameCell}>
          <span className={s.kind}>
            <Icon name={w.kind === 'chat' ? 'chat' : main ? 'folder' : 'branch'} size={14} />
          </span>
          <span className={s.nameText}>
            <span className={s.wsName}>{main ? 'Main folder' : w.name}</span>
            <span className={cx(s.sub, s[`tone_${st.tone}`])}>
              <Dot tone={st.tone === 'muted' ? 'muted' : st.tone} live={running} />
              <span className={s.subText}>
                {st.label}
                {w.branch && !main ? <span className={s.branch}> · {w.branch}</span> : null}
              </span>
            </span>
          </span>
        </span>
        <span role="cell">
          {main ? (
            <span className={s.metric} title="The project itself: not counted with its worktrees">
              <span className={s.mainNote}>Project</span>
              <span className={cx(s.metricValue, s.muted)}>{r.disk ? formatBytes(r.disk) : '–'}</span>
            </span>
          ) : w.kind === 'chat' && w.projectRoot ? (
            <span className={s.metric}>
              <span className={s.mainNote}>In the main folder</span>
            </span>
          ) : (
            <Disk bytes={r.disk} max={scale.disk} color={color} measured={measured} />
          )}
        </span>
        <span role="cell">
          <Tokens tokens={r.tokens} cost={r.cost} max={scale.tokens} cache={cacheHitPct(sessionCache(r.ws.usage))} />
        </span>
        <Trailing when={r.lastActive ? ago(r.lastActive, now) : ''}>
          {r.archivable ? <IconButton icon="archive" label={`Archive ${w.name}…`} onClick={() => actions.run({ type: 'ws', id: w.id, action: 'archive' })} /> : null}
          <IconButton icon="folder" label={revealLabel()} onClick={() => actions.run({ type: 'ws', id: w.id, action: 'finder' })} />
          <IconButton icon="forward" label={`Open ${w.name}`} onClick={open} />
        </Trailing>
      </div>
    </ActionsContext>
  );
}

function AgentsRow({ p, scale, color }: { p: ProjectRow; scale: Scale; color: string }) {
  const { ui } = useBeluga();
  const agents = p.agents!;
  const clean = (): void => ui.openMenu({ kind: 'agents', projectId: p.project.id });
  return (
    <div role="row" tabIndex={0} aria-label="Sub-agent worktrees" className={s.row} onClick={clean} onKeyDown={(e) => e.key === 'Enter' && clean()}>
      <span role="cell" className={s.nameCell}>
        <span className={s.kind}>
          <Icon name="claude" size={14} />
        </span>
        <span className={s.nameText}>
          <span className={s.wsName}>Sub-agent worktrees</span>
          <span className={cx(s.sub, s.tone_muted)}>
            <span className={s.subText}>
              {agents.count} left by Claude Code · {agents.clean === agents.count ? 'all' : agents.clean} safe to remove
            </span>
          </span>
        </span>
      </span>
      <span role="cell">
        <Disk bytes={agents.disk} max={scale.disk} color={color} measured />
      </span>
      <span role="cell" />
      <Trailing when="">
        <IconButton icon="archive" label="Clean Up Sub-agent Worktrees…" onClick={clean} />
      </Trailing>
    </div>
  );
}

function ProjectHead({ p, scale, color, now }: { p: ProjectRow; scale: Scale; color: string; now: number }) {
  const actions = useActions();
  const main = p.rows.find((r) => r.ws.kind === 'main')?.ws;
  const worktrees = p.rows.filter((r) => r.ws.kind === 'worktree').length + (p.agents?.count ?? 0);
  const chats = p.rows.filter((r) => r.ws.kind === 'chat').length;
  const what = [worktrees ? plural(worktrees, 'worktree') : '', chats ? plural(chats, 'chat') : ''].filter(Boolean).join(' · ') || 'Main folder only';
  return (
    <div role="row" className={s.projectRow}>
      <span role="rowheader" className={s.nameCell}>
        {p.project.root ? <ProjectIcon id={p.project.id} name={p.project.name} size={22} /> : <span className={s.chatsIcon}><Icon name="chat" size={14} /></span>}
        <span className={s.nameText}>
          <span className={s.projectName}>{p.project.root ? p.project.name : 'Chats'}</span>
          <span className={s.sub}>
            <span className={s.swatch} style={{ background: color }} />
            {what}
          </span>
        </span>
      </span>
      <span role="cell">
        <span className={s.metric}>
          <Bar value={p.disk} max={scale.projectDisk} color={color} />
          <span className={cx(s.metricValue, s.strong)}>{p.disk ? formatBytes(p.disk) : '–'}</span>
        </span>
      </span>
      <span role="cell">
        <span className={s.metric}>
          <Bar value={p.tokens} max={scale.projectTokens} color={CLAUDE} />
          <span className={cx(s.metricValue, s.strong)}>{p.tokens ? `${compact(p.tokens)} · ${formatCost(p.cost)}` : '–'}</span>
        </span>
      </span>
      <Trailing when={p.lastActive ? ago(p.lastActive, now) : ''}>
        {main ? <IconButton icon="folder" label={revealLabel(p.project.name)} onClick={() => actions.run({ type: 'ws', id: main.id, action: 'finder' })} /> : null}
      </Trailing>
    </div>
  );
}

/** Every project and its worktrees and chats: disk and Claude side by side, sortable, with actions on each row. */
export function Breakdown({ state, rows, sort, onSort, measured, now }: { state: AppState; rows: readonly ProjectRow[]; sort: SortKey; onSort: (s: SortKey) => void; measured: boolean; now: number }) {
  const all = rows.flatMap((p) => p.rows);
  const scale: Scale = {
    projectDisk: Math.max(1, ...rows.map((p) => p.disk)),
    projectTokens: Math.max(1, ...rows.map((p) => p.tokens)),
    disk: Math.max(1, ...all.filter((r) => r.ws.kind !== 'main').map((r) => r.disk ?? 0), ...rows.map((p) => p.agents?.disk ?? 0)),
    tokens: Math.max(1, ...all.map((r) => r.tokens)),
  };
  return (
    <section className={s.breakdown} aria-label="By project">
      <header className={s.breakdownHead}>
        <h2 className={s.sectionTitle}>By project</h2>
        <Segmented label="Sort by" value={sort} options={SORTS} onChange={onSort} />
      </header>
      <div role="table" aria-label="Disk and agent usage by workspace" className={s.table}>
        <div role="row" className={s.columnsHead}>
          <span role="columnheader">Name</span>
          <span role="columnheader">Disk</span>
          <span role="columnheader">Agent</span>
          <span role="columnheader" className={s.when}>
            Last active
          </span>
        </div>
        {rows.map((p) => {
          const color = slotColor(p.slot);
          return (
            <div role="rowgroup" key={p.project.id} id={projectAnchor(p.project.id)} className={s.group}>
              <ProjectHead p={p} scale={scale} color={color} now={now} />
              {p.rows.map((r) => (
                <Row key={r.ws.id} r={r} state={state} scale={scale} color={color} measured={measured} now={now} />
              ))}
              {p.agents ? <AgentsRow p={p} scale={scale} color={color} /> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
