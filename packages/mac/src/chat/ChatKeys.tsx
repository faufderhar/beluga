import * as Popover from '@radix-ui/react-popover';
import { useEffect, useRef, useState } from 'react';
import { ENV_KEY, type EnvVar } from '@beluga/shared/env-vars.js';
import { maskKey } from '@beluga/shared/key-detect.js';
import { Icon } from '../components/Icon.js';
import { Button, Tip, cx } from '../components/ui.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { type KeyTarget, tidyName } from './key-paste-model.js';
import s from './chat-keys.module.css';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Where the panel reads and writes: this chat's own variables, or the keys a new worktree's page holds. */
export interface KeyStore {
  readonly load: () => Promise<readonly EnvVar[]>;
  readonly save: (rows: readonly EnvVar[]) => Promise<void>;
}

/**
 * This chat's keys (BLG-965): a button in the box's bar with how many, and a panel that lists them
 * (the key hidden), puts one in the message, renames one, takes a new value for it, or removes it.
 * Its foot keeps them all for the project, or opens the worktree's whole Environment.
 */
export function ChatKeys({ target, names, store, open, onOpen, onInsert, onRenamed, agent }: { target: KeyTarget; names: readonly string[]; store: KeyStore; open: boolean; onOpen: (open: boolean) => void; onInsert: (name: string) => void; onRenamed: (from: string, to: string) => void; agent: string }) {
  if (!names.length || (target.kind !== 'chat' && target.kind !== 'draft')) return null;
  const label = `${names.length} ${names.length === 1 ? 'key' : 'keys'}`;
  return (
    <Popover.Root open={open} onOpenChange={onOpen}>
      <Tip label={`Keys kept for this chat: ${agent} gets them by name`}>
        <Popover.Trigger asChild>
          <button type="button" className={cx(s.button, open && s.on)} aria-label={`Keys for this chat: ${label}`} data-chat-keys>
            <Icon name="key" size={12} />
            <span>{label}</span>
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content className={s.panel} side="top" align="end" sideOffset={8} collisionPadding={12} aria-label="Keys for this chat" onOpenAutoFocus={(e) => e.preventDefault()}>
          <Panel target={target} store={store} onInsert={(n) => (onInsert(n), onOpen(false))} onRenamed={onRenamed} agent={agent} close={() => onOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Panel({ target, store, onInsert, onRenamed, agent, close }: { target: KeyTarget; store: KeyStore; onInsert: (name: string) => void; onRenamed: (from: string, to: string) => void; agent: string; close: () => void }) {
  const api = useApi();
  const { client } = useBeluga();
  const [rows, setRows] = useState<readonly EnvVar[]>();
  const [editing, setEditing] = useState<string>();
  const wsId = target.kind === 'chat' ? target.workspaceId : undefined;
  const projectName = useApp((st) => (wsId ? st.projects.find((p) => p.workspaces.some((w) => w.id === wsId))?.name : undefined));
  useEffect(() => {
    let live = true;
    store.load().then(
      (r) => live && setRows(r),
      (err: unknown) => live && (setRows([]), toast(client, `Couldn’t read the keys: ${errorText(err)}`, 'error')),
    );
    return () => {
      live = false;
    };
  }, [store]);

  const save = (next: readonly EnvVar[]): Promise<boolean> =>
    store.save(next).then(
      () => (setRows(next), true),
      (err: unknown) => (toast(client, `Couldn’t save the keys: ${errorText(err)}`, 'error'), false),
    );
  const remove = (key: string): void => void save((rows ?? []).filter((r) => r.key !== key));
  const keepForProject = (): void => {
    if (!wsId) return;
    void api.env.carryWorktree(wsId).then(
      (n) => {
        toast(client, `Kept for ${projectName ?? 'the project'}: its every chat and worktree gets ${n === 1 ? 'it' : `these ${n}`}`, 'success');
        close();
      },
      (err: unknown) => toast(client, `Couldn’t keep them: ${errorText(err)}`, 'error'),
    );
  };

  return (
    <div className={s.inner}>
      <header className={s.head}>
        <span className={s.badge} aria-hidden="true">
          <Icon name="key" size={13} />
        </span>
        <div className={s.titles}>
          <div className={s.title}>Keys for this chat</div>
          <div className={s.sub}>
            Kept in Beluga. {agent} gets each one by name, never the key.
          </div>
        </div>
      </header>
      {rows === undefined ? (
        <div className={s.loading}>Reading…</div>
      ) : rows.length ? (
        <ul className={s.rows}>
          {rows.map((r) =>
            editing === r.key ? (
              <EditRow
                key={r.key}
                row={r}
                taken={rows.filter((o) => o.key !== r.key).map((o) => o.key)}
                onCancel={() => setEditing(undefined)}
                onSave={(next) =>
                  void save(rows.map((o) => (o.key === r.key ? next : o))).then((ok) => {
                    if (!ok) return;
                    setEditing(undefined);
                    if (next.key !== r.key) onRenamed(r.key, next.key);
                  })
                }
              />
            ) : (
              <li key={r.key} className={s.row} data-chat-key={r.key}>
                <span className={s.chip}>
                  <Icon name="key" size={10} />
                  {r.key}
                </span>
                <code className={s.masked}>{maskKey(r.value)}</code>
                <span className={s.acts}>
                  <Tip label={`Put $${r.key} in the message`}>
                    <button type="button" className={s.act} aria-label={`Put ${r.key} in the message`} onClick={() => onInsert(r.key)}>
                      <Icon name="plus" size={12} />
                    </button>
                  </Tip>
                  <Tip label="Rename it, or paste a new key">
                    <button type="button" className={s.act} aria-label={`Change ${r.key}`} onClick={() => setEditing(r.key)}>
                      <Icon name="pencil" size={12} />
                    </button>
                  </Tip>
                  <Tip label="Remove it from this chat">
                    <button type="button" className={cx(s.act, s.danger)} aria-label={`Remove ${r.key}`} onClick={() => remove(r.key)}>
                      <Icon name="trash" size={12} />
                    </button>
                  </Tip>
                </span>
              </li>
            ),
          )}
        </ul>
      ) : (
        <div className={s.loading}>No keys kept for this chat now.</div>
      )}
      <footer className={s.foot}>
        {wsId ? (
          <>
            <button
              type="button"
              className={s.link}
              onClick={() => {
                close();
                openSheet({ kind: 'worktree_env', workspaceId: wsId });
              }}
            >
              All variables…
            </button>
            {rows?.length && target.kind === 'chat' && target.worktree ? (
              <Button size="small" icon="lock" onClick={keepForProject} data-keep-for-project>
                Keep for {projectName ?? 'the Project'}
              </Button>
            ) : null}
          </>
        ) : (
          <span className={s.hint}>They go with the new worktree when you start it.</span>
        )}
      </footer>
    </div>
  );
}

/** A key being changed: its name, and a new key pasted over the old (left empty, the old one stays). */
function EditRow({ row, taken, onSave, onCancel }: { row: EnvVar; taken: readonly string[]; onSave: (next: EnvVar) => void; onCancel: () => void }) {
  const [name, setName] = useState(row.key);
  const [value, setValue] = useState('');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const problem = !name ? 'Give it a name' : !ENV_KEY.test(name) ? 'Letters, digits and _ only' : taken.includes(name) ? 'Another key has that name' : undefined;
  const go = (): void => {
    if (!problem) onSave({ key: name, value: value.trim() || row.value });
  };
  const keys = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') (e.preventDefault(), go());
    if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), onCancel());
  };
  return (
    <li className={cx(s.row, s.editing)} data-chat-key-edit={row.key}>
      <label className={s.field}>
        <span className={s.fieldLabel}>Name</span>
        <span className={cx(s.input, problem && s.bad)}>
          <span className={s.dollar}>$</span>
          <input ref={first} value={name} spellCheck={false} onChange={(e) => setName(tidyName(e.target.value))} onKeyDown={keys} aria-label="Name" />
        </span>
      </label>
      <label className={s.field}>
        <span className={s.fieldLabel}>Key</span>
        <span className={s.input}>
          <input type="password" value={value} placeholder={`${maskKey(row.value)}  ·  paste a new one to replace it`} spellCheck={false} autoComplete="off" onChange={(e) => setValue(e.target.value)} onKeyDown={keys} aria-label="New key" />
        </span>
      </label>
      <div className={s.editFoot}>
        <span className={s.problem}>{problem ?? ''}</span>
        <Button size="small" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="small" variant="primary" disabled={Boolean(problem)} onClick={go}>
          Save
        </Button>
      </div>
    </li>
  );
}
