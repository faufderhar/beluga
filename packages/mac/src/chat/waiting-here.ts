import type { Approval } from '../../../../src/core/store.js';
import type { PendingQuestion } from '../../../../src/core/collab-store.js';

/**
 * What a conversation shows above its box of what waits for you: only what was asked in it. An
 * approval or question from another chat is answered there, so here it's a line that takes you
 * there (never Allow / Deny for a chat you aren't looking at). Pure, so it's tested on its own
 * (tests/mac-waiting-here.test.ts); chat/Attention.tsx draws it.
 */

/**
 * Whether an approval is answered in this conversation: asked here, or asked nowhere a chat could
 * open (the room, a friend's request, an external agent), which every chat shows, as before.
 */
export const approvalHere = (a: Pick<Approval, 'channel'>, here: string, opens: (channel: string) => boolean): boolean => !a.channel || a.channel === here || !opens(a.channel);

/** The approvals this conversation shows in full. */
export const approvalsHere = <A extends Pick<Approval, 'channel'>>(approvals: readonly A[], here: string, opens: (channel: string) => boolean): A[] =>
  approvals.filter((a) => approvalHere(a, here, opens));

/** The other conversations waiting on you (an approval, a question or a plan), first asked first, each once. */
export function waitingElsewhere(approvals: readonly Pick<Approval, 'channel'>[], questions: readonly Pick<PendingQuestion, 'channel'>[], here: string, opens: (channel: string) => boolean): string[] {
  const out: string[] = [];
  const add = (channel: string | undefined): void => {
    if (channel && channel !== here && opens(channel) && !out.includes(channel)) out.push(channel);
  };
  for (const a of approvals) add(a.channel);
  for (const q of questions) add(q.channel);
  return out;
}
