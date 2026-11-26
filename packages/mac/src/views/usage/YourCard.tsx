import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState } from '@beluga/core/store.js';
import { type StatsSnapshot, dailySeries, streaks, totalsBy, totalsOf } from '@beluga/shared/stats.js';
import { Icon } from '../../components/Icon.js';
import { Button, cx, personColor } from '../../components/ui.js';
import { useAvatarUrl } from '../../lib/avatars.js';
import { drawBack, drawFront, drawStrap, loadPicture } from './card-face.js';
import { calendar, duration } from './stats-model.js';
import { type Title, titlesOf } from './titles.js';
import { Mark } from '../../onboarding/Mark.js';
import { Recap } from './Recap.js';
import { ShareSheet } from './ShareSheet.js';
import type { ShareInput } from './share-image.js';
import { compact } from './usage-model.js';
import { usePicked } from './use-stats.js';
import s from './your-card.module.css';

// three.js comes only with the Usage tab, and only once the card is drawn.
const Lanyard = lazy(() => import('../../components/reactbits/lanyard-props.js'));
type LanyardProps = import('../../components/reactbits/lanyard-props.js').LanyardProps;

/** Your pass on its lanyard (one at a time: the recap's last slide takes it while it's open). */
const pass = (faces: Faces, color: string, size: number, more: Partial<LanyardProps> = {}) => <Lanyard frontImage={faces.front} backImage={faces.back} strapImage={faces.strap} cardColor="#fbfbfd" strapColor={color} finish="glossy" metal="silver" size={size} strapLength={0.42} breeze={0} {...more} />;

/** How tall the card hangs (px), and how far below the box's bottom it reaches (so it hangs out of its box). */
const CARD_PX = 430;
const OVERHANG_PX = 56;
/** When narrow, how far down the card's top is from the box's. */
const NARROW_TOP_PX = 96;
/** The layer reaches this far below your card's box, so the card can swing out over the page. */
export const BLEED_BELOW = 280;

/** How far past the box's right side the layer reaches. */
const BLEED_RIGHT = 40;

/** The nearest box around `el` that clips what spills out of it (the page that scrolls). */
function clipperOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return p;
  return null;
}

/**
 * Your pass hangs in a layer bigger than its place (out to the page's left edge, over the words,
 * down into the next chapter): its strap starts at the box's top, the card hangs a little past the
 * box's bottom, and it swings out of the box without being cut off; the layer takes the pointer only
 * over the card. Lanyard sizes the card to the layer and hangs it a share of the way across, so it's
 * given the size and the place that keep the card where it belongs.
 */
