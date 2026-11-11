import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatFile } from '@beluga/net/mesh/views.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { IconButton, Tip, cx } from '../components/ui.js';
import { inApp } from '../lib/boot.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { useMyAgent } from '../lib/agent-words.js';
import { type AgentMark, agentMark } from '@beluga/shared/agent-marks.js';
import { handleInvite } from '../lib/invite-command.js';
import { usePrefs } from '../lib/prefs.js';
import { chordLabel } from '../lib/shortcuts-model.js';
import { cmdReturn, returnName, yourComputer } from '../lib/os-words.js';
import { quoted } from '../chat/message-menu.js';
import { DictationStrip, MicButton } from '../chat/Dictation.js';
import { useDictationTarget } from '../lib/dictation.js';
import { MentionHighlighter } from '../chat/MentionHighlighter.js';
import { useSuggestions } from '../chat/Suggestions.js';
import { usePastePaths } from '../chat/paste-paths.js';
import { plainWorktrees, worktreeNamesOf } from '../chat/worktree-box.js';
import { PendingTray } from './ChatFiles.js';
import { addBlobs, addPaths, restorePending, takePending, usePending } from './attachments.js';
import { type Ask, type ChannelSuggestion, askLabel, askTo, channelSuggestions, channelTasks, channelWorld, mentionedAsk, mergeAsk } from './chat-model.js';
import type { TaskMention } from '@beluga/shared/task-refs.js';

/** The tasks this chat can name: those of repositories you're teamed up on with its people (BLG-263). */
export function useChannelTasks(people: ReadonlyArray<{ readonly peerId: string; readonly name: string }>): readonly TaskMention[] {
  const issues = useApp((st) => st.board.issues);
  const team = useApp((st) => st.team);
  return useMemo(() => channelTasks(issues, team, people), [issues, team, people]);
}
import c from '../chat/composer.module.css';
import s from './network.module.css';

/** What you were writing in each conversation (kept while the app runs, like Messages). */
const drafts = new Map<string, string>();

/** Start the words in a conversation's box (shown when it opens): after what's there, if anything. */
export function draftIn(conversation: string, text: string): void {
  const was = drafts.get(conversation)?.trim();
  drafts.set(conversation, was ? `${was} ${text}` : text);
}

/** Put a quote in the message box of the conversation on screen. */
export const QUOTE_EVENT = 'beluga:net-quote';
/** Ask a Claude with the next message (the menu, a message's "Ask Claude About This"). */
export const ASK_EVENT = 'beluga:net-ask';

const MAX = 8000;

export interface Outgoing {
  readonly text: string;
  readonly files: readonly ChatFile[];
  readonly ask?: 'all' | readonly string[];
}

export interface Person {
  readonly peerId: string;
  readonly name: string;
}

/** Pick files with the standard Open panel (in a browser, the page's file picker). */
async function pickFiles(client: ReturnType<typeof useBeluga>['client'], id: string, input: HTMLInputElement | null): Promise<void> {
  if (!inApp()) return void input?.click();
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: true, title: 'Send Files' });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  if (paths.length) await addPaths(client, id, paths);
}

/** Whose agent answers, as a mark: yours by its runtime, everyone's as people, someone else's as the agent glyph (their runtime isn't known here). */
const askMark = (ask: Ask | undefined, mine: AgentMark): AgentMark | 'people' | 'claude' => (!ask || ask.kind === 'me' ? mine : ask.kind === 'all' ? 'people' : 'claude');

/**
 * The Claude button, for the next message only: "Ask: your Claude" (BLG-210). Alone with your
 * Claude: one toggle. With others: the same toggle, and beside it a chevron for everyone's or one
 * person's; once picked, the toggle says whose ("Ask: mia's Claude") and a click takes it back.
 */
