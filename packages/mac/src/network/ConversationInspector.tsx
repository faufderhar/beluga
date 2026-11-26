import type { ReactNode } from 'react';
import { Button, Tip } from '../components/ui.js';
import { TRUST_INFO } from '@beluga/core/trust.js';
import { TRUST_LEVELS, type TrustLevel } from '@beluga/shared/settings-schema.js';
import { PersonRules } from '../gateway/AccessSettings.js';
import { Select } from '../dialogs/settings-controls.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import { type ChatPerson, claudeLine, versionChip, waitingLabel } from '@beluga/core/chat-people.js';
import { APP_VERSION } from '../lib/boot.js';
import { PersonButton } from './PersonProfile.js';
import { PersonAvatar } from './Avatars.js';
import { showWaiting, useChatPeople } from './use-chat-people.js';
import { belugaLine, conversationOf, presenceLine, shownState, sortMembers } from './net-model.js';
import { openNet } from './net-sheets.js';
import s from '../layout/Inspector.module.css';
import n from './network.module.css';

function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className={s.panel}>
      <div className={s.panelHead}>
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.field}>
      <span className={s.fieldLabel}>{label}</span>
      <span className={s.fieldValue}>{children}</span>
    </div>
  );
}

/**
 * What this friend may do here: your trust in them (the one place it's set, BLG-202; the room's
 * menus, Settings and requests only say it and link here), and your rules for their requests.
 */
function FriendAccess({ peerId, name }: { peerId: string; name: string }) {
  const api = useApi();
  const { client } = useBeluga();
  const gateway = useApp((st) => st.gateway.enabled);
  const level = useApp((st): TrustLevel => st.levels[peerId] ?? st.remembered[peerId]?.trust ?? (st.policy === 'deny' ? 'blocked' : st.policy === 'auto' ? 'trusted' : 'ask'));
  const set = (v: TrustLevel): void =>
    void api.people.setTrust(peerId, v).catch((err: unknown) => client.store.dispatch({ type: 'toast', text: `Couldn't change it: ${err instanceof Error ? err.message : String(err)}`, level: 'error' }));
  return (
    <Panel title="Trust">
      <div className={s.wide}>
        <Select<TrustLevel> size="small" label={`Trust ${name}`} value={level} onChange={set} options={TRUST_LEVELS.map((l) => ({ value: l, label: TRUST_INFO[l].label, description: TRUST_INFO[l].detail }))} />
      </div>
      <p className={s.note}>{TRUST_INFO[level].detail}</p>
      {gateway ? <PersonRules peerId={peerId} compact /> : null}
    </Panel>
  );
}

/** Your trust in someone, in a word ("Trusted"), as their card sets it. */
function useTrustLabel(): (peerId: string) => string {
  const levels = useApp((st) => st.levels);
  const remembered = useApp((st) => st.remembered);
  const policy = useApp((st) => st.policy);
  return (peerId) => TRUST_INFO[levels[peerId] ?? remembered[peerId]?.trust ?? (policy === 'deny' ? 'blocked' : policy === 'auto' ? 'trusted' : 'ask')].label;
}

function PersonRow({ p, trust }: { p: ChatPerson; trust?: string }) {
  const chip = versionChip(p, APP_VERSION);
  const line = p.me || p.claude === 'offline' || p.claude === 'update' || !trust ? claudeLine(p) : `${trust} · ${claudeLine(p)}`;
  return (
    <li className={n.hereRow}>
      {p.me ? (
        <PersonAvatar name={p.name} id={p.peerId} state={p.presence} size={30} />
      ) : (
        <PersonButton peerId={p.peerId} name={p.name}>
          <PersonAvatar name={p.name} id={p.peerId} state={p.presence} size={30} />
        </PersonButton>
      )}
      <span className={n.hereText}>
        <span className={n.hereName}>{p.me ? 'You' : p.name}</span>
        <span className={n.hereLine}>{line}</span>
      </span>
      {chip ? <span className={chip.behind ? n.hereBehind : n.hereVersion}>{chip.text}</span> : null}
    </li>
  );
}

/**
 * Who's here (BLG-210): each person with presence, your trust in them, their Claude's state and
 * their Beluga's version (or what it needs), then what waits on whom.
 */
function PeopleHere({ id, title }: { id: string; title: string }) {
  const { people, waiting } = useChatPeople(id);
  const trust = useTrustLabel();
  return (
    <>
      <Panel title={title}>
        <ul className={n.hereList}>
          {people.map((p) => (
            <PersonRow key={p.peerId} p={p} {...(p.me ? {} : { trust: trust(p.peerId) })} />
          ))}
        </ul>
      </Panel>
      {waiting.length ? (
        <Panel title="Waiting">
          <ul className={n.hereList}>
            {waiting.map((w) => (
              <li key={`${w.target.kind}:${w.target.id}`}>
                <button type="button" className={n.waitRow} title={waitingLabel(w)} onClick={() => showWaiting(w)}>
                  <span className={n.hereName}>{w.on === 'you' ? 'On you' : `On ${w.onName}`}</span>
                  <span className={n.hereLine}>{w.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </>
  );
}

const since = (ts: number): string => new Date(ts).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });

/** The inspector beside a conversation with friends: who it's with (a friend, or a group's members). */
export function ConversationDetails({ id }: { id: string }) {
  const net = useApp((st) => st.network);
  const target = conversationOf(id);
  if (target?.kind === 'dm') {
    const f = net.friends.find((x) => x.peerId === target.peerId);
    if (!f) return null;
    return (
      <>
        <PeopleHere id={id} title="In this conversation" />
        <Panel title="Friend">
          <Field label="Name">{f.name}</Field>
          <Field label="Status">{presenceLine(f)}</Field>
          <Field label="Connection">{!f.online ? 'Not connected' : f.via === 'relay' ? 'Through another member’s computer' : 'Direct'}</Field>
          <Field label="Beluga">{belugaLine(f)}</Field>
          <Field label="Added">{since(f.addedAt)}</Field>
        </Panel>
        <FriendAccess peerId={f.peerId} name={f.name} />
      </>
    );
  }
  if (target?.kind === 'group') {
    const g = net.groups.find((x) => x.id === target.groupId);
    if (!g) return null;
    return (
      <>
        {g.active ? <PeopleHere id={id} title="In this channel" /> : null}
        <Panel
        title="Channel"
        action={
          <Button size="small" variant="quiet" icon="people" onClick={() => openNet({ kind: 'group_info', groupId: g.id })}>
            Info
          </Button>
        }
      >
        <Field label="Name">{g.name}</Field>
        <Field label="Members">
          <span className={n.stack} style={{ ['--ring' as string]: 'var(--bg-sunken)', flexWrap: 'wrap', rowGap: 4 }}>
            {sortMembers(g.members).map((m) => (
              <Tip key={m.peerId} label={m.self ? `${m.name} (you)` : `${m.name} · ${presenceLine(m)}${m.admin ? ' · admin' : ''}`}>
                <span style={{ marginRight: 4 }}>
                  {m.self ? (
                    <PersonAvatar name={m.name} id={m.peerId} size={20} />
                  ) : (
                    <PersonButton peerId={m.peerId} name={m.name}>
                      <PersonAvatar name={m.name} id={m.peerId} state={shownState(m)} size={20} />
                    </PersonButton>
                  )}
                </span>
              </Tip>
            ))}
          </span>
        </Field>
        <Field label="You">{g.active ? (g.admin ? 'Admin' : 'Member') : 'Left'}</Field>
        <Field label="Created">{since(g.createdAt)}</Field>
        </Panel>
      </>
    );
  }
  return null;
}
