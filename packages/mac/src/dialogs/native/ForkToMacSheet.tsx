import { useState } from 'react';
import type { SharedFork } from '@beluga/core/friend-share-store.js';
import { trustOf } from '@beluga/core/trust.js';
import { formatBytes } from '@beluga/shared/format.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Field, FormSheet, TextInput } from '../../components/FormSheet.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Button, Tip } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { useApi, useApp } from '../../lib/beluga.js';
import { openSheet } from '../../lib/sheets.js';
import s from './fork-to-mac.module.css';
import m from './menus.module.css';
import { computerTitle, thisComputer } from '../../lib/os-words.js';

/** The folder and branch name Beluga makes from a name (as the core's `slug` does). */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

function Row({ icon, title, detail }: { icon: IconName; title: string; detail: string }) {
  return (
    <li className={s.row}>
      <span className={s.icon}>
        <Icon name={icon} size={13} />
      </span>
      <span>
        <span className={s.title}>{title}</span>
        <span className={s.detail}>{detail}</span>
      </span>
    </li>
  );
}

/**
 * Fork a friend's shared worktree to this Mac (BLG-312): what comes over, what stays behind, a
 * name, then one button. Their worktree goes on as it is; yours is yours.
 */
export function ForkToMacSheet({ owner, wsId, close }: { owner: string; wsId: string; close: () => void }) {
  const api = useApi();
  const ws = useApp((st) => st.shared.find((w) => w.id === wsId && w.owner === owner));
  const ownerName = useApp((st) => st.sharedProjects.find((p) => p.owner === owner)?.ownerName ?? st.network.friends.find((f) => f.peerId === owner)?.name ?? 'Your friend');
  const full = useApp((st) => trustOf(st, owner) === 'full');
  const [name, setName] = useState(ws?.name ?? '');
  if (!ws) return null;
  return (
    <FormSheet
      title={`Fork “${ws.name}” to This ${computerTitle()}`}
      icon="laptop"
      intro={`A worktree of your own that starts where ${ownerName}’s is now, with your agent. ${ownerName}’s goes on as it is.`}
      submitLabel="Fork"
      canSubmit={Boolean(slug(name))}
      onSubmit={async () => {
        await api.sharing.fork(owner, wsId, name.trim());
        close();
      }}
      onCancel={close}
      width={540}
    >
      <Field label="Comes with it">
        <ul className={s.list}>
          <Row icon="branch" title="Its commits and uncommitted changes" detail="Uncommitted work stays uncommitted, as it was" />
          <Row icon="folder" title="Its Scratch" detail="Screenshots, notes and logs the agent saved" />
          <Row icon="chat" title="The conversation" detail="Your agent remembers it and carries on" />
        </ul>
      </Field>
      <Field label="Stays behind">
        <div className={m.note}>
          <Icon name="eyeOff" size={14} />
          <span>node_modules, build output and anything else git ignores, made again by the setup here. Never a .env file or a key.</span>
        </div>
      </Field>
      {full ? null : (
        <div className={m.note}>
          <Icon name="lock" size={14} />
          <span>{`It’s ${ownerName}’s code: the setup waits until you’ve looked it over, and your .env files aren’t copied in.`}</span>
        </div>
      )}
      <Field label="Name" htmlFor="fork-mac-name" hint={slug(name) ? <>Your branch <code>beluga/{slug(name)}</code></> : undefined}>
        <TextInput id="fork-mac-name" value={name} onChange={setName} maxLength={120} spellCheck={false} />
      </Field>
    </FormSheet>
  );
}

/**
 * A fork coming over, in the header: how much of it is here, with a bar that fills, then that it's
 * being set up. Hover for the sizes and how many files are in it.
 */
function ForkProgress({ fork }: { fork: SharedFork }) {
  const { total } = fork;
  if (total === undefined) {
    // A Mac on an older Beluga doesn't say how big it is.
    return (
      <Tip label="Its changes, Scratch and conversation are coming over">
        <span className={s.progress} role="status">
          <Icon name="laptop" size={14} />
          Copying…
        </span>
      </Tip>
    );
  }
  const received = Math.min(fork.received ?? 0, total);
  const here = received >= total;
  const pct = total ? Math.floor((received / total) * 100) : 100;
  const files = fork.files ? `, ${fork.files} ${fork.files === 1 ? 'file' : 'files'}` : '';
  const tip = here ? 'All here: making it a worktree of yours' : `${formatBytes(received)} of ${formatBytes(total)}: its commits${files} and the conversation`;
  return (
    <Tip label={tip}>
      <span className={s.progress} role="progressbar" aria-label={here ? 'Setting up your fork' : 'Copying your fork'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <Icon name="laptop" size={14} />
        {here ? 'Setting up…' : `Copying ${pct}%`}
        <span className={s.bar} aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
      </span>
    </Tip>
  );
}

/**
 * In a friend's worktree you work in (shared over the network), in its header: Fork to My {computerTitle()},
 * how far a fork got (waiting for their Mac, copying), and Open My Fork once it's made.
 */
export function ForkToMacButton({ owner, wsId }: { owner: string; wsId: string }) {
  const actions = useActions();
  const ws = useApp((st) => st.shared.find((w) => w.id === wsId && w.owner === owner));
  const fork = useApp((st) => st.forks[wsId]);
  const mine = useApp((st) => (fork?.wsId ? findWorkspace(st.projects, fork.wsId) : undefined));
  const ownerName = useApp((st) => st.network.friends.find((f) => f.peerId === owner)?.name ?? 'their');
  const online = useApp((st) => Boolean(st.network.friends.find((f) => f.peerId === owner)?.online));
  // A friend's plain chat has no project to fork.
  if (!ws || ws.via !== 'mesh' || ws.role !== 'contribute' || ws.chat) return null;
  if (fork?.state === 'ready' && mine && !mine.archived) {
    return (
      <Tip label={`Your fork, on ${mine.branch ?? 'its own branch'}`}>
        <Button variant="quiet" icon="laptop" onClick={() => actions.run({ type: 'view', view: { kind: 'workspace', id: mine.id, tab: 'chat' } })}>
          Open My Fork
        </Button>
      </Tip>
    );
  }
  if (fork?.state === 'copying') return <ForkProgress fork={fork} />;
  if (fork?.state === 'preparing') {
    const project = ws.project ?? 'the project';
    return (
      <Tip label={`${project} isn’t on ${thisComputer()} yet: it’s copied here first, then forked`}>
        <Button variant="quiet" icon="download" disabled aria-busy="true">
          {`Getting ${project}…`}
        </Button>
      </Tip>
    );
  }
  if (fork?.state === 'asking') {
    return (
      <Tip label={online ? `${ownerName}’s computer is packing it` : 'It goes as soon as their computer is back'}>
        <Button variant="quiet" icon="laptop" disabled aria-busy="true">
          {online ? 'Packing…' : `Waiting for ${ownerName}’s computer…`}
        </Button>
      </Tip>
    );
  }
  return (
    <Tip label={fork?.state === 'failed' ? `Last time: ${fork.error ?? 'it didn’t work'}. Try again` : `Your own copy of this worktree on ${thisComputer()}: its changes, Scratch and conversation`}>
      <Button variant="quiet" icon="laptop" onClick={() => openSheet({ kind: 'fork_to_mac', owner, wsId })}>
        Fork to My {computerTitle()}
      </Button>
    </Tip>
  );
}
