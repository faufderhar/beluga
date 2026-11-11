import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VoiceModelId } from '../src/companion/protocol.js';
import { MacVoice } from '../src/core/voice.js';
import { coerceVoice, resolveVoice, suggestVoice, VOICE_MODEL_IDS, VOICE_MODELS, voiceKnows, voiceSize } from '../src/shared/voice-models.js';

/** Speaking instead of typing (BLG-139): the suggestion, and the Mac writing down the phone's recording. */
describe('voice: what Beluga suggests', () => {
  it('suggests the Mac when it can, Parakeet there for English only', () => {
    expect(suggestVoice({ macVoice: true, language: 'auto' })).toBe('mac');
    expect(suggestVoice({ macVoice: true, language: 'tr' })).toBe('mac');
    expect(suggestVoice({ macVoice: true, language: 'en' })).toBe('mac-fast');
  });

  it('without the Mac: Turbo on a phone with memory to spare, Base on others', () => {
    expect(suggestVoice({ macVoice: false, phoneGB: 12, language: 'auto' })).toBe('best-phone');
    expect(suggestVoice({ macVoice: false, phoneGB: 4, language: 'auto' })).toBe('quick');
    expect(suggestVoice({ macVoice: false, language: 'auto' })).toBe('quick');
  });

  it('never runs Parakeet on a language it does not know', () => {
    expect(voiceKnows('parakeet', 'tr')).toBe(false);
    expect(voiceKnows('parakeet', 'de')).toBe(true);
    expect(voiceKnows('whisper-base', 'tr')).toBe(true);
    expect(resolveVoice({ preset: 'mac-fast', language: 'tr' }, { macVoice: true })).toEqual({ where: 'mac', model: 'whisper-turbo', language: 'tr' });
    expect(resolveVoice({ preset: 'custom', where: 'phone', model: 'parakeet', language: 'tr' }, { macVoice: true })).toEqual({ where: 'phone', model: 'whisper-base', language: 'tr' });
  });

  it('follows the suggestion until you pick, and reads back what was stored', () => {
    expect(resolveVoice({ preset: 'suggested', language: 'auto' }, { macVoice: false, phoneGB: 12 })).toEqual({ where: 'phone', model: 'whisper-turbo', language: 'auto' });
    expect(resolveVoice({ preset: 'quick', language: 'auto' }, { macVoice: true })).toEqual({ where: 'phone', model: 'whisper-base', language: 'auto' });
    // Base has no Mac file: on the Mac it's Turbo.
    expect(resolveVoice({ preset: 'custom', where: 'mac', model: 'whisper-base', language: 'en' }, { macVoice: true }).model).toBe('whisper-turbo');
    expect(coerceVoice(undefined)).toEqual({ preset: 'suggested', language: 'auto' });
    expect(coerceVoice({ preset: 'nope', language: 'tr' })).toEqual({ preset: 'suggested', language: 'tr' });
    expect(coerceVoice({ preset: 'custom', where: 'mac', model: 'parakeet', language: 'xx-bad' })).toEqual({ preset: 'custom', where: 'mac', model: 'parakeet', language: 'auto' });
  });

  it('keeps the protocol and the catalog in step, and says sizes plainly', () => {
    expect(VoiceModelId.options).toEqual([...VOICE_MODEL_IDS]);
    expect(voiceSize(VOICE_MODELS['whisper-base'].files.phone!.bytes)).toBe('57 MB');
    expect(voiceSize(1_300_000_000)).toBe('1.2 GB');
  });
});

