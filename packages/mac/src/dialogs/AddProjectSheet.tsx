import { baseName, sepOf } from '@beluga/shared/os-path.js';
import { cloneableOrigin, repoName } from '@beluga/shared/repo-key.js';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DotMatrix } from '../components/DotMatrix.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { Button, Segmented, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { canPickFolders, inApp, webServed } from '../lib/boot.js';
import { useApi, useApp, useBeluga, useUi } from '../lib/beluga.js';
import { pickFolders } from '../lib/projects.js';
import s from './add-project.module.css';
import { thisComputer } from '../lib/os-words.js';

interface Found {
  readonly path: string;
  readonly name: string;
  readonly changed: number;
}

const ago = (ts: number): string => {
  const d = Math.max(0, (Date.now() - ts) / 1000);
  if (d < 3600) return 'just now';
  if (d < 86_400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86_400 * 30) return `${Math.floor(d / 86_400)}d ago`;
  return `${Math.floor(d / (86_400 * 30))}mo ago`;
};

type Mode = 'add' | 'new' | 'clone';

/** A folder you added here: on its way (adding takes a moment), in, or why it couldn't be. */
type Row = { readonly kind: 'adding'; readonly init?: boolean } | { readonly kind: 'added' } | { readonly kind: 'failed'; readonly error: string; readonly canInit?: boolean };

/** Suggestions shown before you filter (Filter searches every one found). */
const NEWEST = 24;

/**
 * Add projects the Mac way: drop folders on it, choose them in the Open panel, or pick from the
 * git projects already on this Mac (most recently worked on first). Or start a new one, or clone
 * one from its git address.
 */
