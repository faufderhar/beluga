import { randomUUID } from 'node:crypto';
import { type Body, type BodyInput, type BodyOf, MAX_FILE_BYTES } from '../protocol.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import { type SearchHit, searchShare } from './guest-search.js';
import { type ShareService, isDenied } from './shares.js';
import { type Location, type Store, clean } from './store.js';
import type { WorkspaceSharing } from './workspace-sharing.js';

/** What someone invited by link to one project may send you; everything else is dropped. */
const GUEST_KINDS = new Set<Body['kind']>(['chat', 'chat_react', 'agent_request', 'agent_event', 'agent_answer', 'fs_list', 'fs_read', 'fs_fetch', 'fs_search', 'ws_diff', 'ws_leave']);

export function guestMayDo(body: Body, shares: Pick<ShareService, 'isPrivate'>): boolean {
  if (!GUEST_KINDS.has(body.kind)) return false;
  // Not the room chat, not your Claude in the room: only their workspaces (their own agent's answers there too).
  if ((body.kind === 'chat' || body.kind === 'chat_react' || body.kind === 'agent_request' || body.kind === 'agent_event') && !body.channel.startsWith('ws:')) return false;
  // Only folders shared with particular people (their workspaces), never ones shared with the whole room.
  if (body.kind === 'fs_list' || body.kind === 'fs_read' || body.kind === 'fs_fetch' || body.kind === 'fs_search') return shares.isPrivate(body.share);
  return true;
}

export interface SharedDiffDeps {
  readonly store: Store;
  readonly shares: ShareService;
  readonly sharing: WorkspaceSharing;
  readonly manager?: WorkspaceManager;
  readonly send: (body: BodyInput, opts: { to: string }) => boolean;
  readonly request: <T>(to: string, body: BodyInput & { reqId: string }) => Promise<T>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Seeing what changed in a workspace someone shared with you (read-only), and the
 * owner's side of it: a git diff summary, then one file's patch at a time. Secrets
 * never show up, even when they were committed.
 */
export class SharedDiff {
  private token = 0;

  constructor(private readonly deps: SharedDiffDeps) {}

  // ------------------------------------------------------------ owner side

  async serve(from: string, body: BodyOf<'ws_diff'>): Promise<void> {
    const reply = (rest: Partial<BodyOf<'ws_diff_result'>>): void => void this.deps.send({ kind: 'ws_diff_result', reqId: body.reqId, ok: false, ...rest }, { to: from });
    if (!this.deps.sharing.members(body.id)[from] || !this.deps.manager?.find(body.id)) return reply({ error: "That workspace isn't shared with you" });
    try {
      if (body.file !== undefined) {
        // Only files from the (filtered) list, matched literally: no globs like "*" reaching private files.
        if (isDenied(body.file)) return reply({ error: 'That file is private' });
        const listed = (await this.deps.manager.review(body.id)).files.some((f) => f.path === body.file && !isDenied(f.path));
        if (!listed) return reply({ error: "That file isn't part of this workspace's changes" });
        const patch = await this.deps.manager.fileDiff(body.id, body.file);
        return reply({ ok: true, patch: patch.slice(0, MAX_FILE_BYTES - 64) });
      }
      const review = await this.deps.manager.review(body.id);
      reply({
        ok: true,
        review: { base: review.base.slice(0, 200), commits: review.commits.slice(0, 200).map((c) => ({ hash: c.hash.slice(0, 40), subject: c.subject.slice(0, 300) })), files: review.files.filter((f) => !isDenied(f.path)).slice(0, 2000) },
      });
    } catch (err) {
      reply({ error: errorText(err).slice(0, 500) });
    }
  }

  async serveSearch(from: string, body: BodyOf<'fs_search'>): Promise<void> {
    try {
      const { hits, truncated } = await searchShare(this.deps.shares.find(body.share), body.path, body.mode, body.query);
      this.deps.send({ kind: 'fs_search_result', reqId: body.reqId, ok: true, hits, truncated }, { to: from });
    } catch (err) {
      this.deps.send({ kind: 'fs_search_result', reqId: body.reqId, ok: false, error: errorText(err).slice(0, 500) }, { to: from });
    }
  }

  // ------------------------------------------------------------ member side

  async search(at: Location, mode: 'find' | 'grep', query: string): Promise<{ hits: readonly SearchHit[]; truncated: boolean }> {
    const res = await this.deps.request<BodyOf<'fs_search_result'>>(at.owner, { kind: 'fs_search', reqId: randomUUID(), share: at.share, path: at.path, mode, query: query.slice(0, 200) });
    return { hits: res.hits ?? [], truncated: res.truncated ?? false };
  }

  /** Open the Diff tab of a shared workspace: the summary, then the first file. */
  async load(id: string): Promise<void> {
    const w = this.deps.store.getState().shared.find((x) => x.id === id);
    if (!w) return;
    const token = ++this.token;
    this.deps.store.dispatch({ type: 'review', review: { workspaceId: id, selected: 0, loading: true } });
    try {
      const res = await this.deps.request<BodyOf<'ws_diff_result'>>(w.owner, { kind: 'ws_diff', reqId: randomUUID(), id });
      if (token !== this.token) return;
      const raw = res.review ?? { base: '', commits: [], files: [] };
      // Paths and commit subjects come from the owner's repo: never let them carry terminal escapes.
      const data = { base: clean(raw.base), commits: raw.commits.map((c) => ({ ...c, subject: clean(c.subject) })), files: raw.files.map((f) => ({ ...f, path: clean(f.path) })) };
      this.deps.store.dispatch({ type: 'review', review: { workspaceId: id, data, selected: 0, loading: false } });
      if (data.files.length) await this.select(0);
    } catch (err) {
      if (token !== this.token) return;
      this.deps.store.dispatch({ type: 'review', review: { workspaceId: id, selected: 0, loading: false, error: errorText(err) } });
    }
  }

  async select(index: number): Promise<void> {
    const review = this.deps.store.getState().review;
    const file = review?.data?.files[index];
    const w = this.deps.store.getState().shared.find((x) => x.id === review?.workspaceId);
    if (!review || !file || !w) return;
    this.deps.store.dispatch({ type: 'review', review: { ...review, selected: index, diff: undefined } });
    const diff = await this.deps
      .request<BodyOf<'ws_diff_result'>>(w.owner, { kind: 'ws_diff', reqId: randomUUID(), id: w.id, file: file.path })
      .then((r) => clean(r.patch ?? ''), (err: unknown) => `Couldn't load diff: ${errorText(err)}`);
    const latest = this.deps.store.getState().review;
    if (latest?.workspaceId === review.workspaceId && latest.selected === index) this.deps.store.dispatch({ type: 'review', review: { ...latest, diff } });
  }
}
