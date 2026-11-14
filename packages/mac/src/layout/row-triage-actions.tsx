import { useEffect, useState } from 'react';
import { type AppState } from '@beluga/core/store.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import { laterUntil, triageFacts } from '@beluga/core/triage/facts.js';
import { type ChatCategory, categoryOf, settleRefusal, triageKey } from '@beluga/core/triage/model.js';
import { remindLabel, remindPresets } from '@beluga/shared/remind.js';
import { Sheet } from '../dialogs/native/parts.js';
import { ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { Button, IconButton } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { toast, useBeluga } from '../lib/beluga.js';
import { type CategoryEntry, conversationEntries, nextActive, wakeWords } from './attention-model.js';
import { hereOf, openEntry } from './EntryRow.js';
import { toolbarActions } from './toolbar-actions.js';
import s from './Sidebar.module.css';

/**
 * Changing a chat's category: the buttons on its row, the same in its right-click menu, and the
 * sheet for a reminder at a time you pick. Remind Me Later (a snooze, in the code) is there with
 * the categories off too, for your own chats and worktrees; the rest only while `chatCategories` is on.
 */

type Run = ReturnType<typeof useActions>['run'];
type Client = ReturnType<typeof useBeluga>['client'];

const CUSTOM_SNOOZE = 'beluga:snooze-custom';

/** What a reminder time is for, once picked. */
type LaterPick = (until: number) => void;

/**
 * The right-click items of a chat, by channel: none for what has no category. With the setting off,
 * only Remind Me Later, and only on your own chats and worktrees (a plan's or a friend's row has no
 * Later row to go to then).
 */
export function triageItems(state: AppState, channel: string, run: Run, client: Client): ActionItem[] {
  const key = triageKey(state, channel);
  if (!key) return [];
  if (!state.prefs.chatCategories) return key === channel && channel.startsWith('ws:') && !state.shared.some((w) => `ws:${w.id}` === channel) ? [laterItem(state, channel, run, client)] : [];
  const record = state.triage[key];
  const facts = triageFacts(state, key);
  const category = categoryOf(record, facts);
  const refusal = settleRefusal(record, facts, 'you');
  const auto = record?.autoSettle !== false;
  return [
    { label: 'Work Again', icon: 'chat', separate: true, onSelect: () => workAgain(client, run, channel) },
    category === 'snoozed' ? showAgainItem(state, channel, client) : laterItem(state, channel, run, client),
    ...(category === 'settled'
      ? [{ label: 'Un-settle', icon: 'inbox' as const, onSelect: () => unsettle(client, channel) }]
      : [{ label: 'Settle', icon: 'check' as const, ...(refusal ? { disabled: true, hint: refusal } : {}), onSelect: () => settle(client, run, channel) }]),
    { label: `Auto-settle: ${auto ? 'on' : 'off'}`, onSelect: () => call(client, () => client.api.triage.setAutoSettle(channel, !auto)) },
  ];
}

export function RowTriageTools({ e }: { e: CategoryEntry }) {
  const actions = useActions();
  const { client } = useBeluga();
  return (
    <span className={s.hoverTools}>
      {toolsOf(e.category).includes('snooze') ? (
        <ActionsDropdown items={snoozeItems(client, actions.run, e.channel)}>
          <IconButton icon="clock" label={`Remind me later about ${e.name}`} onClick={(ev) => ev.stopPropagation()} />
        </ActionsDropdown>
      ) : null}
      {toolsOf(e.category).includes('settle') ? <IconButton icon="check" label={`Settle ${e.name}`} onClick={(ev) => (ev.stopPropagation(), settle(client, actions.run, e.channel))} /> : null}
      {toolsOf(e.category).includes('wake') ? <IconButton icon="eye" label={`Show ${e.name} again now`} onClick={(ev) => (ev.stopPropagation(), wake(client, e.channel))} /> : null}
      {toolsOf(e.category).includes('unsettle') ? <IconButton icon="inbox" label={`Un-settle ${e.name}`} onClick={(ev) => (ev.stopPropagation(), unsettle(client, e.channel))} /> : null}
      {/* Settled, and done with: put it away (Archive…, as from its menu). */}
      {e.category === 'settled' && e.kind === 'workspace' && canArchive(client.store.getState(), e.ws) ? (
        <IconButton icon="archive" label={`Archive ${e.name}`} onClick={(ev) => (ev.stopPropagation(), actions.run({ type: 'ws', id: e.ws.id, action: 'archive' }))} />
      ) : null}
    </span>
  );
}

/** Custom…: a date and a time, from any menu that offers it. */
export function SnoozeCustomSheet() {
  // What the time you pick is for: one chat's reminder, or the picked chats'.
  const [pick, setPick] = useState<(until: number) => void>();
  const [value, setValue] = useState('');
  useEffect(() => {
    const show = (e: Event): void => {
      setValue('');
      const detail = (e as CustomEvent<LaterPick>).detail;
      setPick(() => detail);
    };
    document.addEventListener(CUSTOM_SNOOZE, show);
    return () => document.removeEventListener(CUSTOM_SNOOZE, show);
  }, []);
  if (!pick) return null;
  const until = value ? new Date(value).getTime() : 0;
  const ok = until > Date.now();
  const confirm = (): void => {
    if (!ok) return;
    pick(until);
    setPick(undefined);
  };
  return (
    <Sheet
      title="Remind me at"
      icon="clock"
      close={() => setPick(undefined)}
      onReturn={confirm}
      footer={
        <>
          <Button onClick={() => setPick(undefined)}>Cancel</Button>
          <Button variant="primary" disabled={!ok} onClick={confirm}>
            Remind Me
          </Button>
        </>
      }
    >
      <input type="datetime-local" aria-label="Date and time" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
    </Sheet>
  );
}

/** Remind Me Later's times, for `pick`: the presets, and Custom… (a date and a time, in the sheet). */
export function laterTimes(pick: LaterPick): ActionItem[] {
  const now = Date.now();
  return [
    ...remindPresets(now).map((p) => ({ label: p.label, keys: wakeWords(p.at, now), onSelect: () => pick(p.at) })),
    { label: 'Custom…', separate: true, onSelect: () => document.dispatchEvent(new CustomEvent<LaterPick>(CUSTOM_SNOOZE, { detail: pick })) },
  ];
}

/** Archive is there for it (as on its menu): not a sub-agent's, nothing that keeps it. */
function canArchive(state: AppState, ws: Workspace): boolean {
  const { primary, icons, more } = toolbarActions(state, ws);
  return [...(primary ? [primary] : []), ...icons, ...more.flat()].some((a) => a.action === 'archive' && !a.disabled);
}

function toolsOf(category: ChatCategory): readonly ('snooze' | 'settle' | 'wake' | 'unsettle')[] {
  switch (category) {
    case 'active':
      return ['snooze', 'settle'];
    case 'working':
      return ['snooze'];
    case 'snoozed':
      return ['wake'];
    case 'settled':
      return ['unsettle'];
  }
}

/** Remind Me Later ▸ when (BLG-748, BLG-770). */
function laterItem(state: AppState, channel: string, run: Run, client: Client): ActionItem {
  const until = laterUntil(state, channel);
  // Woken by a question while put off: it still says when, and asking again sets a new time.
  if (until !== undefined && !state.prefs.chatCategories) return showAgainItem(state, channel, client);
  return { label: 'Remind Me Later', icon: 'clock', submenu: snoozeItems(client, run, channel), onSelect: () => undefined };
}

/** Show Again Now: the reminder is called off, and the chat is back in place. */
function showAgainItem(state: AppState, channel: string, client: Client): ActionItem {
  const until = laterUntil(state, channel);
  return { label: 'Show Again Now', icon: 'eye', ...(until !== undefined ? { hint: remindLabel(until) } : {}), onSelect: () => void wake(client, channel) };
}

function snoozeItems(client: Client, run: Run, channel: string): ActionItem[] {
  return laterTimes((until) => snooze(client, run, channel, until));
}

function settle(client: Client, run: Run, channel: string): void {
  const next = nextIfOpen(client.store.getState(), channel);
  void call(client, () => client.api.triage.settle(channel)).then((done) => {
    if (done && next) openEntry(next, run, client);
  });
}

function snooze(client: Client, run: Run, channel: string, until: number): void {
  const next = nextIfOpen(client.store.getState(), channel);
  void call(client, () => client.api.triage.snooze(channel, until)).then((done) => {
    if (done && next) openEntry(next, run, client);
  });
}

export const wake = (client: Client, channel: string): Promise<boolean> => call(client, () => client.api.triage.wake(channel));

export const unsettle = (client: Client, channel: string): Promise<boolean> => call(client, () => client.api.triage.unsettle(channel));

/** Opens the chat and puts you in its message box. It doesn't change the category: sending does. */
function workAgain(client: Client, run: Run, channel: string): void {
  const state = client.store.getState();
  const entry = conversationEntries(state).find((e) => e.channel === channel);
  if (entry) openEntry(entry, run, client);
  else if (channel.startsWith('ws:')) run({ type: 'open_ws', id: channel.slice(3) });
  focusComposerSoon();
}

/** The box can arrive after the chat opens (a plan's page loads its conversation first): ask until a box has the focus, for at most about two seconds. */
function focusComposerSoon(tries = 50): void {
  setTimeout(() => {
    document.dispatchEvent(new CustomEvent('beluga:focus-composer'));
    if (tries > 1 && document.activeElement?.tagName !== 'TEXTAREA') focusComposerSoon(tries - 1);
  }, 40);
}

/** Settling or putting off the chat you're in moves you on (with the categories on); with no row left, you stay. */
function nextIfOpen(state: AppState, channel: string): CategoryEntry | undefined {
  if (!state.prefs.chatCategories) return undefined;
  const key = triageKey(state, channel);
  const here = hereOf(state);
  if (!key || !here || triageKey(state, here) !== key) return undefined;
  return nextActive(state, channel);
}

async function call(client: Client, what: () => Promise<unknown>): Promise<boolean> {
  try {
    await what();
    return true;
  } catch (err) {
    toast(client, err instanceof Error ? err.message : String(err), 'error');
    return false;
  }
}
