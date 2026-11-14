import { isExternalRequester } from '../core/trust.js';
import type { Approval, DomainState } from '../core/store.js';
import { OFFER_DETAIL, knockWords, offerWords } from '../core/team/model.js';
import type { PendingQuestion } from '../core/collab-store.js';
import type { TaskView as GwTask } from '../core/gateway/model.js';
import { parseDecisionQid } from '../core/plans/decisions.js';
import { type Plan, planTitle, reviewState } from '../core/plans/model.js';
import { firstLine, sentinelById } from '../core/sentinel/model.js';
import { type PlanView as PlanProgress, planView } from '../core/plans/progress.js';
import { type NeedsYou, Topic } from './protocol.js';
import { plainLine, stripCode } from './strip.js';
import { agentLabel } from '../shared/agent-label.js';
import { type AgentRef, defaultAgentOf } from '../protocol.js';

/**
 * Everything waiting for you, each with the API calls its buttons make: the phone's Needs You
 * (views.ts) and the Mac's bell (BLG-255) draw this same list, so the two never disagree about
 * what waits or how it's answered. Browser-safe (tests/browser-safe.test.ts): the Mac loads it.
 */

export const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
export const agentRefView = (a: AgentRef): AgentRef => ({ runtime: clip(a.runtime, 32), label: clip(a.label, 64), ...(a.model ? { model: clip(a.model, 64) } : {}) });
const valid = (t: string): Topic | undefined => (Topic.safeParse(t).success ? (t as Topic) : undefined);

/** A conversation's topic (`room` → `conv:room`, `ws:<id>` → `conv:ws:<id>`). */
export const convTopic = (channel: string): Topic | undefined => valid(`conv:${channel}`);
export const chatTopic = (conversation: string): Topic | undefined => valid(`chat:${conversation}`);
export const planTopic = (id: string): Topic | undefined => valid(`plan:${id}`);
export const taskTopic = (id: string): Topic | undefined => valid(`task:${id}`);
export const sentinelTopic = (id: string): Topic | undefined => valid(`sentinel:${id}`);
export const dashboardTopic = (id: string): Topic | undefined => valid(`dashboard:${id}`);

export const nameOf = (state: DomainState, peerId: string | undefined): string | undefined =>
  peerId ? (state.peers.find((p) => p.peerId === peerId)?.name ?? state.network.friends.find((f) => f.peerId === peerId)?.name) : undefined;

export const myId = (state: DomainState): string => state.selfId || state.self?.peerId || state.network.self?.peerId || 'me';

/** "your Claude", "mia's Codex": the agent of this Mac, or of a peer it knows (else Claude). */
const agentOf = (state: DomainState, peerId: string | undefined, owner: string, capital = false): string =>
  !peerId || peerId === myId(state)
    ? agentLabel(defaultAgentOf(state.self), undefined, true, { capital })
    : agentLabel(defaultAgentOf(state.peers.find((p) => p.peerId === peerId)), owner, false, { capital });

/** The child thread a need holds up, by title: without it "your Claude" could be any of a tree's chats. */
function threadPlace(state: DomainState, channel: string | undefined): Pick<NeedsYou, 'thread'> {
  const ws = channel?.startsWith('ws:') ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === channel.slice(3)) : undefined;
  return ws?.thread ? { thread: clip(ws.name, 300) } : {};
}

function approvalItem(state: DomainState, a: Approval): NeedsYou {
  const from = a.asker ?? (a.peer ? `${nameOf(state, a.peer) ?? 'a friend'}` : agentOf(state, undefined, ''));
  // A friends' chat opens that chat (a request from there, your Claude working there: BLG-207).
  // An external agent's own place has no chat to open.
  const topic = a.channel && !isExternalRequester(a.channel) ? (/^(dm|group):/.test(a.channel) ? chatTopic(a.channel) : convTopic(a.channel)) : undefined;
  return {
    id: `approval:${a.id}`,
    ...threadPlace(state, a.channel),
    // Agents hit a limit on messages to each other: your decision, with its own words on the buttons.
    kind: a.kind === 'chain' ? 'decision' : a.kind === 'request' ? 'request' : 'approval',
    title: clip(a.title, 500),
    ...(a.detail ? { detail: clip(plainLine(a.detail, 64_000), 64_000) } : {}),
    from,
    ...(topic ? { topic } : {}),
    ...(a.askedAt !== undefined ? { askedAt: a.askedAt } : {}),
    ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}),
    actions: [
      { label: a.kind === 'chain' ? 'Continue' : a.once ? 'Allow once' : 'Approve', tone: 'main', method: 'host.answerApproval', args: ['yes', a.id] },
      { label: a.kind === 'chain' ? 'Stop' : 'Decline', tone: 'danger', method: 'host.answerApproval', args: ['no', a.id] },
      // A friend's request for a secret is asked each time: no Always.
      ...(a.once ? [] : [{ label: 'Always', tone: 'plain' as const, method: 'host.answerApproval', args: ['always', a.id] }]),
    ],
  };
}

