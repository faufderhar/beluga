import { expect as baseExpect, test as base } from '@playwright/test';
import { slotHomes } from '../../../scripts/e2e-lock.mjs';
import { type Demo, startDemo } from './daemon.js';

export * from '@playwright/test';

/**
 * Every spec file gets a demo daemon of its own: fresh state, whatever the files before it in this
 * worker archived, merged or turned off. The worker keeps the next one warming up in its other home
 * while a file runs, so switching costs nothing. The page finds its daemon through the dev server's
 * /__beluga/endpoint (src/lib/boot.ts), which is answered here instead.
 *
 * Specs read process.env.BELUGA_HOME (its fake-gh.json) and BELUGA_CLAUDE_HOME (the pretend ~/.claude):
 * in a worker they're the current daemon's. Import `test` and `expect` from here, not @playwright/test.
 */

// The run's homes (scripts/e2e-lock.mjs, or playwright.config.ts without the lock): this worker's are next to them.
const run = { home: process.env.BELUGA_HOME!, claude: process.env.BELUGA_CLAUDE_HOME! };
const port = Number(process.env.E2E_PORT);

class Demos {
  private current?: { demo: Demo; file: string; slot: 0 | 1 };
  private next?: { demo: Promise<Demo>; slot: 0 | 1 };

  constructor(
    private readonly worker: number,
    private readonly linkMs: number,
  ) {}

  private start(slot: 0 | 1): Promise<Demo> {
    return startDemo({ ...slotHomes(run, this.worker, slot), port, linkMs: this.linkMs });
  }

  /** The daemon for a spec file: the one it already has, else the warm one (then the next one warms up). */
  async for(file: string): Promise<Demo> {
    if (this.current?.file === file) return this.current.demo;
    const old = this.current;
    const slot = this.next?.slot ?? 0;
    const demo = this.next?.demo ?? this.start(slot);
    this.next = undefined;
    this.current = undefined;
    // The old daemon goes first: the next one warms up in its home.
    await old?.demo.stop();
    const ready = await demo;
    this.current = { demo: ready, file, slot };
    process.env.BELUGA_HOME = process.env.KLAUD_HOME = ready.home;
    process.env.BELUGA_CLAUDE_HOME = process.env.KLAUD_CLAUDE_HOME = ready.claude;
    const other = slot === 0 ? 1 : 0;
    const warming = this.start(other);
    // Its failure is the next file's (it's awaited there), not an unhandled rejection now.
    warming.catch(() => undefined);
    this.next = { demo: warming, slot: other };
    return ready;
  }

  async stop(): Promise<void> {
    const next = this.next?.demo.then((d) => d.stop(), () => undefined);
    await Promise.all([this.current?.demo.stop(), next]);
  }
}

/** React's words for a view whose store read never holds still, or that redraws itself without end. */
const RENDER_LOOP = /The result of getSnapshot should be cached|Maximum update depth exceeded/;

/** `demoLinkMs` (a project's option): the round trip added to the demo's computers' pages (the remote project: 80 ms). */
export const test = base.extend<{ demo: Demo }, { demos: Demos; demoLinkMs: number }>({
  demoLinkMs: [0, { scope: 'worker', option: true }],
  demos: [
    async ({ demoLinkMs }, use, info) => {
      const demos = new Demos(info.parallelIndex, demoLinkMs);
      await use(demos);
      await demos.stop();
    },
    { scope: 'worker', timeout: 120_000 },
  ],
  demo: [async ({ demos }, use, info) => use(await demos.for(info.file)), { auto: true, timeout: 120_000 }],
  // A view that redraws for good (BLG-905: the bell froze the window grey) fails the test it shows up in.
  page: async ({ page }, use) => {
    const loops: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && RENDER_LOOP.test(m.text())) loops.push(m.text().slice(0, 500));
    });
    page.on('pageerror', (e) => {
      if (RENDER_LOOP.test(e.message)) loops.push(e.message.slice(0, 500));
    });
    await use(page);
    baseExpect(loops, 'A view redrew for good: React said so in the console (BLG-905)').toEqual([]);
  },
  context: async ({ context, demo }, use) => {
    await context.route('**/__beluga/endpoint', (route) => route.fulfill({ json: demo.endpoint }));
    await use(context);
  },
});