function AskButton({ ask, setAsk, people, me }: { ask: Ask | undefined; setAsk: (a: Ask | undefined) => void; people: readonly Person[]; me?: Person }) {
  const mine = ask?.kind === 'me';
  const myMark = agentMark(useMyAgent());
  const whose = ask && ask.kind !== 'me' ? askLabel(ask, true) : 'your agent';
  const toggle = (
    <Tip label={ask ? `${askLabel(ask, true)} answers this message · click to just send it` : 'Your agent answers this message, from this conversation · or type @claude, which asks your agent whichever it is'}>
      <button type="button" className={cx(c.chip, people.length > 0 && s.askMain, ask && c.chipOn)} aria-label={`Ask: ${whose}`} aria-pressed={Boolean(ask)} disabled={!me} onClick={() => setAsk(ask ? undefined : { kind: 'me' })}>
        <Icon name={askMark(ask, myMark)} size={13} />
        {/* Beside a shared screen the box is narrow: the words step aside, Send stays in it. */}
        <span className={c.chipLabel}>Ask: {whose}</span>
      </button>
    </Tip>
  );
  if (!people.length) return toggle;
  const items: ActionItem[] = [
    { label: 'Your Agent', icon: myMark, checked: mine, hint: `It answers here, from ${yourComputer()}`, onSelect: () => setAsk({ kind: 'me' }) },
    { label: people.length === 1 ? 'Both Agents' : 'Everyone’s Agent', icon: 'people', checked: ask?.kind === 'all', hint: 'Each answers from their own computer', onSelect: () => setAsk({ kind: 'all' }) },
    ...people.map((p, i) => ({ label: `${p.name}’s Agent`, separate: i === 0, checked: ask?.kind === 'person' && ask.peerId === p.peerId, hint: `From ${p.name}’s computer`, onSelect: () => setAsk({ kind: 'person', peerId: p.peerId, name: p.name }) })),
    ...(ask ? [{ label: 'Don’t Ask an Agent', separate: true, onSelect: () => setAsk(undefined) }] : []),
  ];
  return (
    <span className={s.askSplit} role="group" aria-label="Ask an agent">
      {toggle}
      <ActionsDropdown items={items} align="start">
        <button type="button" className={cx(c.chip, s.askMore, ask && c.chipOn)} aria-label="Ask Someone Else’s Agent" disabled={!me}>
          <Icon name="chevronDown" size={9} />
        </button>
      </ActionsDropdown>
    </span>
  );
}

/**
 * The message box of a conversation with friends: words, files (paper clip, paste, or drop
 * anywhere on the conversation) and, only when you choose, a Claude to answer. Return sends
 * (or ⌘Return, as in Settings); a failed send puts everything back.
 */
