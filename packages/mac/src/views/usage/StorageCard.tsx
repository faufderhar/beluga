import { formatBytes } from '@beluga/shared/format.js';
import { ProjectIcon } from '../../components/ProjectIcon.js';
import { IconButton, Tip, cx } from '../../components/ui.js';
import { Card, Shimmer, slotColor } from './parts.js';
import type { ProjectRow } from './usage-model.js';
import s from './usage.module.css';

/** Where a project's rows are in the breakdown below (its legend entry scrolls there). */
export const projectAnchor = (id: string): string => `usage-project-${id}`;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const reveal = (id: string): void => document.getElementById(projectAnchor(id))?.scrollIntoView({ behavior: 'smooth', block: 'start' });

/**
 * The space worktrees take, as one bar split by project (like macOS Storage), with a legend
 * that jumps to each project's rows.
 */
export function StorageCard({ rows, measuring, measured, onMeasure }: { rows: readonly ProjectRow[]; measuring: boolean; measured: boolean; onMeasure: () => void }) {
  const parts = rows.filter((r) => r.disk > 0).sort((a, b) => b.disk - a.disk);
  const total = parts.reduce((n, r) => n + r.disk, 0);
  const worktrees = rows.reduce((n, r) => n + r.rows.filter((w) => w.ws.kind === 'worktree').length + (r.agents?.count ?? 0), 0);
  const homes = rows.filter((r) => r.agents || r.rows.some((w) => w.ws.kind === 'worktree')).length;
  const waiting = !measured;
  return (
    <Card
      label="Disk space"
      className={s.storage}
      title="Disk space"
      aside={<IconButton size="small" icon="refresh" label={measuring ? 'Measuring…' : 'Measure Again'} className={cx(measuring && s.spinning)} disabled={measuring} onClick={onMeasure} />}
    >
      <div className={cx(s.hero, waiting && s.heroWaiting)}>
        {waiting ? <Shimmer wide /> : <span className={s.heroValue}>{formatBytes(total)}</span>}
        <span className={s.heroUnit}>in worktrees{worktrees ? ` · ${plural(worktrees, 'folder')} in ${plural(homes, 'project')}` : ''}</span>
      </div>
      <div className={cx(s.stack, waiting && s.stackWaiting)} role="group" aria-label="Disk space by project">
        {waiting ? null : parts.length ? (
          parts.map((r) => (
            <Tip key={r.project.id} label={`${r.project.root ? r.project.name : 'Chats'} · ${formatBytes(r.disk)} (${Math.round((r.disk / total) * 100)}%)`}>
              <button type="button" className={s.segment} style={{ flexGrow: r.disk, background: slotColor(r.slot) }} aria-label={`${r.project.root ? r.project.name : 'Chats'}: ${formatBytes(r.disk)}`} onClick={() => reveal(r.project.id)} />
            </Tip>
          ))
        ) : (
          <span className={s.stackEmpty} />
        )}
      </div>
      {parts.length && !waiting ? (
        <ul className={s.legend}>
          {parts.map((r) => (
            <li key={r.project.id}>
              <button type="button" className={s.legendItem} onClick={() => reveal(r.project.id)}>
                <span className={s.swatch} style={{ background: slotColor(r.slot) }} />
                {r.project.root ? <ProjectIcon id={r.project.id} name={r.project.name} size={14} /> : null}
                <span className={s.legendName}>{r.project.root ? r.project.name : 'Chats'}</span>
                <span className={s.legendValue}>{formatBytes(r.disk)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : !waiting ? (
        <p className={s.quiet}>No worktrees take space right now. Each new worktree is a folder of its own.</p>
      ) : null}
    </Card>
  );
}
