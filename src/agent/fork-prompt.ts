import type { ForkedPlace } from './types.js';

/** Each list in the note stays this short in the instructions (the rest is in .beluga/fork.json). */
const SHOWN = 25;

const WHY: Record<ForkedPlace['left'][number]['why'], string> = {
  secret: 'a secret: it only comes when its owner ticks it',
  ignored: 'git-ignored, and its owner did not pick it',
  big: 'over the 50 MB a file',
  limit: 'past the 150 MB a fork may bring',
  there: 'this worktree already had one: that one was kept',
  unplaced: 'it came, but could not be placed here (a folder Beluga never writes into, or in the way of a file)',
};

/** A name or path from the other Mac, only when it's plain (one line, ordinary characters): it goes into instructions. */
const plain = (s: string): string | undefined => (/^[\w .@+,()'’-]{1,120}$/.test(s) ? s : undefined);
const pathOf = (s: string): string | undefined => (/^[\w .@+,()-]+(\/[\w .@+,()-]+)*\/?$/.test(s) && s.length <= 300 ? s : undefined);

/**
 * A worktree forked from a friend's (BLG-1017): what came over with it and what stayed on their
 * computer, so the agent asks for the one file it needs (or uses its owner's own credentials)
 * instead of running a script that fails half way because a git-ignored file isn't here.
 */
export function buildForkedAppend(f: ForkedPlace): string {
  // Only plain names and paths: anything else the other Mac wrote stays in .beluga/fork.json, never in instructions.
  const listed = <T>(items: readonly T[], path: (t: T) => string, line: (t: T, p: string) => string): string[] =>
    items.flatMap((t) => {
      const p = pathOf(path(t));
      return p ? [line(t, p)] : [];
    }).slice(0, SHOWN);
  const sent = listed(f.sent, (s) => s.path, (s, p) => `- ${p} (${s.files} ${s.files === 1 ? 'file' : 'files'})`);
  const secrets = listed(f.secrets, (s) => s, (_s, p) => `- ${p}`);
  const left = listed(f.left, (l) => l.path, (l, p) => `- ${p}: ${WHY[l.why]}`);
  const owner = plain(f.owner) ?? 'its owner';
  const from = plain(f.from);
  return [
    '',
    `This worktree is a fork of ${owner}'s ${from ? `"${from}"` : 'worktree'}, made on their computer and copied here. Its commits,`,
    `uncommitted work, conversation${f.scratch ? ` and scratch folder (${f.scratch} files)` : ''} came with it. Of what git ignores, only what ${owner} picked came:`,
    ...(sent.length ? sent : ['- nothing']),
    ...(secrets.length ? [`Secrets ${owner} ticked to come (treat them as theirs: never print, commit or send their values):`, ...secrets] : []),
    ...(left.length ? [`Stayed on ${owner}'s computer:`, ...left] : []),
    'The full list is in .beluga/fork.json. Before you run something that needs a file that stayed behind (a',
    'benchmark folder, a key, a .env value), say which one and ask for it: with ask_person / get_file to',
    `${owner}'s agent when the work needs their exact file, or ask your owner to use their own credentials.`,
    'Never stop half way through a run because one of them is missing without saying which.',
  ].join('\n');
}
