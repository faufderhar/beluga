import { type MouseEvent, useState } from 'react';
import { type Issue, type Proof, STATUS_INFO, blocking, childrenOf, issueById, progressOf, taskFiles, taskProof } from '@beluga/core/board/model.js';
import { Thumb } from '../chat/ChatImages.js';
import { localImage } from '../chat/md-images.js';
import { GraphBlock } from '../components/graph/GraphBlock.js';
import { Icon } from '../components/Icon.js';
import { ActionsDropdown } from '../components/SpecMenu.js';
import { IconButton, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { inApp, webServed } from '../lib/boot.js';
import { AssigneeMark, StatusIcon } from './marks.js';
import { ProofGone, ProofPreview, preloadReader } from './ProofPreview.js';
import { TaskPicker } from './pickers.js';
import { ago } from './tasks-model.js';
import { formatBytes } from '@beluga/shared/format.js';
import { useBoard, useSelfId, useSolo, useTaskActions } from './use-tasks.js';
import t from './tasks.module.css';
import { primaryKey, primaryLabel } from '../lib/shortcuts-model.js';

/** A task page's lists: its sub-tasks, what waits on what, the files added for the work, and the proof that it works. */

function TaskLine({ issue, onRemove, removeLabel }: { issue: Issue; onRemove?: () => void; removeLabel?: string }) {
  const selfId = useSelfId();
  const solo = useSolo(issue.projectId);
  const { open } = useTaskActions();
  return (
    <li className={t.line}>
      <button type="button" className={t.lineMain} onClick={() => open(issue)}>
        <StatusIcon status={issue.status} labelled />
        <span className={t.key}>{issue.key}</span>
        <span className={cx(t.lineTitle, !STATUS_INFO[issue.status].open && t.titleClosed)}>{issue.title}</span>
      </button>
      {solo ? null : <AssigneeMark assignee={issue.assignee} selfId={selfId} size={16} />}
      {onRemove ? <IconButton size="small" icon="x" label={removeLabel ?? 'Remove'} className={t.lineRemove} onClick={onRemove} /> : null}
    </li>
  );
}

export function SubTasks({ issue }: { issue: Issue }) {
  const board = useBoard();
  const { api, act } = useTaskActions();
  const kids = childrenOf(board, issue);
  const progress = progressOf(board, issue);
  const [title, setTitle] = useState('');
  const add = async (): Promise<void> => {
    const text = title.trim();
    if (!text) return;
    if (await act(() => api.create({ projectId: issue.projectId, title: text, parent: issue.id, status: issue.status === 'backlog' ? 'backlog' : 'todo' }))) setTitle('');
  };
  return (
    <section className={t.block} aria-label="Sub-tasks">
      <header className={t.blockHead}>
        <h3 className={t.sectionTitle}>Sub-tasks</h3>
        {progress.total ? (
          <span className={cx(t.sectionCount, progress.done === progress.total && t.sectionCountDone)}>
            {progress.done} of {progress.total}
          </span>
        ) : null}
      </header>
      {kids.length ? (
        <ul className={t.lines}>
          {kids.map((k) => (
            <TaskLine key={k.id} issue={k} onRemove={() => void act(() => api.update(k.id, { parent: null }))} removeLabel="Make It a Task of Its Own" />
          ))}
        </ul>
      ) : null}
      <div className={t.addLine}>
        <Icon name="plus" size={12} />
        <input
          value={title}
          placeholder="Add a sub-task"
          aria-label="New sub-task"
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            } else if (e.key === 'Escape') setTitle('');
          }}
        />
      </div>
    </section>
  );
}