/** Claude's question (or plan to approve), or a plan task waiting on your decision. */
function questionItem(state: DomainState, q: PendingQuestion): NeedsYou {
  const topic = convTopic(q.channel);
  const owner = agentOf(state, q.owner, nameOf(state, q.owner) ?? 'a friend');
  const base = { id: `question:${q.qid}`, from: owner, ...(topic ? { topic } : {}), ...threadPlace(state, q.channel) };
  if (q.question.kind === 'plan') {
    return {
      ...base,
      kind: 'question',
      title: `${owner.charAt(0).toUpperCase()}${owner.slice(1)} has a plan for you to approve`,
      detail: clip(stripCode(q.question.plan).text, 64_000),
      freeText: true,
      actions: [
        { label: 'Approve', tone: 'main', method: 'questions.answer', args: [q.qid, { kind: 'plan', approve: true, feedback: '' }] },
        { label: 'Keep planning', tone: 'danger', method: 'questions.answer', args: [q.qid, { kind: 'plan', approve: false, feedback: '' }] },
      ],
      // Your words: what to change in the plan (it keeps planning with them).
      answer: { method: 'questions.answer', args: [q.qid, { kind: 'plan', approve: false, feedback: '' }], slot: [1, 'feedback'], text: true, picks: false, label: 'Send changes' },
    };
  }
  const [first, ...rest] = q.question.questions.filter((x) => !(x.question in q.picked));
  const head = first ?? q.question.questions[0]!;
  const decision = parseDecisionQid(q.qid);
  const plan = decision ? state.plans.plans.find((p) => p.id === decision.plan) : undefined;
  const planT = plan ? planTopic(plan.id) : undefined;
  // Answers to the earlier questions of this prompt (picked one at a time with questions.pick).
  const picked = Object.fromEntries(Object.entries(q.picked).filter(([k]) => !k.endsWith('#multi')));
  const last = !rest.length;
  const single = last && !head.multiSelect && head.options.length > 0 && head.options.length <= 3;
  // Several picks (joined with ", " as the Mac does) or your own words go where `slot` says: the
  // last question sends every answer (questions.answer); an earlier one is kept with questions.pick.
  const answer: NonNullable<NeedsYou['answer']> = last
    ? { method: 'questions.answer', args: [q.qid, { kind: 'answers', answers: { ...picked, [head.question]: '' } }], slot: [1, 'answers', head.question], join: ', ', text: true, picks: head.options.length > 0, label: 'Send' }
    : { method: 'questions.pick', args: [q.qid, head.question, ''], slot: [2], join: ', ', text: true, picks: head.options.length > 0, label: 'Next' };
  return {
    ...base,
    kind: decision ? 'decision' : 'question',
    ...(decision ? { from: plan ? `the plan “${clip(planTitle(plan), 80)}”` : 'a plan' } : {}),
    ...(decision && planT ? { topic: planT } : {}),
    title: clip(plainLine(head.question, 500), 500),
    ...(rest.length ? { detail: clip(rest.map((r) => plainLine(r.question, 1000)).join('\n'), 64_000) } : {}),
    choices: head.options.slice(0, 12).map((o) => ({ label: clip(o.label, 200), ...(o.description ? { description: clip(o.description, 1000) } : {}) })),
    multi: head.multiSelect,
    freeText: true,
    // One question with a few options: a button each (the phone sends the rest, multi-select or words, itself).
    actions: [
      ...(single ? head.options.map((o) => ({ label: clip(o.label, 40), tone: 'plain' as const, method: 'questions.answer', args: [q.qid, { kind: 'answers', answers: { ...picked, [head.question]: o.label } }] })) : []),
      { label: 'Skip', tone: 'danger', method: 'questions.answer', args: [q.qid, { kind: 'skip' }] },
    ],
    answer,
  };
}

