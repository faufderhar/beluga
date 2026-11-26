import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { type NativeRow, nativeDropdown } from '../../lib/native-menu.js';
import { type KeyboardEvent, type ReactNode, type Ref } from 'react';
import type { Project } from '@beluga/workspaces/types.js';
import { Icon } from '../../components/Icon.js';
import { ProjectIcon } from '../../components/ProjectIcon.js';
import { ActionsDropdown, FitContent } from '../../components/SpecMenu.js';
import { Tip, cx } from '../../components/ui.js';
import menu from '../../components/SpecMenu.module.css';
import { FILTERS, FILTER_LABELS, type OverviewFilter, type OverviewSort, SORTS, SORT_LABELS } from './overview-model.js';
import s from './filter-bar.module.css';
import { chordLabel } from '../../lib/shortcuts-model.js';

const FILTER_HINTS: Record<OverviewFilter, string> = {
  all: 'Everything, archived included',
  active: 'Worktrees and chats you can work in',
  needs: 'Approvals, merge conflicts and failing checks',
  ready: 'Committed work that isn’t in main yet',
  archived: 'Put away: the branch and conversation are kept, ready to restore',
};

const SORT_HINTS: Record<OverviewSort, string> = {
  recent: 'What needs you first, then the latest',
  name: 'A to Z',
  size: 'Biggest on disk first',
};

export interface FilterBarProps {
  readonly filter: OverviewFilter;
  readonly counts: Readonly<Record<OverviewFilter, number>>;
  readonly onFilter: (f: OverviewFilter) => void;
  readonly search: string;
  readonly onSearch: (text: string) => void;
  readonly searchRef: Ref<HTMLInputElement>;
  /** Esc in an empty search field, or ↓: on to the list. */
  readonly onLeaveSearch: () => void;
  readonly sort: OverviewSort;
  readonly onSort: (s: OverviewSort) => void;
  readonly projects: readonly Project[];
  readonly project: Project | undefined;
  readonly onProject: (id: string | undefined) => void;
}

/** Above the Overview: the segments (with counts), the project, the sort, and the search. */
export function FilterBar(props: FilterBarProps) {
  return (
    <div className={s.bar}>
      <Segments filter={props.filter} counts={props.counts} onFilter={props.onFilter} />
      <span className={s.flex} />
      <ProjectPopup projects={props.projects} project={props.project} onProject={props.onProject} />
      <SortPopup sort={props.sort} onSort={props.onSort} />
      <SearchField search={props.search} onSearch={props.onSearch} searchRef={props.searchRef} onLeave={props.onLeaveSearch} />
    </div>
  );
}

/** Like NSSegmentedControl, each segment with its count; ← → move between them. */
function Segments({ filter, counts, onFilter }: Pick<FilterBarProps, 'filter' | 'counts' | 'onFilter'>) {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const at = FILTERS.indexOf(filter) + (e.key === 'ArrowRight' ? 1 : -1);
    const next = FILTERS[(at + FILTERS.length) % FILTERS.length]!;
    onFilter(next);
    (e.currentTarget.querySelector(`[data-filter="${next}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className={s.segmented} role="tablist" aria-label="Show" onKeyDown={onKey}>
      {FILTERS.map((f) => {
        const on = f === filter;
        return (
          <Tip key={f} label={FILTER_HINTS[f]}>
            <button
              type="button"
              role="tab"
              data-filter={f}
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              aria-label={`${FILTER_LABELS[f]}, ${counts[f]}`}
              className={cx(s.segment, on && s.segmentOn, f === 'needs' && counts.needs > 0 && s.segmentUrgent)}
              onClick={() => onFilter(f)}
            >
              {FILTER_LABELS[f]}
              <span className={s.count}>{counts[f]}</span>
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

function SortPopup({ sort, onSort }: Pick<FilterBarProps, 'sort' | 'onSort'>) {
  const items = SORTS.map((x) => ({ label: SORT_LABELS[x], hint: SORT_HINTS[x], checked: x === sort, onSelect: () => onSort(x) }));
  return (
    <ActionsDropdown items={items}>
      <button type="button" className={s.popup} aria-label={`Sort by ${SORT_LABELS[sort]}`}>
        <span className={s.popupDim}>Sort:</span> {SORT_LABELS[sort]}
        <Icon name="chevronDown" size={10} className={s.chevron} />
      </button>
    </ActionsDropdown>
  );
}

/** Which project: all of them, or one (by its icon, like apps in the Dock). */
function ProjectPopup({ projects, project, onProject }: Pick<FilterBarProps, 'projects' | 'project' | 'onProject'>) {
  const row = (key: string, checked: boolean, icon: ReactNode, label: string, pick: () => void) => (
    <Dropdown.Item key={key} className={menu.item} onSelect={pick}>
      <span className={menu.line}>
        <span className={menu.icon}>{checked ? <Icon name="check" size={12} /> : null}</span>
        <span className={s.menuIcon}>{icon}</span>
        <span className={menu.label}>{label}</span>
      </span>
    </Dropdown.Item>
  );
  const name = (p: Project): string => (p.root ? p.name : 'Chats');
  const iconOf = (p: Project, size: number) => (p.root ? <ProjectIcon id={p.id} name={p.name} size={size} /> : <Icon name="chat" size={size - 2} />);
  // The Mac's own menu in the app (lib/native-menu.ts), each project by its icon.
  const nativeRows = (): NativeRow[] => [
    { label: 'All Projects', icon: 'grid', ...(!project ? { checked: true } : {}), onSelect: () => onProject(undefined) },
    ...projects.map((p, i): NativeRow => ({ label: name(p), mark: iconOf(p, 16), ...(project?.id === p.id ? { checked: true } : {}), ...(i === 0 ? { separate: true } : {}), onSelect: () => onProject(p.id) })),
  ];
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild {...nativeDropdown(nativeRows)}>
        <button type="button" className={s.popup} aria-label={`Project: ${project ? name(project) : 'All Projects'}`}>
          {project ? iconOf(project, 14) : <Icon name="grid" size={12} />}
          <span className={s.popupText}>{project ? name(project) : 'All Projects'}</span>
          <Icon name="chevronDown" size={10} className={s.chevron} />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <FitContent className={menu.menu} align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
          {row('all', !project, <Icon name="grid" size={13} />, 'All Projects', () => onProject(undefined))}
          {projects.length ? <Dropdown.Separator className={menu.separator} /> : null}
          {projects.map((p) => row(p.id, project?.id === p.id, iconOf(p, 16), name(p), () => onProject(p.id)))}
        </FitContent>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** A Mac search field: Esc clears it (then leaves it), ↓ goes to the first row. */
function SearchField({ search, onSearch, searchRef, onLeave }: { search: string; onSearch: (t: string) => void; searchRef: Ref<HTMLInputElement>; onLeave: () => void }) {
  return (
    <label className={s.field} title={`Search names, branches, projects and last messages (${chordLabel('Cmd+F')})`}>
      <Icon name="search" size={12} />
      <input
        ref={searchRef}
        className={s.input}
        type="text"
        role="searchbox"
        aria-label="Search workspaces"
        placeholder="Search"
        spellCheck={false}
        autoComplete="off"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (search) onSearch('');
            else onLeave();
          } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
            e.preventDefault();
            onLeave();
          }
        }}
      />
      {search ? (
        <button type="button" className={s.clear} aria-label="Clear search" onClick={() => onSearch('')}>
          <Icon name="x" size={8} strokeWidth={2.4} />
        </button>
      ) : null}
    </label>
  );
}
