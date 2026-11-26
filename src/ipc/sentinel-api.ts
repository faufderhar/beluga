import { z } from 'zod';
import { MAX_RUN_AT_ONCE } from '../core/sentinel/model.js';
import { SentinelDraftSchema, SentinelPatchSchema } from '../core/sentinel/schema.js';

/**
 * Sentinel in the API (see api.ts; docs/sentinel.md §4): the Mac app's Sentinel section, and the
 * phone's runs. You act as yourself; your Claude has its own tools. Browser-safe: zod only.
 */

const id = z.string().min(1).max(80);
const chat = z.string().regex(/^[a-z0-9]{1,24}$/);

export const SENTINEL_API = {
  // A new sentinel (paused until you turn it on) → the sentinel.
  'sentinel.create': { args: z.tuple([SentinelDraftSchema]) },
  // Change its name, icon, project (null: Your Mac), trigger, steps, access, limits or where it notifies → the sentinel.
  'sentinel.update': { args: z.tuple([id, SentinelPatchSchema]) },
  // Delete it (its run stops; its runs' folders go with the next prune).
  'sentinel.remove': { args: z.tuple([id]) },
  'sentinel.duplicate': { args: z.tuple([id]) },
  // Run Now → the run (queued when one is going).
  'sentinel.run': { args: z.tuple([id]) },
  // Test its sources once, paused or not, without turning it on (BLG-302): each Keep the numbers step
  // that reads a source runs and keeps what it finds; nothing else runs → SentinelTest (core/sentinel/preview.ts).
  'sentinel.test': { args: z.tuple([id]) },
  // Stop a run → whether one was going.
  'sentinel.stop': { args: z.tuple([id]) },
  // Pause it, or turn it on (Turn On, Resume).
  'sentinel.pause': { args: z.tuple([id, z.boolean()]) },
  // Move To another computer (BLG-807), as your app runs it (src/machines/move-sentinel.ts). Here: whether
  // it runs now, whether it's paused, its project → SentinelMoveCheck.
  'sentinel.moveCheck': { args: z.tuple([id]) },
  // Packed to go: its steps, runs, kept numbers and tiles (not while it runs) → { token, chunks }.
  'sentinel.movePack': { args: z.tuple([id]) },
  // One piece of a packed sentinel (the last one lets it go here).
  'sentinel.moveChunk': { args: z.tuple([z.string().uuid(), z.number().int().min(0).max(200)]) },
  // There: one piece coming in (its number, how many in all, the piece).
  'sentinel.moveReceive': { args: z.tuple([z.string().uuid(), z.number().int().min(0).max(200), z.number().int().min(1).max(201), z.string().max(2 * 1024 * 1024)]) },
  // There: every piece is in, landed paused in that project (null: none), its sources checked there → SentinelLanding.
  'sentinel.moveLand': { args: z.tuple([z.string().uuid(), z.string().min(1).max(200).nullish(), z.string().min(1).max(80)]) },
  // Gone from here with the tiles that showed only it: the copy runs on the other computer (or, there, a copy whose move didn't finish).
  'sentinel.moveDrop': { args: z.tuple([id]) },
  // A chat's schedules (BLG-399): the sentinels whose chat step wakes it (its channel, or its ref) → ChatSchedule[].
  'sentinel.forChat': { args: z.tuple([z.string().min(1).max(400)]) },
  // Its whole index (the last 200 runs), newest first, without outputs.
  'sentinel.runs': { args: z.tuple([id]) },
  // Delete what a run left (BLG-577): `chat` its agents' conversations, `run` those and the run itself
  // (its folder and its line in the history). Not while it runs.
  'sentinel.runDelete': { args: z.tuple([id, z.enum(['chat', 'run'])]) },
  // One run: its steps' outputs (the first 16 KB each) and its report's text → RunDetail.
  'sentinel.runGet': { args: z.tuple([id]) },
  // Your Claude changes it from your words (the page's box; Describe it is create, then this) → { channel }.
  'sentinel.ask': { args: z.tuple([id, z.string().trim().min(1).max(8000)]) },
  'sentinel.recipes': { args: z.tuple([]) },
  // A run waiting for you (a merge): Merge (once GitHub merged it) or Not Now → the run.
  'sentinel.decide': { args: z.tuple([id, z.enum(['merge', 'skip'])]) },
  // Claude steps running together across all sentinels.
  'sentinel.setRunAtOnce': { args: z.tuple([z.number().int().min(1).max(MAX_RUN_AT_ONCE)]) },
  // A webhook sentinel's secret, new (the old URL stops at once); its URL with the secret, or why there's none now → { url?, why? }.
  'sentinel.rotateSecret': { args: z.tuple([id]) },
  'sentinel.webhookUrl': { args: z.tuple([id]) },
  // A sentinel's number over time (two years at most; since a time) → { metric, lines }, oldest first.
  'sentinel.metricRead': { args: z.tuple([id, z.string().min(1).max(80), z.number().optional()]) },
  // A typed column's document (BLG-345), by sentinel, metric, column and its cell (the file's name; only one
  // its latest rows hold) → { name, mime, size, text | base64, runId, at }. The phone reads it through the Mac.
  'sentinel.document': { args: z.tuple([id, z.string().min(1).max(80), z.string().min(1).max(80), z.string().min(1).max(200)]) },
  // The same document opened in its own app on the Mac, or (`reveal`) shown in Finder.
  'sentinel.documentOpen': { args: z.tuple([id, z.string().min(1).max(80), z.string().min(1).max(80), z.string().min(1).max(200), z.enum(['open', 'reveal']).optional()]) },
  // A storage cell's link, signed now for about a minute with the project's Supabase variables → { url, expiresIn }. Never kept.
  'sentinel.signStorage': { args: z.tuple([id, z.string().min(1).max(80), z.string().min(1).max(80), z.string().min(1).max(1200)]) },
  // A storage cell's object, fetched now through a link signed for a minute, for Beluga's viewer → as `sentinel.document`
  // reads, with its bucket and path (one too big: its name, kind and size only). Nothing is kept.
  'sentinel.storageDocument': { args: z.tuple([id, z.string().min(1).max(80), z.string().min(1).max(80), z.string().min(1).max(1200)]) },
  // The same object saved in its run's files (readable only by you) and opened in its own app, or (`reveal`) shown in Finder.
  'sentinel.storageOpen': { args: z.tuple([id, z.string().min(1).max(80), z.string().min(1).max(80), z.string().min(1).max(1200), z.enum(['open', 'reveal']).optional()]) },
  // What a sentinel keeps, to look at and take out (BLG-392): its metrics (how many lines, since when) and its runs' files → SentinelData.
  'sentinel.dataList': { args: z.tuple([id]) },
  // A run's file (its report, a step's output, a document `files/<name>`) as `sentinel.document` reads; text redacted.
  'sentinel.runFile': { args: z.tuple([id, z.string().min(1).max(220)]) },
  // The same file opened in its own app on the Mac, or (`reveal`) shown in Finder.
  'sentinel.runFileOpen': { args: z.tuple([id, z.string().min(1).max(220), z.enum(['open', 'reveal']).optional()]) },
  // Take it out: a metric's whole history (CSV or JSON) or a run's files, written to ~/Downloads/Beluga/<sentinel>/ and shown in Finder.
  'sentinel.dataExport': { args: z.tuple([id, z.union([z.object({ metric: z.string().min(1).max(80), format: z.enum(['csv', 'json']) }), z.object({ runId: id })])]) },
  // Show its numbers' folder, or a run's folder, in Finder.
  'sentinel.dataReveal': { args: z.tuple([id, id.optional()]) },
  // An action cell's button (BLG-349): runs the sentinel its column names, with the row (one of the
  // metric's latest rows, checked) as its trigger's payload → the run.
  'sentinel.runRow': { args: z.tuple([id, z.string().min(1).max(80), z.string().min(1).max(80), z.record(z.string().max(80), z.union([z.string().max(100_000), z.number(), z.boolean(), z.null()]))]) },
  // The Sentinel chat (docs/sentinel.md §12): a new conversation beside the others, open now → { id, channel }.
  'sentinel.chatNew': { args: z.tuple([]) },
  // Open one (the phone's Chat is the open one).
  'sentinel.chatOpen': { args: z.tuple([chat]) },
  // Clear: its messages go and its Claude starts afresh; the chat stays.
  'sentinel.chatClear': { args: z.tuple([chat]) },
  // Delete it for good (its Claude stops first): the one beside it opens, or a fresh first one.
  'sentinel.chatDelete': { args: z.tuple([chat]) },
} as const;
