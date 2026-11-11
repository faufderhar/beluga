import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The core (everything the background daemon runs) must not depend on how it's shown:
 * no Ink or React, nothing from the terminal UI, and no reading or writing the terminal.
 * Both clients (the terminal UI and the Mac app) attach to the same core.
 */
const CORE = ['src/core', 'src/agent', 'src/workspaces', 'src/net', 'src/terminal', 'src/image', 'src/shared', 'src/ipc', 'src/daemon', 'src/external', 'src/protocol.ts'];

const FORBIDDEN: ReadonlyArray<{ readonly what: string; readonly re: RegExp }> = [
  { what: 'imports ink', re: /from\s+['"]ink['"]/ },
  { what: 'imports react', re: /from\s+['"]react(\/[^'"]*)?['"]/ },
  { what: 'imports the terminal UI', re: /from\s+['"](\.\.\/)+ui\// },
  { what: 'uses the terminal directly', re: /process\.(stdout|stdin)\b/ },
];

function sources(entry: string): string[] {
  const abs = path.resolve(entry);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return [];
  }
  if (stat.isFile()) return [abs];
  return readdirSync(abs, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? sources(path.join(entry, d.name)) : /\.tsx?$/.test(d.name) ? [path.resolve(entry, d.name)] : []));
}

describe('core boundaries', () => {
  const files = CORE.flatMap(sources);

  it('finds the core sources', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(FORBIDDEN)('no core file $what', ({ re }) => {
    const offenders = files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => path.relative(process.cwd(), f));
    expect(offenders).toEqual([]);
  });
});
