import { readFile, stat } from 'node:fs/promises';
import { needGateway } from '../core/gateway/registry.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';
import { FILE_MANAGER } from '../shared/assistant.js';

/** What each `gateway.*` method does (see gateway-api.ts). */

type GatewayMethod = Extract<Method, `gateway.${string}`>;
type GatewayHandlers = { readonly [M in GatewayMethod]: (s: Session, ...args: Args<M>) => unknown };

export const GATEWAY_HANDLERS = {
  'gateway.list': (s) => {
    const state = s.store.getState().gateway;
    return { tasks: state.tasks, cards: state.cards, note: state.note };
  },
  'gateway.confirm': (s, id, yes, edited, always) => needGateway(s).confirm(id, yes, edited || undefined, undefined, always ?? false),
  'gateway.setAskFreely': (s, peerId, on) => needGateway(s).setAskFreely(peerId, on),
  'gateway.cancel': (s, id) => needGateway(s).cancel(id),
  'gateway.forget': (s, id) => needGateway(s).forget(id),
  'gateway.ask': (s, person, ask, opts) => needGateway(s).ask({ person, ask, by: 'person', ...(opts?.needs ? { needs: opts.needs } : {}), ...(opts?.project ? { project: opts.project } : {}), ...(opts?.answer ? { conversation: opts.answer.conversation, answer: opts.answer.id } : {}) }),
  'gateway.setNote': (s, note) => needGateway(s).setNote(note),
  'gateway.decide': (s, id, decision) => needGateway(s).decide(id, decision),
  'gateway.answer': (s, id, answers) => needGateway(s).answer(id, answers, 'person'),
  'gateway.saveRule': (s, rule) => needGateway(s).saveRule(rule),
  'gateway.removeRule': (s, id) => needGateway(s).removeRule(id),
  'gateway.setCapabilities': (s, patch) => needGateway(s).setCapabilities(patch),
  'gateway.image': async (s, id, name) => {
    // Only a picture this task's result brought, saved on this Mac.
    const file = needGateway(s).get(id)?.result?.files.find((f) => f.name === name && f.image && f.path);
    if (!file?.path) throw new Error('No such picture');
    const size = (await stat(file.path)).size;
    if (size > MAX_IMAGE_BYTES) throw new Error(`That picture is too big to show here; open it in ${FILE_MANAGER}`);
    const type = /\.png$/i.test(file.path) ? 'image/png' : /\.gif$/i.test(file.path) ? 'image/gif' : /\.webp$/i.test(file.path) ? 'image/webp' : 'image/jpeg';
    return `data:${type};base64,${(await readFile(file.path)).toString('base64')}`;
  },
} satisfies GatewayHandlers;

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
