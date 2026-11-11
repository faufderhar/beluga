import type { Session } from '../core/session.js';
import type { PairingSpec } from '../external/domain/oauth.js';
import { FULL_REACH, STANDALONE_CHATS, defaultLevel } from '../external/domain/grant.js';
import { needExternal } from '../external/registry.js';
import type { Args, Method } from './api.js';

/** What each `external.*` method does (see external-api.ts). */

type ExternalMethod = Extract<Method, `external.${string}`>;
type ExternalHandlers = { readonly [M in ExternalMethod]: (s: Session, ...args: Args<M>) => unknown };

export const EXTERNAL_HANDLERS = {
  'external.status': (s) => needExternal(s).status(),
  'external.setEnabled': (s, on) => needExternal(s).setEnabled(on),
  'external.setRoute': (s, kind, on) => needExternal(s).setRoute(kind, on),
  'external.pairingCode': (s, spec) => needExternal(s).pairingCode(specOf(s, spec)),
  'external.localToken': (s, name, spec) => needExternal(s).localToken(name, specOf(s, spec)),
  'external.agents': (s) => needExternal(s).grants.list(),
  'external.revoke': (s, id) => needExternal(s).revoke(id),
  'external.resume': (s, id) => needExternal(s).resume(id),
  'external.stopAgent': (s, id) => needExternal(s).stopAgent(id),
  'external.stopAll': (s) => needExternal(s).stopAll(),
  'external.setPaused': (s, paused) => needExternal(s).setPaused(paused),
  'external.activity': (s, filter) => needExternal(s).activity(filter ? { ...(filter.agent ? { agent: filter.agent } : {}), ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.limit ? { limit: filter.limit } : {}) } : {}),
} satisfies ExternalHandlers;

function specOf(s: Session, spec: Args<'external.pairingCode'>[0]): PairingSpec {
  const { level = defaultLevel(spec.remote), projects = FULL_REACH.projects, chats = FULL_REACH.chats, remote, allowRemoteFull } = spec;
  return { level, projects: projects === 'all' ? 'all' : projects.map((p) => projectIdOf(s, p)), chats, ...(remote ? { remote } : {}), ...(allowRemoteFull ? { allowRemoteFull } : {}) };
}

function projectIdOf(s: Session, idOrName: string): string {
  // Only the word itself names all your chats with no project: a project called that would be a surprise either way.
  const project = s.store.getState().projects.find((p) => p.root && (p.id === idOrName || p.name === idOrName));
  if (idOrName === STANDALONE_CHATS && project) throw new Error(`A project is called ${idOrName}, the same word as your chats with no project. Give its id.`);
  if (idOrName === STANDALONE_CHATS) return STANDALONE_CHATS;
  if (!project) throw new Error(`No project called ${idOrName}`);
  return project.id;
}
