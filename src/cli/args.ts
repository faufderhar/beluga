import { type ParseArgsConfig, parseArgs } from 'node:util';

type Options = NonNullable<ParseArgsConfig['options']>;

/** One `beluga` command: how it's typed, and what it says in `beluga help`. */
export interface CommandSpec {
  /** Each way to type it, one per line (each fits a terminal with room to spare). */
  readonly usage: readonly string[];
  readonly summary: string;
  readonly options: Options;
  /** Hidden from `beluga help`: the Mac app's and a run's, never typed by people. */
  readonly internal?: boolean;
  /** Takes the rest of the line as is (the daemon parses its own flags). */
  readonly passThrough?: boolean;
}

export const COMMANDS = {
  setup: { usage: ['beluga setup [--yes] [--project <folder or git URL>]'], summary: 'the first run in one go: Claude sign-in, a project, your phone, keeping it running', options: { yes: { type: 'boolean', short: 'y' }, project: { type: 'string' } } },
  up: { usage: ['beluga up [--foreground]'], summary: 'start Beluga in the background (--foreground: in this terminal, for systemd or Docker)', options: { foreground: { type: 'boolean', short: 'f' } } },
  status: { usage: ['beluga status [--json]'], summary: 'whether Beluga is running, its version, projects and phones', options: { json: { type: 'boolean' } } },
  stop: { usage: ['beluga stop'], summary: 'stop Beluga', options: {} },
  logs: { usage: ['beluga logs [-f] [-n <lines>]'], summary: "show Beluga's log (-f: keep showing new lines)", options: { follow: { type: 'boolean', short: 'f' }, lines: { type: 'string', short: 'n' } } },
  project: { usage: ['beluga project add <folder or git URL> [--into <folder>]', 'beluga project list', 'beluga project remove <name>'], summary: 'add a project (a git URL is cloned first), list them, or remove one', options: { into: { type: 'string' } } },
  pair: { usage: ['beluga pair', 'beluga pair --computer [--json]'], summary: 'pair a phone: scan the QR code or type the code, then confirm (--computer: let your Beluga app add this computer)', options: { computer: { type: 'boolean' }, json: { type: 'boolean' } } },
  computers: { usage: ['beluga computers', 'beluga computers add <link or code>', 'beluga computers forget <name>'], summary: 'your devices: who may drive this computer, the computers you drive; add one, or forget one everywhere', options: {} },
  phones: { usage: ['beluga phones', 'beluga phones remove <name>'], summary: 'list the paired phones, or remove one', options: {} },
  service: { usage: ['beluga service [install | remove]'], summary: 'keep Beluga running, from boot (systemd on Linux, launchd on a Mac)', options: {} },
  web: {
    usage: ['beluga web [--listen host:port] [--allow-host name] [--insecure-http]', 'beluga web --tailscale', 'beluga web --public', 'beluga web --off', 'beluga web link', 'beluga web sessions', 'beluga web revoke <id or name>', 'beluga web stop'],
    summary: 'open Beluga in a browser: a link that lets one in (opens the web port, 127.0.0.1:7777), the browsers let in, signing one out, closing the port',
    options: {},
    passThrough: true,
  },
  connect: {
    usage: ['beluga connect <user@host> [--port <port>] [--no-open]', 'beluga connect <user@host> --pair'],
    summary: "open a server's Beluga in this computer's browser through SSH (a host from ~/.ssh/config works); nothing to open on the server. Ctrl+C closes it. --pair: add it to your computers instead (Beluga is installed there if it isn't)",
    options: { port: { type: 'string', short: 'p' }, 'no-open': { type: 'boolean' }, pair: { type: 'boolean' } },
  },
  update: { usage: ['beluga update'], summary: 'update Beluga to the latest release (the server install)', options: {} },
  version: { usage: ['beluga version'], summary: 'show the version', options: {} },
  help: { usage: ['beluga help [command]'], summary: 'show this help, or one command’s', options: {} },
  daemon: { usage: ['beluga daemon [--keep-alive] [demo]'], summary: "run Beluga's engine for the Mac app", options: {}, internal: true, passThrough: true },
  mcp: { usage: ['beluga mcp <command>'], summary: "external agents' server: pair, list, stop and revoke them (beluga mcp --help)", options: {}, passThrough: true },
  chat: { usage: ['beluga chat <command>'], summary: 'start and follow chats from a script (beluga chat --help)', options: {}, passThrough: true },
  'mcp-serve': { usage: ['beluga mcp-serve <suite>'], summary: "one suite of Beluga's tools over stdio, for a run", options: {}, internal: true, passThrough: true },
} as const satisfies Record<string, CommandSpec>;

