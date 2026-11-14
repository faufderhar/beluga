import type { SharedProject } from '@beluga/core/friend-share-store.js';
import type { AppState } from '@beluga/core/store.js';
import { Icon } from '../components/Icon.js';
import { ActionsContext, ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { Avatar, IconButton, cx } from '../components/ui.js';
import pi from '../components/ProjectIcon.module.css';
import { useActions } from '../lib/actions.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { getPrefs, setPrefs, usePrefs } from '../lib/prefs.js';
import { sameDeep } from '../lib/stable.js';
import { signalOf } from './attention-model.js';
import { SignalMark, nameClass, signalClass } from './signal-marks.js';
import { Row, Section } from './sidebar-parts.js';
import { presenceOf } from '@beluga/core/friend-share-people.js';
import side from './Sidebar.module.css';
import g from './project-groups.module.css';
import s from './shared-projects.module.css';
import { computerTitle, thisComputer } from '../lib/os-words.js';

/**
 * What friends shared with you, apart from your own projects: a section per friend ("Ata's
 * conversations"), one row per project with the owner's avatar on its icon, its worktrees nested
 * under it as yours are. It stays while the owner's Mac is offline ("ata is offline"). A project
 * shared whole is also copied to this Mac (BLG-258): its row says where, and opens your copy.
 */

const foldKey = (p: Pick<SharedProject, 'owner' | 'id'>): string => `shared:${p.owner}/${p.id}`;

const hue = (name: string): number => [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 0);

/** The project's icon as its owner has it (or its initial), with the owner's avatar on its corner. */
function SharedIcon({ p, size = 16 }: { p: SharedProject; size?: number }) {
  const radius = Math.round(size * 0.24);
  return (
    <span className={s.icon}>
      {p.icon ? (
        <img className={pi.image} src={`data:${p.icon.mime};base64,${p.icon.data}`} alt="" width={size} height={size} style={{ borderRadius: radius }} draggable={false} />
      ) : (
        <span className={pi.tile} style={{ width: size, height: size, borderRadius: radius, fontSize: size * 0.58, ['--h' as string]: hue(p.name) }} aria-hidden="true">
          {(p.name.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase()}
        </span>
      )}
      <span className={s.badge}>
        <Avatar name={p.ownerName} id={p.owner} size={10} />
      </span>
    </span>
  );
}

/** `room`: worktrees shared through today's room (they go when the room ends), grouped as their project. */
function SharedProjectBlock({ p, room = false }: { p: SharedProject; room?: boolean }) {
  const actions = useActions();
  const api = useApi();
  const { client } = useBeluga();
  const open = usePrefs().openProjects.includes(foldKey(p));
  const view = useApp((st) => st.view);
  const owner = useApp((st) => presenceOf(st, p.owner), sameDeep);
  const rows = useApp((st) => p.worktrees.map((w) => ({ w, signal: signalOf(st, `ws:${w.id}`) })), sameDeep);
  const here = view.kind === 'shared' && view.owner === p.owner ? view.id : undefined;
  const toggle = (): void => {
    const rest = getPrefs().openProjects.filter((k) => k !== foldKey(p));
    setPrefs({ openProjects: open ? rest : [...rest, foldKey(p)] });
  };
  const leave = (): void => {
    const done = room ? Promise.all(p.worktrees.map((w) => api.sharing.leave(p.owner, w.id))) : api.sharing.leaveProject(p.owner, p.id);
    void done.catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'));
  };
  const copy = p.copy;
  const copyAgain = (): void => void api.sharing.copyProject(p.owner, p.id).catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'));
  const items: ActionItem[] = [
    ...(copy?.state === 'ready' && copy.projectId ? [{ label: 'Open Your Copy', icon: 'folder' as const, onSelect: () => actions.run({ type: 'view', view: { kind: 'project', id: copy.projectId! } }) }] : []),
    ...(copy?.state === 'failed' ? [{ label: `Copy to This ${computerTitle()} Again`, icon: 'download' as const, onSelect: copyAgain }] : []),
    { label: p.chats ? 'Leave These Chats' : 'Leave Project', icon: 'x', danger: true, onSelect: leave },
  ];
  const detail = room
    ? 'in your room'
    : owner.state === 'offline'
      ? `${p.ownerName} is offline`
      : owner.state === 'update'
        ? `${p.ownerName}'s Beluga needs an update`
        : copy?.state === 'copying'
          ? `Copying to ${thisComputer()}…`
          : copy?.state === 'failed'
            ? 'Couldn’t copy it here'
            : copy?.state === 'ready'
              ? `Your copy: ${tilde(copy.path ?? '')}`
              : p.role === 'contribute'
                ? 'you can work here'
                : 'you can follow along';
  const shown = open ? rows : rows.filter((r) => r.w.id === here);
  return (
    <>
      <ActionsContext items={items}>
        <Row
          className={cx(side.projectRow, here && side.currentProject, owner.state === 'offline' && s.away)}
          aria-expanded={rows.length ? open : undefined}
          aria-label={`${p.name}, shared by ${p.ownerName}`}
          icon={
            <span className={g.projectIcon}>
              {rows.length ? (
                <button type="button" className={g.foldButton} aria-label={open ? `Fold ${p.name}` : `Show what's in ${p.name}`} onClick={(e) => (e.stopPropagation(), toggle())}>
                  <Icon name="chevronRight" size={9} className={cx(g.disclosure, open && g.disclosureOpen)} />
                </button>
              ) : (
                <span className={g.foldButton} aria-hidden="true" />
              )}
              <SharedIcon p={p} />
            </span>
          }
          label={
            <span>{p.name}</span>
          }
          detail={detail}
          onClick={toggle}
          trailing={
            <>
              <span className={side.hoverTools}>
                <ActionsDropdown items={items}>
                  <IconButton icon="more" label={`More for ${p.name}`} onClick={(e) => e.stopPropagation()} />
                </ActionsDropdown>
              </span>
            </>
          }
        />
      </ActionsContext>
      {shown.map(({ w, signal }) => {
        const selected = here === w.id;
        return (
          <Row
            key={w.id}
            indent={2}
            selected={selected}
            className={signalClass(signal, selected)}
            data-signal-row={signal.level}
            aria-label={w.name}
            icon={<Icon name={w.branch ? 'branch' : 'chat'} size={13} />}
            label={<span className={nameClass(signal)}>{w.name}</span>}
            detail={signal.tip || (w.branch ? w.branch : 'chat')}
            onClick={() => actions.run({ type: 'open_shared', owner: p.owner, id: w.id, tab: 'chat' })}
            trailing={<SignalMark signal={signal} />}
          />
        );
      })}
    </>
  );
}

const tilde = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~');

/** One section per friend who shared something with you: "Ata's conversations". */
export function SharedProjects() {
  const projects = useApp((st) => st.sharedProjects);
  const room = useApp((st) => roomProjects(st), sameDeep);
  const all = [...projects.map((p) => ({ p, room: false })), ...room.map((p) => ({ p, room: true }))];
  const owners = [...new Map(all.map(({ p }) => [p.owner, p.ownerName])).entries()];
  return (
    <>
      {owners.map(([owner, name]) => (
        <Section key={owner} id={`shared:${owner}`} title={`${name}’s conversations`}>
          {all
            .filter(({ p }) => p.owner === owner)
            .map(({ p, room: inRoom }) => (
              <SharedProjectBlock key={foldKey(p)} p={p} room={inRoom} />
            ))}
        </Section>
      ))}
    </>
  );
}

/** Worktrees people in your room shared with you, one row per their project (as a friend's shared project reads). */
function roomProjects(st: AppState): SharedProject[] {
  const byProject = new Map<string, SharedProject>();
  for (const w of st.shared.filter((x) => x.via !== 'mesh')) {
    const key = `${w.owner}/room:${w.project}`;
    const p = byProject.get(key) ?? { owner: w.owner, ownerName: st.peers.find((x) => x.peerId === w.owner)?.name ?? 'someone', id: `room:${w.project}`, name: w.project || w.name, role: w.role, worktrees: [], members: [], updatedAt: 0 };
    byProject.set(key, { ...p, role: p.role === 'contribute' || w.role === 'contribute' ? 'contribute' : 'view', worktrees: [...p.worktrees, { id: w.id, name: w.name, ...(w.branch ? { branch: w.branch } : {}) }] });
  }
  return [...byProject.values()];
}