describe('voice: the Mac writes it down', () => {
  const setup = (opts: { result?: string; download?: (url: string, to: string, on: (n: number) => void) => Promise<void> } = {}) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-voice-'));
    const calls: string[] = [];
    const ctx = { transcribe: (f: string, o: { language?: string }) => (calls.push(`${path.basename(f)}:${o.language ?? '-'}`), { promise: Promise.resolve({ result: ` ${opts.result ?? 'Run the tests'} `, language: 'en' }) }), release: async () => {} };
    const engine = async () => ({ initWhisper: async () => (calls.push('whisper'), ctx), initParakeet: async () => (calls.push('parakeet'), ctx) });
    const voice = new MacVoice(() => dir, engine, opts.download ?? (async () => {}));
    const have = (model: 'whisper-turbo' | 'parakeet') => writeFileSync(path.join(dir, VOICE_MODELS[model].files.mac!.name), Buffer.alloc(0));
    const audio = () => {
      const f = path.join(dir, `rec-${Math.random()}.wav`);
      writeFileSync(f, 'RIFF');
      return f;
    };
    return { dir, calls, voice, have, audio };
  };

  it('writes down a recording with the model asked for, then deletes it', async () => {
    const { voice, calls, audio, dir } = setup();
    // A model is ready only at its full size: fake that by matching the size check.
    const v = voice as unknown as { ready: (m: string) => Promise<boolean> };
    v.ready = async () => true;
    const a = audio();
    expect(await voice.transcribe(a, { model: 'whisper-turbo', language: 'tr' })).toMatchObject({ text: 'Run the tests', language: 'en' });
    expect(existsSync(a)).toBe(false);
    const b = audio();
    await voice.transcribe(b, { model: 'parakeet', language: 'auto' });
    expect(calls.filter((c) => !c.startsWith('rec-'))).toEqual(['whisper', 'parakeet']);
    // Whisper takes the language; Parakeet tells it itself.
    expect(calls.filter((c) => c.startsWith('rec-')).map((c) => c.split(':')[1])).toEqual(['tr', '-']);
    expect(existsSync(dir)).toBe(true);
    await voice.close();
  });

  it('refuses a language the model does not know, and still deletes the audio', async () => {
    const { voice, audio } = setup();
    const a = audio();
    await expect(voice.transcribe(a, { model: 'parakeet', language: 'tr' })).rejects.toThrow(/doesn’t know that language/);
    expect(existsSync(a)).toBe(false);
    await expect(voice.transcribe(audio(), { model: 'whisper-base', language: 'en' })).rejects.toThrow(/doesn’t run on the Mac/);
  });

  it('starts getting a model that is not here, says how far, and drops one that came short', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { voice, audio } = setup({
      download: async (_u, to, on) => {
        on(VOICE_MODELS.parakeet.files.mac!.bytes / 2);
        writeFileSync(to, 'short');
        await gate;
      },
    });
    await expect(voice.transcribe(audio(), { model: 'parakeet', language: 'en' })).rejects.toThrow(/still getting Parakeet \(\d+%\)/);
    // The download and the size check are async. A fixed wait loses that race on a busy runner,
    // so the model is still "coming" and has no incomplete error yet.
    const parakeet = async () => (await voice.status()).models.find((m) => m.model === 'parakeet');
    await expect.poll(parakeet, { timeout: 5_000 }).toMatchObject({ ready: false, progress: 0.5 });
    release();
    await expect.poll(parakeet, { timeout: 5_000 }).toMatchObject({ ready: false, error: expect.stringMatching(/incomplete/) });
    expect((await voice.status()).models.map((m) => m.model)).toEqual(['whisper-turbo', 'parakeet']);
  });
});

describe('voice: the Mac app’s own microphone (voice.*)', () => {
  it('takes only a WAV, and is the Mac app’s (not the phone’s)', async () => {
    const { VOICE_HANDLERS } = await import('../src/ipc/voice-handlers.js');
    const { PHONE } = await import('../src/companion/coverage.js');
    await expect(VOICE_HANDLERS['voice.transcribe']({} as never, Buffer.from('not audio').toString('base64'), { model: 'parakeet', language: 'en' })).rejects.toThrow(/isn’t a recording/);
    expect([PHONE['voice.models'], PHONE['voice.prepare'], PHONE['voice.transcribe']]).toEqual(['mac', 'mac', 'mac']);
  });
});
