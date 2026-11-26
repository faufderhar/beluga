import { useRef, useState } from 'react';
import { ACCESS, ACCESS_INFO, type Access, CLAUDE_CHANGED, CLAUDE_CHANGED_BANNER, DEFAULT_KEEP_CHATS, KEEP_CHATS, KEEP_CHATS_INFO, type KeepChats, FIRST_SENTINEL_CHAT, sentinelChatChannel, NOTIFY_WHERE, type RunSummary, type Sentinel, type SentinelPatch, TIME_LIMITS, accessRank, runsOf, scheduleSentence } from '@beluga/core/sentinel/model.js';
import { activityOf } from '@beluga/ui/workspace-models.js';
import { recipeById } from '@beluga/core/sentinel/recipes.js';
import { Icon } from '../components/Icon.js';
import { Select } from '../components/Select.js';
import { useAgentEntries } from '../components/agent-options.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Empty, IconButton, Tip, cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { RunsOnLabel } from '../chat/RunsOn.js';
import { useSentinelMoveTo } from './move-to.js';
import { useActions } from '../lib/actions.js';
import { AskPanel, SentinelChat } from './SentinelChat.js';
import { Attention } from '../chat/Attention.js';
import home from './home.module.css';
import { useSwipeBack } from '../tasks/use-swipe-back.js';
import { SwipeBackEdge } from '../tasks/SwipeBackEdge.js';
import { ago } from '../tasks/tasks-model.js';
import { ClaudeMark, Disc, RunPill } from './marks.js';
import { StepsCard, WhenCard } from './SentinelCards.js';
import { DataCard } from './DataCard.js';
import { NumbersCard } from './NumbersCard.js';
import {
  MAC_SCOPE,
  NOTIFY_LABEL,
  PAUSE_AFTER_CHOICES,
  PER_DAY_CHOICES,
  accessSentence,
  askLine,
  byWords,
  chatPlaceOf,
  dotStrip,
  durationText,
  headlineOf,
  iconOf,
  pauseAfterLabel,
  perDayLabel,
  runDuration,
  sharedAgent,
  whenText,
  withAgent,
} from './sentinel-model.js';
import { useDraft } from './use-draft.js';
import { useClock } from '../lib/window-active.js';
import { useRunsFolder, useSentinelActions, useSentinelState } from './use-sentinel.js';
import t from '../tasks/tasks.module.css';
import s from './sentinel.module.css';
import { shortcutKeys } from '../lib/shortcuts.js';
import { primaryKey } from '../lib/shortcuts-model.js';
import { ASSISTANT_TITLE } from '@beluga/shared/assistant.js';
import { useOpenFolderLabel } from '../lib/remote-open.js';

/**
 * A sentinel's page: the editor and its history in one. The name is renamed in place, When and
 * Steps change as you go (saved at once: no Save button), the properties run down the right, and
 * the history shows the last 30 runs as dots, then as rows that open the run. ⌘[ or Esc go back.
 */
export function SentinelPage({ id }: { id: string }) {
  const state = useSentinelState();
  const item = state.items.find((x) => x.id === id);
  if (!state.enabled) return <Empty icon="sentinel" title="Sentinel needs the Beluga app" />;
  if (!item) return <Empty icon="sentinel" title="This sentinel isn’t here anymore" detail="It may have been deleted." />;
  return <Page item={item} />;
}

function Page({ item }: { item: Sentinel }) {
  const wrap = useRef<HTMLDivElement>(null);
  const a = useSentinelActions();
  const back = (): void => a.openList();
  const swipe = useSwipeBack(wrap, back);
  const save = (patch: SentinelPatch): void => void a.act(() => a.update(item.id, patch));
  // The Sentinel chat docks beside the page when you ask from here (its properties make room for it).
  const asking = useApp((st) => st.view.kind === 'sentinel_chat' && st.view.about === item.id);
  return (
    <div className={home.home}>
      <div ref={wrap} className={cx(t.pageWrap, home.grow)}>
        <SwipeBackEdge progress={swipe} />
        <div className={t.page}>
          <div className={t.pageMain} data-sentinel-page={item.id}>
            <Crumbs item={item} back={back} />
            <Header item={item} save={save} />
            <AskBox item={item} />
            <Banners item={item} />
            <WhenCard item={item} save={save} />
            <StepsCard item={item} save={save} />
            <NumbersCard item={item} />
            <History item={item} />
            <DataCard item={item} />
          </div>
          {asking ? null : <Properties item={item} save={save} />}
        </div>
      </div>
      {asking ? (
        <AskPanel>
          <SentinelChat onClose={() => a.open(item.id)} />
        </AskPanel>
      ) : null}
    </div>
  );
}

