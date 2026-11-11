import type { DomainState, View } from '../../../../src/core/store.js';
import type { Notice } from '../../../../src/core/work-store.js';
import type { NeedsYou } from '../../../../src/companion/protocol.js';
import { allNeeds, needMatches } from '../../../../src/companion/needs-you.js';
import { macViewFor, needView } from '../../../../src/companion/open-on-mac.js';
import { planTitle } from '../../../../src/core/plans/model.js';
import { ASSISTANT_TITLE } from '../../../../src/shared/assistant.js';
import { findWorkspace } from '../../../../src/ui/workspace-models.js';
import { sameDeep } from '../lib/stable.js';

/**
 * The bell's "Waiting for you" (BLG-255): everything that waits on you, from the same list the
 * phone's Needs You draws (companion/needs-you.ts), each with where it lives, what opening it
 * shows, and which of its buttons sit on the row. Pure, so it's tested on its own
 * (tests/mac-waiting.test.ts); NotificationCenter only draws it.
 */

export type WaitingAction = NeedsYou['actions'][number];

export interface Waiting {
  readonly item: NeedsYou;
  /** The page it's answered on, when it has one (a friend request is answered in the sidebar). */
  readonly view?: View;
  /** Where it is, in words ("Tasks · beluga", "#design", "Requests"). */
  readonly place?: string;
  /** The buttons on the row: its main answer and the way to say no, or a question's few choices. */
  readonly surface: readonly WaitingAction[];
  /** The rest (Always, Skip…): on right-click. */
  readonly more: readonly WaitingAction[];
}

/** Where a request is answered on the Mac: its own page (a team-up on Tasks, a run), else its conversation or plan. */
export function waitingView(state: DomainState, item: Pick<NeedsYou, 'id' | 'topic'>): View | undefined {
  return needView(state, item.id) ?? (item.topic ? macViewFor(state, { topic: item.topic }) : undefined);
}

const projectName = (state: Pick<DomainState, 'projects'>, id: string | undefined): string | undefined => (id ? state.projects.find((p) => p.id === id)?.name : undefined);

/** A page, in a few words, so a request says where it is. */
export function placeOf(state: DomainState, view: View | undefined): string | undefined {
  if (!view) return undefined;
  switch (view.kind) {
    case 'room':
      return 'Room';
    case 'assistant':
      return ASSISTANT_TITLE;
    case 'requests':
      return 'Requests';
    case 'workspace': {
      const ws = findWorkspace(state.projects, view.id);
      const project = state.projects.find((p) => p.workspaces.some((w) => w.id === view.id));
      return ws ? [project?.root ? project.name : '', ws.name].filter(Boolean).join(' · ') : undefined;
    }
    case 'shared':
      return state.shared.find((w) => w.id === view.id)?.name;
    case 'conversation': {
      const id = view.id.slice(view.id.indexOf(':') + 1);
      if (view.id.startsWith('group:')) {
        const g = state.network.groups.find((x) => x.id === id);
        return g ? `#${g.name}` : undefined;
      }
      const f = state.network.friends.find((x) => x.peerId === id);
      return f ? `Chat with ${f.name}` : undefined;
    }
    case 'tasks': {
      const name = projectName(state, view.projectId);
      return name ? `Tasks · ${name}` : 'Tasks';
    }
    case 'task': {
      const issue = state.board.issues.find((i) => i.id === view.id);
      return issue ? `Tasks · ${issue.key}` : 'Tasks';
    }
    case 'plan': {
      const plan = state.plans.plans.find((p) => p.id === view.id);
      return plan ? `Plan · ${planTitle(plan)}` : 'Plans';
    }
    case 'team_plan':
      return `Shared plan · ${state.team.plans.find((p) => p.owner === view.owner && p.id === view.id)?.title ?? 'from a teammate'}`;
    case 'sentinel':
      return 'Sentinel';
    case 'sentinel_page':
      return state.sentinel.items.find((i) => i.id === view.id)?.name ?? 'Sentinel';
    case 'sentinel_run': {
      const run = state.sentinel.runs.find((r) => r.id === view.runId);
      return state.sentinel.items.find((i) => i.id === run?.sentinelId)?.name ?? 'Sentinel';
    }
    case 'project':
      return projectName(state, view.id);
    default:
      return undefined;
  }
}

/** Requests with no page of their own still say where they're answered. */
const PLACE_BY_ID: ReadonlyArray<readonly [RegExp, string]> = [[/^friend:/, 'Friends']];

/**
 * One main action and its "no" on the row (Approve · Decline, Team Up · Not Now). A question
 * without one shows its few choices instead; everything else goes on right-click.
 */
export function splitActions(actions: readonly WaitingAction[]): Pick<Waiting, 'surface' | 'more'> {
  const main = actions.find((a) => a.tone === 'main');
  if (main) {
    const no = actions.find((a) => a.tone === 'danger');
    const surface = no ? [main, no] : [main];
    return { surface, more: actions.filter((a) => !surface.includes(a)) };
  }
  const choices = actions.filter((a) => a.tone === 'plain').slice(0, 3);
  return { surface: choices, more: actions.filter((a) => !choices.includes(a)) };
}

/** Everything waiting for you, newest first (what has no time, Claude's questions, counts as just asked). */
export function waitingList(state: DomainState): readonly Waiting[] {
  const at = (n: NeedsYou): number => n.askedAt ?? Number.MAX_SAFE_INTEGER;
  return allNeeds(state)
    .sort((a, b) => at(b) - at(a))
    .map((item) => {
      const view = waitingView(state, item);
      const place = placeOf(state, view) ?? PLACE_BY_ID.find(([re]) => re.test(item.id))?.[1];
      return { item, ...(view ? { view } : {}), ...(place ? { place } : {}), ...splitActions(item.actions) };
    });
}

/**
 * How deep a waiting list goes, and some: list › row › request › its actions › one › its args › an
 * answer › its picks. sameDeep's usual six levels stop at an answer and call it changed every time.
 */
const WAITING_DEPTH = 16;

/** Two waiting lists say the same (to the bottom of every answer: BLG-905), so the bell redraws only when one changes. */
export const sameWaiting = (a: readonly Waiting[], b: readonly Waiting[]): boolean => sameDeep(a, b, WAITING_DEPTH);

/** The request a notice is about: its `need`, or the approval or question it names (`ref`). */
export function noticeNeed(n: Pick<Notice, 'need' | 'ref' | 'tag'>): string | undefined {
  if (n.need) return n.need;
  if (n.ref === undefined) return undefined;
  return n.tag === 'approval' ? `approval:${n.ref}` : `question:${n.ref}`;
}

/** A notice about something still waiting: the waiting row stands for it, so the history leaves it out. */
export function isCovered(n: Pick<Notice, 'need' | 'ref' | 'tag'>, waiting: readonly Waiting[]): boolean {
  const need = noticeNeed(n);
  return need !== undefined && waiting.some((w) => needMatches(w.item.id, need));
}

/** Where opening a past notice about a request goes, when its conversation or plan doesn't say. */
export function noticeNeedView(state: DomainState, n: Pick<Notice, 'need' | 'ref' | 'tag'>): View | undefined {
  const need = noticeNeed(n);
  if (!need) return undefined;
  const live = allNeeds(state).find((x) => needMatches(x.id, need));
  return live ? waitingView(state, live) : needView(state, need);
}

/** The bell's count: what waits for you, plus unread notices that aren't about one of those. */
export function bellCount(state: DomainState, waiting: readonly Waiting[] = waitingList(state)): number {
  return waiting.length + state.inbox.filter((n) => !n.read && !isCovered(n, waiting)).length;
}
