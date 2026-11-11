import { useRemoteAttention } from '../machines/remote-attention.js';
import { machineClientOf } from '../machines/pane-clients.js';
import { onMachine } from '../machines/pane-model.js';
import * as Popover from '@radix-ui/react-popover';
import { useEffect, useState } from 'react';
import type { View } from '@beluga/core/store.js';
import type { Method } from '@beluga/ipc/api.js';
import type { Notice } from '@beluga/core/work-store.js';
import { dndActive, dndLabel } from '@beluga/shared/quiet.js';
import { type NoticeFilter, type NoticeLook, NOTICE_FILTERS, filterNotices, foldPlanNotices, groupNotices, noticeAgo, noticeLook } from '@beluga/ui/notice-models.js';
import { planTitle } from '@beluga/core/plans/model.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Button, Empty as EmptyState, IconButton, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { copyText } from '../lib/copy.js';
import { brandNotice } from '../lib/brand.js';
import { MachineProvider, toast, useApi, useApp, useBeluga, useUi } from '../lib/beluga.js';
import { macNoticeTarget, openNoticeTarget } from '../lib/notices.js';
import { sameFields } from '../lib/stable.js';
import { PartBoundary } from '../lib/part-boundary.js';
import { type Waiting, type WaitingAction, bellCount, isCovered, noticeNeedView, sameWaiting, waitingList } from './waiting-model.js';
import s from './notifications.module.css';

/** A few marks the shared icon set doesn't have, drawn the same way (16 grid, 1.5 strokes). */
const OWN: Partial<Record<NoticeLook | 'moon', string>> = {
  question: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z M6.3 6.4a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3 M8 11.2v.01',
  mention: 'M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z M10.5 8v1.2a1.6 1.6 0 0 0 3.2 0V8a5.7 5.7 0 1 0-2.3 4.6',
  left: 'M6.5 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M2 13.5c0-2.4 2-4 4.5-4 1 0 1.9.2 2.6.7 M10.5 11.5h4',
  moon: 'M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z',
};

const ICON: Record<NoticeLook, IconName> = {
  approval: 'hand',
  question: 'chat',
  plan: 'wand',
  done: 'check',
  problem: 'alert',
  joined: 'person',
  left: 'person',
  invited: 'share',
  people: 'people',
  mention: 'chat',
  message: 'chat',
  pr: 'pr',
  task: 'terminal',
  test: 'bell',
};

function Mark({ look, size = 14 }: { look: NoticeLook | 'moon'; size?: number }) {
  const own = OWN[look];
  if (!own) return <Icon name={ICON[look as NoticeLook]} size={size} />;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={own} />
    </svg>
  );
}

/** The time now, ticking every half minute while shown (for "4m"). */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Row({ n, now, onOpen }: { n: Notice; now: number; onOpen: (n: Notice) => void }) {
  const api = useApi();
  const { look, tone } = noticeLook(n);
  const shown = brandNotice(n);
  const items: ActionItem[] = [
    { label: 'Open', onSelect: () => onOpen(n) },
    { label: n.read ? 'Mark as Unread' : 'Mark as Read', onSelect: () => void (n.read ? api.inbox.unread(n.id) : api.inbox.read({ id: n.id })) },
    { label: 'Copy', icon: 'copy', separate: true, onSelect: () => void copyText(n.body ? `${n.title}\n${n.body}` : n.title) },
    { label: 'Clear', danger: true, onSelect: () => void api.inbox.clear({ id: n.id }) },
  ];
  return (
    <ActionsContext items={items}>
    <li className={cx(s.row, !n.read && s.unread)}>
      <button type="button" className={s.rowMain} onClick={() => onOpen(n)}>
        <span className={cx(s.tile, s[`tone_${tone}`])}>
          <Mark look={look} />
        </span>
        <span className={s.text}>
          <span className={s.title}>{shown.title}</span>
          {shown.body ? <span className={s.body}>{shown.body}</span> : null}
        </span>
        <span className={s.time}>{noticeAgo(n.ts, now)}</span>
      </button>
      <span className={s.rowActions}>
        <Tip label={n.read ? 'Mark as unread' : 'Mark as read'}>
          <button type="button" className={s.rowAction} aria-label={n.read ? 'Mark as unread' : 'Mark as read'} onClick={() => void (n.read ? api.inbox.unread(n.id) : api.inbox.read({ id: n.id }))}>
            <span className={cx(s.readDot, !n.read && s.readDotOn)} />
          </button>
        </Tip>
        <Tip label="Clear">
          <button type="button" className={s.rowAction} aria-label="Clear" onClick={() => void api.inbox.clear({ id: n.id })}>
            <Icon name="x" size={11} />
          </button>
        </Tip>
      </span>
      {!n.read ? <span className={s.unreadDot} aria-label="Unread" /> : null}
    </li>
    </ActionsContext>
  );
}