function useLayer(): { ref: React.RefObject<HTMLElement | null>; size: number; strapLength: number; anchor: number; style: React.CSSProperties } {
  const ref = useRef<HTMLElement | null>(null);
  // `left`: from the box's left side to the left edge of the page around it.
  const [box, setBox] = useState({ width: 1000, height: 580, left: 40 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clipper = clipperOf(el);
    const measure = (): void => {
      const left = clipper ? el.getBoundingClientRect().left - clipper.getBoundingClientRect().left - clipper.clientLeft : 40;
      setBox({ width: el.clientWidth, height: el.clientHeight, left: Math.max(0, Math.round(left)) });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (clipper) ro.observe(clipper);
    return () => ro.disconnect();
  }, []);
  const narrow = box.width < 736;
  // The layer: the box (when narrow, the pass's own place: 400 px) and the bleed below.
  const tall = (narrow ? 400 : box.height) + BLEED_BELOW;
  const size = Math.min(0.9, CARD_PX / tall);
  // Lanyard puts the card's top at 0.12–0.42 of the layer's height (strapLength 0–1).
  const cardTop = narrow ? NARROW_TOP_PX : Math.max(NARROW_TOP_PX, box.height + OVERHANG_PX - CARD_PX);
  const strapLength = Math.min(1, Math.max(0, (cardTop / tall - 0.12) / 0.3));
  // Where the strap hangs, from the box's left side: the middle when narrow, else over the left column.
  const hangX = narrow ? box.width / 2 : 0.27 * (box.width + 80) - 40;
  const anchor = (box.left + hangX) / (box.left + box.width + BLEED_RIGHT);
  return { ref, size, strapLength, anchor, style: { top: 0, left: -box.left, right: -BLEED_RIGHT, height: tall } };
}

interface Faces {
  readonly front: string;
  readonly back: string;
  readonly strap: string;
}

/** Your pass number: four digits that are always yours (from your id). */
export function serialOf(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return String(h % 10_000).padStart(4, '0');
}

/** Your name and picture as the network knows them (else this Mac's name). */
function useYou(state: AppState): { name: string; id: string; picture?: string } {
  const self = state.network.self;
  const id = self?.peerId ?? state.selfId;
  const name = self?.name || state.self?.name || 'You';
  const picture = useAvatarUrl(id);
  return { name, id, ...(picture ? { picture } : {}) };
}

/** Everything the card and the titles read from the stats, all time. */
function useStanding(stats: StatsSnapshot, now: number) {
  return useMemo(() => {
    const all = totalsOf(stats, '');
    const agents = [...totalsBy(stats, 'agent', '').entries()].filter(([k, t]) => k && t.agentMs + t.prompts + t.tokens > 0).length;
    const { longest } = streaks(stats, now);
    const year = calendar(dailySeries(stats, 'prompts', now, 371), now)
      .slice(-52)
      .map((w) => w.map((d) => d.level));
    const active = Object.keys(stats.days).length;
    return { all, longest, titles: titlesOf({ all, hours: stats.hours, longestStreak: longest, agents }), year, active };
  }, [stats, now]);
}

/** How many titles show before "Show all". */
const FEW_TITLES = 5;

/**
 * The titles you've earned, one line each with what earned it; press one to wear it on your pass.
 * The few best show first (with the one you wear), the rest behind "Show all".
 */
function TitleList({ titles, worn, onWear }: { titles: readonly Title[]; worn: string; onWear: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const few = titles.slice(0, FEW_TITLES);
  const shown = all || titles.length <= FEW_TITLES + 1 ? titles : few.some((t) => t.id === worn) ? few : [...few, titles.find((t) => t.id === worn)!];
  const hidden = titles.length - shown.length;
  return (
    <div className={s.titles}>
      <div className={s.titlesHead}>
        <span>Titles you’ve earned</span>
        <span className={s.titlesHint}>Press one to wear it</span>
      </div>
      <ul className={s.titleList} aria-label="Titles you’ve earned">
        {shown.map((t) => {
          const on = t.id === worn;
          return (
            <li key={t.id}>
              <button type="button" aria-pressed={on} className={cx(s.row, on && s.rowOn)} style={{ '--t': t.color } as React.CSSProperties} onClick={() => onWear(t.id)}>
                <Icon name={t.icon} size={14} />
                <span className={s.rowName}>{t.name}</span>
                <span className={s.rowWhy}>{t.why}</span>
                <span className={s.rowCheck} aria-hidden>
                  {on ? <Icon name="check" size={13} /> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {hidden > 0 || all ? (
        <button type="button" className={s.more} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${titles.length}`}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The top of the Usage tab: your pass on a lanyard (grab it, swing it, flip it) with your picture,
 * name and title, and beside it the title in words, what earned it, and the titles you've earned
 * as a list (press one to wear it on your pass). The recap starts from here.
 */
export function YourCard({ state, stats, now }: { state: AppState; stats: StatsSnapshot; now: number }) {
  const [recap, setRecap] = useState(false);
  const you = useYou(state);
  const { all, longest, titles, year, active } = useStanding(stats, now);
  const [sharing, setSharing] = useState(false);
  const [worn, setWorn] = usePicked<string>(
    'beluga.usage.title',
    titles[0]!.id,
    titles.map((t) => t.id),
  );
  const title: Title = titles.find((t) => t.id === worn) ?? titles[0]!;
  const since = stats.since ? `Since ${new Date(stats.since).toLocaleDateString([], { month: 'short', year: 'numeric' })}` : 'From today';
  const figures = useMemo(
    () => [
      { value: duration(all.agentMs).replace(' min', 'm'), label: 'agent time' },
      { value: compact(all.prompts), label: 'prompts' },
      all.prsMerged ? { value: compact(all.prsMerged), label: 'PRs merged' } : { value: compact(all.worktrees), label: 'worktrees' },
    ],
    [all],
  );
  const [faces, setFaces] = useState<Faces | undefined>(undefined);
  const key = `${you.name}|${you.picture ?? ''}|${title.id}|${figures.map((f) => f.value).join(',')}|${since}|${stats.hours.join('')}|${active}`;
  useEffect(() => {
    let alive = true;
    void loadPicture(you.picture).then((picture) => {
      if (!alive) return;
      const face = { name: you.name, title: title.name, color: title.color, personColor: personColor(you.id), figures, hours: stats.hours, year, since, serial: serialOf(you.id), active, ...(picture ? { picture } : {}) };
      setFaces({ front: drawFront(face), back: drawBack(face), strap: drawStrap(title.color) });
    });
    return () => {
      alive = false;
    };
    // Drawn again only when what's on it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // What the picture to share shows (drawn again only when it changes).
  const shareInput = useMemo<ShareInput | undefined>(
    () =>
      faces
        ? {
            front: faces.front,
            title: title.name,
            why: title.id === 'rookie' ? 'Just getting started' : title.why,
            color: title.color,
            since,
            figures: [
              { value: figures[0]!.value, label: 'with my agents' },
              { value: compact(all.prompts), label: 'prompts sent' },
              all.prsMerged ? { value: compact(all.prsMerged), label: 'pull requests merged' } : { value: compact(all.worktrees), label: 'worktrees made' },
              longest > 1 ? { value: `${longest} days`, label: 'longest streak' } : { value: active.toLocaleString(), label: 'active days' },
            ],
          }
        : undefined,
    [faces, title, since, figures, all, longest, active],
  );
  const layer = useLayer();
  return (
    <section ref={layer.ref} className={s.hero} aria-label="Your card">
      {/* Its place in the layout; the pass itself hangs in the layer below. */}
      <div className={s.lanyard} />
      <div className={s.layer} style={layer.style}>
        {faces && !recap ? <Suspense fallback={null}>{pass(faces, title.color, layer.size, { strapLength: layer.strapLength, passThrough: true, anchor: layer.anchor, wiggle: 1 })}</Suspense> : null}
      </div>
      <div className={s.words}>
        <span className={s.brand}>
          <Mark size={22} delay={0.3} />
          <span>Usage Pass {new Date(now).getFullYear()}</span>
          <span className={s.brandAside}>
            {since} · {active.toLocaleString()} active {active === 1 ? 'day' : 'days'}
          </span>
        </span>
        <h1 key={title.id} className={s.title}>
          {title.name}
        </h1>
        <p className={s.why}>
          <span className={s.whyMark} style={{ '--t': title.color } as React.CSSProperties}>
            <Icon name={title.icon} size={15} />
          </span>
          {title.id === 'rookie' ? 'Titles come as your stats grow: send prompts, ship pull requests, keep a streak.' : title.why}
        </p>
        {titles.length > 1 ? <TitleList titles={titles} worn={title.id} onWear={setWorn} /> : null}
        <div className={s.foot}>
          <Button size="small" variant="primary" icon="play" onClick={() => setRecap(true)}>
            Play Your Recap
          </Button>
          <Button size="small" variant="plain" icon="share" onClick={() => setSharing(true)} disabled={!faces}>
            Share…
          </Button>
        </div>
      </div>
      {recap ? <Recap state={state} stats={stats} now={now} title={title} pass={faces ? <Suspense fallback={null}>{pass(faces, title.color, 0.5, { passThrough: true, anchor: 0.69 })}</Suspense> : undefined} onShare={() => (setRecap(false), setSharing(true))} onClose={() => setRecap(false)} /> : null}
      {sharing && shareInput ? <ShareSheet input={shareInput} onClose={() => setSharing(false)} /> : null}
    </section>
  );
}