/** Blocked by, blocks, related: each a list with + to add (a task picker) and ✕ to take back. */
export function Relations({ issue }: { issue: Issue }) {
  const board = useBoard();
  const { api, act } = useTaskActions();
  const blockers = issue.blockedBy.map((id) => issueById(board, id)).filter((i): i is Issue => Boolean(i));
  const waiting = blocking(board, issue);
  const related = issue.related.map((id) => issueById(board, id)).filter((i): i is Issue => Boolean(i));
  const others = board.issues.filter((i) => i.id !== issue.id);
  const groups = [
    { rel: 'blocked_by' as const, title: 'Blocked by', items: blockers, hint: 'Tasks that must be done first' },
    { rel: 'blocks' as const, title: 'Blocks', items: waiting, hint: 'Tasks waiting on this one' },
    { rel: 'related' as const, title: 'Related', items: related, hint: 'Worth knowing about' },
  ];
  return (
    <section className={t.block} aria-label="Relations">
      <div className={t.relations}>
        {groups.map((g) => (
          <div key={g.rel} className={t.relation}>
            <header className={t.blockHead}>
              <h3 className={t.sectionTitle}>{g.title}</h3>
              <TaskPicker label={`Add to ${g.title}`} candidates={others.filter((o) => !g.items.some((x) => x.id === o.id))} onPick={(other) => void act(() => api.relate(issue.id, g.rel, other.id, true))} align="end">
                <IconButton size="small" icon="plus" label={`Add: ${g.hint}`} />
              </TaskPicker>
            </header>
            {g.items.length ? (
              <ul className={t.lines}>
                {g.items.map((other) => (
                  <TaskLine key={other.id} issue={other} onRemove={() => void act(() => api.relate(issue.id, g.rel, other.id, false))} removeLabel={`Remove from ${g.title}`} />
                ))}
              </ul>
            ) : (
              <div className={t.relationEmpty}>{g.hint}</div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Files for a task: the Open panel; in a page the web port served, the browser's picker, uploaded to the server. */
async function pickFiles(title: string, multiple = false, failed: (why: Error) => void = () => undefined): Promise<string[]> {
  if (!inApp()) {
    if (!webServed()) return [];
    const { chooseLocalFiles, uploadFiles } = await import('../lib/web-files.js');
    const sent = await uploadFiles(await chooseLocalFiles({ multiple }), (file, err) => failed(new Error(`Couldn’t upload ${file.name}: ${err instanceof Error ? err.message : String(err)}`)));
    return sent.map((u) => u.path);
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple, title });
  return picked === null ? [] : Array.isArray(picked) ? picked : [picked];
}

const IMAGE = /\.(png|jpe?g|gif|webp|heic|svg)$/i;

/**
 * Files someone added for the work (dropped on the task, its card or its row, or picked with +):
 * Beluga keeps a copy, they open in place, and the Claude doing the task gets their paths.
 */
export function FilesList({ issue }: { issue: Issue }) {
  const { api, act } = useTaskActions();
  const files = taskFiles(issue);
  const add = async (): Promise<void> => {
    for (const path of await pickFiles('Add files to this task', true, (why) => void act(() => Promise.reject(why)))) {
      const name = path.split('/').pop() ?? path;
      await act(() => api.addProof(issue.id, { kind: IMAGE.test(path) ? 'image' : 'file', title: name.slice(0, 120), path, context: true }));
    }
  };
  return (
    <section className={t.block} aria-label="Files">
      <header className={t.blockHead}>
        <h3 className={t.sectionTitle}>Files</h3>
        {files.length ? <span className={t.sectionCount}>{files.length}</span> : null}
        <span className={t.grow} />
        {inApp() || webServed() ? <IconButton size="small" icon="plus" label="Add Files" onClick={() => void add()} /> : null}
      </header>
      {files.length ? (
        <ProofItems issue={issue} items={files} />
      ) : (
        <div className={t.relationEmpty}>{inApp() || webServed() ? 'Drop files here, or on the task’s card, for the work to use. Your agent gets them too.' : 'Files added for the work show here.'}</div>
      )}
    </section>
  );
}

/** Proof: screenshots, pages, files, graphs and results that show the work, people's and Claude's. */
export function ProofList({ issue }: { issue: Issue }) {
  const { api, act } = useTaskActions();
  const [link, setLink] = useState<string>();
  const addFile = async (): Promise<void> => {
    const [path] = await pickFiles('Add proof to this task', false, (why) => void act(() => Promise.reject(why)));
    if (!path) return;
    const name = path.split('/').pop() ?? path;
    await act(() => api.addProof(issue.id, { kind: IMAGE.test(path) ? 'image' : 'file', title: name, path }));
  };
  const addLink = async (): Promise<void> => {
    const url = link?.trim();
    if (!url) return;
    const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    let title = full;
    try {
      title = new URL(full).hostname;
    } catch {
      return;
    }
    if (await act(() => api.addProof(issue.id, { kind: 'url', title, url: full }))) setLink(undefined);
  };
  return (
    <section className={t.block} aria-label="Proof">
      <header className={t.blockHead}>
        <h3 className={t.sectionTitle}>Proof</h3>
        <span className={t.grow} />
        <ActionsDropdown
          items={[
            ...(inApp() || webServed() ? [{ label: 'Picture or File…', icon: 'image' as const, onSelect: () => void addFile() }] : []),
            { label: 'Link…', icon: 'link', onSelect: () => setLink('') },
          ]}
        >
          <IconButton size="small" icon="plus" label="Add Proof" />
        </ActionsDropdown>
      </header>
      {link !== undefined ? (
        <div className={t.addLine}>
          <Icon name="link" size={12} />
          <input
            autoFocus
            value={link}
            placeholder="https://preview.example.com/checkout"
            aria-label="Link"
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addLink();
              else if (e.key === 'Escape') setLink(undefined);
            }}
            onBlur={() => !link?.trim() && setLink(undefined)}
          />
        </div>
      ) : null}
      {taskProof(issue).length ? (
        <ProofItems issue={issue} />
      ) : link === undefined ? (
        <div className={t.relationEmpty}>Screenshots, pages and results that show it works. The agent adds them as it goes.</div>
      ) : null}
    </section>
  );
}

/** A task's proof (or its files: `items`), newest first (on its page, and in a plan's task details). */
/** `readOnly`: shown elsewhere (a plan's details), so without a remove button. */
export function ProofItems({ issue, items = taskProof(issue), readOnly = false }: { issue: Issue; items?: readonly Proof[]; readOnly?: boolean }) {
  const { api, act } = useTaskActions();
  // A gone file isn't asked for (it would only fail): it shows as gone, and the lightbox skips it.
  const images = items.filter((p) => p.kind === 'image' && p.path && !p.gone).map((p) => localImage(p.path!, p.title));
  return (
    <div className={t.proof}>
      {items
        .slice()
        .reverse()
        .map((p) => (
          <ProofItem key={p.id} proof={p} images={images} onRemove={readOnly ? undefined : () => void act(() => api.removeProof(issue.id, p.id))} />
        ))}
    </div>
  );
}

function ProofItem({ proof, images, onRemove }: { proof: Proof; images: ReturnType<typeof localImage>[]; onRemove: (() => void) | undefined }) {
  const actions = useActions();
  const [preview, setPreview] = useState(false);
  const by = `${proof.by.kind === 'claude' ? 'Agent' : proof.by.kind === 'person' ? proof.by.name : 'Beluga'} · ${ago(proof.at)}`;
  const remove = onRemove ? <IconButton size="small" icon="x" label={`Remove ${proof.title}`} className={t.proofRemove} onClick={onRemove} /> : null;
  if (proof.kind === 'graph' && proof.body) {
    return (
      <figure className={cx(t.proofItem, t.proofWide)}>
        <GraphBlock code={proof.body} localImages />
        <figcaption className={t.proofCaption}>
          <span>{by}</span>
          {remove}
        </figcaption>
      </figure>
    );
  }
  if ((proof.kind === 'image' || proof.kind === 'file') && proof.gone && (proof.path || proof.bytes !== undefined)) {
    // Let go when its task was archived (it says how big it was), or removed with its worktree before it was kept.
    const why = proof.bytes !== undefined ? `Let go when the task was archived (it was ${formatBytes(proof.bytes)})` : `${proof.from ?? proof.path}: removed with its worktree before Beluga kept a copy`;
    return (
      <figure className={proof.kind === 'image' ? t.proofItem : cx(t.proofItem, t.proofCard)}>
        {proof.kind === 'image' ? <ProofGone /> : null}
        <figcaption className={t.proofCaption}>
          <Tip label={why}>
            <span className={t.proofTitle}>{proof.kind === 'image' ? proof.title : `${proof.title} · ${proof.bytes !== undefined ? 'Let go when archived' : 'Proof file is gone'}`}</span>
          </Tip>
          {remove}
        </figcaption>
      </figure>
    );
  }
  if (proof.kind === 'image' && proof.path) {
    const index = images.findIndex((i) => i.local === proof.path);
    return (
      <figure className={t.proofItem}>
        <div className={t.proofPicture}>
          <Thumb image={images[index] ?? localImage(proof.path, proof.title)} all={images} index={Math.max(0, index)} tiled />
        </div>
        <figcaption className={t.proofCaption}>
          {proof.thumb ? (
            <Tip label={`Kept small when the task was archived (the full one was ${formatBytes(proof.bytes ?? 0)})`}>
              <span className={t.proofTitle}>{proof.title} · kept small</span>
            </Tip>
          ) : (
            <span className={t.proofTitle}>{proof.title}</span>
          )}
          {remove}
        </figcaption>
      </figure>
    );
  }
  if (proof.kind === 'text') {
    return (
      <figure className={cx(t.proofItem, t.proofWide)}>
        <pre className={t.proofText}>{proof.body}</pre>
        <figcaption className={t.proofCaption}>
          <span className={t.proofTitle}>{proof.title}</span>
          <span>{by}</span>
          {remove}
        </figcaption>
      </figure>
    );
  }
  const url = proof.url;
  const path = proof.path;
  // A file opens over this page at once; ⌘-click shows it in the Files view (as it used to).
  const open = (e: MouseEvent): void => {
    if (url) actions.openLink({ kind: 'url', url });
    else if (path && primaryKey(e)) actions.openLink({ kind: 'local', path, dir: false });
    else if (path) setPreview(true);
  };
  return (
    <figure className={cx(t.proofItem, t.proofCard)}>
      {preview && path ? <ProofPreview proof={{ ...proof, path }} onClose={() => setPreview(false)} /> : null}
      <Tip label={url ?? (path ? `${path} · ${primaryLabel()}-click to show in Files` : proof.title)}>
        <button type="button" className={t.proofLink} onClick={open} onPointerEnter={path && !url ? preloadReader : undefined}>
          <Icon name={url ? 'globe' : 'file'} size={14} />
          <span className={t.proofTitle}>{proof.title}</span>
        </button>
      </Tip>
      <figcaption className={t.proofCaption}>
        <span>{by}</span>
        {remove}
      </figcaption>
    </figure>
  );
}