function Crumbs({ item, back }: { item: Sentinel; back: () => void }) {
  const a = useSentinelActions();
  const project = useApp((st) => st.projects.find((p) => p.id === item.projectId));
  return (
    <nav className={t.crumbs} aria-label="Where this sentinel is">
      <IconButton size="small" icon="back" label="Back" keys={shortcutKeys('page-back')} className={t.crumbBack} onClick={back} />
      <button type="button" className={t.crumb} onClick={() => a.openList()}>
        Sentinel
      </button>
      <Icon name="chevronRight" size={10} />
      <button type="button" className={t.crumb} onClick={() => a.openList(item.projectId ?? MAC_SCOPE)}>
        {project?.name ?? ASSISTANT_TITLE}
      </button>
      <span className={t.grow} />
    </nav>
  );
}

function Header({ item, save }: { item: Sentinel; save: (patch: SentinelPatch) => void }) {
  const a = useSentinelActions();
  const folder = useRunsFolder();
  const items = useApp((st) => st.sentinel.items);
  const name = useDraft(item.name, (v) => {
    const next = v.replace(/\s+/g, ' ').trim();
    if (next && next !== item.name) save({ name: next });
  });
  // A sentinel on a computer: its runs folder in your editor over Remote-SSH, else its path copied (BLG-852).
  const runsFolder = useOpenFolderLabel('Open the Runs Folder', 'Copy the Runs Folder’s Path');
  // Move To ▸ another computer of yours (BLG-807): Pause and Move To while it runs.
  const moveTo = useSentinelMoveTo(item);
  const more: ActionItem[] = [
    { label: 'Duplicate', icon: 'copy', onSelect: () => void a.duplicate(item) },
    { label: 'Copy as JSON', icon: 'copy', onSelect: () => a.copyJson(item) },
    ...(folder ? [{ label: runsFolder, icon: 'folder' as const, onSelect: () => a.openFolder(folder) }] : []),
    ...(moveTo ? [moveTo] : []),
    { label: 'Delete…', danger: true, separate: true, onSelect: () => a.remove(item, () => a.openList()) },
  ];
  return (
    <header className={s.head}>
      <Disc icon={item.paused ? 'pause' : iconOf(item.icon)} tone={item.paused ? 'paused' : item.trigger.kind === 'schedule' ? 'clock' : item.trigger.kind === 'manual' || item.trigger.kind === 'after' ? 'hand' : 'event'} size={40} />
      <div className={s.headText}>
        <input
          className={s.name}
          value={name.text}
          aria-label="Name"
          spellCheck={false}
          onChange={(e) => name.change(e.target.value)}
          onBlur={name.flush}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        <span className={s.subtitle}>{scheduleSentence(item.trigger, (id) => items.find((x) => x.id === id)?.name)}</span>
      </div>
      <div className={s.headActions}>
        {/* Where it runs (BLG-786): the computer it was made on. Only with a computer paired. */}
        <RunsOnLabel tip="It runs on the computer it was made on until you move it." />
        <Tip label={item.paused ? 'Once now, even though it’s paused' : 'Once now, whatever its schedule'}>
          <Button size="small" icon="play" variant={item.paused ? 'plain' : 'primary'} onClick={() => void a.runNow(item)}>
            Run Now
          </Button>
        </Tip>
        {item.paused ? (
          <Button size="small" variant="primary" icon="check" onClick={() => void a.setPaused(item, false)}>
            {item.pausedWhy && item.pausedWhy !== CLAUDE_CHANGED ? 'Resume' : 'Turn On'}
          </Button>
        ) : (
          <Button size="small" icon="pause" onClick={() => void a.setPaused(item, true)}>
            Pause
          </Button>
        )}
        <ActionsDropdown items={more}>
          <IconButton size="small" icon="more" label={`More for ${item.name}`} />
        </ActionsDropdown>
      </div>
    </header>
  );
}

