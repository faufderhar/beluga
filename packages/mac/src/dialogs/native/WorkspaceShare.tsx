import { useState } from 'react';
import type { WsRole } from '@beluga/protocol.js';
import { inviteChoice } from '@beluga/ui/invite-menus.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { shareRowDetail, worktreeShareRows, type WorktreeShareRow } from '@beluga/ui/worktree-share.js';
import { cannotTake } from '@beluga/net/mesh/features.js';
import { presenceOf } from '@beluga/core/friend-share-people.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Avatar, Button } from '../../components/ui.js';
import { toast, useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { openNet } from '../../network/net-sheets.js';
import { Select } from '../settings-controls.js';
import type { NativeMenuProps } from './index.js';
import { Choice, Section, Sheet, Tag } from './parts.js';
import { ACCESS, type Access, SharePicker } from './SharePicker.js';
import s from './sharing.module.css';
import { thisComputer } from '../../lib/os-words.js';

/**
 * Share a workspace with just this one worktree's people (BLG-340): pick a friend and what they can
 * do, Share (BLG-623); friends get it over the Beluga network with nobody in a room. Listed under it:
 * who has it (friends, and anyone from your room), each with their level, changed or removed in place.
 */
export function WorkspaceShareSheet({ menu, close }: NativeMenuProps<'ws_share'>) {
  const api = useApi();
  const { ui, client } = useBeluga();
  const ws = useApp((st) => findWorkspace(st.projects, menu.id));
  const project = useApp((st) => st.projects.find((p) => p.workspaces.some((w) => w.id === menu.id)));
  const self = useApp((st) => st.self);
  const network = useApp((st) => st.network);
  const peers = useApp((st) => st.peers);
  const members = useApp((st) => st.members);
  const projectShares = useApp((st) => st.projectShares);
  const projects = useApp((st) => st.projects);
  if (!ws) return null;
  // A chat says chat, never worktree; a plain one (in no project) has no project files to give, only its Scratch.
  const what = ws.kind === 'chat' ? 'chat' : 'worktree';
  const gives = project?.root ? 'its conversation, files and Scratch' : 'its conversation and Scratch';
  const rows = worktreeShareRows({ peers, self, members, network, projectShares, projects }, ws.id);
  const said = (p: Promise<unknown>): void => void p.catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'warn'));
  const set = (row: WorktreeShareRow, access: Access): void => {
    const where = { peerId: row.peerId, workspaceId: ws.id, ...(project ? { projectId: project.id } : {}) };
    if (row.via === 'room') said(access === 'none' ? api.sharing.remove(ws.id, row.peerId) : api.sharing.invite(ws.id, row.peerId, access));
    else said(access === 'none' ? api.sharing.unshareFriend(where) : api.sharing.shareWithFriend({ ...where, role: access }));
  };
  const shared = rows.filter((r) => r.access !== 'none');
  // Only friends are picked here; someone in your room who isn't one is invited from their name, or by link.
  const candidates = rows.flatMap((r) => {
    const friend = r.access === 'none' ? network.friends.find((f) => f.peerId === r.peerId) : undefined;
    if (!friend) return [];
    const why = r.via === 'network' ? cannotTake(friend.name, friend.beluga, 'share.project', friend.online) : undefined;
    return [{ peerId: r.peerId, name: r.name, ...(why ? { why } : {}) }];
  });
  const add = (peerId: string, role: WsRole): void => {
    const row = rows.find((r) => r.peerId === peerId);
    if (row) set(row, role);
  };
  const none = !network.enabled
    ? 'Turn on the Beluga network in Settings to share with your friends.'
    : network.friends.length
      ? 'All your friends have it.'
      : `No friends yet. Add a friend, then share this ${what} with them here.`;
  const byLink = (): void => ui.openMenu({ kind: 'invite_link', ...inviteChoice(project?.root ? project.id : undefined) });
  const addFriend = (): void => (close(), openNet({ kind: 'add_friend' }));
  return (
    <Sheet
      title={`Share “${ws.name}”`}
      subtitle={`Only this ${what}: people you add see ${gives}, and can ask your agent here. Friends get it over the Beluga network, so nobody needs to be in your room.`}
      icon="share"
      close={close}
      footer={
        <>
          {self?.host ? (
            <Button variant="quiet" icon="link" onClick={byLink}>
              Invite by Link…
            </Button>
          ) : (
            <Button variant="quiet" icon="people" onClick={addFriend}>
              Add a Friend…
            </Button>
          )}
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <Section title="Share with">
        <SharePicker candidates={candidates} onShare={(peerId, role) => add(peerId, role)} none={none} />
      </Section>
      <Section title="People with access">
        <div className={s.list} role="list" aria-label="People with access">
          {self ? (
            <div role="listitem" className={s.item}>
              <Avatar name={self.name} id={self.peerId} size={24} />
              <div className={s.itemText}>
                <span className={s.itemTitle}>{self.name} (you)</span>
                <span className={s.itemDetail}>Your agent does the work here, on {thisComputer()}</span>
              </div>
              <Tag>Owner</Tag>
            </div>
          ) : null}
          {shared.map((row) => {
            const friend = network.friends.find((f) => f.peerId === row.peerId);
            const presence = friend ? presenceOf({ network, peers }, row.peerId) : undefined;
            const inRoom = peers.some((p) => p.peerId === row.peerId);
            return (
              <div key={row.peerId} role="listitem" className={s.item}>
                <Avatar name={row.name} id={row.peerId} size={24} />
                <div className={s.itemText}>
                  <span className={s.itemTitle}>
                    {row.name} {presence && presence.state !== 'online' ? <Tag tone="muted">{presence.label}</Tag> : null}
                  </span>
                  <span className={s.itemDetail}>{shareRowDetail(row, inRoom, what)}</span>
                </div>
                <Select<Access> label={`Access for ${row.name}`} value={row.access} options={ACCESS} onChange={(a) => set(row, a)} />
              </div>
            );
          })}
          {shared.length ? null : <div className={s.empty}>Only you so far.</div>}
        </div>
      </Section>
      <p className={s.hint}>Your agent runs on your computer. Risky steps still ask you, unless you fully trust the person asking.</p>
    </Sheet>
  );
}

