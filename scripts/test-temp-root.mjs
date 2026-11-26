// Every vitest run keeps its temporary files in a folder of its own, beluga-run-<pid>-XXXXXX in the
// system's temp folder, and removes it when the run ends. vitest.config.ts uses this file as a global
// setup: it points TMPDIR (TMP and TEMP on Windows) at that folder before any worker starts, so every
// mkdtemp a test makes, the homes tests/setup.ts gives each file, and whatever the daemons and shells
// a test starts write to their temp folder land inside it. A test that forgets its own cleanup, a
// cleanup that a timeout or a failure skipped, or a folder Windows wouldn't let go then still leaves
// nothing behind once the run ends.
// A run killed outright (Ctrl-C twice, a crash, a closed terminal) can't remove its folder: the next
// run removes every beluga-run-* folder whose run is no longer alive.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alive } from './e2e-lock.mjs';

const TEMP_VARS = ['TMPDIR', 'TMP', 'TEMP'];
const ROOT_NAME = /^beluga-run-(\d+)-[A-Za-z0-9]{6}$/;

const removeDir = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

/** Remove the run folders in `base` whose run has ended (`isAlive` says whether a pid still runs). → the names removed */
export function sweepRunRoots(base, isAlive = alive) {
  let names;
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  const swept = [];
  for (const name of names) {
    const pid = Number(ROOT_NAME.exec(name)?.[1]);
    if (!pid || isAlive(pid)) continue;
    try {
      removeDir(path.join(base, name));
      swept.push(name);
    } catch {
      // Still held (Windows): the run after this one tries again.
    }
  }
  return swept;
}

/** Make this run's folder in `base` and point the temp variables of `env` at it. → { root, remove } */
export function ownRunRoot(base = os.tmpdir(), env = process.env, pid = process.pid) {
  sweepRunRoots(base);
  const root = mkdtempSync(path.join(base, `beluga-run-${pid}-`));
  const before = TEMP_VARS.map((name) => [name, env[name]]);
  for (const name of TEMP_VARS) env[name] = root;
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    for (const [name, value] of before) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    try {
      removeDir(root);
    } catch {
      // Something still holds it (Windows): the next run sweeps it.
    }
  };
  return { root, remove };
}

export default function setup() {
  const { remove } = ownRunRoot();
  // vitest stopped without its teardown (a failed global setup, an exit on a signal) still exits.
  process.once('exit', remove);
  return () => {
    process.off('exit', remove);
    remove();
  };
}
