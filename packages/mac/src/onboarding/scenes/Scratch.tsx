import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Icon, type IconName } from '../../components/Icon.js';
import { SPRING } from '../fx.js';
import { useBeatControl } from './use-beats.js';
import t from './tour-scenes.module.css';

/**
 * The Scratch folder (BLG-989): you ask, and what your agent makes on the way (a screenshot, a
 * test log, a response) lands in Scratch while it's still working, each one a click to open. Three
 * requests take turns; picking one plays it, and a file you open holds the scene still.
 */

type Page = 'phone' | 'error' | 'list';
type Line = { readonly text: string; readonly tone?: 'ok' | 'bad' | 'warn' };
type File =
  | { readonly name: string; readonly kind: 'shot'; readonly page: Page }
  | { readonly name: string; readonly kind: 'log'; readonly lines: readonly Line[] }
  | { readonly name: string; readonly kind: 'json'; readonly rows: ReadonlyArray<readonly [string, string]> };

interface Run {
  readonly id: string;
  readonly ask: string;
  readonly branch: string;
  /** What the agent is doing as each file lands. */
  readonly doing: readonly string[];
  readonly files: readonly File[];
  readonly answer: string;
}

export const SCRATCH_RUNS: readonly Run[] = [
  {
    id: 'login',
    ask: 'Check the login page on a phone',
    branch: 'fix/login-mobile',
    doing: ['Opening the login page at 375 px', 'Reading the console', 'Measuring the layout'],
    files: [
      { name: 'login-375px.png', kind: 'shot', page: 'phone' },
      { name: 'console.log', kind: 'log', lines: [{ text: 'GET /login 200' }, { text: 'Sign In off screen', tone: 'warn' }, { text: 'GET /api/session 401' }] },
      { name: 'layout.json', kind: 'json', rows: [['viewport', '375 × 812'], ['button.top', '860'], ['visible', 'false']] },
    ],
    answer: 'At 375 px the Sign In button is below the screen. Fixing it now.',
  },
  {
    id: 'tests',
    ask: 'Run the tests',
    branch: 'feat/checkout',
    doing: ['Running npm test', 'Opening the failing page', 'Saving the failure'],
    files: [
      { name: 'test-run.log', kind: 'log', lines: [{ text: 'cart adds items', tone: 'ok' }, { text: 'coupon applies', tone: 'ok' }, { text: 'checkout total', tone: 'bad' }, { text: '27 passed, 1 failed' }] },
      { name: 'checkout.png', kind: 'shot', page: 'error' },
      { name: 'failure.json', kind: 'json', rows: [['test', 'checkout total'], ['expected', '$48.00'], ['received', '$52.80']] },
    ],
    answer: 'Tax is added twice at checkout. The fix is one line.',
  },
  {
    id: 'api',
    ask: 'What does the orders API return?',
    branch: 'main',
    doing: ['Calling GET /api/orders', 'Saving the response', 'Opening the orders page'],
    files: [
      { name: 'orders.json', kind: 'json', rows: [['id', 'ord_1042'], ['total', '129.00'], ['status', 'paid']] },
      { name: 'request.txt', kind: 'log', lines: [{ text: 'GET /api/orders?limit=20' }, { text: '200 OK in 182 ms', tone: 'ok' }, { text: '20 orders' }] },
      { name: 'orders-page.png', kind: 'shot', page: 'list' },
    ],
    answer: 'Twenty orders a page, newest first, totals in dollars.',
  },
];

// Beats: the ask · a file lands · another · another · the answer, held.
const BEATS = [800, 1400, 1400, 1400, 3200] as const;
const ANSWER = 4;

const ICON: Record<File['kind'], IconName> = { shot: 'image', log: 'terminal', json: 'fileText' };

/** A screenshot, drawn: a phone's login, a page with an error, a list of orders. */
function Shot({ page }: { readonly page: Page }) {
  if (page === 'phone') {
    return (
      <span className={t.shot} data-page="phone">
        <i className={t.shotTitle} />
        <i className={t.shotField} />
        <i className={t.shotField} />
        <i className={t.shotOff}>Sign In</i>
      </span>
    );
  }
  if (page === 'error') {
    return (
      <span className={t.shot}>
        <i className={t.shotBanner}>Total $52.80</i>
        <i className={t.shotRow} />
        <i className={t.shotRow} />
        <i className={t.shotButton} />
      </span>
    );
  }
  return (
    <span className={t.shot}>
      {[0, 1, 2, 3].map((i) => (
        <i key={i} className={t.shotListRow}>
          <b />
          <b />
        </i>
      ))}
    </span>
  );
}

