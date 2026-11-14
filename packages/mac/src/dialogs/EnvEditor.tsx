import { useEffect, useRef, useState } from 'react';
import type { EnvScope, InheritedVar } from '@beluga/core/env-vars.js';
import { type EnvVar, envProblems, importEnv, parseEnvText } from '@beluga/shared/env-vars.js';
import { Icon } from '../components/Icon.js';
import { Button, Tip, cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { copyText } from '../lib/copy.js';
import { Group, Switch } from './settings-controls.js';
import { ExampleNote, ImportBox, Lent, tagOf } from './EnvRows.js';
import e from './env-settings.module.css';

interface EnvRow extends EnvVar {
  readonly id: number;
}

let nextId = 1;
const withIds = (vars: readonly EnvVar[]): EnvRow[] => vars.map((v) => ({ ...v, id: nextId++ }));
const filled = (rows: readonly EnvVar[]): EnvVar[] => rows.filter((r) => r.key || r.value).map(({ key, value }) => ({ key, value }));
export const envErrorText = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Bad arguments for env\.\w+: /, '') : String(err));

/** A list this long gets a search box. */
const SEARCH_FROM = 10;

type Status = { kind: 'idle' } | { kind: 'saved' } | { kind: 'error'; text: string } | { kind: 'removed'; row: EnvRow; index: number };

/** One row of the list: one of yours here, or one lent from below that typing over sets here. */
type Listed = { kind: 'own'; row: EnvRow; index: number; below?: InheritedVar } | { kind: 'lent'; item: InheritedVar } | { kind: 'needed'; key: string };

/** Where an editor edits: your variables (no project), a project's, or a worktree's (BLG-924). */
export interface EnvPlaceProps {
  readonly projectId: string;
  readonly worktreeId?: string;
}

/**
 * The key/value editor for one place: yours, a project's, or a worktree's. Changes save as you
 * leave a field. What the place gets from below shows greyed in the same list, each marked where
 * it comes from (the .env, Everywhere, the project), and typing over one sets it here, which wins;
 * the arrow beside it takes that back (BLG-369, BLG-926). Names .env.example asks for that nothing
 * sets show empty, to fill in.
 */
