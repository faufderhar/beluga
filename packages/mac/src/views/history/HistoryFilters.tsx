import { useEffect, useRef, useState } from 'react';
import type { HistoryFilters as Filters } from '@beluga/workspaces/history.js';
import { Icon } from '../../components/Icon.js';
import { Select, type SelectEntry } from '../../components/Select.js';
import { IconButton, cx } from '../../components/ui.js';
import { AuthorAvatar } from './HistoryList.js';
import { branchChoices } from './history-model.js';
import type { LogQuery } from './use-history.js';
import s from './history.module.css';

const SEARCH_DELAY_MS = 280;
const EVERYONE = '\u0000everyone';

/** History's filters: which branches, whose commits, and a path. */
export function HistoryFilters({ filters, query, onChange, compact, onRefresh, refreshing }: { filters: Filters | undefined; query: LogQuery; onChange: (q: LogQuery) => void; compact?: boolean; onRefresh?: () => void; refreshing?: boolean }) {
  const [path, setPath] = useState(query.path ?? '');
  // The latest query and handler (a branch picked while typing a path isn't undone by the delay).
  const latest = useRef({ query, onChange });
  latest.current = { query, onChange };
  useEffect(() => setPath(query.path ?? ''), [query.path]);
  useEffect(() => {
    if (path === (latest.current.query.path ?? '')) return;
    const t = setTimeout(() => latest.current.onChange({ ...latest.current.query, path: path.trim() || undefined } as LogQuery), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [path]);
  const ch = branchChoices(filters);
  const branchOptions: SelectEntry<string>[] = [
    ...ch.all.map((b) => ({ ...b, icon: b.value === 'all' ? ('branch' as const) : ('check' as const) })),
    ...(ch.local.length ? [{ section: 'Branches', options: ch.local.map((b) => ({ ...b, ...(b.value === filters?.current ? { badge: 'checked out' } : {}) })) }] : []),
    ...(ch.remote.length ? [{ section: 'Remote', options: ch.remote }] : []),
    ...(ch.tags.length ? [{ section: 'Tags', options: ch.tags }] : []),
  ];
  // An author picked before the list loaded still shows.
  const authors = filters?.authors ?? [];
  const authorOptions: SelectEntry<string>[] = [
    { value: EVERYONE, label: 'Everyone', icon: 'people' },
    ...(authors.length ? [{ section: 'People', options: authors.map((a) => ({ value: a.email || a.name, label: a.name, description: a.email, keywords: [a.email], badge: String(a.commits), icon: <AuthorAvatar name={a.name} email={a.email} size={16} /> })) }] : []),
    ...(query.author && !authors.some((a) => (a.email || a.name) === query.author) ? [{ value: query.author, label: query.author }] : []),
  ];
  return (
    <div className={cx(s.filters, compact && s.filtersCompact)} role="group" aria-label="Filter the history">
      <Select size="small" mono label="Branch" value={query.branch} options={branchOptions} onChange={(branch) => onChange({ ...query, branch })} searchPlaceholder="Find a branch or tag" />
      <Select size="small" label="Author" value={query.author ?? EVERYONE} options={authorOptions} onChange={(a) => onChange({ ...query, author: a === EVERYONE ? undefined : a } as LogQuery)} searchPlaceholder="Find a person" />
      <label className={s.search}>
        <Icon name="search" size={12} />
        <input className="selectable" type="search" aria-label="Path" placeholder={compact ? 'Path' : 'Path or file name'} value={path} spellCheck={false} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && path && (e.stopPropagation(), setPath(''))} />
      </label>
      {onRefresh ? <IconButton size="small" icon="refresh" label={refreshing ? 'Loading…' : 'Reload'} className={cx(refreshing && s.spinning)} onClick={onRefresh} /> : null}
    </div>
  );
}