function Content({ file }: { readonly file: File }) {
  if (file.kind === 'shot') return <Shot page={file.page} />;
  if (file.kind === 'log') {
    return (
      <span className={t.log}>
        {file.lines.map((l) => (
          <span key={l.text} data-tone={l.tone}>
            {l.tone === 'ok' ? <Icon name="check" size={9} /> : l.tone === 'bad' ? <Icon name="x" size={9} /> : l.tone === 'warn' ? <Icon name="alert" size={9} /> : null}
            {l.text}
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className={t.json}>
      {file.rows.map(([k, v]) => (
        <span key={k}>
          <b>“{k}”</b>: <em>{v}</em>
        </span>
      ))}
    </span>
  );
}

export function Scratch() {
  const [at, setAt] = useState(0);
  const [open, setOpen] = useState<string>();
  const { beat, go } = useBeatControl(BEATS, { rest: ANSWER, paused: open !== undefined, onLoop: () => setAt((a) => (a + 1) % SCRATCH_RUNS.length) });
  const run = SCRATCH_RUNS[at]!;
  const landed = run.files.slice(0, Math.min(run.files.length, beat));
  const working = beat < ANSWER;
  const opened = run.files.find((f) => f.name === open);
  const pick = (i: number): void => {
    setOpen(undefined);
    setAt(i);
    go(0);
  };
  return (
    <div className={t.stage}>
      <div className={t.scratch}>
        <div className={t.picks} role="radiogroup" aria-label="Ask your agent">
          {SCRATCH_RUNS.map((r, i) => (
            <button key={r.id} type="button" role="radio" aria-checked={i === at} className={t.pick} onClick={() => pick(i)}>
              {i === at ? <motion.span layoutId="scratch-pick" className={t.pickOn} transition={SPRING} /> : null}
              <span className={t.pickLabel}>{r.ask}</span>
            </button>
          ))}
        </div>
        <div className={t.window}>
          <div className={t.bar}>
            <span className={t.lights}>
              <i />
              <i />
              <i />
            </span>
            <span className={t.mono}>web · {run.branch}</span>
            <span className={t.state} data-done={working ? undefined : ''}>
              {working ? (
                <>
                  <span className={t.liveDot} /> Still working
                </>
              ) : (
                <>
                  <Icon name="check" size={10} /> Done
                </>
              )}
            </span>
          </div>
          <div className={t.split}>
            <div className={t.talk}>
              <AnimatePresence mode="popLayout">
                <motion.div key={run.id} className={t.ask} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={SPRING}>
                  {run.ask}
                </motion.div>
              </AnimatePresence>
              <div className={t.doing}>
                {run.doing.slice(0, Math.min(run.doing.length, beat + 1)).map((d, i, shown) => {
                  const live = working && i === shown.length - 1;
                  return (
                    <motion.span key={`${run.id}-${d}`} className={t.doingLine} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={SPRING}>
                      <Icon name={live ? 'refresh' : 'check'} size={11} className={live ? t.spin : t.ok} />
                      {d}
                    </motion.span>
                  );
                })}
              </div>
              <AnimatePresence>
                {!working ? (
                  <motion.div key={`a-${run.id}`} className={t.answer} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={SPRING}>
                    <Icon name="claude" size={12} className={t.claude} /> {run.answer}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
            <div className={t.folder}>
              <div className={t.folderHead}>
                <Icon name="folder" size={11} /> Scratch
                <span className={t.count}>{landed.length}</span>
              </div>
              <div className={t.tiles}>
                <AnimatePresence mode="popLayout">
                  {landed.map((f, i) => (
                    <motion.button
                      key={`${run.id}-${f.name}`}
                      type="button"
                      layoutId={`scratch-${run.id}-${f.name}`}
                      className={t.tile}
                      aria-label={`Open ${f.name}`}
                      onClick={() => setOpen(f.name)}
                      initial={{ opacity: 0, y: 16, scale: 0.9 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      transition={SPRING}
                    >
                      <span className={t.tileBody}>
                        <Content file={f} />
                      </span>
                      <span className={t.tileName}>
                        <Icon name={ICON[f.kind]} size={10} />
                        <span>{f.name}</span>
                        {working && i === landed.length - 1 ? <span className={t.newDot} aria-label="New" /> : null}
                      </span>
                    </motion.button>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          </div>
          <AnimatePresence>
            {opened ? (
              <motion.div key="veil" className={t.veil} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(undefined)}>
                <motion.div layoutId={`scratch-${run.id}-${opened.name}`} className={t.preview} transition={SPRING} onClick={(e) => e.stopPropagation()}>
                  <span className={t.previewHead}>
                    <Icon name={ICON[opened.kind]} size={11} /> {opened.name}
                    <button type="button" className={t.close} aria-label="Close" onClick={() => setOpen(undefined)}>
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                  <span className={t.previewBody}>
                    <Content file={opened} />
                  </span>
                </motion.div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
