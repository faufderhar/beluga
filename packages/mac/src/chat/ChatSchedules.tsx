import { CLAUDE_CHANGED, type ChatSchedule, chatSchedules, scheduleSentence } from '@beluga/core/sentinel/model.js';
import { activeAssistantChannel, assistantChannel } from '@beluga/shared/assistant.js';
import { Button, Dot, Tip } from '../components/ui.js';
import { Switch } from '../dialogs/settings-controls.js';
import { useApp } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { Panel } from '../layout/inspector-parts.js';
import { nextText } from '../sentinel/sentinel-model.js';
import { useSentinelActions } from '../sentinel/use-sentinel.js';
import { askToSchedule } from './schedule-mode.js';
import { scheduleSpent } from './schedule-model.js';
import s from './chat-schedules.module.css';

/**
 * A chat's schedules (BLG-399), in its Info panel: each sentinel whose chat step wakes this chat,
 * with its status dot, when it runs, Run Now and an on/off switch; a click opens its page. A
 * one-time schedule that already ran reads as done, with no switch. Only when the chat has one.
 */

type Tone = 'ok' | 'warn' | 'muted' | 'claude';

/** The Schedules section for the chat a view shows: a worktree or project chat (`ws:<id>`), or a Your Mac chat. */
export function ChatSchedules({ channel }: { channel: string }) {
  const rows = useApp((st) => (st.selfId ? chatSchedules(st.sentinel, `${st.selfId}/${channel}`) : []), sameDeep);
  const names = useApp((st) => st.sentinel.items.map((i) => ({ id: i.id, name: i.name })), sameDeep);
  if (!rows.length) return null;
  const nameOf = (id: string): string | undefined => names.find((n) => n.id === id)?.name;
  return (
    <Panel
      title={rows.length > 1 ? `Schedules · ${rows.length}` : 'Schedules'}
      action={
        <Tip label="Schedule a message in this chat (/schedule)">
          <Button size="small" variant="quiet" icon="plus" aria-label="New schedule" onClick={() => askToSchedule(channel)} />
        </Tip>
      }
    >
      <div className={s.list} role="list" aria-label="Schedules">
        {rows.map((row) => (
          <ScheduleRow key={row.id} row={row} sentence={scheduleSentence(row.trigger, nameOf)} />
        ))}
      </div>
    </Panel>
  );
}

/** The channel of the chat a Your Mac view shows (its open tab when none is named). */
export const useAssistantChannel = (chat: string | undefined): string => useApp((st) => (chat ? assistantChannel(chat) : activeAssistantChannel(st.assistant)));

function ScheduleRow({ row, sentence }: { row: ChatSchedule; sentence: string }) {
  const a = useSentinelActions();
  const spent = scheduleSpent(row);
  const tone = spent ? 'muted' : toneOf(row);
  const when = row.nextAt !== undefined ? `${sentence} · next ${nextText(row.nextAt, Date.now())}` : row.paused ? `${sentence} · paused` : spent ? `${sentence} · done` : sentence;
  return (
    <div className={s.row} role="listitem" data-schedule={row.id}>
      <button type="button" className={s.open} onClick={() => a.open(row.id)} title={row.prompt ? `Sends “${row.prompt}”` : undefined}>
        <span className={s.dot}>
          <Dot tone={tone} live={row.running} />
        </span>
        <span className={s.text}>
          <span className={s.name}>{row.name}</span>
          <span className={s.when}>{when}</span>
        </span>
      </button>
      <Tip label={row.paused ? 'Run it once now, even though it’s off' : 'Run it now'}>
        <Button size="small" variant="quiet" icon="play" aria-label={`Run ${row.name} now`} disabled={row.running} onClick={() => void a.runNow(row)} />
      </Tip>
      {spent ? null : <Switch on={!row.paused} label={`${row.name}: ${row.paused ? 'off' : 'on'}`} onChange={(v) => void a.setPaused(row, !v)} />}
    </div>
  );
}

const toneOf = (row: ChatSchedule): Tone => (row.running ? 'claude' : row.paused && row.pausedWhy && row.pausedWhy !== CLAUDE_CHANGED ? 'warn' : row.paused ? 'muted' : 'ok');
