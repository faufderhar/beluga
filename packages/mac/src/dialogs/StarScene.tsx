import { BELUGA } from '../components/beluga-path.js';
import s from './star-scene.module.css';

/**
 * The Star sheet's picture (SupportSheets.tsx): a paper-cut ocean, layers of blue stacked like cut
 * card, deepening toward the front, with the Beluga whale rising out from between them. Each layer
 * casts a soft paper shadow on the one behind; the front ones drift a few pixels and the whale rises
 * and settles, slowly. Everything holds still when less motion is asked for.
 */

const W = 440;
const H = 200;

/** One layer's edge: a gentle wave that rises toward the right, closed along the bottom. */
function layerPath(base: number, i: number): string {
  const pts: string[] = [];
  for (let x = -40; x <= W + 40; x += 10) {
    const y = base - (x - W / 2) * 0.2 + Math.sin(x / 58 + i * 1.3) * (7 + i * 0.9) + Math.sin(x / 23 + i * 2.6) * 2.4;
    pts.push(`${x} ${y.toFixed(1)}`);
  }
  return `M${pts.join(' L')} L${W + 40} ${H + 20} L-40 ${H + 20} Z`;
}

/** Back to front: where each layer's edge sits. The whale rises between BEHIND and the rest. */
const BASES = [24, 46, 68, 90, 112, 133, 152, 170, 188];
const BEHIND = 5;

export function StarScene() {
  const layer = (base: number, i: number) => (
    <g key={i} className={s.layer} data-depth={i}>
      <path d={layerPath(base, i)} className={s[`l${i}`]} filter="url(#paper)" />
    </g>
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={s.scene} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <filter id="paper" x="-10%" y="-30%" width="120%" height="160%">
          <feDropShadow dx="0" dy="-3" stdDeviation="3.5" style={{ floodColor: 'var(--paper-shadow)' }} />
        </filter>
        <filter id="lift" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="3" stdDeviation="4" style={{ floodColor: 'var(--paper-shadow)' }} />
        </filter>
      </defs>
      <rect width={W} height={H} className={s.sky} />
      {BASES.slice(0, BEHIND).map(layer)}
      <g className={s.rise}>
        <svg x="166" y="26" width="156" height="125" viewBox="56 147 912 730" overflow="visible" filter="url(#lift)">
          <path d={BELUGA} fillRule="evenodd" className={s.whale} />
        </svg>
      </g>
      {BASES.slice(BEHIND).map((base, k) => layer(base, k + BEHIND))}
    </svg>
  );
}

/** A filled five-pointed star (the Icon set's star is an outline). */
export function StarGlyph({ size = 15 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.6l1.98 4.02 4.44.64-3.21 3.13.76 4.42L8 11.72l-3.97 2.09.76-4.42L1.58 6.26l4.44-.64z" fill="currentColor" />
    </svg>
  );
}
