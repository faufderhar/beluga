import { z } from 'zod';
import { createGatewayToolDefs } from '../../../agent/gateway-tools.js';
import { createRoomToolDefs, setProjectSetupToolDef } from '../../../agent/tools.js';
import type { RoomBridge, SetupTools } from '../../../agent/types.js';
import { isSecretPath } from '../../../core/shares.js';
import { ToolRefusal } from '../../domain/decide.js';
import { reachedProjects, reachesProject, type Grant } from '../../domain/grant.js';
import type { PeersPort } from '../../ports/peers.js';
import type { ExternalToolDef, Resolved } from '../mcp-tools.js';
import { type Adapted, type AnyDef, type Run, adapt, call, isInside } from './adapt.js';
import { untrusted } from './read.js';

/**
 * An agent reaches people through the gates your own agent uses: what your trust rules and theirs
 * say holds, and they see its name. Results are data from that person. An agent never gets a secret
 * file. Its tasks are its own: it can't read, answer or cancel anyone else's.
 */

const CARD_DETAIL_MAX = 2000;
const SECRET = 'That file holds secrets. An external agent never gets one.';

export function peerTools(port: PeersPort): ExternalToolDef[] {
  const agent = (grant: Grant) => ({ id: grant.id, name: grant.name });
  const nothing: Resolved = { target: '', inScope: true };
  const words = (who: unknown, what: unknown): string => untrusted(`To ${String(who)}: ${String(what)}`, CARD_DETAIL_MAX).text;
  const toPerson = (who: unknown, what: unknown): Resolved => ({ ...nothing, detail: words(who, what) });
  /** A file on their Mac, by a path that says it is a secret: refused before anyone is asked. */
  const noSecret = (file: unknown, who: unknown): Resolved => (isSecretPath(String(file)) ? { denial: 'capability_denied', message: SECRET } : toPerson(who, `send ${String(file)}`));
  const ownTask = (args: Record<string, unknown>, grant: Grant): Resolved => (port.taskSender(String(args.task)) === grant.id ? { target: `task:${String(args.task)}`, inScope: true } : { denial: 'not_found', message: 'No such task from this agent.' });

  const reportProject = (args: Record<string, unknown>, grant: Grant): Resolved => {
    const projectId = port.projectId(String(args.project));
    if (!projectId) return { denial: 'not_found', message: 'No such project.' };
    return { target: `project:${projectId}`, inScope: reachesProject(grant, projectId), detail: `It wants everyone to read a report: ${untrusted(String(args.title), 200).text}` };
  };
  /** Only a file in a project it reaches goes out: not anything on this Mac. */
  const sendable = (args: Record<string, unknown>, grant: Grant): Resolved => {
    if (isSecretPath(String(args.path))) return { denial: 'capability_denied', message: SECRET };
    const inside = reachedProjects(grant, port.projectIds()).some((id) => port.projectDirs(id).some((dir) => isInside(String(args.path), dir)));
    return { target: '', inScope: inside, detail: words(args.peer, `send ${String(args.path)}`) };
  };

  const room = createRoomToolDefs({} as RoomBridge); // Only names and schemas: each call makes its own, for its agent.
  const gateway = createGatewayToolDefs({} as RoomBridge);
  const setup = setProjectSetupToolDef({} as SetupTools);

  const runRoom: Run = (def, args, grant) => call(createRoomToolDefs(port.bridge(agent(grant))), def.name, args);
  const runGateway: Run = async (def, args, grant) => {
    const result = await call(createGatewayToolDefs(port.bridge(agent(grant))), def.name, args);
    // A file can turn out to be a secret only when it arrives: it stays with you, whoever approved it.
    if (typeof args.task === 'string' && port.taskHoldsSecret(args.task)) throw new ToolRefusal('capability_denied', SECRET);
    return result;
  };
  const runReport: Run = (def, { project, ...rest }, grant) => call(createRoomToolDefs(port.bridge(agent(grant), port.projectId(String(project)))), def.name, rest);

  return [
    ...adapt(room, runRoom, ROOM_READS.map((name): Adapted => ({ name, resolve: () => nothing }))),
    ...adapt(room, runRoom, [
      { name: 'ask_agent', resolve: (a) => toPerson(a.peer, a.prompt), extra: ' They see this agent\'s name on the request.' },
      { name: 'run_on_peer', resolve: (a) => toPerson(a.peer, `run ${String(a.command)}`), extra: ' They see this agent\'s name on the request.' },
      { name: 'get_peer_file', drop: ['save_to'], resolve: (a) => noSecret(a.path, a.peer), extra: ' It is saved in the Beluga downloads folder. An external agent never gets a secret.' },
      { name: 'send_file', resolve: sendable, extra: ' A file must be in a project this agent reaches.' },
    ]),
    ...adapt(room, runReport, [{ name: 'write_report', shape: { project: z.string().min(1).max(200).describe('The project it goes in, by its name.') }, resolve: reportProject }]),
    ...adapt(gateway, runGateway, [
      { name: 'who_can', resolve: () => nothing },
      { name: 'ask_person', resolve: (a) => toPerson(a.person, a.ask), extra: ' They see this agent\'s name. The result stays here: use wait_for or check.' },
      { name: 'run_on', resolve: (a) => toPerson(a.person, `run ${String(a.command)}`), extra: ' They see this agent\'s name. The result stays here: use wait_for or check.' },
      { name: 'get_file', resolve: (a) => noSecret(a.path, a.person), extra: ' An external agent never gets a secret, whoever would approve it.' },
      { name: 'answer_question', resolve: ownTask },
      { name: 'wait_for', resolve: ownTask },
      { name: 'check', resolve: ownTask },
      { name: 'cancel', resolve: ownTask },
    ]),
    ...adapt([setup as AnyDef], (def, { worktree, ...rest }) => {
      const found = port.setup(String(worktree));
      if (!found) throw new Error('No such worktree.');
      return call([setProjectSetupToolDef(found.tools) as AnyDef], def.name, rest);
    }, [
      {
        name: 'set_project_setup',
        shape: { worktree: z.string().max(300).describe('A worktree of the project, from list_work.') },
        resolve: (a, g) => {
          const found = port.setup(String(a.worktree));
          if (!found) return { denial: 'not_found', message: 'No such worktree.' };
          return { target: `project:${found.projectId}`, inScope: reachesProject(g, found.projectId), detail: `The command that runs in each new worktree: ${untrusted(String(a.command), CARD_DETAIL_MAX).text}` };
        },
      },
    ]),
  ];
}

const ROOM_READS = ['list_peers', 'list_peer_files', 'read_peer_file'] as const;