export function EnvEditor({ projectId, worktreeId }: EnvPlaceProps) {
  const api = useApi();
  const project = useApp((st) => st.projects.find((p) => p.id === projectId));
  const keysHere = useApp((st) => (worktreeId ? st.envKeys.worktrees?.[worktreeId] : project ? st.envKeys.projects[project.root] : st.envKeys.global));
  const [rows, setRows] = useState<EnvRow[] | undefined>(undefined);
  const [scope, setScope] = useState<EnvScope | undefined>(undefined);
  const [dotenv, setDotenv] = useState(false);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [focusId, setFocusId] = useState<{ id: number; field: 'key' | 'value'; caret?: number } | undefined>(undefined);
  const [reload, setReload] = useState(0);
  const saved = useRef('');
  const editing = useRef(false);

  // Load the values (only this screen gets them), and again if another screen changes them.
  useEffect(() => {
    if (editing.current) return;
    let live = true;
    const load = worktreeId ? api.env.worktree(worktreeId) : api.env.get(projectId || undefined);
    void load.then((next) => {
      if (!live) return;
      saved.current = JSON.stringify([filled(next.vars), next.dotenv]);
      setRows(withIds(next.vars));
      setScope(next);
      setDotenv(next.dotenv);
    });
    return () => void (live = false);
  }, [projectId, worktreeId, keysHere, reload]);

  const problems = envProblems(rows ?? []);
  const commit = (next: readonly EnvRow[], nextDotenv = dotenv): void => {
    editing.current = false;
    if (envProblems(next).size) return setStatus({ kind: 'error', text: 'Fix the highlighted names to save' });
    const snapshot = JSON.stringify([filled(next), nextDotenv]);
    if (snapshot === saved.current) return;
    const saving = worktreeId ? api.env.setWorktree(worktreeId, filled(next)) : api.env.set(projectId || undefined, filled(next), projectId ? nextDotenv : undefined);
    saving.then(
      () => {
        saved.current = snapshot;
        setStatus((s) => (s.kind === 'removed' ? s : { kind: 'saved' }));
      },
      (err: unknown) => setStatus({ kind: 'error', text: envErrorText(err) }),
    );
  };
  const change = (id: number, patch: Partial<EnvVar>): void => {
    editing.current = true;
    setStatus({ kind: 'idle' });
    setRows((rs) => rs?.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const add = (): void => {
    const row = withIds([{ key: '', value: '' }])[0]!;
    setQuery('');
    setRows((rs) => [...(rs ?? []), row]);
    setFocusId({ id: row.id, field: 'key' });
  };
  // Typing over one from below: it's set here from now on (and wins), the caret kept where you type.
  const override = (key: string, value: string, caret: number | null): void => {
    const row = withIds([{ key, value }])[0]!;
    editing.current = true;
    setStatus({ kind: 'idle' });
    setRows((rs) => [...(rs ?? []), row]);
    setFocusId({ id: row.id, field: 'value', ...(caret !== null ? { caret } : {}) });
  };
  const addAll = (vars: readonly EnvVar[]): void => {
    const next = importEnv(rows ?? [], vars);
    const known = new Map((rows ?? []).map((r) => [r.key, r.id]));
    const merged = next.map((v) => ({ ...v, id: known.get(v.key) ?? nextId++ }));
    setRows(merged);
    setImporting(false);
    commit(merged);
  };
  // Removed at once, with Undo beside the status until the next change.
  const remove = (id: number, undoable = true): void => {
    const index = (rows ?? []).findIndex((r) => r.id === id);
    const row = rows?.[index];
    const next = (rows ?? []).filter((r) => r.id !== id);
    setRows(next);
    if (row && undoable && (row.key || row.value)) setStatus({ kind: 'removed', row, index });
    commit(next);
  };
  const undo = (): void => {
    if (status.kind !== 'removed') return;
    const next = [...(rows ?? [])];
    next.splice(Math.min(status.index, next.length), 0, status.row);
    setRows(next);
    setStatus({ kind: 'idle' });
    commit(next);
  };
  const setDotenvOn = (on: boolean): void => {
    setDotenv(on);
    if (rows) commit(rows, on);
  };

  // Closing the sheet (or switching place) mid-edit saves it too: a field left without a blur isn't lost.
  const saveOnClose = useRef<() => void>(() => undefined);
  saveOnClose.current = () => {
    if (editing.current && rows) commit(rows);
  };
  useEffect(() => () => saveOnClose.current(), []);

  if (!rows || !scope) return <div className={e.empty}>Loading…</div>;
  const filesLabel = scope.dotenvFiles?.length ? scope.dotenvFiles.join(' and ') : '.env';
  const listed = listRows(rows, scope, Boolean(projectId && !worktreeId && dotenv), filesLabel);
  const total = listed.length;
  const q = query.trim().toLowerCase();
  const visible = q ? listed.filter((x) => (x.kind === 'own' ? !x.row.key || x.row.key.toLowerCase().includes(q) : (x.kind === 'lent' ? x.item.key : x.key).toLowerCase().includes(q))) : listed;
  const isShown = (key: string, id?: number): boolean => showAll || shown.has(id === undefined ? `k:${key}` : `r:${id}`);
  const toggle = (tag: string): void => setShown((set) => (set.has(tag) ? new Set([...set].filter((x) => x !== tag)) : new Set([...set, tag])));
  const copy = (value: string): void => void copyText(value).then(() => setStatus({ kind: 'saved' }));

  return (
    <Group>
      {projectId && !worktreeId ? (
        <div className={e.sourceBar}>
          <Icon name="file" size={12} className={e.sourceIcon} />
          <span className={e.sourceText}>
            Use the main folder’s {filesLabel}
            {dotenv ? <span className={e.muted}> · {scope.dotenvKeys.length || 'none yet'}</span> : null}
          </span>
          <Switch label="Use the main folder's .env" on={dotenv} onChange={setDotenvOn} />
        </div>
      ) : null}
      {total > SEARCH_FROM ? (
        <div className={e.searchBar}>
          <Icon name="search" size={12} className={e.sourceIcon} />
          <input className={e.search} type="search" aria-label="Find a variable" placeholder={`Find among ${total}`} value={query} spellCheck={false} onChange={(ev) => setQuery(ev.target.value)} />
        </div>
      ) : null}
      <div className={e.head}>
        <span>Name</span>
        <span>Value</span>
        <Tip label={showAll ? 'Hide the values' : 'Show the values'}>
          <button type="button" className={cx(e.eye, showAll && e.eyeOn)} aria-label="Show values" aria-pressed={showAll} onClick={() => setShowAll(!showAll)}>
            <Icon name="eye" size={13} />
          </button>
        </Tip>
        <span />
      </div>
      {total ? null : <div className={e.empty}>{emptyText(projectId, worktreeId)}</div>}
      {q && !visible.length ? <div className={e.empty}>Nothing called “{query.trim()}”.</div> : null}
      {visible.map((item) => {
        if (item.kind !== 'own') {
          const key = item.kind === 'lent' ? item.item.key : item.key;
          return <Lent key={`${item.kind}:${key}`} item={item.kind === 'lent' ? item.item : { key, value: '', from: scope.example?.file ?? '.env.example' }} needed={item.kind === 'needed'} hidden={!isShown(key)} canToggle={!showAll} onToggle={() => toggle(`k:${key}`)} onType={(value, caret) => override(key, value, caret)} onCopy={copy} />;
        }
        const { row: r, index: i, below } = item;
        const masked = !isShown(r.key, r.id);
        // Set here over what comes from below: marked changed (with a way back) only when the value differs.
        const changed = Boolean(below && below.value !== r.value);
        return (
          <div key={r.id} className={cx(e.row, problems.has(i) && e.bad, changed && e.changed)}>
            <input
              className={cx(e.key, below && e.fixedKey)}
              aria-label="Name"
              aria-invalid={problems.has(i)}
              value={r.key}
              placeholder="NAME"
              spellCheck={false}
              autoComplete="off"
              readOnly={Boolean(below)}
              tabIndex={below ? -1 : undefined}
              autoFocus={focusId?.id === r.id && focusId.field === 'key'}
              onChange={(ev) => change(r.id, { key: ev.target.value.trim() })}
              onBlur={() => commit(rows)}
              onPaste={(ev) => {
                const text = ev.clipboardData.getData('text');
                const pasted = /[=\n]/.test(text) ? parseEnvText(text).vars : [];
                if (!pasted.length) return;
                ev.preventDefault();
                addAll(pasted);
              }}
            />
            <span className={e.valueCell}>
              <input
                className={cx(e.value, masked && r.value && e.masked)}
                aria-label={`Value of ${r.key || 'the new variable'}`}
                value={r.value}
                placeholder="value"
                spellCheck={false}
                autoComplete="off"
                autoFocus={focusId?.id === r.id && focusId.field === 'value'}
                onFocus={(ev) => {
                  if (focusId?.id !== r.id || focusId.field !== 'value') return;
                  const at = focusId.caret ?? ev.currentTarget.value.length;
                  ev.currentTarget.setSelectionRange(at, at);
                  setFocusId(undefined);
                }}
                onChange={(ev) => change(r.id, { value: ev.target.value })}
                onBlur={() => commit(rows)}
              />
              {r.value ? (
                <Tip label={`Copy ${r.key || 'the value'}`}>
                  <button type="button" className={e.copy} aria-label={`Copy ${r.key || 'the value'}`} onClick={() => copy(r.value)}>
                    <Icon name="copy" size={11} />
                  </button>
                </Tip>
              ) : null}
            </span>
            <button type="button" className={cx(e.eye, !masked && e.eyeOn)} aria-label={masked ? `Show ${r.key || 'value'}` : `Hide ${r.key || 'value'}`} aria-pressed={!masked} disabled={showAll} onClick={() => toggle(`r:${r.id}`)}>
              <Icon name="eye" size={13} />
            </button>
            {below && changed ? (
              <Tip label={below.from.startsWith('.env') ? 'Changed here. Click for the .env value (the file stays as it is)' : `Changed here. Click for ${fromWords(below.from)} value`}>
                <button type="button" className={e.reset} aria-label={`Use ${below.from} for ${r.key}`} onClick={() => remove(r.id, false)}>
                  <Icon name="refresh" size={11} />
                </button>
              </Tip>
            ) : below ? (
              <Tip label={`Same as ${fromWords(below.from)} value, kept in Beluga too`}>
                <span className={e.sourceTag}>{tagOf(below.from)}</span>
              </Tip>
            ) : (
              <button type="button" className={e.remove} aria-label={`Remove ${r.key || 'this row'}`} onClick={() => remove(r.id)}>
                <Icon name="x" size={10} />
              </button>
            )}
            {problems.has(i) ? <div className={e.problem}>{problems.get(i)}</div> : null}
            {!problems.has(i) && scope.overridden?.[r.key]?.length ? (
              <div className={e.override}>
                Not used in {scope.overridden[r.key]!.join(', ')}: {scope.overridden[r.key]!.length > 1 ? 'they set' : 'it sets'} {r.key} too, and that wins. Change it there.
              </div>
            ) : null}
          </div>
        );
      })}
      {importing ? <ImportBox onImport={addAll} onClose={() => setImporting(false)} /> : null}
      {projectId && !worktreeId && scope.example && scope.exampleSync === false ? <ExampleNote projectId={projectId} example={scope.example} onDone={(n) => (setStatus(n ? { kind: 'saved' } : { kind: 'error', text: 'Nothing to add' }), setReload((x) => x + 1))} onError={(text) => setStatus({ kind: 'error', text })} /> : null}
      <div className={e.foot}>
        <Button size="small" variant="quiet" icon="plus" onClick={add}>
          Add variable
        </Button>
        {importing ? null : (
          <Button size="small" variant="quiet" icon="clip" onClick={() => setImporting(true)}>
            Paste lines…
          </Button>
        )}
        {projectId && !worktreeId && dotenv ? <KeepCopy projectId={projectId} notCopied={(scope.dotenvVars ?? []).filter((v) => !rows.some((r) => r.key === v.key)).length} onStatus={setStatus} /> : null}
        <span className={e.flex} />
        <span className={cx(e.status, status.kind === 'error' && e.statusError)} role="status">
          {status.kind === 'saved' ? (
            <>
              <Icon name="check" size={11} /> Saved
            </>
          ) : status.kind === 'removed' ? (
            <>
              Removed {status.row.key || 'a row'}
              <button type="button" className={e.inlineLink} onClick={undo}>
                Undo
              </button>
            </>
          ) : status.kind === 'error' ? (
            status.text
          ) : null}
        </span>
      </div>
    </Group>
  );
}

/** Whose value: "the .env’s", "your", "app’s". */
function fromWords(from: string): string {
  if (from.startsWith('.env')) return `the ${from}’s`;
  if (from === 'Everywhere') return 'your';
  return `${from}’s`;
}

function emptyText(projectId: string, worktreeId: string | undefined): string {
  if (worktreeId) return 'Nothing set for this worktree only. What you add here wins over the project’s, its .env and yours, in this worktree.';
  if (projectId) return 'No variables yet, and no .env in the main folder. Add one, or paste a few KEY=value lines.';
  return 'No variables yet. Add one, or paste a few KEY=value lines.';
}

/**
 * One list, the .env's order first (a value changed here stays in its place, only its tag
 * changes), then ones set only here, then what .env.example asks for that nothing sets, then
 * what comes from further below (yours, for a project; the project's, for a worktree).
 */
function listRows(rows: readonly EnvRow[], scope: EnvScope, withFile: boolean, filesLabel: string): Listed[] {
  const file: InheritedVar[] = withFile ? (scope.dotenvVars ?? []).map((v) => ({ ...v, from: filesLabel })) : [];
  const fileKeys = new Set(file.map((v) => v.key));
  const lower = (scope.inherited ?? []).filter((v) => !fileKeys.has(v.key));
  const below = new Map([...lower, ...file].map((v) => [v.key, v]));
  const ownOf = (row: EnvRow, index: number): Listed => ({ kind: 'own', row, index, ...(below.has(row.key) ? { below: below.get(row.key)! } : {}) });
  const own = new Map(rows.map((row, index) => [row.key, ownOf(row, index)]));
  const listedFile: Listed[] = file.map((v) => own.get(v.key) ?? { kind: 'lent', item: v });
  const onlyHere: Listed[] = rows.map(ownOf).filter((x) => x.kind === 'own' && !fileKeys.has(x.row.key));
  const set = new Set([...rows.map((r) => r.key), ...below.keys()]);
  const needed: Listed[] = (scope.example?.missing ?? []).filter((k) => !set.has(k)).map((key) => ({ kind: 'needed', key }));
  const lent: Listed[] = lower.filter((v) => !own.has(v.key)).map((item) => ({ kind: 'lent', item }));
  return [...listedFile, ...onlyHere, ...needed, ...lent];
}

/** Keep a Copy in Beluga: the .env values copied into the project's own, kept if the file goes. */
function KeepCopy({ projectId, notCopied, onStatus }: { projectId: string; notCopied: number; onStatus: (s: Status) => void }) {
  const api = useApi();
  const [copying, setCopying] = useState(false);
  if (!notCopied) return null;
  const copyIn = (): void => {
    setCopying(true);
    api.env.importDotenv(projectId).then(
      (n) => {
        setCopying(false);
        onStatus(n ? { kind: 'saved' } : { kind: 'error', text: 'They’re all in Beluga already' });
      },
      (err: unknown) => {
        setCopying(false);
        onStatus({ kind: 'error', text: envErrorText(err) });
      },
    );
  };
  return (
    <Tip label="Copies the .env values into Beluga, so they stay even if the file changes or goes">
      <Button size="small" variant="quiet" icon="download" disabled={copying} onClick={copyIn}>
        {copying ? 'Copying…' : 'Keep a Copy in Beluga'}
      </Button>
    </Tip>
  );
}
