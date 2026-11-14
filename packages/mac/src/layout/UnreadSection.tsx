import { usePrefs } from '../lib/prefs.js';
import { HarnessMark } from '../threads/HarnessMark.js';
import { type UnreadEntry, unreadEntries } from './attention-model.js';
import { EntryRow, useEntryList } from './EntryRow.js';
import { SignalMark } from './signal-marks.js';
import { Section } from './sidebar-parts.js';
import m from './signal.module.css';

/**
 * The top of the sidebar, like Slack's Unreads: every conversation that finished, got a
 * message, or needs you, one click away. Nothing waiting: it isn't there at all. The one you
 * open from here stays (plain, selected) while you're in it, so the list doesn't jump under you.
 */

export function UnreadSection() {
  const prefs = usePrefs();
  const list = useEntryList((state) => (prefs.unreadSection ? unreadEntries(state) : []));
  if (!prefs.unreadSection) return null;
  // In the place it had, so nothing moves under the pointer.
  const rows = list.kept ? [...list.entries.slice(0, list.kept.at), list.kept.entry, ...list.entries.slice(list.kept.at)] : list.entries;
  if (!rows.length) return null;
  return (
    <div role="region" aria-label="Unread" className={m.section}>
      <Section id="unread" title="Unread">
        {rows.map((e, at) => (
          <EntryRow
            key={e.channel}
            e={e}
            list={list}
            at={at}
            data-chat-row={chatRowOf(e)}
            trailing={
              <>
                <SignalMark signal={e.signal} />
                {e.kind === 'workspace' ? <HarnessMark ws={e.ws} /> : null}
              </>
            }
          />
        ))}
      </Section>
    </div>
  );
}

/** The chat a row can be dragged as, and takes a drop as (others have no address of yours). */
function chatRowOf(e: UnreadEntry): string | undefined {
  if (e.kind === 'plan') return e.plan.home;
  return e.kind === 'workspace' && e.ws.kind !== 'main' ? `ws:${e.ws.id}` : undefined;
}
