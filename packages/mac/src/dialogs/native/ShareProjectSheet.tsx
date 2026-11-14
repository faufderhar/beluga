import type { WsRole } from '@beluga/protocol.js';
import { cannotTake } from '@beluga/net/mesh/features.js';
import { ProjectIcon } from '../../components/ProjectIcon.js';
import { Avatar, Button } from '../../components/ui.js';
import { toast, useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { presenceOf } from '@beluga/core/friend-share-people.js';
import { Select } from '../settings-controls.js';
import { Section, Sheet, Tag } from './parts.js';
import { ACCESS, type Access, SharePicker } from './SharePicker.js';
import s from './sharing.module.css';
import { thisComputer } from '../../lib/os-words.js';

/**
 * Share with…: a project with friends over the network. Nobody hosts: it shows in each friend's
 * Projects with your avatar, its worktrees under it (new ones too), and stays while either of you
 * is offline. Like a worktree's Share sheet: pick a friend and what they can do (BLG-623), and who
 * has it is listed with their level, changed or removed in place.
 */
export function ShareProjectSheet({ projectId, close }: { readonly projectId: string; readonly close: () => void }) {
  const api = useApi();
  const { client } = useBeluga();
  const project = useApp((st) => st.projects.find((p) => p.id === projectId));
  const grants = useApp((st) => st.projectShares[projectId]);
  const network = useApp((st) => st.network);
  const peers = useApp((st) => st.peers);
  if (!project) return null;
  const friends = network.friends.filter((f) => grants?.[f.peerId]);
  const candidates = network.friends
    .filter((f) => !grants?.[f.peerId])
    .map((f) => {
      const why = cannotTake(f.name, f.beluga, 'share.project', f.online);
      return { peerId: f.peerId, name: f.name, ...(why ? { why } : {}) };
    });
  const none = !network.enabled ? 'Turn on the Beluga network in Settings to share with your friends.' : network.friends.length ? 'All your friends have it.' : 'No friends yet. Add a friend first, then share with them here.';
  const set = (peerId: string, access: Access): void => {
    const done = access === 'none' ? api.sharing.unshareFriend({ peerId, projectId }) : api.sharing.shareWithFriend({ peerId, projectId, role: access });
    void done.catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'warn'));
  };
  const worktrees = project.workspaces.filter((w) => !w.archived && !w.external && w.kind !== 'main').length;
  return (
    <Sheet
      title={`Share “${project.name}”`}
      subtitle={`Friends you add see it in their Projects with your avatar, with its ${worktrees === 1 ? 'worktree' : `${worktrees} worktrees`} (and new ones). Nobody needs to host, and it stays while either of you is offline.`}
      badge={<ProjectIcon id={project.id} name={project.name} size={36} />}
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
      <Section title="Share with">
        <SharePicker candidates={candidates} onShare={set} none={none} />
      </Section>
      <Section title="Friends with access">
        <div className={s.list} role="list" aria-label="Friends with access">
          {friends.map((f) => {
            const access: Access = grants?.[f.peerId]?.role ?? 'none';
            // Worktrees removed since don't count: only the ones they can still open.
            const only = grants?.[f.peerId]?.only?.filter((id) => project.workspaces.some((w) => w.id === id && !w.archived));
            const presence = presenceOf({ network, peers }, f.peerId);
            // Only some worktrees: said so, so it never reads as the whole project.
            const where = only ? (only.length === 1 ? 'in that worktree only' : 'in those worktrees only') : 'in all its worktrees, new ones too';
            const detail = access === 'contribute' ? `Talks to your agent ${where}` : `Follows along ${where}, read-only`;
            return (
              <div key={f.peerId} role="listitem" className={s.item}>
                <Avatar name={f.name} id={f.peerId} size={24} />
                <div className={s.itemText}>
                  <span className={s.itemTitle}>
                    {f.name} {presence.state === 'online' ? null : <Tag tone="muted">{presence.label}</Tag>} {only ? <Tag>{only.length === 1 ? 'one worktree' : only.length ? `${only.length} worktrees` : 'no worktrees now'}</Tag> : null}
                  </span>
                  <span className={s.itemDetail}>{detail}</span>
                </div>
                <Select<Access> label={`Access for ${f.name}`} value={access} options={ACCESS} onChange={(a) => set(f.peerId, a)} />
              </div>
            );
          })}
          {friends.length ? null : <div className={s.empty}>Not shared with anyone yet.</div>}
        </div>
      </Section>
      <p className={s.hint}>Your agent does the work, on {thisComputer()}. Risky steps still ask you, unless you fully trust the person asking.</p>
    </Sheet>
  );
}
