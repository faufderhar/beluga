import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CallNotesView } from '@beluga/shared/calls.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { Avatar, IconButton, cx, personColor } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { useMyAgentName } from '../lib/agent-words.js';
import { namesOf } from './CallStrip.js';
import { clockOf, findTurns, lengthOf, marks, minuteMarks, timeline, turns, wordCount } from './notes-model.js';
import c from './notes.module.css';
import { thisComputer } from '../lib/os-words.js';

/* ---------- Which notes are open (one reader at a time, over its conversation) ---------- */

let openId: string | undefined;
const subs = new Set<() => void>();
const setOpen = (id: string | undefined): void => {
  openId = id;
  for (const f of [...subs]) f();
};
const useOpenNotes = (): string | undefined =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    () => openId,
  );

/** Who was in it, you last: "bob, mia and you". */
const peopleWords = (people: CallNotesView['people']): string => namesOf([...people.filter((p) => p.name !== 'You'), ...people.filter((p) => p.name === 'You').map(() => ({ name: 'you' }))]);

const dayOf = (at: number): string => new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });

/** The notes as Markdown: for copying, and for the private chat with your agent. */
export function notesMarkdown(v: CallNotesView, place: string): string {
  const time = new Date(v.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const lines = turns(v.lines).map((t) => `**${t.name}** (${clockOf(v.startedAt, t.at)}): ${t.text}`);
  // The first line names the chat it opens: short.
  return [`Call in ${place} · ${dayOf(v.startedAt)}`, '', `${time}, ${lengthOf(v)}, with ${peopleWords(v.people)}.`, '', ...lines].join('\n');
}

/**
 * A call's notes in the chat (BLG-715): one line however long the call was, since notes can run to
 * thousands of lines. A click opens them in the reader beside the chat.
 */
export function NotesBox({ notes }: { notes: CallNotesView; place: string }) {
  const open = useOpenNotes() === notes.id;
  const waiting = notes.people.filter((p) => !p.sent && p.name !== 'You');
  const words = wordCount(notes.lines);
  return (
    <div className={c.chipRow}>
      <button type="button" className={cx(c.chip, open && c.chipOpen)} aria-label="Call notes" aria-expanded={open} onClick={() => setOpen(open ? undefined : notes.id)}>
        <span className={c.mark} aria-hidden="true">
          <Icon name="book" size={13} />
        </span>
        <strong>Call notes</strong>
        <span className={c.chipMeta}>
          {lengthOf(notes)} · {peopleWords(notes.people)}
          {words ? ` · ${words.toLocaleString()} words` : ''}
          {waiting.length ? ` · waiting for ${namesOf(waiting)}` : ''}
        </span>
        <Icon name="chevronRight" size={12} className={c.chipGo} />
      </button>
    </div>
  );
}

/**
 * A call's notes named in a message (`call:<id>`, what Talk About It and agents write): a chip with
 * where and how long; a click opens the notes beside their chat.
 */
export function CallNotesChip({ id }: { id: string }) {
  const { client } = useBeluga();
  // Two plain picks (the store's own objects), so nothing new is made on each read.
  const conversation = useApp((st) => Object.entries(st.network.callNotes ?? {}).find(([, list]) => list.some((x) => x.id === id))?.[0]);
  const notes = useApp((st) => (conversation ? st.network.callNotes?.[conversation]?.find((x) => x.id === id) : undefined));
  const found = conversation && notes ? { conversation, notes } : undefined;
  const place = useApp((st) => {
    const c = found?.conversation;
    if (!c) return '';
    if (c === 'room') return 'the room';
    if (c.startsWith('dm:')) return st.network.friends.find((f) => f.peerId === c.slice(3))?.name ?? 'a friend';
    return `#${st.network.groups.find((g) => g.id === c.slice(6))?.name ?? 'channel'}`;
  });
  if (!found) {
    return (
      <span className={cx(c.inlineChip, c.inlineGone)} title={`These notes aren’t on ${thisComputer()}`}>
        <Icon name="book" size={11} />
        Call notes
      </span>
    );
  }
  const open = (): void => {
    if (found.conversation === 'room') client.store.dispatch({ type: 'view', view: { kind: 'room' } });
    else client.store.dispatch({ type: 'view', view: { kind: 'conversation', id: found.conversation } });
    setOpen(found.notes.id);
  };
  return (
    <button type="button" className={c.inlineChip} onClick={open} title="Open the notes beside their chat">
      <Icon name="book" size={11} />
      Call in {place} · {dayOf(found.notes.startedAt)} · {lengthOf(found.notes)}
    </button>
  );
}

/** The reader for a conversation's open notes, if any (CallRoom puts it beside the chat). */
export function NotesReaderFor({ conversation, place }: { conversation: string; place: string }) {
  const id = useOpenNotes();
  const notes = useApp((st) => (id ? st.network.callNotes?.[conversation]?.find((n) => n.id === id) : undefined));
  // Open notes show only beside their own conversation: elsewhere this draws nothing, and coming
  // back finds them still open (a chip in another chat may open them before going there).
  return notes ? <NotesReader notes={notes} place={place} /> : null;
}

/** A turn's words, with what the search found marked. */
function Said({ text, query }: { text: string; query: string }) {
  return (
    <>
      {marks(text, query).map((p, i) =>
        p.hit ? (
          <mark key={i} className={c.hit}>
            {p.text}
          </mark>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * A call's notes, made for long calls (BLG-715): like the chat (your words on the right, everyone
 * else's on the left), with search, one person's words only, and the call's timeline to jump
 * along: each turn a stripe in its speaker's color, the part you're reading shown on it.
 */
function NotesReader({ notes, place }: { notes: CallNotesView; place: string }) {
  const { client } = useBeluga();
  const agent = useMyAgentName();
  const all = useMemo(() => turns(notes.lines), [notes.lines]);
  const [query, setQuery] = useState('');
  const [only, setOnly] = useState<string | undefined>();
  const [hit, setHit] = useState(0);
  const [seen, setSeen] = useState<{ from: number; to: number }>({ from: 0, to: 0 });
  const list = useRef<HTMLOListElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => all.map((t, i) => ({ t, i })).filter(({ t }) => !only || t.by === only), [all, only]);
  const found = useMemo(() => findTurns(all, query).filter((i) => !only || all[i]!.by === only), [all, query, only]);
  const stripes = useMemo(() => timeline(notes, all), [notes, all]);
  const speakers = useMemo(() => notes.people.filter((p) => all.some((t) => t.by === p.peerId)), [notes.people, all]);

  const goTo = (index: number, smooth = true): void => {
    const el = list.current?.querySelector<HTMLElement>(`[data-turn="${index}"]`);
    el?.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    el?.animate([{ backgroundColor: 'color-mix(in srgb, var(--call) 22%, transparent)' }, { backgroundColor: 'transparent' }], { duration: 900, easing: 'ease-out' });
  };

  // ⌘F searches the notes while they're open; Esc closes them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        search.current?.focus();
      } else if (e.key === 'Escape' && document.activeElement !== search.current) setOpen(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Which part of the call is on screen, for the timeline.
  const onScroll = (): void => {
    const el = list.current;
    if (!el) return;
    const turnsEls = el.querySelectorAll<HTMLElement>('[data-turn]');
    let from = -1;
    let to = -1;
    for (const t of turnsEls) {
      const top = t.offsetTop - el.scrollTop;
      if (top + t.offsetHeight < 0 || top > el.clientHeight) continue;
      const i = Number(t.dataset['turn']);
      if (from < 0) from = i;
      to = i;
    }
    if (from >= 0) setSeen((s) => (s.from === from && s.to === to ? s : { from, to }));
  };
  useEffect(onScroll, [shown]);

  const step = (d: 1 | -1): void => {
    if (!found.length) return;
    const next = (hit + d + found.length) % found.length;
    setHit(next);
    goTo(found[next]!);
  };

  const span = Math.max(1, notes.endedAt - notes.startedAt);
  const seenFrom = all[seen.from] ? (all[seen.from]!.at - notes.startedAt) / span : 0;
  const seenTo = all[seen.to] ? (all[seen.to]!.until - notes.startedAt) / span : 0;
  const talk = (): void => {
    // A chip, never the transcript: the agent looks up what it needs with its call notes tools.
    // Its first words name the chat (Call in #launch · Nov 5); the chip says which call.
    const prompt = `Call in ${place} · ${dayOf(notes.startedAt)}: let’s talk about it. \`call:${notes.id}\`, with ${peopleWords(notes.people)}. Look up what was said with your call notes tools. Start with a short summary: what was decided, who’s doing what, and what’s still open.`;
    void client.api.workspaces.startChat('chats', prompt).catch((err: unknown) => client.store.dispatch({ type: 'toast', text: `Couldn’t open the chat: ${err instanceof Error ? err.message : String(err)}`, level: 'error' }));
  };
  const items: ActionItem[] = [
    { label: `Talk About It with ${agent}`, icon: 'sparkles', hint: 'A chat of your own, that only you see', onSelect: talk },
    { label: 'Copy the Notes', icon: 'copy', separate: true, onSelect: () => void copyText(notesMarkdown(notes, place)).then(() => client.store.dispatch({ type: 'toast', text: 'Copied the notes', level: 'success' })) },
    { label: 'Forget These Notes…', icon: 'trash', danger: true, separate: true, onSelect: () => void client.api.calls.forgetNotes(notes.id).then(() => setOpen(undefined)) },
  ];
  const meId = notes.people.find((p) => p.name === 'You')?.peerId;

  return (
    <aside className={c.reader} aria-label="Call notes reader">
      <header className={c.readerHead}>
        <span className={c.mark} aria-hidden="true">
          <Icon name="book" size={14} />
        </span>
        <div className={c.readerTitle}>
          <strong>Call notes</strong>
          <span>
            {dayOf(notes.startedAt)} · {lengthOf(notes)} · {peopleWords(notes.people)} · {wordCount(notes.lines).toLocaleString()} words
          </span>
        </div>
        <ActionsDropdown items={items}>
          <IconButton icon="more" label="More for these notes" />
        </ActionsDropdown>
        <IconButton icon="x" label="Close the Notes" onClick={() => setOpen(undefined)} />
      </header>

      <div className={c.tools}>
        <label className={c.search}>
          <Icon name="search" size={13} />
          <input
            ref={search}
            value={query}
            placeholder="Search the call"
            aria-label="Search the call"
            onChange={(e) => {
              setQuery(e.target.value);
              setHit(0);
              const first = findTurns(all, e.target.value).find((i) => !only || all[i]!.by === only);
              if (first !== undefined) goTo(first, false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
              if (e.key === 'Escape') {
                setQuery('');
                search.current?.blur();
              }
            }}
          />
          {query ? (
            <span className={c.found} aria-live="polite">
              {found.length ? `${hit + 1} of ${found.length}` : 'None'}
              <button type="button" aria-label="Previous" onClick={() => step(-1)} disabled={!found.length}>
                <Icon name="chevronUp" size={12} />
              </button>
              <button type="button" aria-label="Next" onClick={() => step(1)} disabled={!found.length}>
                <Icon name="chevronDown" size={12} />
              </button>
            </span>
          ) : null}
        </label>
        <div className={c.people} role="radiogroup" aria-label="Whose words">
          <button type="button" role="radio" aria-checked={!only} className={cx(c.person, !only && c.personOn)} onClick={() => setOnly(undefined)}>
            Everyone
          </button>
          {speakers.map((p) => (
            <button key={p.peerId} type="button" role="radio" aria-checked={only === p.peerId} className={cx(c.person, only === p.peerId && c.personOn)} onClick={() => setOnly(only === p.peerId ? undefined : p.peerId)}>
              <span className={c.dot} style={{ background: personColor(p.peerId) }} />
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* The whole call at a glance: a stripe per turn in its speaker's color; click to jump there. */}
      <div className={c.timeline} role="group" aria-label="The call’s timeline">
        {stripes.map((s) => (
          <button
            key={s.index}
            type="button"
            tabIndex={-1}
            aria-label={`${all[s.index]!.name} at ${clockOf(notes.startedAt, all[s.index]!.at)}`}
            className={cx(c.stripe, only && only !== s.by && c.stripeDim, found.includes(s.index) && c.stripeHit)}
            style={{ left: `${s.from * 100}%`, width: `${s.width * 100}%`, background: personColor(s.by) }}
            onClick={() => goTo(s.index)}
          />
        ))}
        <span className={c.seen} style={{ left: `${seenFrom * 100}%`, width: `${Math.max(0.6, (seenTo - seenFrom) * 100)}%` }} aria-hidden="true" />
        {minuteMarks(notes).map((m) => (
          <span key={m} className={c.minute} style={{ left: `${((m * 60_000) / span) * 100}%` }}>
            {m}:00
          </span>
        ))}
      </div>

      <ol ref={list} className={c.transcript} onScroll={onScroll}>
        {shown.length ? (
          shown.map(({ t, i }, k) => {
            const prev = shown[k - 1]?.t;
            const mine = t.by === meId;
            const runStart = !prev || prev.by !== t.by;
            const gap = prev && t.at - prev.until > 120_000;
            return (
              <li key={`${t.by}-${t.at}`} data-turn={i} className={cx(c.turn, mine ? c.mine : c.theirs, runStart && c.runStart, found[hit] === i && query && c.current)}>
                {gap ? <span className={c.gap}>{clockOf(notes.startedAt, t.at)}</span> : null}
                {!mine && runStart ? (
                  <span className={c.face}>
                    <Avatar name={t.name} id={t.by} size={22} />
                  </span>
                ) : null}
                <div className={c.bubbleCol}>
                  {runStart ? (
                    <span className={c.who}>
                      {mine ? null : <span style={{ color: personColor(t.by) }}>{t.name}</span>}
                      <time>{clockOf(notes.startedAt, t.at)}</time>
                    </span>
                  ) : null}
                  <p className={c.bubble} title={clockOf(notes.startedAt, t.at)}>
                    <Said text={t.text} query={query} />
                  </p>
                </div>
              </li>
            );
          })
        ) : (
          <li className={c.empty}>{notes.lines.length ? 'Nothing from them in this call.' : 'Nothing was written down.'}</li>
        )}
      </ol>
      <footer className={c.readerFoot}>Each person’s own words, written down on their Mac: expect small mistakes.</footer>
    </aside>
  );
}

