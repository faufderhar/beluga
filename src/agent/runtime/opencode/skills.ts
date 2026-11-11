import { fillArguments, findSkill } from '../../../core/claude-code/skills.js';
import { CLAUDE_BUILT_INS } from '../../../shared/skills.js';

/**
 * Claude Code's skills and custom commands on OpenCode (BLG-686). OpenCode runs a message starting
 * `/name` as one of its own commands when it has one: its built-ins (init, review, compact), its
 * own commands, and your Claude Code skills, which it loads itself from ~/.claude/skills and a
 * project's .claude/skills. What it doesn't have is mapped:
 * - a Claude Code custom command (commands/<name>.md) becomes the prompt, $ARGUMENTS filled in;
 * - a skill OpenCode didn't load (a plugin's) goes in as its instructions;
 * - one of Claude Code's own built-ins goes in as plain text, said in a note.
 */

export interface OpenCodePrompt {
  /** The message as OpenCode gets it. */
  readonly prompt: string;
  /** What didn't carry over, in words, for the chat. */
  readonly notes: readonly string[];
}

/** `agent`: whose commands these are, for the note (Copilot maps its slash commands the same way). */
export async function mapOpenCodeSlash(prompt: string, cwd: string, home: string, commands: ReadonlySet<string>, agent = 'OpenCode'): Promise<OpenCodePrompt> {
  // "//name": the / menu's way of saying a skill that shares a Beluga command's name.
  const m = /^\/\/?([\w.:-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (!m) return { prompt, notes: [] };
  const name = m[1]!;
  const args = (m[2] ?? '').trim();
  if (commands.has(name)) return { prompt: args ? `/${name} ${args}` : `/${name}`, notes: [] };
  const found = await findSkill(name, cwd, home);
  if (!found) {
    if (CLAUDE_BUILT_INS.has(name)) return { prompt, notes: [`/${name} is one of Claude Code's own commands: not on ${agent}, so it went in as plain text.`] };
    return { prompt, notes: [] };
  }
  const body = fillArguments(found.body, args, found.source === 'plugin' ? found.dir : undefined);
  if (found.kind === 'skill') return { prompt: `Use the ${name} skill. Its instructions:\n\n${body}${args ? `\n\n${args}` : ''}`, notes: [] };
  return { prompt: body, notes: [] };
}
