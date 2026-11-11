/**
 * BM25 over each tool's name, description and input schema: how beluga_find ranks by default. Plain code in this
 * process, built in a few milliseconds for every tool, with no dependency.
 */

/** What a tool is found by. */
export interface SearchableTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/** Ranks tool names for a query, best first; a tool that shares no word with it is left out. */
export type ToolRanking = (query: string) => readonly string[];

const K1 = 1.2;
const B = 0.75;
/** The name counts twice: `sentinel_remove` is about removing sentinels more than any word in its description. */
const NAME_WEIGHT = 2;
/** Schema keys that say how, not what: never words to find a tool by. */
const SCHEMA_SYNTAX = new Set(['type', 'pattern', 'format', '$schema', 'additionalProperties']);
const STOP = new Set('a an the of to in on for and or is it its this that with by from as at be your you my me i what which who how do does can'.split(' '));

/** Lowercase words, without stop words, with a light plural fold (tasks → task, entries → entry). */
export function searchWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !STOP.has(word))
    .map((word) => (word.length > 4 && word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));
}

/** Every property name and every string in a JSON schema (descriptions, enum values), in order. */
function schemaText(schema: unknown, key?: string): string[] {
  if (typeof schema === 'string') return key && SCHEMA_SYNTAX.has(key) ? [] : [schema];
  if (Array.isArray(schema)) return schema.flatMap((item) => schemaText(item));
  if (!schema || typeof schema !== 'object') return [];
  return Object.entries(schema).flatMap(([k, value]) => [...(key === 'properties' ? [k] : []), ...schemaText(value, k)]);
}

/** The text a tool is found by: its name split at `_`, its description and its schema's words. */
export function toolText(tool: SearchableTool): string {
  return [tool.name.replace(/_/g, ' '), tool.description, ...schemaText(tool.inputSchema)].join(' ');
}

export function bm25Ranking(tools: readonly SearchableTool[]): ToolRanking {
  const docs = tools.map((tool) => {
    const nameWords = searchWords(tool.name.replace(/_/g, ' '));
    const words = [...searchWords(toolText(tool)), ...Array.from({ length: NAME_WEIGHT - 1 }, () => nameWords).flat()];
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    return { name: tool.name, counts, length: words.length };
  });
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(docs.length, 1);
  const holders = new Map<string, number>();
  for (const doc of docs) for (const word of doc.counts.keys()) holders.set(word, (holders.get(word) ?? 0) + 1);
  const idf = (word: string) => {
    const n = holders.get(word) ?? 0;
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
  };
  return (query) => {
    const words = [...new Set(searchWords(query))];
    return docs
      .map((doc) => ({
        name: doc.name,
        score: words.reduce((sum, word) => {
          const f = doc.counts.get(word) ?? 0;
          return f ? sum + (idf(word) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / average)) : sum;
        }, 0),
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .map((hit) => hit.name);
  };
}
