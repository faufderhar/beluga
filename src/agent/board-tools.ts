import { tool, toolSuite } from './tool-kit.js';
import { z } from 'zod';
import { DEFAULT_LABELS } from '../core/board/labels.js';
import type { BoardTools } from './types.js';

/**
 * The task board as Claude's tools (server `beluga_board`), in your own runs (and a trusted friend's,
 * on their project's board only: BLG-701): read tasks, keep the
 * one it's doing true (its brief, decisions, notes for the next agent, proof), split work into
 * sub-tasks and mark what waits on what. Every change shows in the task's activity as Claude's.
 */

export const BOARD_TOOL_NAMES = ['task_define', 'task_get', 'task_list', 'task_create', 'task_start', 'board_create', 'task_update', 'task_brief_edit', 'task_note', 'task_relate', 'task_attach_proof'].map((n) => `mcp__beluga_board__${n}`);

const key = z.string().min(2).max(40).optional().describe('The task’s key, like BOB-12. Leave out for the task this worktree is doing');
const STATUS = z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled']);
const PRIORITY = z.enum(['urgent', 'high', 'medium', 'low', 'none']);
const SECTION = z.enum(['goal', 'context', 'acceptance', 'decisions', 'questions', 'handoff']);
const ESTIMATE = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(8)]).describe('Points: 1 an hour or so, 2 half a day, 3 a day, 5 a few days, 8 a week (split it)');
const items = (max: number) => z.array(z.string().min(1).max(400)).max(max);

