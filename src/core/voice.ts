import { createWriteStream, mkdirSync } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type VoiceModelId, VOICE_MODEL_IDS, VOICE_MODELS, voiceKnows } from '../shared/voice-models.js';
import type { VoiceMacView } from '../companion/protocol.js';
import { belugaHome } from './home.js';
import { ASSISTANT_TITLE, THE_COMPUTER } from '../shared/assistant.js';

/**
 * Your Mac writes down what you said (BLG-140, BLG-144): on the phone (it `put`s the WAV and calls
 * companion.transcribe) or in the Mac app (voice.transcribe); the Mac runs Whisper Turbo or Parakeet on its GPU (whisper.cpp
 * through @fugood/whisper.node) and gives the words back. The audio is deleted once it's written
 * down, and goes nowhere else. A model comes the first time the phone asks for it, into
 * ~/.beluga/voice (part file first, so one cut short never looks ready).
 */

interface Context {
  transcribe(file: string, o: { language?: string; prompt?: string }): { promise: Promise<{ result: string; language?: string }> };
  release(): Promise<void>;
}
interface Engine {
  initWhisper(o: { filePath: string; useGpu?: boolean }): Promise<Context>;
  initParakeet(o: { filePath: string; useGpu?: boolean }): Promise<Context>;
}

/** A model stays loaded this long after it last wrote something down (Turbo holds about 1 GB). */
const IDLE_MS = 3 * 60_000;

