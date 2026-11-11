/** Which agent changed which plan, in this daemon's life: an agent never passes a milestone of a plan it changed. */
const changes = new WeakMap<object, Set<string>>();

export function planChangesOf(session: object): Set<string> {
  const known = changes.get(session) ?? new Set<string>();
  changes.set(session, known);
  return known;
}