/**
 * "Ask Claude about this sentinel…": one line under the header. What you say goes to the Sentinel
 * chat, which opens beside the page (naming this sentinel, so Claude knows which one): you watch it
 * change things there, and answer its approvals there.
 */
function AskBox({ item }: { item: Sentinel }) {
  const api = useApi();
  const actions = useActions();
  const active = useApp((st) => st.sentinel.chats?.active ?? FIRST_SENTINEL_CHAT);
  const a = useSentinelActions();
  // New Sentinel › Describe it: Claude writing this one from your words, its last line, then its answer.
  const ask = useApp((st) => st.sentinel.asks?.[item.id]);
  const live = useApp((st) => (ask?.state === 'writing' ? activityOf(st.log, ask.channel) : undefined));
  const line = askLine(ask, live);
  const [text, setText] = useState('');
  const send = (): void => {
    const words = text.trim();
    if (!words) return;
    void api.session.submit(`About “${item.name}”: ${words}`, { channel: sentinelChatChannel(active) });
    actions.run({ type: 'view', view: { kind: 'sentinel_chat', chat: active, about: item.id } });
    setText('');
  };
  return (
    <section className={s.ask} aria-label="Ask your agent" data-testid="sentinel-ask">
      <div className={s.askRow}>
        <ClaudeMark />
        <input
          className={s.askInput}
          value={text}
          placeholder="Ask your agent about this sentinel: “make it weekly”, “why did it fail?”…"
          aria-label="Ask your agent about this sentinel"
          spellCheck
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Tip label="The Sentinel chat opens beside this page; your agent changes it there" keys="↩">
          <Button size="small" icon="arrowRight" disabled={!text.trim()} onClick={send}>
            Ask
          </Button>
        </Tip>
      </div>
      {ask ? <Attention channel={ask.channel} /> : null}
      {line && ask ? (
        <div className={s.askLine} data-who={line.who} role="status" aria-live="polite">
          {line.who === 'claude' ? <span className={s.askDot} aria-hidden="true" /> : <Icon name={line.who === 'done' ? 'check' : 'alert'} size={12} />}
          <span className={s.askText}>{line.text}</span>
          <Button size="small" variant="quiet" onClick={() => a.openChannel(ask.channel)}>
            Open Chat
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function Banners({ item }: { item: Sentinel }) {
  const a = useSentinelActions();
  const last = useApp((st) => runsOf(st.sentinel, item.id)[0]);
  if (item.paused && item.pausedWhy === CLAUDE_CHANGED) {
    return (
      <div className={s.banner} data-tone="info" role="status" data-testid="sentinel-claude-changed">
        <ClaudeMark />
        <span className={s.bannerText}>{CLAUDE_CHANGED_BANNER}</span>
        <Button size="small" variant="primary" onClick={() => void a.setPaused(item, false)}>
          Turn On
        </Button>
      </div>
    );
  }
  if (item.paused && item.pausedWhy) {
    return (
      <div className={s.banner} data-tone="error" role="status">
        <Icon name="alert" size={14} />
        <span className={s.bannerText}>
          <strong>{item.pausedWhy}.</strong> {last?.why ? `The last one: ${last.why.split('\n')[0]}` : 'Look at the last run, fix what it needs, then resume.'}
        </span>
        {last ? (
          <Button size="small" variant="quiet" onClick={() => a.openRun(last.id)}>
            Open Last Run
          </Button>
        ) : null}
        <Button size="small" onClick={() => void a.setPaused(item, false)}>
          Resume
        </Button>
      </div>
    );
  }
  if (item.paused) {
    return (
      <div className={s.banner} data-tone="info" role="status">
        <Icon name="pause" size={14} />
        <span className={s.bannerText}>This sentinel is paused. Turn On to let it run{item.trigger.kind === 'schedule' ? ' on its schedule' : item.trigger.kind === 'manual' || item.trigger.kind === 'after' ? '' : ' when it happens'}; Run Now tries it once first.</span>
      </div>
    );
  }
  return null;
}

/** The runs: a dot strip of the last 30, then each as a row (when, by what, how it went, how long). */
function History({ item }: { item: Sentinel }) {
  const state = useSentinelState();
  const a = useSentinelActions();
  const now = useClock(true, 15_000);
  const runs = runsOf(state, item.id);
  const dots = dotStrip(runs);
  const liveName = (r: RunSummary): string | undefined => {
    const step = state.live[r.id]?.stepId;
    return step ? item.steps.find((x) => x.id === step)?.name : undefined;
  };
  return (
    <section className={s.card} aria-label="History">
      <header className={s.cardHead}>
        <h3 className={s.cardTitle}>History</h3>
        <span className={t.grow} />
        {runs.length ? <span className={s.hint}>{runs.length === 1 ? '1 run' : `the last ${runs.length} runs`}</span> : null}
      </header>
      {!runs.length ? (
        <p className={s.empty}>No runs yet. Run Now tries it once.</p>
      ) : (
        <>
          <div className={s.strip} role="list" aria-label="The last runs, oldest first">
            {dots.map((d) => (
              <Tip key={d.id} label={d.label}>
                <button type="button" role="listitem" className={s.stripDot} data-tone={d.tone} aria-label={d.label} onClick={() => a.openRun(d.id)} />
              </Tip>
            ))}
          </div>
          <div className={s.runs} role="list">
            {runs.map((r) => {
              const live = r.state === 'running' ? liveName(r) : undefined;
              return (
                <button
                  key={r.id}
                  type="button"
                  role="listitem"
                  className={s.run}
                  data-run={r.id}
                  onClick={() => a.openRun(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && primaryKey(e)) {
                      e.preventDefault();
                      const channel = r.channel ?? r.steps.find((x) => x.channel)?.channel;
                      if (chatPlaceOf(channel)) a.openChannel(channel);
                    }
                  }}
                >
                  <span className={s.runWhen}>{whenText(r.startedAt, now)}</span>
                  <span className={s.runBy}>{byWords(r, state)}</span>
                  <RunPill state={r.state} />
                  <span className={cx(s.runHeadline, live && s.runLive)}>{live ? `${live}…` : headlineOf(r)}</span>
                  <span className={s.runTook}>{durationText(runDuration(r, now))}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function Properties({ item, save }: { item: Sentinel; save: (patch: SentinelPatch) => void }) {
  const a = useSentinelActions();
  const all = useApp((st) => st.projects);
  const agents = useAgentEntries();
  const projects = all.filter((p) => p.root && !p.error);
  const agent = sharedAgent(item.steps);
  const claudeSteps = item.steps.some((x) => x.kind === 'claude');
  const limits: number[] = TIME_LIMITS.includes(item.limits.minutes as (typeof TIME_LIMITS)[number]) ? [...TIME_LIMITS] : [...TIME_LIMITS, item.limits.minutes].sort((x, y) => x - y);
  const perDay: number[] = PER_DAY_CHOICES.includes(item.limits.perDay ?? 0) ? [...PER_DAY_CHOICES] : [...PER_DAY_CHOICES, item.limits.perDay!].sort((x, y) => x - y);
  const pauseAfter: number[] = PAUSE_AFTER_CHOICES.includes(item.limits.pauseAfter) ? [...PAUSE_AFTER_CHOICES] : [...PAUSE_AFTER_CHOICES, item.limits.pauseAfter].sort((x, y) => x - y);
  return (
    <aside className={t.props} aria-label="Properties">
      <Prop label="Project">
        <Select
          label="Project"
          size="small"
          value={item.projectId ?? MAC_SCOPE}
          options={[{ value: MAC_SCOPE, label: ASSISTANT_TITLE }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(v) => save({ projectId: v === MAC_SCOPE ? null : v })}
        />
      </Prop>
      <Prop label="Access">
        <Select<Access>
          label="Access"
          size="small"
          value={item.access}
          options={ACCESS.map((x) => ({ value: x, label: ACCESS_INFO[x].label, description: accessSentence(x, item.steps) }))}
          onChange={(access) => {
            // Less access than its steps need: say which step, before it's refused.
            if (accessRank(access) < accessRank(item.access)) {
              const needs = item.steps.find((st) => (st.kind === 'merge' && access !== 'ship') || ((st.kind === 'pr' || (st.kind === 'claude' && st.where === 'worktree')) && access === 'look'));
              if (needs) return void a.act(() => Promise.reject(new Error(`“${needs.name}” needs more than ${ACCESS_INFO[access].label}: remove it first`)));
            }
            save({ access });
          }}
        />
      </Prop>
      <p className={s.accessHint}>
        {accessSentence(item.access, item.steps)}.
      </p>
      {claudeSteps ? (
        <Prop label="Agent">
          <Select label="Agent and model for every agent step" size="small" value={agent ?? 'mixed'} placeholder="Mixed" options={agents} onChange={(v) => save({ steps: withAgent(item.steps, v) })} />
        </Prop>
      ) : null}
      <Prop label="Time limit">
        <Select label="Time limit" size="small" value={String(item.limits.minutes)} options={limits.map((n) => ({ value: String(n), label: n < 60 ? `${n} minutes` : n === 60 ? '1 hour' : `${n / 60} hours`, description: 'Per run; the agent is stopped and the run fails as timed out' }))} onChange={(v) => save({ limits: { minutes: Number(v) } })} />
      </Prop>
      <Prop label="Runs per day">
        <Select label="Runs per day" size="small" value={String(item.limits.perDay ?? 0)} options={perDay.map((n) => ({ value: String(n), label: perDayLabel(n) }))} onChange={(v) => save({ limits: { perDay: Number(v) } })} />
      </Prop>
      <Prop label="Pause after">
        <Select label="Pause after" size="small" value={String(item.limits.pauseAfter)} options={pauseAfter.map((n) => ({ value: String(n), label: pauseAfterLabel(n) }))} onChange={(v) => save({ limits: { pauseAfter: Number(v) } })} />
      </Prop>
      {claudeSteps ? (
        <Prop label="Keep chats">
          <Select<KeepChats>
            label="Which runs’ chats to keep"
            size="small"
            value={item.keepChats ?? DEFAULT_KEEP_CHATS}
            options={KEEP_CHATS.map((k) => ({ value: k, label: KEEP_CHATS_INFO[k].label, description: KEEP_CHATS_INFO[k].description }))}
            onChange={(keepChats) => save({ keepChats })}
          />
        </Prop>
      ) : null}
      <Prop label="Notify">
        <Select label="Notify" size="small" value={item.notify} options={NOTIFY_WHERE.map((n) => ({ value: n, label: NOTIFY_LABEL[n], description: n === 'off' ? 'Only failures and pausing still tell you' : 'When a run ends (a Notify step says more)' }))} onChange={(notify) => save({ notify })} />
      </Prop>
      <div className={t.propsRule} />
      <Prop label="Id" quiet>
        <span className={cx(t.propStatic, t.mono, 'selectable')}>{item.id}</span>
      </Prop>
      {item.recipe ? (
        <Prop label="Recipe" quiet>
          <span className={t.propStatic}>{recipeById(item.recipe)?.name ?? item.recipe}</span>
        </Prop>
      ) : null}
      <Prop label="Created" quiet>
        <span className={t.propStatic}>{ago(item.createdAt)}</span>
      </Prop>
      <Prop label="Changed" quiet>
        <span className={t.propStatic}>{ago(item.updatedAt)}</span>
      </Prop>
    </aside>
  );
}

function Prop({ label, children, quiet }: { label: string; children: React.ReactNode; quiet?: boolean }) {
  return (
    <div className={cx(t.prop, quiet && t.propStaticRow)}>
      <span className={t.propLabel}>{label}</span>
      <div className={t.propControl}>{children}</div>
    </div>
  );
}