function gatewayItems(state: DomainState, t: GwTask): NeedsYou[] {
  const topic = t.conversation ? convTopic(t.conversation) : t.direction === 'sent' ? convTopic(`task:${t.id}`) : undefined;
  const at = topic ? { topic } : {};
  if (t.direction === 'sent' && t.state === 'confirm') {
    return [
      {
        id: `confirm:${t.id}`,
        kind: 'confirm',
        title: `Ask ${agentOf(state, t.peerId, clip(t.peerName, 60))}?`,
        detail: clip(plainLine(t.ask, 64_000), 64_000),
        from: agentOf(state, undefined, ''),
        ...at,
        askedAt: t.createdAt,
        actions: [
          { label: 'Ask', tone: 'main', method: 'gateway.confirm', args: [t.id, true] },
          // Send it, and let your Claude ask them without checking from now on.
          { label: 'Always', tone: 'plain', method: 'gateway.confirm', args: [t.id, true, '', true] },
          { label: 'Not now', tone: 'danger', method: 'gateway.confirm', args: [t.id, false] },
        ],
      },
    ];
  }
  if (t.direction === 'sent' && t.question) {
    const head = t.question.questions[0];
    if (!head) return [];
    const single = t.question.questions.length === 1 && !head.multiSelect && head.options.length > 0 && head.options.length <= 3;
    return [
      {
        id: `gwq:${t.id}:${t.question.qid}`,
        kind: 'question',
        title: clip(plainLine(head.question, 500), 500),
        detail: clip(plainLine(t.summary ?? t.ask, 64_000), 64_000),
        from: agentOf(state, t.peerId, clip(t.peerName, 60)),
        ...at,
        askedAt: t.question.askedAt,
        choices: head.options.slice(0, 12).map((o) => ({ label: clip(o.label, 200), ...(o.description ? { description: clip(o.description, 1000) } : {}) })),
        multi: head.multiSelect,
        // One question: picks or words go in the answer list. Several at once: only on the Mac (or Skip).
        freeText: t.question.questions.length === 1,
        actions: [
          ...(single ? head.options.map((o) => ({ label: clip(o.label, 40), tone: 'plain' as const, method: 'gateway.answer', args: [t.id, [o.label]] })) : []),
          { label: 'Skip', tone: 'danger', method: 'gateway.answer', args: [t.id, 'skip'] },
        ],
        ...(t.question.questions.length === 1 ? { answer: { method: 'gateway.answer', args: [t.id, ['']], slot: [1, 0], join: ', ', text: true, picks: head.options.length > 0, label: 'Send' } } : {}),
      },
    ];
  }
  // A friend's request: its approval card (approvals) already stands for it when there is one.
  if (t.direction === 'received' && t.state === 'awaiting_approval' && !state.approvals.some((a) => a.task === t.id)) {
    return [
      {
        id: `request:${t.id}`,
        kind: 'request',
        title: clip(t.secret ? `${t.peerName} wants ${t.secret.label}` : t.summary ? `${t.peerName}: ${t.summary}` : `${t.peerName} asks ${agentOf(state, undefined, '')}`, 500),
        detail: clip(plainLine(t.ask, 64_000), 64_000),
        from: clip(t.peerName, 100),
        ...(t.chat && chatTopic(t.chat) ? { topic: chatTopic(t.chat)! } : {}),
        askedAt: t.createdAt,
        actions: [
          { label: t.secret ? 'Allow once' : 'Approve', tone: 'main', method: 'gateway.decide', args: [t.id, { answer: 'yes' }] },
          { label: 'Decline', tone: 'danger', method: 'gateway.decide', args: [t.id, { answer: 'no' }] },
          ...(t.secret ? [] : [{ label: 'Always', tone: 'plain' as const, method: 'gateway.decide', args: [t.id, { answer: 'always' }] }]),
        ],
      },
    ];
  }
  return [];
}

/**
 * What a running plan gave up on by itself, so it's yours: a task Beluga woke that stopped again
 * (Resume), or a milestone it couldn't move on after every rescue step (saying what it tried).
 */