/** A plan's task news, folded under the plan: one line, opened to see each. */
function PlanFold({ plan, notices, now, onOpen }: { plan: string; notices: readonly Notice[]; now: number; onOpen: (n: Notice) => void }) {
  const [open, setOpen] = useState(false);
  const found = useApp((st) => st.plans.plans.find((p) => p.id === plan));
  const unread = notices.some((n) => !n.read);
  return (
    <li className={cx(s.row, unread && s.unread)}>
      <button type="button" className={s.rowMain} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={s.tile}>
          <Icon name="flag" size={14} />
        </span>
        <span className={s.text}>
          <span className={s.title}>{found ? planTitle(found) : 'A plan'}</span>
          <span className={s.body}>{`${notices.length} updates from its tasks`}</span>
        </span>
        <span className={s.time}>{noticeAgo(notices[0]!.ts, now)}</span>
      </button>
      {open ? (
        <ul className={s.list}>
          {notices.map((n) => (
            <Row key={n.id} n={n} now={now} onOpen={onOpen} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** What a request is, for its icon. */
function waitingIcon(w: Waiting): IconName {
  const id = w.item.id;
  if (id.startsWith('friend:') || id.startsWith('knock:') || id.startsWith('join:')) return 'person';
  if (id.startsWith('team:')) return 'people';
  if (id.startsWith('team-task:')) return 'task';
  if (id.startsWith('sentinel:')) return 'merge';
  if (w.item.kind === 'question' || w.item.kind === 'confirm') return 'chat';
  if (w.item.kind === 'decision') return 'flag';
  return 'hand';
}

/** Go to a page: a workspace or a shared one opens the way the sidebar opens it. */
function useGo(): (view: View) => void {
  const actions = useActions();
  return (view) => {
    if (view.kind === 'workspace') actions.run({ type: 'open_ws', id: view.id, tab: view.tab });
    else if (view.kind === 'shared') actions.run({ type: 'open_shared', owner: view.owner, id: view.id, tab: view.tab });
    else actions.run({ type: 'view', view });
  };
}

/** Something waiting for you: who and where, answered right here, or opened where it lives. */
/** `on`: one of your computers' (BLG-790), drawn with its client: its name in the line, opened there. */
function WaitingRow({ w, now, close, on }: { w: Waiting; now: number; close: () => void; on?: { readonly name: string; readonly open: (view: View) => void } }) {
  const { client } = useBeluga();
  const api = useApi();
  const go = useGo();
  const [busy, setBusy] = useState(false);
  const { item } = w;
  const answer = (a: WaitingAction): void => {
    setBusy(true);
    (client.call as (m: Method, ...args: unknown[]) => Promise<unknown>)(a.method as Method, ...a.args).then(
      () => setBusy(false),
      (e: unknown) => {
        setBusy(false);
        toast(client, e instanceof Error ? e.message : String(e), 'error');
      },
    );
  };
  const open = (): void => {
    if (!w.view) return;
    (on?.open ?? go)(w.view);
    close();
  };
  const meta = [...new Set([item.from ?? '', w.place ?? '', on?.name ?? ''])].filter(Boolean).join(' · ');
  const items: ActionItem[] = [
    ...(w.view ? [{ label: w.place ? `Open in ${w.place}` : 'Open', onSelect: open }] : []),
    ...[...w.surface, ...w.more].map((a, i) => ({ label: a.label, ...(a.tone === 'danger' ? { danger: true } : {}), ...(i === 0 ? { separate: true } : {}), onSelect: () => answer(a) })),
    // Off every list (here and the phone) without answering it (BLG-359).
    { label: 'Dismiss', separate: true, onSelect: () => void api.needs.dismiss(item.id) },
  ];
  // A question that takes words or several picks is answered where it was asked.
  const typed = !w.surface.length;
  return (
    <ActionsContext items={items}>
      <li className={cx(s.row, s.unread, s.waiting)} data-need={item.id}>
        <button type="button" className={s.rowMain} onClick={open} disabled={!w.view} aria-label={`${item.title}${w.place ? `, in ${w.place}` : ''}`}>
          <span className={cx(s.tile, s.tone_warn)}>
            <Icon name={waitingIcon(w)} size={14} />
          </span>
          <span className={s.text}>
            <span className={s.title}>{item.title}</span>
            {meta ? <span className={s.where}>{meta}</span> : null}
          </span>
          <span className={s.time}>{item.askedAt ? noticeAgo(item.askedAt, now) : 'now'}</span>
        </button>
        <span className={s.answers}>
          {typed ? (
            <Button size="small" variant="primary" disabled={!w.view} onClick={open}>
              Answer
            </Button>
          ) : (
            w.surface.map((a) => (
              <Button key={a.label} size="small" variant={a.tone === 'main' ? 'primary' : 'plain'} disabled={busy} onClick={() => answer(a)}>
                {a.label}
              </Button>
            ))
          )}
        </span>
      </li>
    </ActionsContext>
  );
}

function Empty({ filter, any }: { filter: NoticeFilter; any: boolean }) {
  const title = !any ? 'You’re all caught up' : filter === 'unread' ? 'Nothing unread' : filter === 'needsYou' ? 'Nothing waiting for you' : 'No mentions';
  const detail = !any ? 'Beluga lists here when your agent finishes or needs you, and when friends come and go.' : 'The rest are under All.';
  return (
    <div className={s.empty}>
      <Icon name="bell" size={20} />
      <div className={s.emptyTitle}>{title}</div>
      <div className={s.emptyDetail}>{detail}</div>
    </div>
  );
}

/** What happened while you were elsewhere: Today and Earlier, filters, read, clear. */
function Center({ close }: { close: () => void }) {
  const api = useApi();
  const actions = useActions();
  const { ui, client } = useBeluga();
  const inbox = useApp((st) => st.inbox);
  const notify = useApp((st) => st.prefs.notify);
  // What waits for you, drawn again only when it changes (not on every streamed step).
  const waiting = useApp(waitingList, sameWaiting);
  const [filter, setFilter] = useState<NoticeFilter>('all');
  const now = useNow();
  const unread = inbox.filter((n) => !n.read).length;
  const history = inbox.filter((n) => !isCovered(n, waiting));
  const shownWaiting = filter === 'mentions' ? [] : waiting;
  const groups = groupNotices(filterNotices(history, filter), now);
  const go = useGo();
  const quiet = dndActive(notify, now);

  const open = (n: Notice): void => {
    const places = client.store.getState();
    // About a request: where it's answered (a team-up opens Tasks, a friend's request Requests).
    const page = noticeNeedView(places, n);
    if (page) {
      if (!n.read) void api.inbox.read({ id: n.id });
      go(page);
      close();
      return;
    }
    const target = macNoticeTarget(places, n.channel, n.plan ? { id: n.plan, ...(n.planTask ? { task: n.planTask } : {}) } : undefined);
    if (!n.read) void api.inbox.read({ id: n.id });
    if (!target) return;
    openNoticeTarget(actions, target, (id) => client.store.dispatch({ type: 'view', view: { kind: 'conversation', id } }));
    close();
  };

  return (
    <>
      <header className={s.head}>
        <h2 className={s.heading}>Notifications</h2>
        <button type="button" className={s.link} disabled={!unread} onClick={() => void api.inbox.read()}>
          Mark all read
        </button>
        <button type="button" className={s.link} disabled={!inbox.length} onClick={() => void api.inbox.clear()}>
          Clear all
        </button>
        <IconButton
          icon="gear"
          label="Notification settings"
          onClick={() => {
            close();
            ui.patch({ settings: 'notifications' });
          }}
        />
      </header>
      {quiet ? (
        <div className={s.quiet}>
          <Mark look="moon" size={13} />
          <span>Do Not Disturb {dndLabel(notify, now)}</span>
          <button type="button" className={s.link} onClick={() => void api.session.setPrefs({ notify: { ...notify, dnd: null } })}>
            Turn off
          </button>
        </div>
      ) : null}
      <div className={s.filters} role="tablist" aria-label="Show">
        {NOTICE_FILTERS.map((f) => (
          <button key={f.value} type="button" role="tab" aria-selected={filter === f.value} className={cx(s.filter, filter === f.value && s.filterOn)} onClick={() => setFilter(f.value)}>
            {f.label}
            {f.value === 'unread' && unread ? <span className={s.count}>{unread}</span> : null}
          </button>
        ))}
      </div>
      <div className={s.scroll}>
        {shownWaiting.length ? (
          <section className={s.group} aria-label="Waiting for you">
            <h3 className={s.groupTitle}>
              Waiting for you <span className={s.count}>{shownWaiting.length}</span>
            </h3>
            <ul className={s.list}>
              {shownWaiting.map((w) => (
                <WaitingRow key={w.item.id} w={w} now={now} close={close} />
              ))}
            </ul>
          </section>
        ) : null}
        {filter === 'mentions' ? null : <RemoteWaiting close={close} now={now} />}
        {groups.length ? (
          groups.map((g) => (
            <section key={g.label} className={s.group} aria-label={g.label}>
              <h3 className={s.groupTitle}>{g.label}</h3>
              <ul className={s.list}>
                {foldPlanNotices(g.notices).map((e) =>
                  e.kind === 'one' ? <Row key={e.notice.id} n={e.notice} now={now} onOpen={open} /> : <PlanFold key={`plan:${e.plan}`} plan={e.plan} notices={e.notices} now={now} onOpen={open} />,
                )}
              </ul>
            </section>
          ))
        ) : shownWaiting.length ? null : (
          <Empty filter={filter} any={inbox.length > 0} />
        )}
      </div>
    </>
  );
}

/**
 * What waits for you on each of your computers (BLG-790), after this Mac's: the same rows, drawn
 * with that computer's client so answering acts there; opening one opens its page there in the pane.
 */
function RemoteWaiting({ close, now }: { close: () => void; now: number }) {
  const remote = useRemoteAttention();
  const actions = useActions();
  const { ui } = useBeluga();
  return (
    <>
      {remote
        .filter((r) => r.waiting.length)
        .map((r) => {
          const client = machineClientOf(r.machine.id);
          if (!client) return null;
          return (
            <section key={r.machine.id} className={s.group} aria-label={`Waiting on ${r.machine.name}`}>
              <h3 className={s.groupTitle}>
                Waiting on {r.machine.name} <span className={s.count}>{r.waiting.length}</span>
              </h3>
              <MachineProvider machine={r.machine.id} client={client} ui={ui.windowStore}>
                <ul className={s.list}>
                  {r.waiting.map((w) => (
                    <WaitingRow key={w.item.id} w={w} now={now} close={close} on={{ name: r.machine.name, open: (view) => actions.run({ type: 'view', view: onMachine(r.machine.id, view) }) }} />
                  ))}
                </ul>
              </MachineProvider>
            </section>
          );
        })}
    </>
  );
}

/** The bell in the toolbar: how many things are new, and the notification centre under it. */
export function NotificationBell() {
  const { ui, client } = useBeluga();
  const open = useUi((u) => u.notices);
  // Just the two counts: the bell is drawn again only when one of them changes.
  const { waiting, unread } = useApp((st) => {
    const list = waitingList(st);
    return { waiting: list.length, unread: bellCount(st, list) - list.length };
  }, sameFields);
  const quiet = useApp((st) => dndActive(st.prefs.notify));
  // Every computer's too (BLG-790): what waits there and its new notices, added once each.
  const remote = useRemoteAttention();
  const waitingThere = remote.reduce((n, r) => n + r.waiting.length, 0);
  const newThere = remote.reduce((n, r) => n + r.bell - r.waiting.length, 0);
  const label = `Notifications${waiting + waitingThere ? ` · ${waiting + waitingThere} waiting for you` : ''}${unread + newThere ? ` · ${unread + newThere} new` : ''}${quiet ? ' · Do Not Disturb' : ''}`;
  return (
    <Popover.Root open={open} onOpenChange={(o) => ui.patch({ notices: o })}>
      <Popover.Trigger asChild>
        <IconButton icon="bell" label={label} active={open} badge={waiting + unread + waitingThere + newThere} className={cx(quiet && s.bellQuiet)} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={s.popover} align="end" sideOffset={6} collisionPadding={12} aria-label="Notifications">
          {/* One notification that can't be drawn shows here, not as a grey window (BLG-905). */}
          <PartBoundary
            part="notifications"
            onCrash={(crash) => void client.api.diagnostics.windowCrash(crash).catch(() => undefined)}
            fallback={(error, retry) => (
              <div className={s.broken}>
                <EmptyState
                  icon="alert"
                  title="Notifications ran into a problem"
                  detail={error.message}
                  action={
                    <Button size="small" onClick={retry}>
                      Try Again
                    </Button>
                  }
                />
              </div>
            )}
          >
            <Center close={() => ui.patch({ notices: false })} />
          </PartBoundary>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