export function NetComposer({ id, placeholder, people, me, send, addPeople, note }: { id: string; placeholder: string; people: readonly Person[]; me?: Person; send: (out: Outgoing) => Promise<unknown>; addPeople?: () => void; note?: string }) {
  const { client, ui } = useBeluga();
  const prefs = usePrefs();
  const [text, setText] = useState(() => drafts.get(id) ?? '');
  const [ask, setAsk] = useState<Ask>();
  const myMark = agentMark(useMyAgent());
  const pending = usePending(id);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // @ and / as you type: the Claudes and people here, and the channel's commands.
  const friends = useApp((st) => st.network.friends);
  const tasks = useChannelTasks(people);
  const items = useMemo(() => (text ? channelSuggestions(text, { people, admin: Boolean(addPeople), friends, tasks }) : []), [text, people, addPeople, friends, tasks]);
  const world = useMemo(() => channelWorld(me, people, tasks), [me, people, tasks]);
  const write = (next: string): void => {
    setText(next);
    sug.reset();
  };
  const run = (picked: ChannelSuggestion): void => {
    if (!picked.command) return write(picked.value);
    write('');
    if (picked.command === 'claude') setAsk({ kind: 'me' });
    else if (picked.command === 'claudes') setAsk({ kind: 'all' });
    else if (picked.command === 'files') void pickFiles(client, id, picker.current);
    else addPeople?.();
  };
  const sug = useSuggestions(items, text, run);
  // A pasted path of a file on this Mac: the file goes, as if dropped.
  const pastePaths = usePastePaths(ref, (files) => void addPaths(client, id, files.map((f) => f.path)));
  useEffect(() => {
    setText(drafts.get(id) ?? '');
    setAsk(undefined);
    ref.current?.focus();
  }, [id]);
  useEffect(() => {
    if (text) drafts.set(id, text);
    else drafts.delete(id);
  }, [id, text]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 12 * 20 + 16)}px`;
  }, [text]);
  useEffect(() => {
    const quote = (e: Event): void => {
      const q = (e as CustomEvent<string>).detail;
      setText((t) => `${quoted(q)}\n\n${t.trim()}`);
      ref.current?.focus();
    };
    const asked = (e: Event): void => {
      setAsk((e as CustomEvent<Ask>).detail);
      ref.current?.focus();
    };
    const focus = (): void => ref.current?.focus();
    document.addEventListener(QUOTE_EVENT, quote);
    document.addEventListener(ASK_EVENT, asked);
    document.addEventListener('beluga:focus-composer', focus);
    return () => {
      document.removeEventListener(QUOTE_EVENT, quote);
      document.removeEventListener(ASK_EVENT, asked);
      document.removeEventListener('beluga:focus-composer', focus);
    };
  }, []);
  const over = text.length > MAX;
  const adding = pending.some((p) => p.state === 'adding');
  const ready = pending.filter((p) => p.state === 'ready');
  // Asking a Claude needs no words: it reads the conversation and answers what's open.
  const canSend = !over && !adding && (Boolean(text.trim()) || ready.length > 0 || Boolean(ask && me));
  const submit = (): void => {
    if (!canSend) return;
    const body = text.trim();
    // /invite adds a friend, or adds the friends named to this conversation (BLG-203): never sent as a message.
    if (handleInvite(client, ui, body)) return setText('');
    const files = takePending(id);
    // The button and the words' mentions ("@claude", "@claude:mia", "@claudes") together; the words stay as typed.
    const to = me ? mergeAsk(ask ? askTo(ask, me.peerId) : undefined, mentionedAsk(body, me.peerId, people)) : undefined;
    setText('');
    setAsk(undefined);
    // Worktrees' links written short in the box go out whole ("worktree:wt-…", BLG-887).
    send({ text: plainWorktrees(body, worktreeNamesOf(client.store.getState().projects)), files, ...(to ? { ask: to } : {}) }).catch(() => {
      // Nothing is lost: the words and files come back (ahead of anything new).
      setText((t) => (t.trim() ? `${body}\n${t}` : body));
      restorePending(id, files);
      client.store.dispatch({ type: 'toast', text: 'Your message wasn’t sent. It’s back in the box.', level: 'warn' });
    });
  };
  // Speaking instead of typing (Settings › Voice): the words come here when this is the box you're in.
  useDictationTarget(ref, submit);
  const sendKeys = prefs.sendWith === 'enter' ? '↩' : chordLabel('Cmd+Enter');
  const label = ask ? `${askLabel(ask)} · ` : '';
  return (
    <div className={c.wrap}>
      {sug.list}
      <div className={cx(c.box, ask && c.asking)}>
        {ask ? (
          <span className={c.askChip}>
            <Icon name={askMark(ask, myMark)} size={12} />
            {askLabel(ask)}
            <button type="button" aria-label="Don’t ask an agent" onClick={() => setAsk(undefined)}>
              <Icon name="x" size={10} />
            </button>
          </span>
        ) : null}
        <PendingTray id={id} items={pending} />
        <DictationStrip box={ref} />
        <div className={c.inputWrap}>
          <MentionHighlighter text={text} world={world} input={ref} className={c.input ?? ''} />
          <textarea
            ref={ref}
            className={`${c.input} ${c.overHighlight} selectable`}
            rows={1}
            value={text}
            placeholder={ask ? `${askLabel(ask)}: write a question, or just send and it reads the conversation` : placeholder}
            aria-label={placeholder}
            spellCheck
            onChange={(e) => write(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.items].flatMap((it) => (it.kind === 'file' ? [it.getAsFile()].filter((f): f is File => Boolean(f)) : []));
              if (!files.length) return void pastePaths(e);
              e.preventDefault();
              void addBlobs(client, id, files);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (sug.onKeyDown(e)) return;
              if (e.key === 'Escape' && ask) {
                e.preventDefault();
                setAsk(undefined);
                return;
              }
              if (e.key !== 'Enter') return;
              const modKey = e.metaKey || e.ctrlKey;
              const sends = prefs.sendWith === 'enter' ? !e.shiftKey && !modKey : modKey;
              if (!sends) return;
              e.preventDefault();
              submit();
            }}
          />
        </div>
        <div className={c.bar}>
          <AskButton ask={ask} setAsk={setAsk} people={people} {...(me ? { me } : {})} />
          {people.length ? (
            <Tip label="Mention someone here, or their agent · or type @">
              <button
                type="button"
                className={c.chip}
                aria-label="Friends"
                onClick={() => {
                  write(text && !/\s$/.test(text) ? `${text} @` : `${text}@`);
                  ref.current?.focus();
                }}
              >
                <Icon name="people" size={13} />
                <span className={c.chipLabel}>Friends</span>
              </button>
            </Tip>
          ) : null}
          <IconButton icon="clip" label="Send Files…" onClick={() => void pickFiles(client, id, picker.current)} />
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) void addBlobs(client, id, files);
            }}
          />
          <span className={c.flex} />
          {note ? (
            <span className={s.offlineNote} role="note">
              {note}
            </span>
          ) : null}
          {text.length > MAX - 500 ? <span className={cx(s.counter, over && s.counterOver)}>{MAX - text.length}</span> : null}
          <MicButton box={ref} />
          <Tip label={`${label}${prefs.sendWith === 'enter' ? `Send · Shift+${returnName()} for a new line` : `Send · ${cmdReturn()}`}`} keys={sendKeys}>
            <button type="button" className={cx(c.send, canSend && c.sendReady)} onClick={submit} aria-label={ask ? `Send and ${askLabel(ask).toLowerCase()}` : 'Send'} disabled={!canSend}>
              <Icon name="send" size={14} />
            </button>
          </Tip>
        </div>
      </div>
    </div>
  );
}