function stuckItems(plan: Plan, progress: PlanProgress, at: Pick<NeedsYou, 'topic' | 'from'>): NeedsYou[] {
  if (plan.status !== 'active') return [];
  const titles = new Map((progress.body?.milestones ?? []).flatMap((m) => [[m.id, m.title] as const, ...m.tasks.map((t) => [t.id, t.title] as const)]));
  const stalled = Object.entries(plan.watch ?? {})
    .filter(([, w]) => w.needsYou)
    .map(([taskId, w]): NeedsYou => ({
      id: `plan:${plan.id}:stalled:${taskId}`,
      kind: 'decision',
      // What it said last is usually what it waits on you for: shown first, with what to do.
      title: clip(w.said ? `“${titles.get(taskId) ?? 'A task'}” needs you` : `“${titles.get(taskId) ?? 'A task'}” stopped twice: resume it?`, 500),
      // Claude's own words: no code on the phone, as its answers (stripCode).
      detail: clip(w.said ? `It says: “${plainLine(w.said, 300)}” Do what it asks, then Resume it.` : w.reason, 64_000),
      ...at,
      askedAt: w.at,
      actions: [{ label: 'Resume', tone: 'main', method: 'plans.resumeTask', args: [plan.id, taskId] }],
    }));
  const rescued = Object.entries(plan.rescue ?? {})
    .filter(([, r]) => r.yours)
    .map(([unitId, r]): NeedsYou => ({
      id: `plan:${plan.id}:rescue:${unitId}`,
      kind: 'stuck',
      title: clip(`Stuck${titles.has(unitId) ? ` on “${titles.get(unitId)}”` : ''}`, 500),
      detail: clip(r.tried.length ? `Beluga tried: ${r.tried.join('; ')}` : 'Beluga couldn’t move it on by itself', 64_000),
      ...at,
      askedAt: r.at,
      actions: [],
    }));
  // A merge conflict Claude couldn't fix (a milestone into the plan's branch, or main into it for its PR): ask it again.
  const merging = Object.entries(plan.merging ?? {}).filter(([, m]) => m.conflict?.stuck);
  const conflicts = [
    ...merging.map(([id, m]) => ({ key: id, files: m.conflict!.files, at: m.conflict!.at, what: `merging “${titles.get(id) ?? 'a milestone'}” into ${plan.branch ?? 'the plan’s branch'}` })),
    ...(plan.mainMerge?.conflict?.stuck ? [{ key: 'main', files: plan.mainMerge.conflict.files, at: plan.mainMerge.conflict.at, what: `merging ${plan.mainMerge.main} into ${plan.branch ?? 'the plan’s branch'} for its pull request` }] : []),
  ].map(
    (c): NeedsYou => ({
      id: `plan:${plan.id}:conflict:${c.key}`,
      kind: 'stuck',
      title: clip('A merge conflict Claude couldn’t fix', 500),
      detail: clip(`While ${c.what}: ${c.files.join(', ')}`, 64_000),
      ...at,
      askedAt: c.at,
      actions: [{ label: 'Ask Claude again', tone: 'main', method: 'plans.retryConflicts', args: [plan.id] }],
    }),
  );
  return [...stalled, ...rescued, ...conflicts];
}

/** What a plan waits for from you: approving its draft, passing a milestone at its gate, or what it couldn't move on itself. */
function planItems(plan: Plan, progress: PlanProgress): NeedsYou[] {
  const title = clip(planTitle(plan), 200);
  const topic = planTopic(plan.id);
  const at = { ...(topic ? { topic } : {}), from: 'your plan' };
  return [...gateItems(plan, progress, title, at), ...stuckItems(plan, progress, at)];
}

