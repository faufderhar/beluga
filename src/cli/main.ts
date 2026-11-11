import { type ParsedCommand, UsageError, countFlag, helpText, parseCommand, usageText, wrap, HELP_WIDTH } from './args.js';
import { type Exit, type Io, stdio } from './io.js';
import type { SocketClient } from '../ipc/socket-client.js';
import { belugaEnv } from '../core/beluga-env.js';
import { installedVersion } from '../core/version.js';

/** Run one parsed command; the heavy parts load only for the command that needs them. */
export async function run(cmd: ParsedCommand, io: Io): Promise<Exit> {
  switch (cmd.name) {
    case 'help':
      io.out(helpText(cmd.positionals[0]));
      return 0;
    case 'version':
      io.out(`Beluga ${installedVersion()}\n`);
      return 0;
    case 'up': {
      const { up } = await import('./up.js');
      return up({ foreground: cmd.flags.foreground === true }, io, await upDeps());
    }
    case 'setup': {
      const { setupHere } = await import('./setup-here.js');
      return setupHere({ yes: cmd.flags.yes === true, ...(typeof cmd.flags.project === 'string' ? { project: cmd.flags.project } : {}) }, io);
    }
    case 'service': {
      const [sub = 'status'] = cmd.positionals;
      const { installService, removeService, serviceEnv, serviceStatus } = await import('./service.js');
      if (sub === 'install') return installService(serviceEnv(), io);
      if (sub === 'remove' || sub === 'uninstall') return removeService(serviceEnv(), io);
      if (sub === 'status') return serviceStatus(serviceEnv(), io);
      throw new UsageError(`\`beluga service\` can install or remove; there's no \`${sub}\`.`, 'service');
    }
    case 'status': {
      const { status } = await import('./status.js');
      return status({ json: cmd.flags.json === true }, io);
    }
    case 'stop': {
      const { stop } = await import('./stop.js');
      return stop(io);
    }
    case 'logs': {
      const { logs, DEFAULT_LINES } = await import('./logs.js');
      const ctrlC = new AbortController();
      process.once('SIGINT', () => ctrlC.abort());
      return logs({ follow: cmd.flags.follow === true, lines: countFlag(cmd.flags.lines, 'lines', DEFAULT_LINES, 'logs'), signal: ctrlC.signal }, io);
    }
    case 'project': {
      const [sub = 'list', ...rest] = cmd.positionals;
      const { addProject, listProjects, projectLinkOf, removeProject } = await import('./project.js');
      const into = typeof cmd.flags.into === 'string' ? cmd.flags.into : undefined;
      if (sub === 'list') return attached(io, async (client) => listProjects(client.store.getDomain().projects, io));
      if (sub === 'add') return attached(io, (client) => addProject(projectLinkOf(client), rest.join(' ') || undefined, io, into ? { into } : {}));
      if (sub === 'remove') return attached(io, (client) => removeProject(projectLinkOf(client), rest.join(' ') || undefined, io));
      throw new UsageError(`\`beluga project\` can add, list or remove; there's no \`${sub}\`.`, 'project');
    }
    case 'web': {
      const { web } = await import('./web.js');
      return web(cmd.positionals, io);
    }
    case 'connect':
      return connectHere(cmd, io);
    case 'update': {
      const { update } = await import('./update.js');
      return update(io);
    }
    case 'pair':
      if (cmd.flags.json === true && cmd.flags.computer !== true) throw new UsageError('--json goes with --computer.', 'pair');
      return cmd.flags.computer === true ? pairComputerHere(io, cmd.flags.json === true) : pairHere(io);
    case 'computers': {
      const [sub = 'list', ...rest] = cmd.positionals;
      const { addComputer, computersLinkOf, forgetDevice, listComputers } = await import('./computers.js');
      if (sub === 'list') return attached(io, (client) => listComputers(computersLinkOf(client), io));
      if (sub === 'forget') return attached(io, (client) => forgetDevice(computersLinkOf(client), rest.join(' ') || undefined, io));
      if (sub === 'add') return withCtrlC((ctrlC) => attached(io, (client) => addComputer(computersLinkOf(client), rest.join(' ') || undefined, io, { ask: asker(ctrlC), signal: ctrlC.signal })));
      throw new UsageError(`\`beluga computers\` lists them, adds one or forgets one; there's no \`${sub}\`.`, 'computers');
    }
    case 'phones': {
      const [sub, ...rest] = cmd.positionals;
      if (sub !== undefined && sub !== 'remove' && sub !== 'list') throw new UsageError(`\`beluga phones\` lists them; \`beluga phones remove <name>\` removes one.`, 'phones');
      const { listPhones, phoneBookOf, removePhone } = await import('./phones.js');
      return attached(io, async (client) => (sub === 'remove' ? removePhone(phoneBookOf(client), rest.join(' ') || undefined, io) : listPhones(client.store.getDomain().companion.devices, io)));
    }
    case 'daemon': {
      const { daemon } = await import('./daemon.js');
      await daemon(cmd.positionals);
      return 0;
    }
    case 'mcp': {
      const { runMcp } = await import('./mcp.js');
      return (await runMcp(cmd.positionals)) as Exit;
    }
    case 'chat': {
      const { runChat } = await import('./chat.js');
      return (await runChat(cmd.positionals)) as Exit;
    }
    case 'mcp-serve': {
      // Started by an agent's runtime with its run's token, never by hand (agent/tool-host.ts).
      const url = belugaEnv('TOOLS_URL');
      const token = belugaEnv('TOOLS_TOKEN');
      if (!cmd.positionals[0] || !url || !token) throw new Error('mcp-serve needs a suite, BELUGA_TOOLS_URL and BELUGA_TOOLS_TOKEN');
      const { serveStdio } = await import('../mcp-serve.js');
      await serveStdio(cmd.positionals[0], url, token);
      return 0;
    }
  }
}

