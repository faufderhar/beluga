import type { ClaudeAnswer, ClaudeQuestion } from '../../../protocol.js';

/**
 * Antigravity's own question tool, `ask_question`. Its form doesn't reach a client over ACP: agy
 * "runs" it at once (no permission asked), ends the turn, and the question and its options are left
 * written in the answer, so nothing waited for you. Its call still carries the question whole (as
 * agy 1.5.8 sends it: `{ questions: [{ question, options: ["…"], is_multi_select }] }`), so Beluga
 * asks it for Antigravity: the same card Claude's AskUserQuestion gets (on the phone too), and your
 * answer goes back to Antigravity as the next turn.
 */

export const AGY_ASK_TOOL = 'ask_question';

type Asked = Extract<ClaudeQuestion, { kind: 'question' }>;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One option as agy sends it: a string, or `{ label, description }`. */
function optionOf(o: unknown): { label: string; description: string } | undefined {
  if (typeof o === 'string') return o.trim() ? { label: clip(o.trim(), 200), description: '' } : undefined;
  if (!o || typeof o !== 'object') return undefined;
  const r = o as Record<string, unknown>;
  const label = str(r.label) || str(r.text) || str(r.value) || str(r.title);
  return label ? { label: clip(label, 200), description: clip(str(r.description), 1000) } : undefined;
}

/** The card for an `ask_question` call's input; undefined when it holds no question. */
export function agyQuestion(raw: Record<string, unknown> | undefined): Asked | undefined {
  if (!raw) return undefined;
  const list = Array.isArray(raw.questions) ? raw.questions : str(raw.question) ? [raw] : [];
  const questions = list
    .map((q): Asked['questions'][number] | undefined => {
      if (!q || typeof q !== 'object') return undefined;
      const r = q as Record<string, unknown>;
      const question = str(r.question) || str(r.text);
      if (!question) return undefined;
      const options = (Array.isArray(r.options) ? r.options : []).map(optionOf).filter((o): o is { label: string; description: string } => Boolean(o));
      return { question: clip(question, 1000), header: clip(str(r.header), 40), options: options.slice(0, 6), multiSelect: r.is_multi_select === true || r.multiSelect === true || r.multi_select === true };
    })
    .filter((q): q is Asked['questions'][number] => Boolean(q))
    .slice(0, 4);
  return questions.length ? { kind: 'question', questions } : undefined;
}

/** Your answer, as the message that starts Antigravity's next turn. */
export function agyAnswerPrompt(asked: Asked, answer: ClaudeAnswer): string {
  if (answer.kind !== 'answers') return 'The person skipped your question (ask_question). Go on with your best judgment and say what you assumed.';
  const lines = asked.questions.map((q) => `- ${q.question}\n  → ${answer.answers[q.question]?.trim() || '(no answer)'}`);
  return `The person answered your question (ask_question) in Beluga:\n${lines.join('\n')}\n\nGo on from here with that answer.`;
}
