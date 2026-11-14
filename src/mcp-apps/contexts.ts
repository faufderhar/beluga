/**
 * What MCP Apps told the model (ui/update-model-context): the latest per app instance (an update
 * replaces it), per conversation, until your Claude's next turn there takes it. Kept in memory.
 */

export interface AppContext {
  /** Who it's from, for the wrapper ("clock-app · show_clock"). */
  readonly app: string;
  readonly text: string;
}

/** Conversations kept (the oldest go). */
const MAX_CHANNELS = 100;
/** App instances kept per conversation (the oldest go). */
const MAX_INSTANCES = 20;

export class AppContexts {
  private readonly byChannel = new Map<string, Map<string, AppContext>>();

  /** The context of one app instance (its step) now; '' forgets it. */
  set(channel: string, instance: string, app: string, text: string): void {
    const entries = this.byChannel.get(channel) ?? new Map<string, AppContext>();
    entries.delete(instance);
    if (text) entries.set(instance, { app, text });
    while (entries.size > MAX_INSTANCES) entries.delete(entries.keys().next().value!);
    this.byChannel.delete(channel);
    if (entries.size) this.byChannel.set(channel, entries);
    while (this.byChannel.size > MAX_CHANNELS) this.byChannel.delete(this.byChannel.keys().next().value!);
  }

  /** Every app's context in that conversation, for the turn starting now; they're gone after. */
  take(channel: string): AppContext[] {
    const entries = this.byChannel.get(channel);
    this.byChannel.delete(channel);
    return entries ? [...entries.values()] : [];
  }
}

const all = new WeakMap<object, AppContexts>();

/** The session's app contexts (made the first time). */
export function appContextsOf(session: object): AppContexts {
  let c = all.get(session);
  if (!c) all.set(session, (c = new AppContexts()));
  return c;
}
