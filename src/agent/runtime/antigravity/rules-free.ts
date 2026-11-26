import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { belugaHome } from '../../../core/home.js';

/**
 * Antigravity reads its own global rules on every turn: ~/.gemini/GEMINI.md, ~/.gemini/AGENTS.md
 * and their ~/.gemini/config/ counterparts with its rules folder. A run in Beluga goes by your
 * project's rules (its AGENTS.md, GEMINI.md, .agents/) and Beluga's instructions, not those. agy
 * has no switch for it, but it takes its Gemini folder as a flag (`--gemini-dir`), so Beluga gives
 * it one of its own: everything of ~/.gemini linked in (your sign-in, conversations, settings,
 * skills, plugins, MCP servers), the global rules left out.
 *
 * agy saves some files by writing a new one and renaming it over the old (projects.json,
 * settings.json): in this folder that replaces the link with a file of its own. Each start puts it
 * back where it belongs first (the newer of the two kept), and links it again, so there's one copy
 * of everything, yours.
 */

/** What's left out, at the top and in config/: the global rules. */
export const GLOBAL_RULES = new Set(['GEMINI.md', 'AGENTS.md', 'rules', 'rules.json']);

/** Where agy keeps its files: ~/.gemini. */
export const agyGeminiHome = (home: string = os.homedir()): string => path.join(home, '.gemini');

/** Beluga's Gemini folder for agy (~/.beluga/agy-gemini). */
export const agyRulesFreeDir = (home: string = belugaHome()): string => path.join(home, 'agy-gemini');

const lstat = (p: string) => fs.lstat(p).catch(() => undefined);
const names = async (dir: string): Promise<string[]> => fs.readdir(dir).catch(() => []);

/** Moves `from` onto `to` (another volume: copied, then removed). */
async function moveOnto(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

/** One folder of the mirror: each entry of `real` linked in but those left out; a file agy wrote here goes back to `real`. */
async function mirror(real: string, here: string, leftOut: (name: string) => boolean): Promise<void> {
  await fs.mkdir(here, { recursive: true });
  const theirs = new Set(await names(real));
  for (const name of await names(here)) {
    const at = path.join(here, name);
    const st = await lstat(at);
    if (!st || st.isSymbolicLink()) {
      // A link to what's left out (or to nothing any more) goes.
      if (st && (leftOut(name) || !theirs.has(name))) await fs.rm(at, { force: true });
      continue;
    }
    if (!st.isFile() || leftOut(name)) continue;
    // A file agy wrote here: it goes back (the newer copy kept), and the link comes back below.
    const target = path.join(real, name);
    const mine = await lstat(target);
    if (!mine || st.mtimeMs >= mine.mtimeMs) await moveOnto(at, target);
    else await fs.rm(at, { force: true });
    theirs.add(name);
  }
  for (const name of theirs) {
    if (leftOut(name)) continue;
    const at = path.join(here, name);
    const target = path.join(real, name);
    const st = await lstat(at);
    if (st?.isSymbolicLink() && (await fs.readlink(at)) === target) continue;
    if (st && !st.isSymbolicLink()) continue;
    if (st) await fs.rm(at, { force: true });
    await fs.symlink(target, at).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
  }
}

let making: Promise<unknown> = Promise.resolve();

/**
 * agy's flags for a start without your global rules: `--gemini-dir` on Beluga's folder, made ready
 * now. None (it reads ~/.gemini as it is) on Windows, where links need rights you may not have, and
 * when there are no global rules to leave out.
 */
export function rulesFreeArgs(opts: { readonly real?: string; readonly dir?: string; readonly platform?: NodeJS.Platform } = {}): Promise<readonly string[]> {
  const run = async (): Promise<readonly string[]> => {
    if ((opts.platform ?? process.platform) === 'win32') return [];
    const real = opts.real ?? agyGeminiHome();
    const dir = opts.dir ?? agyRulesFreeDir();
    const config = path.join(real, 'config');
    const rules = [...(await names(real)), ...(await names(config))].some((n) => GLOBAL_RULES.has(n));
    if (!rules) return [];
    await fs.mkdir(config, { recursive: true });
    await mirror(real, dir, (n) => GLOBAL_RULES.has(n) || n === 'config');
    await mirror(config, path.join(dir, 'config'), (n) => GLOBAL_RULES.has(n));
    return [`--gemini-dir=${dir}`];
  };
  // One at a time: two starts at once would make the same links.
  const next = making.then(run, run);
  making = next.catch(() => undefined);
  return next;
}