async function guarded(fn: () => string | Promise<string>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

/** Labels come from the board's set: the built-in ones (named here) and any the project added (the brief lists them). */
const LABELS = (max: number) =>
  z
    .array(z.string().max(32))
    .max(max)
    .optional()
    .describe(`From the board's set only: ${DEFAULT_LABELS.map((l) => l.name).join(', ')}, and any the project added. Never make one up; "important" only when it matters most`);

export function createBoardToolDefs(board: BoardTools) {
  return [
    tool(
      'task_define',
      'Define the work this conversation is for, as a task: a short title and, in your own words (never the user’s message pasted in), its goal, the context someone new needs, acceptance criteria, the decisions made and why, open questions, an estimate and a priority. In plan mode it goes on the board when the user approves your plan; call it right before ExitPlanMode. Elsewhere, with no task yet, it opens this worktree’s task now: private and the user’s (tell them).',
      {
        title: z.string().min(1).max(120),
        goal: z.string().min(1).max(4000).describe('What it’s for and what done looks like, in a sentence or three'),
        context: z.string().max(8000).optional().describe('Where the code is and how it works today'),
        acceptance: items(15).optional().describe('Checkable statements: done means all are true'),
        decisions: items(15).optional().describe('What was decided and why, one per line'),
        questions: items(10).optional().describe('What is still unclear'),
        estimate: ESTIMATE.optional(),
        priority: PRIORITY.optional(),
        labels: LABELS(6),
      },
      (a) =>
        guarded(() =>
          board.define({
            title: a.title,
            goal: a.goal,
            ...(a.context ? { context: a.context } : {}),
            ...(a.acceptance ? { acceptance: a.acceptance } : {}),
            ...(a.decisions ? { decisions: a.decisions } : {}),
            ...(a.questions ? { questions: a.questions } : {}),
            ...(a.estimate ? { estimate: a.estimate } : {}),
            ...(a.priority ? { priority: a.priority } : {}),
            ...(a.labels ? { labels: a.labels } : {}),
          }),
        ),
    ),
    tool('task_get', 'A task in full: status, priority, who it’s for, its parent, sub-tasks, blockers, pull request, its brief and recent activity.', { key }, (a) => guarded(() => board.get(a.key))),
    tool(
      'task_list',
      'Tasks, one per line (key · status · priority · title, and the repo when its board covers several). scope: open (default: every unfinished task), mine (yours and your Claude’s), all (recently finished too). Without project: this task’s board and this repo’s tasks.',
      { scope: z.enum(['open', 'mine', 'all']).optional(), project: z.string().max(80).optional().describe('A board’s or a repo’s name (or a board’s key prefix, like BOB)'), query: z.string().max(200).optional().describe('Words in the title, key, labels or brief') },
      (a) => guarded(() => board.list({ ...(a.scope ? { scope: a.scope } : {}), ...(a.project ? { project: a.project } : {}), ...(a.query ? { query: a.query } : {}) })),
    ),
    tool(
      'task_create',
      'Create a task (a sub-task with parent). A task is on a board and runs in one repo (its worktree is made there); a board can cover several repos. It goes on this task’s board (a sub-task: its parent’s), running in this worktree’s repo, unless you name another: project for work in another repo, board for another board. Write its goal in your own words, with acceptance criteria as a "- [ ]" checklist, and an estimate.',
      {
        title: z.string().min(1).max(200),
        goal: z.string().max(4000).optional(),
        context: z.string().max(8000).optional(),
        acceptance: z.string().max(4000).optional(),
        decisions: z.string().max(4000).optional(),
        questions: z.string().max(4000).optional(),
        estimate: ESTIMATE.optional(),
        project: z.string().max(80).optional().describe('The repo it runs in (a project’s name), when the work is in another repo than this one'),
        board: z.string().max(80).optional().describe('The board it goes on (its name or key prefix), when not this task’s board; board_create makes a new one'),
        parent: z.string().max(40).optional().describe('The parent task’s key'),
        blocked_by: z.array(z.string().max(40)).max(10).optional().describe('Keys of tasks that must be done first'),
        status: z.enum(['backlog', 'todo']).optional(),
        priority: PRIORITY.optional(),
        labels: LABELS(8),
        private: z.boolean().optional().describe('Only the user sees it: never sent to their teammates or to Linear. Only when the user asks for it ("just for me", "private"). A private task’s sub-tasks are private anyway'),
      },
      (a) =>
        guarded(() =>
          board.create({
            title: a.title,
            ...(a.goal ? { goal: a.goal } : {}),
            ...(a.context ? { context: a.context } : {}),
            ...(a.acceptance ? { acceptance: a.acceptance } : {}),
            ...(a.decisions ? { decisions: a.decisions } : {}),
            ...(a.questions ? { questions: a.questions } : {}),
            ...(a.estimate ? { estimate: a.estimate } : {}),
            ...(a.project ? { project: a.project } : {}),
            ...(a.board ? { board: a.board } : {}),
            ...(a.parent ? { parent: a.parent } : {}),
            ...(a.blocked_by ? { blockedBy: a.blocked_by } : {}),
            ...(a.status ? { status: a.status } : {}),
            ...(a.priority ? { priority: a.priority } : {}),
            ...(a.labels ? { labels: a.labels } : {}),
            ...(a.private ? { private: true } : {}),
          }),
        ),
    ),
    tool(
      'task_start',
      'Start a task, as the user’s Start does: a worktree of its own in the repo it runs in (this project or another), with an agent working it from its brief right away. task_create first when it isn’t on the board. Only when the user asks you to start, kick off or hand off work. Name both in your answer as the result says (`task:KEY`, `worktree:<id>`).',
      { key: z.string().min(2).max(40).describe('The task’s key, like BOB-12') },
      (a) => guarded(() => board.start(a.key)),
    ),
    tool(
      'board_create',
      'Make a board for work across a few repos (a launch, a feature that touches the API and the app): each task on it runs in one of its repos. No need for the user to make it first. Then put tasks on it with task_create (board: its name). When a board already covers those repos, use it instead.',
      {
        name: z.string().min(1).max(60).describe('Short, what the work is ("Launch", "Payments")'),
        repos: z.array(z.string().min(1).max(80)).min(1).max(20).describe('The repos it covers (projects’ names)'),
        prefix: z.string().min(2).max(6).optional().describe('What its task keys start with ("LNCH"); left out: made from the name'),
      },
      (a) => guarded(() => board.createBoard({ name: a.name, repos: a.repos, ...(a.prefix ? { prefix: a.prefix } : {}) })),
    ),
    tool(
      'task_update',
      'Change a task: its title, status, priority, estimate, labels (the full list), the repo it runs in (project), or who it’s for (me: the user; nobody). A task is for a person, never a Claude. Mark a task done or canceled only when the user asked or said its work shipped (its sub-tasks still open go Done with it). in_review is refused while an acceptance criterion is neither ticked nor explained.',
      { key, title: z.string().min(1).max(200).optional(), status: STATUS.optional(), priority: PRIORITY.optional(), estimate: ESTIMATE.optional(), labels: LABELS(12), assign: z.enum(['me', 'nobody']).optional(), project: z.string().max(80).optional().describe('The repo it runs in from now on (a project’s name): it stays on its board') },
      (a) =>
        guarded(() =>
          board.update(a.key, {
            ...(a.title ? { title: a.title } : {}),
            ...(a.status ? { status: a.status } : {}),
            ...(a.priority ? { priority: a.priority } : {}),
            ...(a.labels ? { labels: a.labels } : {}),
            ...(a.estimate ? { estimate: a.estimate } : {}),
            ...(a.assign ? { assign: a.assign } : {}),
            ...(a.project ? { project: a.project } : {}),
          }),
        ),
    ),
    tool(
      'task_brief_edit',
      'Write one section of a task’s brief (Markdown). Sections: goal, context, acceptance ("- [ ]" checklist; "- [x]" ticks one; one that can’t be true yet gets its reason on its line: "- [ ] … — deferred: why" or "— not done: why"), decisions (what was decided and why), questions (still open), handoff (notes for the next agent). mode "append" adds a line (decisions); "replace" (default) rewrites the section. Say why in reason: it shows in the history.',
      { key, section: SECTION, content: z.string().max(20_000), reason: z.string().max(200).optional(), mode: z.enum(['replace', 'append']).optional() },
      (a) => guarded(() => board.editBrief(a.key, a.section, a.content, a.reason, a.mode)),
    ),
    tool('task_note', 'Leave a note on a task’s activity: what you did, found or tried. Short.', { key, text: z.string().min(1).max(8000) }, (a) => guarded(() => board.note(a.key, a.text))),
    tool(
      'task_relate',
      'Mark what waits on what: blocked_by (this task waits on other), blocks (other waits on this), related. remove: true takes it back.',
      { key, relation: z.enum(['blocked_by', 'blocks', 'related']), other: z.string().min(2).max(40), remove: z.boolean().optional() },
      (a) => guarded(() => board.relate(a.key, a.relation, a.other, a.remove)),
    ),
    tool(
      'task_attach_proof',
      'Attach proof to a task: a screenshot (kind image, path: its absolute path, e.g. in the scratch folder), a page (url), a file (path), a graph (body: beluga-graph JSON) or a result (text, body).',
      { key, kind: z.enum(['image', 'url', 'file', 'graph', 'text']), title: z.string().min(1).max(120), path: z.string().max(4096).optional(), url: z.string().url().max(2000).optional(), body: z.string().max(60_000).optional() },
      (a) => guarded(() => board.attachProof(a.key, { kind: a.kind, title: a.title, ...(a.path ? { path: a.path } : {}), ...(a.url ? { url: a.url } : {}), ...(a.body ? { body: a.body } : {}) })),
    ),
  ];
}

export function createBoardTools(board: BoardTools) {
  return toolSuite({ name: 'beluga_board', version: '0.1.0', tools: createBoardToolDefs(board) });
}
