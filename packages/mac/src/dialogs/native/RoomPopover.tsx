import * as Popover from '@radix-ui/react-popover';
import { Avatar, Button, Dot } from '../../components/ui.js';
import { useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { thisComputer } from '../../lib/os-words.js';
import { Switch } from '../settings-controls.js';
import { openPerson } from './PersonPopover.js';
import { useFlash } from './parts.js';
import p from './person.module.css';
import r from './room.module.css';

type Tone = 'ok' | 'warn' | 'error';

const invite = (): void => void document.dispatchEvent(new CustomEvent('beluga:invite-room'));

/** What remote access is doing, in words. */
function reach(phase: string | undefined, detail: string | undefined, hasLink: boolean): string {
  if (phase === 'ready' || hasLink) return 'Friends anywhere can join with a link';
  if (phase === 'local') return 'Only people on this network can join';
  if (phase === 'failed') return detail ?? 'Couldn’t open remote access';
  if (phase) return 'Opening a secure link…';
  return 'Remote access opens when you invite someone';
}

/** The room's state in a few words: who's here, or how the connection is doing. */
function useRoomLine(): { readonly line: string; readonly tone: Tone } {
  const status = useApp((st) => st.status);
  const host = useApp((st) => st.self?.host === true);
  const reconnecting = useApp((st) => st.connection?.state === 'reconnecting');
  if (status === 'connected') return { line: host ? `Hosted on ${thisComputer()}` : 'Connected', tone: 'ok' };
  if (reconnecting) return { line: 'Reconnecting…', tone: 'warn' };
  return status === 'connecting' ? { line: 'Connecting…', tone: 'warn' } : { line: 'Offline', tone: 'error' };
}

/**
 * The room, as a part of your profile's card at the bottom of the sidebar: who's here, whether new
 * people can join, its link and Invite People…. Its buttons close the card they're in.
 */
export function RoomSection() {
  const api = useApi();
  const { ui } = useBeluga();
  const room = useApp((st) => st.room);
  const peers = useApp((st) => st.peers);
  const selfId = useApp((st) => st.selfId);
  const host = useApp((st) => st.self?.host === true);
  const roomOpen = useApp((st) => st.roomOpen);
  const link = useApp((st) => st.invite);
  const hosting = useApp((st) => st.hosting);
  const { line, tone } = useRoomLine();
  const [copied, flash] = useFlash();
  return (
    <section className={r.section} aria-label="Room">
      <div className={r.head}>
        {/* Yours reads "Your room", not your name back to you; someone else's keeps its name ("bob's room"). */}
        <div className={r.room}>{host ? 'Your room' : room}</div>
        <div className={r.line}>
          <Dot tone={tone} />
          {line}
        </div>
        {host ? <div className={r.dim}>{reach(hosting?.phase, hosting?.detail, Boolean(link))}</div> : null}
      </div>
      {peers.length > 1 ? (
        <div className={r.people} role="list" aria-label="People here">
          {peers.map((x, index) => (
            <Popover.Close asChild key={x.peerId}>
              <button
                type="button"
                role="listitem"
                className={r.person}
                onClick={() => setTimeout(() => openPerson(ui, index, document.querySelector<HTMLElement>(`[data-person-row="${CSS.escape(x.peerId)}"]`)), 0)}
                title={`${x.name}${x.peerId === selfId ? ' (you)' : ''}`}
              >
                <Avatar name={x.name} id={x.peerId} size={28} />
                <span>{x.peerId === selfId ? 'You' : x.name}</span>
              </button>
            </Popover.Close>
          ))}
        </div>
      ) : null}
      {host ? (
        <div className={r.row}>
          <div>
            <div>New people can join</div>
            <div className={r.dim}>{roomOpen ? 'Anyone with a link can come in (or knock).' : 'Closed: even with a link, nobody new gets in.'}</div>
          </div>
          <Switch label="New people can join" on={roomOpen} onChange={(v) => void api.session.setRoomOpen(v)} />
        </div>
      ) : null}
      <div className={r.buttons}>
        {link ? (
          <Button icon={copied ? 'check' : 'copy'} onClick={() => void api.session.copyInvite().then(() => flash('room'))}>
            {copied ? 'Copied' : 'Copy Link'}
          </Button>
        ) : null}
        <Popover.Close asChild>
          <Button variant="primary" icon="link" onClick={invite}>
            Invite People…
          </Button>
        </Popover.Close>
      </div>
    </section>
  );
}

/**
 * The room as a row of its own at the bottom of the sidebar, only while the Beluga network is off
 * (there's no profile then to hold it): its state in words, opening the room's card.
 */
export function RoomRow({ label }: { readonly label: string }) {
  const { tone } = useRoomLine();
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={r.status} aria-label={`${label}: room details`}>
          <Dot tone={tone} />
          <span className={r.statusLabel}>{label}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={`${p.card} ${r.card}`} side="top" align="start" sideOffset={8} collisionPadding={10} aria-label="Room">
          <RoomSection />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
