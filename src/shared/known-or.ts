/** What a value of a kind looks like: what libraries probe objects for doesn't. */
const VALUE = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * A table of what each value of a kind means (STATUS_INFO, STEP_INFO…), that also answers for a
 * value it doesn't have. Several Beluga versions meet in one cluster: a paired computer, a team's
 * board, a friend on a newer Beluga sends a status, a step or a trust level this version doesn't
 * know, and `TABLE[value].label` threw and took a screen down. A value the table doesn't have gets
 * `unknown(value)` instead (its label the value itself, whatever decides something the safest
 * choice), the same entry each time. Lookups of what the table has, iterating it, `in` and its
 * methods are as before; only a key shaped like one of these values (lower case, `_` or `-`) is
 * answered, so what libraries probe objects for (`@@iterator`, `asymmetricMatch`) stays undefined.
 * Browser-safe.
 */
export function knownOr<K extends string, V>(table: Readonly<Record<K, NoInfer<V>>>, unknown: (value: string) => NoInfer<V>): Readonly<Record<K, V>> {
  const made = new Map<string, V>();
  return new Proxy(table, {
    get(target, key, receiver) {
      if (typeof key !== 'string' || key in target || !VALUE.test(key)) return Reflect.get(target, key, receiver);
      let v = made.get(key);
      if (v === undefined) {
        v = unknown(key);
        if (made.size < 100) made.set(key, v);
      }
      return v;
    },
  });
}