/** From a person: put them into one of your workspaces, one click each. */
export function InvitePersonSheet({ menu, close }: NativeMenuProps<'invite_person'>) {
  const api = useApi();
  const peer = useApp((st) => st.peers.find((p) => p.peerId === menu.peerId));
  const projects = useApp((st) => st.projects);
  const members = useApp((st) => st.members);
  const [role, setRole] = useState<WsRole>('contribute');
  const [filter, setFilter] = useState('');
  if (!peer) return null;
  const list = projects
    .flatMap((p) => p.workspaces.filter((w) => !w.archived && !w.external).map((w) => ({ w, label: p.root ? `${p.name} › ${w.name}` : w.name })))
    .filter((x) => x.label.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <Sheet
      title={`Invite ${peer.name} to a Workspace`}
      subtitle={`${peer.name} sees its conversation and files${role === 'contribute' ? ', and can ask your agent there' : ''}.`}
      badge={<Avatar name={peer.name} id={peer.peerId} size={36} />}
      close={close}
      footer={
        <>
          <span />
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <div className={s.field} style={{ gridTemplateColumns: '1fr auto' }}>
        <input className={s.input} placeholder="Filter workspaces" aria-label="Filter workspaces" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Choice<WsRole>
          label="They can"
          value={role}
          options={[
            { value: 'contribute', label: 'Work here' },
            { value: 'view', label: 'Follow' },
          ]}
          onChange={setRole}
        />
      </div>
      <div className={s.list} role="list" aria-label="Workspaces">
        {list.slice(0, 60).map(({ w, label }) => {
          const now = members[w.id]?.[peer.peerId];
          const icon: IconName = w.kind === 'chat' ? 'chat' : w.kind === 'main' ? 'folder' : 'branch';
          return (
            <div key={w.id} role="listitem" className={s.item} aria-label={label}>
              <Icon name={icon} size={14} className={s.itemIcon} />
              <div className={s.itemText}>
                <span className={s.itemTitle}>{label}</span>
                <span className={s.itemDetail}>{w.kind === 'chat' ? 'Chat' : w.kind === 'main' ? 'Main folder' : (w.branch ?? 'Worktree')}</span>
              </div>
              {now === role ? (
                <Tag tone="accent">
                  <Icon name="check" size={10} /> {now === 'contribute' ? 'Works here' : 'Follows'}
                </Tag>
              ) : (
                <Button size="small" onClick={() => void api.sharing.invite(w.id, peer.peerId, role)}>
                  {now ? (role === 'contribute' ? 'Let Work' : 'Make Follower') : 'Invite'}
                </Button>
              )}
            </div>
          );
        })}
        {list.length ? null : <div className={s.empty}>No workspaces match.</div>}
      </div>
    </Sheet>
  );
}