export function AddProjectSheet() {
  const { ui, client } = useBeluga();
  const api = useApi();
  const asked = useUi((u) => u.addProject ?? false);
  const open = asked !== false;
  const [mode, setMode] = useState<Mode>('add');
  const home = useApp((st) => st.home);
  const roots = useApp((st) => st.projects.map((p) => p.root).filter(Boolean).join('\n'));
  // Projects you hid: listed too, with Show (they come back where they were).
  const hidden = useApp((st) => st.hiddenProjects.join('\n'));
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [found, setFound] = useState<Found[] | undefined>();
  const [rows, setRows] = useState<ReadonlyMap<string, Row>>(new Map());
  const [filter, setFilter] = useState('');
  const [typed, setTyped] = useState('');
  const [over, setOver] = useState(false);
  const filterBox = useRef<HTMLInputElement>(null);
  const close = (): void => ui.patch({ addProject: false });
  const short = (p: string): string => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

  useEffect(() => {
    if (!open) return;
    setMode(asked === 'new' || asked === 'clone' ? asked : 'add');
    setRows(new Map());
    setRevealed(new Set());
    setFilter('');
    setFound(undefined);
    void api.projects.suggest().then(setFound, () => setFound([]));
  }, [open, asked]);

  const mark = (path: string, row: Row): void => setRows((m) => new Map(m).set(path, row));
  // Each folder shows Adding… on its row at once, then Added or what went wrong.
  const add = async (paths: readonly string[]): Promise<void> => {
    await Promise.all(
      paths.map(async (p) => {
        mark(p, { kind: 'adding' });
        const res = await api.projects.add(p).catch((err: unknown) => ({ error: errorText(err) }));
        mark(p, res.error ? { kind: 'failed', error: res.error, canInit: 'canInit' in res && res.canInit } : { kind: 'added' });
      }),
    );
  };
  // A plain folder: git there, what's in it in a first commit, and it's added.
  const initGit = async (p: string): Promise<void> => {
    mark(p, { kind: 'adding', init: true });
    const res = await api.projects.initGit(p).catch((err: unknown) => ({ error: errorText(err) }));
    mark(p, res.error ? { kind: 'failed', error: res.error } : { kind: 'added' });
  };

  // Folders dropped anywhere on the window while this is open are added.
  useEffect(() => {
    if (!open || mode !== 'add' || !inApp()) return;
    let off: (() => void) | undefined;
    let alive = true;
    void import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
      const un = await getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === 'over' || e.payload.type === 'enter') setOver(true);
        else if (e.payload.type === 'leave') setOver(false);
        else if (e.payload.type === 'drop') {
          setOver(false);
          void add(e.payload.paths);
        }
      });
      if (alive) off = un;
      else un();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [open, mode]);

  const show = async (path: string): Promise<void> => {
    if (await api.workspaces.showProject(path)) setRevealed((r) => new Set([...r, path]));
  };

  const hiddenSet = useMemo(() => new Set(hidden.split('\n').filter(Boolean)), [hidden]);
  const shown = useMemo(() => {
    const known = new Set(roots.split('\n'));
    const q = filter.trim().toLowerCase();
    const listed = new Set((found ?? []).map((f) => f.path));
    // Folders you dropped, chose or typed (not among the suggestions) and hidden projects come first,
    // even while the suggestions are still being looked for: what you added shows at once.
    const extra = [...rows.keys(), ...(found ? [...hiddenSet, ...revealed] : [])].filter((p, i, all) => !listed.has(p) && all.indexOf(p) === i).map((p): Found => ({ path: p, name: baseName(p) || p, changed: 0 }));
    const newest = (found ?? []).filter((f, i) => q || i < NEWEST || rows.has(f.path));
    return [...extra, ...newest]
      .filter((f) => !known.has(f.path) || rows.has(f.path) || revealed.has(f.path))
      .filter((f) => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
  }, [found, filter, roots, rows, hiddenSet, revealed]);

  // The folder panel failing says so (it used to do nothing); typing a path below still works.
  const choose = async (): Promise<void> => {
    const picked = await pickFolders('Add projects').catch((err: unknown) => {
      client.store.dispatch({ type: 'toast', text: `Couldn't open the folder picker: ${errorText(err)}. Type the path below instead.`, level: 'error' });
      return undefined;
    });
    if (picked) await add(picked);
  };

  if (!open) return null;
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.sheet} aria-describedby={undefined} onOpenAutoFocus={(e) => (e.preventDefault(), mode === 'add' && filterBox.current?.focus())}>
          <div className={s.head}>
            <Dialog.Title className={s.title}>{mode === 'new' ? 'New project' : mode === 'clone' ? 'Clone a project' : 'Add projects'}</Dialog.Title>
            <Dialog.Close className={s.close} aria-label="Close">
              <Icon name="x" size={11} />
            </Dialog.Close>
          </div>

          <div className={s.modes}>
            <Segmented<Mode>
              label="Add or start a project"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'add', label: 'Add existing', icon: 'folder' },
                { value: 'new', label: 'Start new', icon: 'plus' },
                { value: 'clone', label: 'Clone', icon: 'download' },
              ]}
            />
          </div>
          {mode === 'new' ? (
            <NewProject onDone={close} />
          ) : mode === 'clone' ? (
            <CloneProject onDone={close} />
          ) : (
            <>
              <div
                className={cx(s.drop, over && s.dropOver)}
                onDragOver={(e) => (e.preventDefault(), setOver(true))}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => (e.preventDefault(), setOver(false))}
              >
                <Icon name="folder" size={22} />
                <div className={s.dropText}>
                  <strong>{webServed() ? 'Choose a project folder where Beluga runs' : 'Drop project folders here'}</strong>
                  <span>A git project, or a folder full of them (new ones in it show up too).</span>
                </div>
                {canPickFolders() ? (
                  <Button variant="primary" onClick={() => void choose()}>
                    Choose Folders…
                  </Button>
                ) : null}
              </div>

              <div className={s.listHead}>
                <span>On {thisComputer()}</span>
                <input ref={filterBox} className={s.filter} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label={`Filter projects on ${thisComputer()}`} />
              </div>
              <div className={s.list} role="list">
                {shown.length === 0 ? (
                  <div className={s.note}>{found === undefined ? 'Looking in your code folders…' : filter ? `Nothing called “${filter}”.` : 'No other git projects in ~/Projects, ~/Developer, ~/code and the like.'}</div>
                ) : (
                  shown.map((f) => {
                    const row = rows.get(f.path);
                    const done = row?.kind === 'added' || revealed.has(f.path);
                    const wasHidden = hiddenSet.has(f.path) || revealed.has(f.path);
                    const when = wasHidden ? 'hidden' : f.changed ? ago(f.changed) : undefined;
                    return (
                      <div key={f.path} className={s.item} role="listitem" onDoubleClick={() => !done && !row && void (wasHidden ? show(f.path) : add([f.path]))}>
                        <ProjectIcon id={`path:${f.path}`} name={f.name} size={26} />
                        <span className={s.itemText}>
                          <span className={s.itemName}>{f.name}</span>
                          {row?.kind === 'failed' ? (
                            <span className={s.itemError} role="alert">
                              {row.error}
                            </span>
                          ) : (
                            <span className={s.itemPath}>
                              {short(f.path)}
                              {when ? ` · ${when}` : ''}
                            </span>
                          )}
                        </span>
                        {row?.kind === 'adding' ? (
                          <span className={s.adding}>
                            <DotMatrix size={12} /> {row.init ? 'Setting up git…' : 'Adding…'}
                          </span>
                        ) : done ? (
                          <span className={s.added}>
                            <Icon name="check" size={12} /> {wasHidden ? 'Showing' : 'Added'}
                          </span>
                        ) : wasHidden ? (
                          <Button size="small" onClick={() => void show(f.path)} aria-label={`Show ${f.name}`}>
                            Show
                          </Button>
                        ) : row?.kind === 'failed' && row.canInit ? (
                          <Button size="small" onClick={() => void initGit(f.path)} aria-label={`Set up git in ${f.name}`}>
                            Set Up Git
                          </Button>
                        ) : (
                          <Button size="small" onClick={() => void add([f.path])}>
                            {row?.kind === 'failed' ? 'Try Again' : 'Add'}
                          </Button>
                        )}
                      </div>
                    );
                  })
                )}
                {found === undefined && shown.length > 0 ? <div className={s.note}>Looking in your code folders…</div> : null}
              </div>

              <form
                className={s.pathRow}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!typed.trim()) return;
                  void add([typed.trim()]);
                  setTyped('');
                }}
              >
                <input className={s.path} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type a path, like ~/code/app" aria-label="Folder path" spellCheck={false} />
                <Button size="small" type="submit" disabled={!typed.trim()}>
                  Add
                </Button>
                <span className={s.flex} />
                <Button variant={rows.size || revealed.size ? 'primary' : 'quiet'} onClick={close}>
                  {rows.size || revealed.size ? 'Done' : 'Cancel'}
                </Button>
              </form>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Where a new or cloned project goes: your code folder, until you pick another. */