export class MacVoice {
  private readonly getting = new Map<VoiceModelId, { got: number; done: Promise<void> }>();
  private readonly failed = new Map<VoiceModelId, string>();
  private readonly loaded = new Map<VoiceModelId, { ctx: Promise<Context>; idle?: ReturnType<typeof setTimeout> }>();
  /** One at a time: whisper.cpp takes the GPU whole. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    /** ~/.beluga/voice, asked for only when a model is (so making one touches nothing). */
    private readonly dirOf: () => string,
    private readonly engine: () => Promise<Engine> = async () => (await import('@fugood/whisper.node')) as unknown as Engine,
    private readonly download: (url: string, to: string, onBytes: (n: number) => void) => Promise<void> = fetchTo,
  ) {}

  private file(model: VoiceModelId): string {
    return path.join(this.dirOf(), VOICE_MODELS[model].files.mac!.name);
  }

  private async ready(model: VoiceModelId): Promise<boolean> {
    const want = VOICE_MODELS[model].files.mac?.bytes;
    const s = await stat(this.file(model)).catch(() => undefined);
    return want !== undefined && s?.size === want;
  }

  /** The Mac's models: which are here, which are coming and how far. */
  async status(): Promise<VoiceMacView> {
    const models: VoiceMacView['models'] = [];
    for (const id of VOICE_MODEL_IDS) {
      const f = VOICE_MODELS[id].files.mac;
      if (!f) continue;
      const g = this.getting.get(id);
      const failed = this.failed.get(id);
      models.push({ model: id, bytes: f.bytes, ready: await this.ready(id), ...(g ? { progress: Math.min(1, g.got / f.bytes) } : {}), ...(failed && !g ? { error: failed } : {}) });
    }
    return { models };
  }

  /** Get a model now (the phone's Settings, or its first use) → where they all stand. */
  async prepare(model: VoiceModelId): Promise<VoiceMacView> {
    void this.fetchModel(model).catch(() => {});
    return this.status();
  }

  private fetchModel(model: VoiceModelId): Promise<void> {
    const f = VOICE_MODELS[model].files.mac;
    if (!f) return Promise.reject(new Error(`${VOICE_MODELS[model].label} doesn’t run on ${THE_COMPUTER}`));
    const on = this.getting.get(model);
    if (on) return on.done;
    const g = { got: 0, done: Promise.resolve() };
    g.done = (async () => {
      if (await this.ready(model)) return;
      mkdirSync(this.dirOf(), { recursive: true, mode: 0o700 });
      const part = `${this.file(model)}.part`;
      await rm(part, { force: true });
      await this.download(f.url, part, (n) => (g.got += n));
      if ((await stat(part)).size !== f.bytes) {
        await rm(part, { force: true });
        throw new Error(`${VOICE_MODELS[model].label} came incomplete; try again`);
      }
      await rename(part, this.file(model));
    })()
      .then(
        () => void this.failed.delete(model),
        (e: unknown) => {
          this.failed.set(model, e instanceof Error ? e.message : String(e));
          throw e;
        },
      )
      .finally(() => this.getting.delete(model));
    this.getting.set(model, g);
    return g.done;
  }

  private context(model: VoiceModelId): Promise<Context> {
    const had = this.loaded.get(model);
    if (had) {
      if (had.idle) clearTimeout(had.idle);
      return had.ctx;
    }
    const filePath = this.file(model);
    const ctx = this.engine().then((e) => (VOICE_MODELS[model].kind === 'parakeet' ? e.initParakeet({ filePath, useGpu: true }) : e.initWhisper({ filePath, useGpu: true })));
    ctx.catch(() => this.loaded.delete(model));
    this.loaded.set(model, { ctx });
    return ctx;
  }

  private letGoLater(model: VoiceModelId): void {
    const l = this.loaded.get(model);
    if (!l) return;
    if (l.idle) clearTimeout(l.idle);
    l.idle = setTimeout(() => {
      this.loaded.delete(model);
      void l.ctx.then((c) => c.release()).catch(() => {});
    }, IDLE_MS);
    l.idle.unref?.();
  }

  /**
   * The words in a WAV the phone sent (deleted after, whatever happens) → { text, language? }.
   * A model that isn't here yet starts coming, and this says how far it is.
   */
  async transcribe(audio: string, a: { model: VoiceModelId; language: string; prompt?: string | undefined }): Promise<{ text: string; language?: string; ms: number }> {
    try {
      const m = VOICE_MODELS[a.model];
      if (!m.files.mac) throw new Error(`${m.label} doesn’t run on ${THE_COMPUTER}`);
      if (!voiceKnows(a.model, a.language)) throw new Error(`${m.label} doesn’t know that language`);
      if (!(await this.ready(a.model))) {
        void this.fetchModel(a.model).catch(() => {});
        const g = this.getting.get(a.model);
        const pct = g ? Math.round((g.got / m.files.mac.bytes) * 100) : 0;
        throw new Error(`${ASSISTANT_TITLE} is still getting ${m.label} (${pct}%)`);
      }
      const run = this.queue.then(async () => {
        const t = Date.now();
        const ctx = await this.context(a.model);
        try {
          // Parakeet tells the language itself; Whisper takes one ('auto': it tells), and the words
          // before this phrase as its prompt (BLG-160), so names and style carry across phrases.
          const r = await ctx.transcribe(audio, m.kind === 'whisper' ? { language: a.language, ...(a.prompt ? { prompt: a.prompt } : {}) } : {}).promise;
          return { text: r.result.trim(), ...(r.language ? { language: r.language } : {}), ms: Date.now() - t };
        } finally {
          this.letGoLater(a.model);
        }
      });
      this.queue = run.catch(() => {});
      return await run;
    } finally {
      await rm(audio, { force: true });
    }
  }

  /** The daemon stops: let go of the models. */
  async close(): Promise<void> {
    for (const [id, l] of [...this.loaded]) {
      if (l.idle) clearTimeout(l.idle);
      this.loaded.delete(id);
      await l.ctx.then((c) => c.release()).catch(() => {});
    }
  }
}

/** A file from the web, counting bytes as they come. */
async function fetchTo(url: string, to: string, onBytes: (n: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Couldn’t get the model (${res.status})`);
  const count = new Transform({
    transform(chunk: Buffer, _e, done) {
      onBytes(chunk.length);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), count, createWriteStream(to, { mode: 0o600 }));
}

let shared: MacVoice | undefined;
/** The one MacVoice of this daemon: the phone and the Mac app share its loaded model and its queue. */
export function sharedVoice(): MacVoice {
  return (shared ??= new MacVoice(() => path.join(belugaHome(), 'voice')));
}
