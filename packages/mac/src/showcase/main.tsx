import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { motion } from 'motion/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { BelugaProvider } from '../lib/beluga.js';
import { apply } from '../lib/prefs.js';
import { EASE_OUT, Rise, Words } from '../onboarding/fx.js';
import { Mark } from '../onboarding/Mark.js';
import { Archive } from '../onboarding/scenes/Archive.js';
import { Earnings } from '../onboarding/scenes/Earnings.js';
import { Friends } from '../onboarding/scenes/Friends.js';
import { Machines } from '../onboarding/scenes/Machines.js';
import { Parallel } from '../onboarding/scenes/Parallel.js';
import { Sentinel } from '../onboarding/scenes/Sentinel.js';
import { Scratch } from '../onboarding/scenes/Scratch.js';
import { Together } from '../onboarding/scenes/Together.js';
import o from '../onboarding/onboarding.module.css';
import { STAGING, Staged } from './staging.js';
import { TablesTour } from './TablesTour.js';
import '../styles/tokens.css';
import '../styles/base.css';

/**
 * The onboarding's scenes, one at a time on a plain page, for the README's GIFs
 * (scripts/readme-scenes.mjs): `/showcase.html?scene=parallel&theme=dark&bg=%230d1117`.
 * The flat ones are tilted in 3D for it (./staging), like the Parallel scene.
 * The background matches GitHub's, so the GIF looks cut out on the page. Only in development.
 */

/** The welcome's mark, name and promise, without its button: the README's banner (a still). */
function Hello() {
  return (
    <div className={o.hello}>
      <Mark size={104} />
      <Rise delay={1} className={o.wordmark}>
        Beluga
      </Rise>
      <h1 className={o.heroTitle} style={{ fontSize: 52 }}>
        <Words text="An agent for every task," delay={1.25} />
        <br />
        <motion.span className={o.heroSoft} initial={{ opacity: 0, y: '0.25em', filter: 'blur(10px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.9, ease: EASE_OUT, delay: 1.55 }}>
          all running at once.
        </motion.span>
      </h1>
    </div>
  );
}

const SCENES: Record<string, () => ReactNode> = {
  hello: () => <Hello />,
  parallel: () => <Parallel />,
  scratch: () => <Scratch />,
  tables: () => <TablesTour />,
  friends: () => <Friends />,
  sentinel: () => <Sentinel />,
  machines: () => <Machines />,
  together: () => <Together />,
  earnings: () => <Earnings />,
  archive: () => <Archive />,
};

const params = new URLSearchParams(location.search);
const name = params.get('scene') ?? 'parallel';
const scene = SCENES[name] ?? SCENES.parallel!;
const staging = STAGING[name];
const width = Number(params.get('w') ?? 640);
const height = Number(params.get('h') ?? 440);

apply();
// A still (the README's header): no glow behind the mark, and the second line at rest instead of mid-sheen.
if (params.has('still')) {
  const style = document.createElement('style');
  style.textContent = `[filter="url(#mark-glow)"] { display: none; } .${o.heroSoft} { animation: none; background: none; color: var(--text-3); }`;
  document.head.append(style);
}
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.body.style.cssText = `margin:0;background:${params.get('bg') ?? 'transparent'}`;

// Nothing here talks to Beluga: the scenes only need the providers for buttons nobody presses.
const client = {} as SocketClient;

createRoot(document.getElementById('root')!).render(
  <BelugaProvider client={client}>
    <Tooltip.Provider>
      <div style={{ width, height, display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
        <motion.div
          style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center' }}
          initial={{ opacity: 0, scale: 0.94, filter: 'blur(12px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.1 }}
        >
          {staging ? (
            <Staged staging={staging}>
              {scene()}
            </Staged>
          ) : (
            scene()
          )}
        </motion.div>
      </div>
    </Tooltip.Provider>
  </BelugaProvider>,
);