function useParent(): [string | undefined, (dir: string) => void] {
  const api = useApi();
  const [parent, setParent] = useState<string | undefined>();
  useEffect(() => {
    void api.projects.newHome().then(
      (dir) => setParent((p) => p ?? dir),
      () => undefined,
    );
  }, []);
  return [parent, setParent];
}

const useShort = (): ((p: string) => string) => {
  const home = useApp((st) => st.home);
  return (p) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
};

/** The In row: the folder, and Change… (or a path to type where folders can't be picked). */
function Where({ parent, onChange, label }: { parent: string | undefined; onChange: (dir: string) => void; label: string }) {
  const short = useShort();
  const change = async (): Promise<void> => {
    const picked = await pickFolders(label);
    if (picked?.[0]) onChange(picked[0]);
  };
  return (
    <div className={s.field}>
      <span>In</span>
      <div className={s.whereRow}>
        {canPickFolders() ? (
          <>
            <span className={s.whereText}>
              <Icon name="folder" size={13} /> {parent ? short(parent) : 'Your code folder'}
            </span>
            <Button size="small" onClick={() => void change()}>
              Change…
            </Button>
          </>
        ) : (
          <input className={s.path} value={parent ? short(parent) : ''} onChange={(e) => onChange(e.target.value)} aria-label={label} spellCheck={false} />
        )}
      </div>
    </div>
  );
}