function gateItems(plan: Plan, progress: PlanProgress, title: string, at: Pick<NeedsYou, 'topic' | 'from'>): NeedsYou[] {
  const next = progress.next;
  // Claude is still writing the first plan: nothing to approve yet (the Mac's Approve Plan waits too).
  if (next.kind === 'approve' && !progress.body?.milestones.length) return [];
  // A fresh agent is verifying the draft, as you asked (BLG-772): the Mac's Approve Plan waits for it too.
  const review = reviewState(plan);
  if (next.kind === 'approve' && review === 'reviewing') return [];
  if (next.kind === 'approve' && review === 'findings' && plan.review && !plan.review.fixAsked) {
    const found = plan.review.findings;
    return [
      {
        id: `plan:${plan.id}:review:${plan.draftRev}`,
        kind: 'decision',
        title: `The reviewer found ${found.length === 1 ? 'one thing' : `${found.length} things`} to fix in “${title}”`,
        detail: clip(found.map((f, i) => `${i + 1}. ${plainLine(f.text, 1000)}`).join('\n'), 64_000),
        ...at,
        askedAt: plan.review.at,
        actions: [
          { label: 'Fix', tone: 'main', method: 'plans.fixReview', args: [plan.id] },
          { label: 'Approve anyway', tone: 'plain', method: 'plans.approve', args: [plan.id] },
          { label: 'Discard', tone: 'danger', method: 'plans.discard', args: [plan.id] },
        ],
      },
    ];
  }
  if (next.kind === 'approve' || next.kind === 'review_changes') {
    return [
      {
        id: `plan:${plan.id}:approve:${plan.draftRev}`,
        kind: 'decision',
        title: next.kind === 'approve' ? `Approve the plan “${title}”?` : `Approve the changes to “${title}”?`,
        ...(plan.draft?.goal ? { detail: clip(plainLine(plan.draft.goal, 4000), 4000) } : {}),
        ...at,
        askedAt: plan.updatedAt,
        actions: [
          { label: 'Approve', tone: 'main', method: 'plans.approve', args: [plan.id] },
          // A first draft can be read by a fresh agent first, and approved once it reads well (BLG-772).
          ...(next.kind === 'approve' ? [{ label: 'Verify, then approve', tone: 'plain' as const, method: 'plans.verify', args: [plan.id, { thenApprove: true }] }] : []),
          { label: 'Discard', tone: 'danger', method: 'plans.discard', args: [plan.id] },
        ],
      },
    ];
  }
  if (next.kind === 'pass') {
    const m = next.milestone.milestone;
    // Passed once, but its work couldn't go into the plan's branch: why, and pass it again.
    const failed = next.milestone.run.mergeFailed;
    return [
      {
        id: `plan:${plan.id}:pass:${m.id}`,
        kind: 'decision',
        title: failed ? `“${clip(m.title, 200)}” couldn’t merge: pass it again?` : `“${clip(m.title, 200)}” is ready: pass it?`,
        detail: clip(failed ? failed.reason : m.criteria.join('\n'), 64_000),
        ...at,
        // Send it back takes your words (the answer template).
        freeText: true,
        actions: [
          { label: 'Pass', tone: 'main', method: 'plans.pass', args: [plan.id, m.id] },
          { label: 'Check again', tone: 'plain', method: 'plans.recheck', args: [plan.id, m.id] },
        ],
        answer: { method: 'plans.sendBack', args: [plan.id, m.id, ''], slot: [2], text: true, picks: false, label: 'Send back' },
      },
    ];
  }
  return [];
}

export const progressOf = (state: DomainState, plan: Plan): PlanProgress => planView(plan, state.board);

/** Someone came to the door with a link you made: let them in (with what the link offers) or turn them away. */
function knockItems(state: DomainState): NeedsYou[] {
  return state.knocks.map((k) => {
    const name = nameOf(state, k.peerId) ?? state.guests[k.peerId]?.name ?? 'Someone';
    const link = state.links.find((l) => l.id === k.linkId);
    return {
      id: `knock:${k.peerId}`,
      kind: 'request',
      title: clip(`${name} wants to come in`, 500),
      detail: clip(link ? `With your link to ${link.label}` : 'With one of your links', 64_000),
      from: clip(name, 100),
      ...(k.ts ? { askedAt: k.ts } : {}),
      actions: [
        { label: 'Let in', tone: 'main', method: 'invites.letIn', args: [k.peerId] },
        { label: 'Turn away', tone: 'danger', method: 'invites.decline', args: [k.peerId] },
      ],
    };
  });
}

/** People asking to join a channel you run (you're its admin). */
function joinItems(state: DomainState): NeedsYou[] {
  return state.network.groups
    .filter((g) => g.admin && g.active)
    .flatMap((g) =>
      g.requests.map((r) => {
        const topic = chatTopic(`group:${g.id}`);
        return {
          id: `join:${g.id}:${r.peerId}`,
          kind: 'request',
          title: clip(`${r.name} asks to join ${g.name}`, 500),
          from: clip(r.name, 100),
          ...(topic ? { topic } : {}),
          askedAt: r.ts,
          actions: [
            { label: 'Let in', tone: 'main' as const, method: 'network.groups.approve', args: [g.id, r.peerId] },
            { label: 'Decline', tone: 'danger' as const, method: 'network.groups.decline', args: [g.id, r.peerId] },
          ],
        };
      }),
    );
}

