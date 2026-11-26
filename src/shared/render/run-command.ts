import { isTerminal, promptOf, readTerminal } from './terminal.js';

/**
 * What a fenced block would run in a terminal, for its Run button: a shell code block as written
 * (its `$ ` prompts and comment-only lines left out), or a session's commands without what they
 * printed. Undefined when there's nothing to run: code in another language, output, a log.
 * Pure: the screens read alike.
 */

/** Fences that hold shell commands (a script, or a session). */
const SHELL_FENCE = /^(sh|bash|zsh|shell|fish|console|terminal|term|shell-session|sh-session|shellsession|bash-session|zsh-session)$/;

/** Fences with no language of their own: Run only when every line reads as a command. */
const PLAIN_FENCE = /^(|text|txt|plain|plaintext)$/;

/** A line that's only a comment (zsh, interactive, runs `# note` as a command). */
const COMMENT = /^\s*#/;

/** Programs a pasted command usually starts with (a block with no language is run only when each line does). */
const COMMAND_WORDS = new Set(
  'npm npx pnpm pnpx yarn bun bunx deno node nvm corepack git gh brew cd ls mkdir cp mv rm touch cat echo export source open code cursor claude beluga curl wget ssh scp tar unzip chmod chown sudo make cmake cargo rustup go python python3 pip pip3 pipx uv poetry ruby gem bundle swift xcodebuild xcode-select pod docker docker-compose kubectl helm terraform aws gcloud az vercel supabase firebase flyctl fly heroku java mvn gradle ./gradlew dotnet php composer adb expo eas'.split(' '),
);

/** A line that reads as a command: a program from the list, or a script by its path (./setup.sh). */
function looksLikeCommand(line: string): boolean {
  const word = /^\s*(\S+)/.exec(line)?.[1] ?? '';
  return COMMAND_WORDS.has(word) || /^\.{0,2}\/[\w./-]+$/.test(word);
}

export function runnableCommand(lang: string | undefined, code: string): string | undefined {
  const l = (lang ?? '').toLowerCase();
  const plain = PLAIN_FENCE.test(l);
  if (!plain && !SHELL_FENCE.test(l)) return undefined;
  const lines = code.split('\n').filter((x) => x.trim() && !COMMENT.test(x));
  if (!lines.length) return undefined;
  if (plain && !isTerminal(l, code) && !readsAsCommands(lines)) return undefined;
  // A session (a prompt, then what it printed): only the commands.
  if (isTerminal(l, code)) {
    const commands = readTerminal(code).commands.filter((c) => c.trim() && !COMMENT.test(c));
    return commands.length ? commands.join('\n') : undefined;
  }
  // Commands written with their prompts ("$ npm test"): the prompts come off.
  const prompted = lines.every((x) => promptOf(x) !== undefined);
  const text = (prompted ? lines.map((x) => x.slice(promptOf(x)!.length)) : lines).join('\n').trim();
  return text || undefined;
}

/** Each line a command (its prompt aside), or the rest of one that goes on (a line ending in `\`). */
function readsAsCommands(lines: readonly string[]): boolean {
  return lines.every((line, i) => (i > 0 && lines[i - 1]!.trimEnd().endsWith('\\')) || looksLikeCommand(line.slice(promptOf(line)?.length ?? 0)));
}

/**
 * The keys that type a command into a shell and run it: Ctrl+U first (whatever was half typed
 * goes), then each line with Return after it.
 */
export function shellInput(command: string): string {
  return `\x15${command.replace(/\r?\n/g, '\r')}\r`;
}