/** Start new: a name and where it goes; Beluga makes the folder, git and a first commit, then opens a worktree draft in it. */
function NewProject({ onDone }: { onDone: () => void }) {
  const api = useApi();
  const actions = useActions();
  const short = useShort();
  const [name, setName] = useState('');
  const [parent, setParent] = useParent();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const nameBox = useRef<HTMLInputElement>(null);

  useEffect(() => nameBox.current?.focus(), []);

  const create = async (): Promise<void> => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const made = await api.projects.create(name.trim(), parent);
      onDone();
      // Its first task: describe what to build, and it gets a worktree of its own.
      actions.run({ type: 'new_worktree', projectId: made.id });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const where = parent ? `${short(parent).replace(/[\\/]+$/, '')}${sepOf(parent)}${name.trim() || 'name'}` : undefined;
  return (
    <form
      className={s.newForm}
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <label className={s.field}>
        <span>Name</span>
        <input ref={nameBox} className={s.nameInput} value={name} onChange={(e) => (setName(e.target.value), setError(undefined))} placeholder="my-app" aria-label="Project name" spellCheck={false} autoComplete="off" />
      </label>
      <Where parent={parent} onChange={setParent} label="Where the new project goes" />
      <p className={error ? s.newError : s.newNote} role={error ? 'alert' : undefined}>
        {error ?? (where ? `Makes ${where} with git and a first commit, ready for worktrees.` : 'Makes the folder with git and a first commit, ready for worktrees.')}
      </p>
      <div className={s.pathRow}>
        <span className={s.flex} />
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={!name.trim() || busy}>
          <Steady now={busy ? 'Creating…' : 'Create Project'} all={['Create Project', 'Creating…']} />
        </Button>
      </div>
    </form>
  );
}

/**
 * A button's words that keep it as wide as its widest wording: "Clone Project" turning into the
 * shorter "Cloning…" no longer shrinks it (WebKit left a strip of the wider blue button behind).
 */
function Steady({ now, all }: { now: string; all: readonly string[] }) {
  return (
    <span className={s.steady}>
      {all.map((w) => (
        <span key={w} className={w === now ? undefined : s.steadyOff} aria-hidden={w === now ? undefined : true}>
          {w}
        </span>
      ))}
    </span>
  );
}

type MyRepos = Awaited<ReturnType<ReturnType<typeof useApi>['projects']['myRepos']>>;
type MyRepo = MyRepos['repos'][number];

/** Your GitHub repositories (gh's sign-in): undefined while asked, an error's words when GitHub couldn't be reached. */
function useMyRepos(): MyRepos | string | undefined {
  const api = useApi();
  const [got, setGot] = useState<MyRepos | string | undefined>();
  useEffect(() => {
    let alive = true;
    api.projects.myRepos().then(
      (r) => alive && setGot(r),
      (err: unknown) => alive && setGot(errorText(err)),
    );
    return () => {
      alive = false;
    };
  }, []);
  return got;
}

