import { query } from '@anthropic-ai/claude-agent-sdk';
import { type BtwRequest, btwPrompt } from '../../btw.js';
import { claudeExecutable } from '../../claude-code.js';

/** How long a side question may take before it's given up. */
const BTW_TIMEOUT_MS = 3 * 60_000;

/** Why a finished side question has no words: what Claude's reply held, and why it stopped. */
export function emptyAnswer(sent: readonly string[], stop?: string | null): string {
  const held = sent.length ? `it sent only ${[...new Set(sent)].join(' and ')}` : 'it sent nothing';
  return `Claude finished without an answer (${held}${stop ? `, stop: ${stop}` : ''})`;
}

/**
 * Answer a side question (/btw): a fork of the conversation's session, so Claude knows the whole
 * conversation, with no tools, one turn, and nothing saved, so the conversation never sees it.
 * Runs beside a live run without touching it. `env`: over yours, for Claude Code (a local model's
 * endpoint, so a local conversation's side question goes there, never to Anthropic).
 */
export async function askBtw(req: BtwRequest, opts: { claudePath?: string; env?: Readonly<Record<string, string>> } = {}): Promise<string> {
  const abortController = new AbortController();
  const stop = (): void => abortController.abort();
  req.signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, BTW_TIMEOUT_MS);
  timer.unref();
  let text = '';
  let said = '';
  let sent: string[] = [];
  try {
    const q = query({
      prompt: btwPrompt(req.question),
      options: {
        cwd: req.cwd,
        ...(req.resume ? { resume: req.resume, forkSession: true } : {}),
        tools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        includePartialMessages: true,
        abortController,
        ...(req.model ? { model: req.model } : {}),
        ...claudeExecutable(opts.claudePath),
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      },
    });
    for await (const msg of q) {
      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          text += ev.delta.text;
          req.onText(text);
        }
        continue;
      }
      // Claude's whole reply: its words, for when neither the stream nor the result carried them.
      if (msg.type === 'assistant') {
        const blocks = msg.message.content as readonly { type: string; text?: string }[];
        sent = blocks.map((b) => b.type);
        said = blocks.flatMap((b) => (b.type === 'text' && b.text ? [b.text] : [])).join('\n\n') || said;
        continue;
      }
      if (msg.type !== 'result') continue;
      if (msg.subtype !== 'success') throw new Error(text ? 'Claude stopped before it finished' : 'Claude couldn’t answer that');
      const answer = msg.result || text || said;
      if (answer.trim()) return answer;
      // A blank card looks like nothing happened (BLG-729): say what came back instead.
      throw new Error(emptyAnswer(sent, msg.stop_reason));
    }
    if (said.trim()) return said;
    if (text) return text;
    throw new Error('Claude stopped without an answer');
  } catch (err) {
    if (abortController.signal.aborted) throw new Error(req.signal.aborted ? 'Stopped' : 'Claude took too long');
    throw err;
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', stop);
  }
}