/** How `beluga up` starts Beluga: under systemd or launchd when a service is installed (they keep it running), else in the background. */
export async function upDeps(): Promise<import('./up.js').UpDeps> {
  const { startInBackground } = await import('./up.js');
  const { foreground } = await import('./daemon.js');
  const { serviceEnv, serviceInstalled, startService } = await import('./service.js');
  const env = serviceEnv();
  const start = serviceInstalled(env) ? async () => (await startService(env)) ?? new Promise<string>(() => undefined) : startInBackground;
  return { start, foreground };
}

/** Run against the running daemon (loaded only for the commands that attach), or say it isn't running. */
async function attached(io: Io, use: (client: SocketClient) => Promise<Exit>): Promise<Exit> {
  const { NOT_RUNNING, withDaemon } = await import('./attach.js');
  const done = await withDaemon(use);
  if (done !== undefined) return done;
  io.err(NOT_RUNNING);
  return 1;
}

/** Ask a question on this terminal (no readline, BLG-681); Ctrl+C aborts. */
function asker(ctrlC: AbortController): (question: string) => Promise<string> {
  return async (question) => {
    const { readLine } = await import('./prompt.js');
    // Aborted (Ctrl+C), the question never answers: pair() hears it through the signal.
    return readLine(question, { signal: ctrlC.signal }).catch(() => new Promise<string>(() => undefined));
  };
}

/** `beluga pair` against the running daemon, on this terminal. */
async function pairHere(io: Io): Promise<Exit> {
  const { pair, pairLinkOf } = await import('./pair.js');
  const ctrlC = new AbortController();
  const onSigint = (): void => ctrlC.abort();
  process.on('SIGINT', onSigint);
  try {
    return await attached(io, (client) => pair(pairLinkOf(client), io, { ask: asker(ctrlC), signal: ctrlC.signal, tty: Boolean(process.stdout.isTTY), columns: process.stdout.columns ?? 80 }));
  } finally {
    process.off('SIGINT', onSigint);
  }
}

/** Run with Ctrl+C turned into an abort signal for as long as it takes. */
async function withCtrlC<T>(use: (ctrlC: AbortController) => Promise<T>): Promise<T> {
  const ctrlC = new AbortController();
  const onSigint = (): void => ctrlC.abort();
  process.on('SIGINT', onSigint);
  try {
    return await use(ctrlC);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

/** `beluga pair --computer` against the running daemon, on this terminal (BLG-774). */
async function pairComputerHere(io: Io, json: boolean): Promise<Exit> {
  const { pairComputer, computerPairLinkOf } = await import('./pair.js');
  return withCtrlC((ctrlC) => attached(io, (client) => pairComputer(computerPairLinkOf(client), io, { signal: ctrlC.signal, tty: Boolean(process.stdout.isTTY) && !json, columns: process.stdout.columns ?? 80, json })));
}

/** `beluga connect user@host` on this terminal, until Ctrl+C. */
async function connectHere(cmd: ParsedCommand, io: Io): Promise<Exit> {
  const [host, ...extra] = cmd.positionals;
  if (!host || extra.length) throw new UsageError('`beluga connect` takes one host: user@host, or a Host from ~/.ssh/config.', 'connect');
  if (cmd.flags.pair === true) {
    // Add it to your computers (BLG-781): your daemon does the ssh, with your keys and agent.
    const { addOverSsh, computersLinkOf } = await import('./computers.js');
    return withCtrlC((ctrlC) => attached(io, (client) => addOverSsh(computersLinkOf(client), host, io, { ask: asker(ctrlC), signal: ctrlC.signal })));
  }
  const port = cmd.flags.port === undefined ? undefined : countFlag(cmd.flags.port, 'port', 0, 'connect');
  if (port !== undefined && (port < 1 || port > 65535)) throw new UsageError('--port takes a port, like --port 7778.', 'connect');
  const { connect } = await import('./connect.js');
  const { systemOpen } = await import('../core/os-open.js');
  const ctrlC = new AbortController();
  const onSigint = (): void => ctrlC.abort();
  process.on('SIGINT', onSigint);
  try {
    return await connect({ host, open: cmd.flags['no-open'] !== true, ...(port !== undefined ? { port } : {}) }, io, { ssh: belugaEnv('SSH') ?? 'ssh', openUrl: systemOpen, signal: ctrlC.signal });
  } finally {
    process.off('SIGINT', onSigint);
  }
}

/** What was typed, run; a typing mistake shows the command's usage. */
export async function main(argv: readonly string[], io: Io = stdio): Promise<Exit> {
  try {
    return await run(parseCommand(argv), io);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(`${wrap(err.message, HELP_WIDTH, '').join('\n')}\n${err.command ? usageText(err.command) : '`beluga help` lists what it can do.\n'}`);
    return 2;
  }
}