/** The Clone tab's list of your repositories: pick one (its address fills in), double-click to clone it. */
function MyRepoList({ got, url, onPick, onClone }: { got: MyRepos | string | undefined; url: string; onPick: (r: MyRepo) => void; onClone: (r: MyRepo) => void }) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const repos = typeof got === 'object' ? got.repos : [];
  const shown = q ? repos.filter((r) => r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q)) : repos;
  const picked = url.trim();
  return (
    <>
      <div className={s.listHead}>
        <span>Your repositories</span>
        <input className={s.filter} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter your repositories" spellCheck={false} />
      </div>
      <div className={cx(s.list, s.repoList)} role="list">
        {got === undefined ? (
          <div className={s.note}>
            <DotMatrix size={12} /> Looking at your GitHub…
          </div>
        ) : typeof got === 'string' ? (
          <div className={s.note} role="alert">
            Couldn't read your repositories: {got}
          </div>
        ) : shown.length === 0 ? (
          <div className={s.note}>{filter ? `Nothing called “${filter}”.` : 'No repositories on your GitHub yet.'}</div>
        ) : (
          shown.map((r) => {
            const [owner, name] = r.fullName.split('/');
            const on = picked !== '' && picked === r.url;
            return (
              <button
                key={r.fullName}
                type="button"
                role="listitem"
                className={cx(s.item, s.repo, on && s.repoPicked)}
                aria-current={on || undefined}
                onClick={() => onPick(r)}
                onDoubleClick={() => onClone(r)}
              >
                <span className={s.glyph}>
                  <Icon name={r.private ? 'lock' : 'folder'} size={13} />
                </span>
                <span className={s.itemText}>
                  <span className={s.itemName}>{name ?? r.fullName}</span>
                  <span className={s.itemPath}>
                    {owner}
                    {r.private ? ' · private' : ''}
                    {r.pushedAt ? ` · pushed ${ago(r.pushedAt)}` : ''}
                    {r.description ? ` · ${r.description}` : ''}
                  </span>
                </span>
                {r.here ? (
                  <span className={s.added}>
                    <Icon name="check" size={12} /> On {thisComputer()}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </>
  );
}

/** Without gh, or signed out of it: one line on how to get your repositories listed here. */
function MyReposHint({ gh }: { gh: MyRepos['gh'] }) {
  if (gh === 'ok') return null;
  return <p className={s.newNote}>{gh === 'missing' ? 'Install the GitHub CLI (brew install gh) and run gh auth login to pick from your repositories here.' : 'Run gh auth login in Terminal to pick from your GitHub repositories here.'}</p>;
}

/** Clone: one of your GitHub repositories, or any git address (https or ssh), and where it goes; Beluga clones and adds it, then opens a worktree draft in it. */
function CloneProject({ onDone }: { onDone: () => void }) {
  const api = useApi();
  const actions = useActions();
  const short = useShort();
  const [url, setUrl] = useState('');
  const [parent, setParent] = useParent();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const urlBox = useRef<HTMLInputElement>(null);
  const mine = useMyRepos();
  // The list shows while it's asked for and once you're signed in; without gh, the paste box as before.
  const listed = mine === undefined || typeof mine === 'string' || mine.gh === 'ok';

  useEffect(() => urlBox.current?.focus(), []);

  const address = url.trim();
  const name = cloneableOrigin(address) ? repoName(address) : undefined;
  const clone = async (to = address): Promise<void> => {
    if (!to || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const got = await api.projects.clone(to, parent);
      onDone();
      actions.run({ type: 'new_worktree', projectId: got.id });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const where = parent && name ? `${short(parent).replace(/[\\/]+$/, '')}${sepOf(parent)}${name}` : undefined;
  const pick = (r: MyRepo): void => {
    if (busy) return;
    setUrl(r.url);
    setError(undefined);
  };
  return (
    <form
      className={cx(s.newForm, listed && s.cloneForm)}
      onSubmit={(e) => {
        e.preventDefault();
        void clone();
      }}
    >
      {listed ? <MyRepoList got={mine} url={url} onPick={pick} onClone={(r) => (pick(r), void clone(r.url))} /> : null}
      <label className={s.field}>
        <span>Address</span>
        <input
          ref={urlBox}
          className={s.nameInput}
          value={url}
          onChange={(e) => (setUrl(e.target.value), setError(undefined))}
          placeholder={listed ? 'Pick one above, or paste any git address' : 'https://github.com/owner/repo'}
          aria-label="Git address"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <Where parent={parent} onChange={setParent} label="Where the cloned project goes" />
      <p className={error ? s.newError : s.newNote} role={error ? 'alert' : undefined}>
        {error ?? (busy ? 'Cloning… a big repository can take a few minutes.' : where ? `Clones it into ${where} and adds it, ready for worktrees.` : 'An https or ssh address, from GitHub or anywhere git can reach.')}
      </p>
      {typeof mine === 'object' ? <MyReposHint gh={mine.gh} /> : null}
      <div className={s.pathRow}>
        <span className={s.flex} />
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={!address || busy}>
          <Steady now={busy ? 'Cloning…' : 'Clone Project'} all={['Clone Project', 'Cloning…']} />
        </Button>
      </div>
    </form>
  );
}