/** The width help is written for: the narrowest terminal people use. */
export const HELP_WIDTH = 80;

/**
 * Words in lines of at most `width` characters (prefix and indent included): the first line starts
 * with `first`, every other with `indent`.
 */
export function wrap(text: string, width: number, indent: string, first = ''): string[] {
  const lines: string[] = [];
  let line = first;
  let words = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = words ? `${line} ${word}` : `${line}${word}`;
    if (words && [...next].length > width) {
      lines.push(line);
      line = `${indent}${word}`;
      words = 1;
    } else {
      line = next;
      words++;
    }
  }
  if (words) lines.push(line);
  return lines;
}

export type CommandName = keyof typeof COMMANDS;

export interface ParsedCommand {
  readonly name: CommandName;
  readonly flags: Readonly<Record<string, string | boolean | undefined>>;
  readonly positionals: readonly string[];
}

/** A mistake in what was typed: shown with the command's usage, exit code 2. */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly command?: CommandName,
  ) {
    super(message);
  }
}

const ALIASES: Readonly<Record<string, CommandName>> = { '--version': 'version', '-v': 'version', '--help': 'help', '-h': 'help', start: 'up', projects: 'project' };

const isCommand = (name: string): name is CommandName => Object.hasOwn(COMMANDS, name);

/** Read what was typed after `beluga`; bare `beluga` is help. */
export function parseCommand(argv: readonly string[]): ParsedCommand {
  const [first, ...rest] = argv;
  if (first === undefined) return { name: 'help', flags: {}, positionals: [] };
  const name = ALIASES[first] ?? first;
  if (!isCommand(name)) throw new UsageError(`There's no \`beluga ${first}\`.`);
  const spec: CommandSpec = COMMANDS[name];
  const help = rest.includes('--help') || rest.includes('-h');
  // People's own pass-through commands (`web`) still answer --help; the Mac app's take it as theirs.
  if (spec.passThrough && (spec.internal || !help)) return { name, flags: {}, positionals: rest };
  if (help) return { name: 'help', flags: {}, positionals: [name] };
  try {
    const { values, positionals } = parseArgs({ args: rest, options: spec.options, allowPositionals: true, strict: true });
    return { name, flags: values as ParsedCommand['flags'], positionals };
  } catch (err) {
    throw new UsageError(argsProblem(err, name), name);
  }
}

/** What node:util's parseArgs said, in our words (its own run past 80 columns). */
function argsProblem(err: unknown, command: CommandName): string {
  const e = err as { code?: string; message?: string };
  const option = /'([^']+)'/.exec(e.message ?? '')?.[1];
  if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && option) return `\`beluga ${command}\` has no ${option}.`;
  if (e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && option) return `${option.split(/[ ,]/)[0]} needs a value after it.`;
  return (e.message ?? String(err)).split('\n')[0]!;
}

/** How a command is typed, under "Usage:". */
export function usageText(command: CommandName): string {
  const spec: CommandSpec = COMMANDS[command];
  return `Usage:\n${spec.usage.map((u) => `  ${u}`).join('\n')}\n`;
}

/** `beluga help`, or one command's usage; every line fits HELP_WIDTH columns. */
export function helpText(command?: string): string {
  if (command && isCommand(command)) {
    const spec: CommandSpec = COMMANDS[command];
    return `${usageText(command)}\n${wrap(spec.summary, HELP_WIDTH, '  ', '  ').join('\n')}\n`;
  }
  const rows = Object.entries(COMMANDS as Record<string, CommandSpec>).filter(([, c]) => !c.internal);
  const width = Math.max(...rows.map(([name]) => name.length)) + 4;
  const pad = ' '.repeat(width);
  const list = rows.flatMap(([name, c]) => wrap(c.summary, HELP_WIDTH, pad, `  ${name.padEnd(width - 2)}`));
  return ['Beluga: Claude Code across your projects, from your phone or any browser.', '', 'Usage: beluga <command>', '', ...list, '', 'How each one is typed: `beluga help <command>`.', 'Start with `beluga setup`, or `beluga up` and `beluga status`.', ''].join('\n');
}

/** A whole number flag (`-n 20`), or a UsageError saying what's wrong. */
export function countFlag(value: string | boolean | undefined, name: string, fallback: number, command: CommandName): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (typeof value !== 'string' || !Number.isInteger(n) || n < 0) throw new UsageError(`--${name} needs a whole number, like --${name} 50.`, command);
  return n;
}
