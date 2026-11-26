import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// The app's own React (packages/mac/node_modules), the one native-menu.ts renders with.
const { createElement } = createRequire(new URL('../packages/mac/package.json', import.meta.url))('react') as typeof import('react');

// Loaded by a variable path, so the root tsc doesn't pull the app's sources (and their @beluga aliases) in.
const SOURCE = '../packages/mac/src/lib/native-menu.js';
const { picture } = (await import(/* @vite-ignore */ SOURCE)) as { picture: (p: { mark: unknown }) => Promise<unknown> };

describe('a native menu row’s mark', () => {
  it('that can’t be drawn outside the app (a project’s icon reads its context) is no picture, not a failed menu', async () => {
    const Needs = (): never => {
      throw new Error('useBeluga outside BelugaProvider');
    };
    await expect(picture({ mark: createElement(Needs) })).resolves.toBeUndefined();
  });

  it('that isn’t an SVG (a letter tile) is no picture either', async () => {
    await expect(picture({ mark: createElement('span', null, 'J') })).resolves.toBeUndefined();
  });
});
