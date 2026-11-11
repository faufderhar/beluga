import { AgentRef, MessageVia, ProviderUsage } from '../../protocol.js';
import { z } from 'zod';

/**
 * The gateway's wire protocol: tasks between Claudes. A task is a request from one person's
 * Claude (or the person) to another's: "ask" (their Claude does the work its own way) or "run"
 * (one command, run directly on their Mac). Results go only to the requester, never to a room.
 *
 * Messages travel the same over a friend's mesh link (`gw` frames, see net/mesh/wire.ts) and
 * over today's rooms (a `gateway` body sent to one person). Every message rides in a frame with
 * its own id; the receiver acknowledges it, and what matters (requests, results, cancels) waits
 * in the sender's outbox until it does. Browser-safe: zod only.
 */

/** What a task may need on the other Mac: each is a capability its owner allows or not (see access.ts). */
export const NEEDS = ['project', 'shell', 'files', 'screen', 'device'] as const;
export type Need = (typeof NEEDS)[number];

/** Everything a Beluga can offer (what one person is offered depends on its owner's settings). */
export const OFFERED: readonly Need[] = NEEDS;

/** ask: their Claude does it. run: one command, directly on their Mac. file: one file, sent by their Beluga. */
export const TASK_KINDS = ['ask', 'run', 'file'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** States a task passes through on the other Mac before its result. */
export const LIVE_STATES = ['queued', 'awaiting_approval', 'working'] as const;
export type LiveState = (typeof LIVE_STATES)[number];

export const RESULT_STATUSES = ['done', 'declined', 'failed', 'cancelled'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const TRUST = ['blocked', 'ask', 'trusted', 'full'] as const;

/** Limits: what one task may carry. */
export const MAX_ASK = 16_000;
/** The few words a request's notification shows (the full ask is one click away). */
export const MAX_REQUEST_SUMMARY = 140;
export const MAX_SUMMARY = 60_000;
export const MAX_DATA_CHARS = 256 * 1024;
export const MAX_FILES = 8;
/** Bytes of files one result may carry (inline, base64); bigger files are listed, not sent. */
export const MAX_FILE_TOTAL = 512 * 1024;
export const MAX_SCHEMA_CHARS = 8_000;
/** Files too big to come inline are fetched in chunks over the same link: at most this big each… */
export const MAX_TRANSFER_FILE = 32 * 1024 * 1024;
/** …this much per task… */
export const MAX_TRANSFER_TOTAL = 64 * 1024 * 1024;
/** …in pieces this big (well under a room message's 1 MB once base64'd). */
export const CHUNK_BYTES = 192 * 1024;
/** Questions one task's Claude may send back to the requester. */
export const MAX_QUESTIONS = 5;

export const TaskId = z.string().regex(/^t_[\w-]{10,40}$/);
const PeerId = z.string().regex(/^[\w-]{8,64}$/);
const json = (max: number) =>
  z.unknown().refine((v) => {
    try {
      return (JSON.stringify(v) ?? '').length <= max;
    } catch {
      return false;
    }
  }, `Too large (over ${max} characters as JSON)`);

/** What the requester wants back: data matching a JSON schema, or files. */
export const Expects = z.union([z.literal('files'), z.record(z.string(), z.unknown()).and(json(MAX_SCHEMA_CHARS))]);
export type Expects = z.infer<typeof Expects>;

/**
 * A turn of a chaired dialogue (core/dialogues, BLG-468) riding a task: which dialogue, turn n of
 * its cap, who chairs it, and what was said since this side last spoke, so both threads match.
 * Declared by the chair only (never by an agent's tools): the gateway counts its asks against the
 * dialogue's own cap instead of the per-conversation limit, and its mode keeps talk read-only.
 */
export const DialogueEnvelope = z.object({
  id: z.string().regex(/^dlg_[\w-]{6,40}$/),
  turn: z.number().int().min(1).max(10_000),
  cap: z.number().int().min(1).max(10_000),
  /** The chair's owner, by name (whoever started it). */
  chair: z.string().min(1).max(80),
  topic: z.string().min(1).max(500),
  mode: z.enum(['talk', 'cross-reference', 'work']),
  /** Who talks, as the chair sees them (owner unset: the chair's). */
  participants: z.array(z.object({ agent: z.object({ runtime: z.string().max(32), model: z.string().max(64).optional(), label: z.string().max(64) }), owner: z.string().max(80).optional() })).min(2).max(4),
  said: z.array(z.object({ name: z.string().max(100), text: z.string().max(16_000), agent: z.boolean() })).max(20).default([]),
});
export type DialogueEnvelope = z.infer<typeof DialogueEnvelope>;

export const TaskRequest = z.object({
  t: z.literal('task_request'),
  id: TaskId,
  from: PeerId,
  to: PeerId,
  /** ask: their Claude does it; run: one command, directly on their Mac; file: one file from their Mac. */
  kind: z.enum(TASK_KINDS).default('ask'),
  ask: z.string().min(1).max(MAX_ASK),
  /** A few words for the notification ("take a screenshot of your desktop"); the full ask is behind See more. */
  summary: z.string().min(1).max(MAX_REQUEST_SUMMARY).optional(),
  needs: z.array(z.enum(NEEDS)).max(NEEDS.length).default([]),
  /** One of their projects (by name) to work or run in. */
  project: z.string().min(1).max(80).optional(),
  expects: Expects.optional(),
  /** Epoch ms after which it shouldn't start any more. */
  deadline: z.number().int().positive().optional(),
  /** run: the command, where, and for how long at most. */
  command: z.string().min(1).max(8000).optional(),
  cwd: z.string().max(4096).optional(),
  timeoutSec: z.number().int().min(1).max(600).optional(),
  /** file: the full path of the file on their Mac (~ is their home). */
  path: z.string().min(1).max(4096).optional(),
  /** Who asked: the person's Claude, or the person from their screen. */
  by: z.enum(['agent', 'person']).default('agent'),
  /** The channel you both are in that it was asked from (its card is there; otherwise it's in your DM). */
  chat: z.string().regex(/^group:[\w-]{1,80}$/).optional(),
  /** A turn of a chaired dialogue (an older Mac drops it and runs it as a plain ask). */
  dialogue: DialogueEnvelope.optional(),
  /**
   * ask: which of their agents (one their card lists, BLG-503). Their Mac runs it there when it's set
   * up, else on their default agent and says so; an older Mac drops it and runs its default.
   */
  agent: AgentRef.optional(),
  /** An external agent of the sender's asked. Shown on the card; their rules still judge the sender. */
  via: MessageVia.optional(),
  ts: z.number().int().min(0),
});
export type TaskRequest = z.infer<typeof TaskRequest>;

export const TaskUpdate = z.object({
  t: z.literal('task_update'),
  id: TaskId,
  state: z.enum(LIVE_STATES),
  step: z.string().max(300).optional(),
  ts: z.number().int().min(0),
});
export type TaskUpdate = z.infer<typeof TaskUpdate>;

export const ResultFile = z.object({
  name: z.string().min(1).max(200),
  size: z.number().int().min(0),
  /** The bytes, base64 (missing: too big to send this way). */
  b64: z.string().max(Math.ceil((MAX_FILE_TOTAL * 4) / 3) + 8).optional(),
  /** Too big to come inline: fetch it with file_get (this id), and check it against sha256. */
  ref: z.string().regex(/^[\w-]{8,40}$/).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** A picture (a screenshot): screens show it. */
  image: z.boolean().optional(),
});
export type ResultFile = z.infer<typeof ResultFile>;

export const TaskResult = z.object({
  t: z.literal('task_result'),
  id: TaskId,
  status: z.enum(RESULT_STATUSES),
  summary: z.string().max(MAX_SUMMARY),
  data: json(MAX_DATA_CHARS).optional(),
  files: z.array(ResultFile).max(MAX_FILES).default([]),
  /** The steps it took (short lines). */
  log: z.array(z.string().max(300)).max(60).default([]),
  /** A file request for a secret that its owner approved, that one time ("private SSH key id_ed25519"): the requester's Claude is told so. */
  secret: z.string().min(1).max(200).optional(),
  /** An ask: which of their agents answered (runtime and model; BLG-448). An older Mac leaves it out: Claude. */
  agent: AgentRef.optional(),
  ts: z.number().int().min(0),
});
export type TaskResult = z.infer<typeof TaskResult>;

export const TaskCancel = z.object({
  t: z.literal('task_cancel'),
  id: TaskId,
  /** A dialogue stopped on this side (BLG-468): it ends on the other side too, whichever way the task went. */
  dialogue: z.object({ id: z.string().regex(/^dlg_[\w-]{6,40}$/), why: z.string().max(300) }).optional(),
  ts: z.number().int().min(0),
});
export type TaskCancel = z.infer<typeof TaskCancel>;

const QuestionId = z.string().regex(/^q_[\w-]{6,40}$/);
const QuestionOption = z.object({ label: z.string().max(200), description: z.string().max(1000).default('') });
/** One of the questions (Claude's AskUserQuestion): what it asks, and the answers it offers. */
export const TaskQuestionItem = z.object({ question: z.string().min(1).max(1000), header: z.string().max(40).default(''), options: z.array(QuestionOption).max(6).default([]), multiSelect: z.boolean().default(false) });
export type TaskQuestionItem = z.infer<typeof TaskQuestionItem>;

/** The friend's Claude, working on your task, asks you (your Claude first, then you). */
export const TaskQuestion = z.object({ t: z.literal('task_question'), id: TaskId, qid: QuestionId, questions: z.array(TaskQuestionItem).min(1).max(4), ts: z.number().int().min(0) });
export type TaskQuestion = z.infer<typeof TaskQuestion>;

/** The answer (by question), or skip: it goes on with its best judgment. */
export const TaskAnswer = z.object({
  t: z.literal('task_answer'),
  id: TaskId,
  qid: QuestionId,
  answers: z.record(z.string().max(1000), z.string().max(4000)).optional(),
  skip: z.boolean().optional(),
  ts: z.number().int().min(0),
});
export type TaskAnswer = z.infer<typeof TaskAnswer>;

const TransferRef = z.string().regex(/^[\w-]{8,40}$/);
/** The requester asks for the next piece of a result's file. */
export const FileGet = z.object({ t: z.literal('file_get'), id: TaskId, ref: TransferRef, offset: z.number().int().min(0).max(MAX_TRANSFER_FILE), ts: z.number().int().min(0) });
export type FileGet = z.infer<typeof FileGet>;

/** One piece of it (or why there's none). */
export const FileChunk = z.object({
  t: z.literal('file_chunk'),
  id: TaskId,
  ref: TransferRef,
  offset: z.number().int().min(0).max(MAX_TRANSFER_FILE),
  b64: z.string().max(Math.ceil((CHUNK_BYTES * 4) / 3) + 8).default(''),
  eof: z.boolean().default(false),
  error: z.string().max(300).optional(),
  ts: z.number().int().min(0),
});
export type FileChunk = z.infer<typeof FileChunk>;

/** What my Beluga offers you, told to you so your Claude knows whom to ask for what. */
export const PeerCardMsg = z.object({
  t: z.literal('card'),
  /** "Ask me for…": a short note other Claudes see. */
  note: z.string().max(280).optional(),
  /** How much I trust you (what your requests may do here). */
  trust: z.enum(TRUST),
  offers: z.array(z.enum(NEEDS)).max(NEEDS.length),
  /** My projects you may name. */
  projects: z.array(z.string().min(1).max(80)).max(60).default([]),
  /** My Claude is on. */
  claude: z.boolean().default(true),
  /** How much of my plans I have left, one per provider (BLG-597): only to people I share it with. */
  usages: z.array(ProviderUsage).max(8).optional(),
});
export type PeerCardMsg = z.infer<typeof PeerCardMsg>;

export const GatewayMsg = z.discriminatedUnion('t', [TaskRequest, TaskUpdate, TaskResult, TaskCancel, PeerCardMsg, TaskQuestion, TaskAnswer, FileGet, FileChunk]);
export type GatewayMsg = z.infer<typeof GatewayMsg>;
export type GatewayMsgInput = z.input<typeof GatewayMsg>;

const FrameId = z.string().regex(/^[\w-]{8,40}$/);

/** One message and its frame id, or the acknowledgement of one. */
export const Frame = z.union([z.object({ f: FrameId, m: GatewayMsg }), z.object({ ack: FrameId })]);
export type Frame = z.infer<typeof Frame>;

/** Parse what came in; undefined for anything malformed. */
export function parseFrame(raw: unknown): Frame | undefined {
  const parsed = Frame.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
