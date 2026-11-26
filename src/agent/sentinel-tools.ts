import { tool, toolSuite } from './tool-kit.js';
import { z } from 'zod';
import { TOOL_DRAFT_SHAPE, TOOL_PATCH_SHAPE } from '../core/sentinel/tool-draft.js';
import { SOURCE_KINDS } from '../shared/view-spec.js';
import type { SentinelTools } from './types.js';
import { ASSISTANT_TITLE } from '../shared/assistant.js';

/**
 * Sentinels as Claude's tools (server `beluga_sentinel`), in your own runs only: list them, read
 * one, set one up from what you said ("every morning…"; it starts paused), change, run, pause or
 * delete one (deleting asks you), and inside a sentinel's run, stop it when there's nothing to do.
 */

export const SENTINEL_TOOL_NAMES = ['sentinel_stop', 'sentinel_list', 'sentinel_get', 'sentinel_create', 'sentinel_run', 'sentinel_test', 'sentinel_try_source', 'sentinel_update', 'sentinel_pause', 'sentinel_remove', 'sentinel_runs', 'sentinel_delete_runs'].map((n) => `mcp__beluga_sentinel__${n}`);

const ref = z.string().min(1).max(80).describe('The sentinel’s id (from sentinel_list) or its name');

async function guarded(fn: () => string | Promise<string>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

/** What every sentinel with a database source needs from Claude before its query is written (BLG-304). */
const READ_FIRST =
  'Before writing a source’s query, read the schema with sentinel_try_source: the columns of every table you join, how the foreign keys actually link (which column holds which id), and child rows that would double-count (chunks or retries pointing at a parent). For a table of events, include who did it when there is a user. Ask the user about columns whose meaning isn’t obvious instead of guessing. Leave a postgres source without url or env: it uses the project’s own variables (DATABASE_URL, or Supabase’s).';

export function createSentinelToolDefs(sentinel: SentinelTools) {
  const stop = sentinel.stop;
  return [
    ...(stop
      ? [
          tool(
            'sentinel_stop',
            'This sentinel run has nothing to do this time ("nothing changed since yesterday"): it ends as skipped, not failed, with your reason as its line. Call it, then end your turn with one short line.',
            { reason: z.string().min(1).max(200) },
            (a) => guarded(() => stop(a.reason)),
          ),
        ]
      : []),
    tool('sentinel_list', 'The user’s sentinels, one per line: name, when it runs, watching or paused, access, its last run and the next, and its `sentinel:<id>` link.', {}, () => guarded(() => sentinel.list())),
    tool('sentinel_get', 'One sentinel’s whole definition (its trigger, steps with their ids and fields, access, limits) as material, to change it with sentinel_update.', { id: ref }, (a) => guarded(() => sentinel.get(a.id))),
    tool(
      'sentinel_create',
      `Set up a sentinel from what the user asked for ("every weekday at 8, triage new issues into tasks"): when it runs, and its steps in order (Ask Claude with a full prompt in your own words, Run a script, Notify me, Keep the numbers). It is always made paused, and you can’t turn it on: tell the user and link it as \`sentinel:<id>\` (inline code) so they can check it and turn it on themselves from its page (the Mac or the phone). A Keep the numbers step that reads a source (postgres, sqlite, http, file) runs once first, with the project’s variables: when it can’t connect or its query fails, nothing is saved and the error says why; fix it and call again. When it works, the answer has a preview (the first rows, how empty each column is, columns flagged as empty in nearly every row) and the check is kept as a test run, so its tiles fill: show the user that preview before you say it’s done. To send a prompt to the chat you are in on a schedule or one time ("send this here every day at 9", "in 5 hours"), use a chat step with to: "this chat". ${READ_FIRST}`,
      TOOL_DRAFT_SHAPE,
      (a) => guarded(() => sentinel.create(a)),
    ),
    tool('sentinel_run', 'Run a sentinel now. Only one that is on: a paused one runs only when the user turns it on or presses Run (to check a paused one’s sources, use sentinel_test). It runs on its own; its report shows on its page.', { id: ref }, (a) => guarded(() => sentinel.run(a.id))),
    tool(
      'sentinel_test',
      'Test a sentinel once without turning it on: it works on a paused one, and it stays paused. Each Keep the numbers step that reads a source runs once with the project’s current variables and keeps what it finds (its dashboard tiles fill), and the answer is a preview per source (the first rows, how empty each column is, columns flagged as empty) or why it failed (no IPv6, the wrong pooler, the wrong password…). Nothing else runs: no Claude, script, service call, message or pull request, and no sentinel after it. A command source, or an address that sends one of the user’s $VARS, waits for their Run Now. Use it to check a fix right away.',
      { id: ref },
      (a) => guarded(() => sentinel.test(a.id)),
    ),
    tool(
      'sentinel_try_source',
      `Run a view source once, read-only, and see its first rows, before you put it in a sentinel: read the schema (postgres: SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, ordinal_position; the foreign keys from information_schema.key_column_usage), look at a few real rows, then try the query you mean to keep. It uses the project’s variables (a postgres source without url or env finds DATABASE_URL, or Supabase’s), never writes, and a command source waits for the user’s yes. ${READ_FIRST}`,
      {
        source: z.looseObject({ kind: z.enum(SOURCE_KINDS) }).describe('The same JSON a view’s source takes: { kind: "postgres", query: "SELECT …" }, { kind: "sqlite", path, query }, { kind: "http", url, headers? }'),
        project: z.string().max(200).optional().describe(`The project whose variables and folder it uses (its name); leave out for ${ASSISTANT_TITLE}`),
      },
      (a) => guarded(() => sentinel.trySource(a.source, a.project)),
    ),
    tool(
      'sentinel_update',
      'Change a sentinel: only the fields given change (steps: the whole new list in order, keeping the ids of steps you keep or edit; sentinel_get has them). You can’t turn one on, and a change keeps it as it was: one that is on stays on. When you add or edit a script, a service call, a pull request or a merge step, raise its access, move it to another project, point a message, friend or Run another sentinel step elsewhere, or give it a trigger of another kind or target, tell the user what it now does (inside a sentinel run, such a change pauses it until they turn it on again). A merge step always waits for the user’s approval: you can’t turn that off. A source you add or change runs once first: when it fails nothing changes; when it works the answer has its preview to show the user.',
      { id: ref, ...TOOL_PATCH_SHAPE },
      ({ id, ...patch }) => guarded(() => sentinel.update(id, patch)),
    ),
    tool('sentinel_pause', 'Pause a sentinel: nothing runs until the user turns it back on. You can pause one but never turn one on: that is the user’s, from the Mac or the phone.', { id: ref }, (a) => guarded(() => sentinel.pause(a.id))),
    tool('sentinel_remove', 'Delete a sentinel (only when the user asks): it stops watching and a run going now stops. The user is asked to approve it first.', { id: ref }, (a) => guarded(() => sentinel.remove(a.id))),
    tool('sentinel_runs', 'A sentinel’s runs, newest first: id, when, how it ended (done, failed, skipped, stopped…), its line, and whether its agent’s chat is still kept. To show the user what ran, or before offering to clear some away.', { id: ref }, (a) => guarded(() => sentinel.runs(a.id))),
    tool(
      'sentinel_delete_runs',
      'Delete some of a sentinel’s runs, only when the user asks (or agrees to your offer): what "chat" deletes is their agent’s conversations for good, the reports and outputs staying on each run’s page; "run" deletes the runs themselves (chats, reports, outputs, their folders). Pick them by ids (sentinel_runs), by how they ended (state) and/or started before a time (before: a date or "7d", "2 weeks"). A run still going is never deleted; worktrees and kept numbers stay. The user approves it first, every time.',
      {
        id: ref,
        what: z.enum(['chat', 'run']),
        runs: z.array(z.string().min(1).max(80)).max(200).optional(),
        state: z.enum(['done', 'failed', 'skipped', 'stopped']).optional(),
        before: z.string().max(40).optional(),
      },
      (a) => guarded(() => sentinel.deleteRuns(a.id, { ...(a.runs ? { runs: a.runs } : {}), ...(a.state ? { state: a.state } : {}), ...(a.before ? { before: a.before } : {}) }, a.what)),
    ),
  ];
}

export function createSentinelTools(sentinel: SentinelTools) {
  return toolSuite({ name: 'beluga_sentinel', version: '0.1.0', tools: createSentinelToolDefs(sentinel) });
}