/** Someone in your room asks to be friends on the Beluga network (BLG-202). */
function offerItems(state: DomainState): NeedsYou[] {
  return (state.network.offers ?? [])
    .filter((o) => o.dir === 'in')
    .map((o) => ({
      id: `friend:${o.peerId}`,
      kind: 'request' as const,
      title: clip(o.via ? `${o.name} from the ${o.via} team wants to add you as a friend` : `${o.name} wants to add you as a friend`, 500),
      detail: 'You’re in the same room. As friends you can talk, share and ask each other’s agents, with nobody hosting',
      from: clip(o.name, 100),
      askedAt: o.at,
      actions: [
        { label: 'Accept', tone: 'main' as const, method: 'network.friends.answerOffer', args: [o.peerId, true] },
        { label: 'Not now', tone: 'danger' as const, method: 'network.friends.answerOffer', args: [o.peerId, false] },
      ],
    }));
}

/** Someone rings you (BLG-706): answer on your Mac (its window picks up the call) or decline. */
function callItems(state: DomainState): NeedsYou[] {
  return Object.values(state.network.calls ?? {})
    .filter((c) => c.mine === 'ringing')
    .map((c) => {
      const by = state.network.friends.find((f) => f.peerId === c.ringBy)?.name ?? c.people.find((p) => p.peerId === c.ringBy)?.name ?? 'Someone';
      const group = c.conversation.startsWith('group:') ? state.network.groups.find((g) => g.id === c.conversation.slice(6)) : undefined;
      return {
        id: `call:${c.id}`,
        kind: 'call',
        title: clip(`${by} is calling${group ? ` in #${group.name}` : ''}`, 500),
        detail: c.people.length > 1 ? clip(`${c.people.map((p) => p.name).join(', ')} are in the call`, 500) : 'Your Mac picks it up when you answer',
        from: clip(by, 100),
        topic: 'chats' as const,
        ...(c.ringSince ? { askedAt: c.ringSince } : {}),
        actions: [
          { label: 'Answer on Mac', tone: 'main' as const, method: 'calls.join', args: [c.conversation] },
          { label: 'Decline', tone: 'danger' as const, method: 'calls.decline', args: [c.conversation] },
        ],
      };
    });
}

/** A friend on the same GitHub repository: team up on it (BLG-221). Only offers waiting on you. */
function teamOfferItems(state: DomainState): NeedsYou[] {
  return state.team.offers
    .filter((o) => o.state !== 'asked')
    .map((o) => ({
      id: `team:${o.peerId}:${o.projectId}`,
      kind: 'request' as const,
      title: clip(`${offerWords(o)}. ${o.state === 'invited' && o.team?.length ? 'Join?' : 'Team up?'}`, 500),
      detail: OFFER_DETAIL,
      from: clip(o.name, 100),
      askedAt: o.at,
      actions: [
        { label: 'Team Up', tone: 'main' as const, method: 'team.answer', args: [o.peerId, o.projectId, true] },
        { label: 'Not Now', tone: 'danger' as const, method: 'team.answer', args: [o.peerId, o.projectId, false] },
      ],
    }));
}

/** A teammate gave you a task (BLG-223): it waits until you've seen it. */
function assignedItems(state: DomainState): NeedsYou[] {
  return state.team.assigned.flatMap((a) => {
    const topic = taskTopic(a.issueId);
    return [
      {
        id: `team-task:${a.issueId}`,
        kind: 'request' as const,
        title: clip(`${a.by} gave you ${a.key}: ${a.title}`, 500),
        detail: 'It’s in your tasks, on your board for this repository.',
        from: clip(a.by, 100),
        ...(topic ? { topic } : {}),
        askedAt: a.at,
        actions: [{ label: 'Got It', tone: 'main' as const, method: 'team.ackAssignment', args: [a.issueId] }],
      },
    ];
  });
}

/** A teammate knocking on one of your worktrees (BLG-416): let them in as a viewer or an editor. */
function worktreeKnockItems(state: DomainState): NeedsYou[] {
  return (state.team.knocks ?? []).map((k) => {
    const topic = chatTopic(`ws:${k.workspaceId}`);
    return {
      id: `wt-knock:${k.id}`,
      kind: 'request' as const,
      title: clip(knockWords(k), 500),
      detail: clip(k.note ? `“${k.note}” · ${k.key}: ${k.title}` : `${k.key}: ${k.title}`, 64_000),
      from: clip(k.name, 100),
      ...(topic ? { topic } : {}),
      askedAt: k.at,
      actions: [
        { label: 'Let In as Editor', tone: 'main' as const, method: 'team.answerKnock', args: [k.id, 'contribute'] },
        { label: 'Not Now', tone: 'danger' as const, method: 'team.answerKnock', args: [k.id, 'decline'] },
        { label: 'Let In as Viewer', tone: 'plain' as const, method: 'team.answerKnock', args: [k.id, 'view'] },
      ],
    };
  });
}

/**
 * Shared plans (BLG-225): a plan a teammate shared that you haven't approved (Approve, or words as a
 * comment), and a teammate's suggested change to a plan of yours (Apply / Set Aside).
 */
function sharedPlanItems(state: DomainState): NeedsYou[] {
  const self = myId(state);
  const theirs = state.team.plans
    .filter((p) => p.status === 'draft' && !p.reviews.some((r) => r.by === self && r.kind === 'approve' && r.rev === p.rev))
    .map((p) => ({
      id: `team-plan:${p.owner}:${p.id}:${p.rev}`,
      kind: 'decision' as const,
      title: clip(`${p.ownerName} shared the plan “${p.title}”: approve it?`, 500),
      detail: clip(
        [plainLine(p.body.goal, 2000), ...p.body.milestones.map((m, i) => `${i + 1}. ${m.title} (${m.tasks.length} task${m.tasks.length === 1 ? '' : 's'})`)].filter(Boolean).join('\n'),
        64_000,
      ),
      from: clip(p.ownerName, 100),
      askedAt: p.updatedAt,
      freeText: true,
      actions: [{ label: 'Approve', tone: 'main' as const, method: 'team.reviewPlan', args: [p.owner, p.id, { kind: 'approve' }] }],
      answer: { method: 'team.reviewPlan', args: [p.owner, p.id, { kind: 'comment', text: '' }], slot: [2, 'text'], text: true, picks: false, label: 'Comment' },
    }));
  const mine = Object.values(state.team.planShares).flatMap((share) => {
    const plan = state.plans.plans.find((p) => p.id === share.planId);
    if (!plan) return [];
    return share.reviews
      .filter((r) => r.kind === 'suggest' && !r.settled)
      .map((r) => ({
        id: `team-suggest:${r.id}`,
        kind: 'decision' as const,
        title: clip(`${r.name} suggests ${r.ops?.length === 1 ? 'a change' : `${r.ops?.length ?? 0} changes`} to “${planTitle(plan)}”`, 500),
        ...(r.text ? { detail: clip(r.text, 64_000) } : {}),
        from: clip(r.name, 100),
        ...(planTopic(plan.id) ? { topic: planTopic(plan.id)! } : {}),
        askedAt: r.at,
        actions: [
          { label: 'Apply', tone: 'main' as const, method: 'team.applySuggestion', args: [plan.id, r.id] },
          { label: 'Set Aside', tone: 'danger' as const, method: 'team.dismissSuggestion', args: [plan.id, r.id] },
        ],
      }));
  });
  return [...theirs, ...mine];
}

/**
 * Sentinel runs waiting for you (docs/sentinel.md §5): a merge that passed its checks and review,
 * held for your Merge. The detail is the merge step's own line (the checks, Claude's review).
 */
function sentinelItems(state: DomainState): NeedsYou[] {
  const s = state.sentinel;
  if (!s.enabled) return [];
  return s.runs.flatMap((r) => {
    const sn = r.state === 'needs-you' ? sentinelById(s, r.sentinelId) : undefined;
    if (!sn) return [];
    const at = sn.steps.findIndex((st) => st.kind === 'merge');
    const step = at >= 0 ? (r.steps.find((x) => x.id === sn.steps[at]!.id) ?? r.steps[at]) : undefined;
    const detail = [step?.why ? firstLine(step.why, 2000) : '', r.pr ? `Pull request #${r.pr.number}` : ''].filter(Boolean).join('\n');
    const topic = sentinelTopic(sn.id);
    return [
      {
        id: `sentinel:${r.id}`,
        kind: 'decision' as const,
        title: clip(firstLine(r.headline, 500) || `${sn.name} waits for you`, 500),
        ...(detail ? { detail: clip(detail, 64_000) } : {}),
        from: clip(sn.name, 100),
        ...(topic ? { topic } : {}),
        askedAt: Math.round(step?.startedAt ?? r.startedAt),
        actions: [
          { label: 'Merge', tone: 'main' as const, method: 'sentinel.decide', args: [r.id, 'merge'] },
          { label: 'Not Now', tone: 'danger' as const, method: 'sentinel.decide', args: [r.id, 'skip'] },
        ],
      },
    ];
  });
}

/**
 * A dialogue between your agents waiting on you: one proposed from the composer (confirm its caps)
 * or paused at its cap (Continue?). One a friend chairs is theirs to decide, not yours.
 */
function dialogueItems(state: DomainState): NeedsYou[] {
  return Object.values(state.dialogues ?? {}).flatMap((d) => {
    if (d.remoteChair || (d.status !== 'paused' && d.status !== 'proposed')) return [];
    const topic = convTopic(d.channel ?? 'room');
    const what = clip(firstLine(d.topic, 200), 200);
    const base = { id: `dialogue:${d.id}`, kind: 'decision' as const, from: d.participants.map((p) => p.agent.label).join(' and '), ...(topic ? { topic } : {}), askedAt: Math.round(d.updatedAt) };
    return [
      d.status === 'paused'
        ? {
            ...base,
            title: clip(`Your agents paused after ${d.turns.filter((t) => t.by !== 'person').length} turns: continue?`, 500),
            detail: what,
            actions: [
              { label: 'Continue', tone: 'main' as const, method: 'dialogues.continue', args: [d.id] },
              { label: 'Stop', tone: 'danger' as const, method: 'dialogues.stop', args: [d.id] },
            ],
          }
        : {
            ...base,
            title: 'Start this dialogue between your agents?',
            detail: what,
            actions: [
              { label: 'Start', tone: 'main' as const, method: 'dialogues.confirm', args: [d.id] },
              { label: 'Cancel', tone: 'danger' as const, method: 'dialogues.stop', args: [d.id] },
            ],
          },
    ];
  });
}

/** Everything waiting for you, in no order and uncut (needsYou sorts and keeps 50), minus what you dismissed. */
export function allNeeds(state: DomainState): NeedsYou[] {
  const dismissed = state.dismissedNeeds ?? [];
  const all = waitingNeeds(state);
  return dismissed.length ? all.filter((n) => !dismissed.includes(n.id)) : all;
}

/** Everything waiting for you, dismissed or not. */
export function waitingNeeds(state: DomainState): NeedsYou[] {
  return [
    ...state.approvals.map((a) => approvalItem(state, a)),
    ...state.questions.map((q) => questionItem(state, q)),
    ...state.gateway.tasks.flatMap((t) => gatewayItems(state, t)),
    ...state.plans.plans.filter((p) => p.status !== 'done').flatMap((p) => planItems(p, progressOf(state, p))),
    ...knockItems(state),
    ...joinItems(state),
    ...offerItems(state),
    ...callItems(state),
    ...teamOfferItems(state),
    ...assignedItems(state),
    ...worktreeKnockItems(state),
    ...sharedPlanItems(state),
    ...sentinelItems(state),
    ...dialogueItems(state),
  ];
}

/** A notice's `need` names this item: its id, or the start of it (`gwq:<task>` for that task's question). */
export const needMatches = (id: string, need: string): boolean => id === need || id.startsWith(`${need}:`);

/** Everything waiting for you, oldest first: approvals, Claude's questions, friends' requests, plan decisions. */
export function needsYou(state: DomainState): NeedsYou[] {
  const items = allNeeds(state);
  // Oldest first; what has no time (Claude's questions) counts as just asked.
  const at = (n: NeedsYou): number => n.askedAt ?? Number.MAX_SAFE_INTEGER;
  return items.sort((a, b) => at(a) - at(b)).slice(0, 50);
}
