// The card above the chat box that asks about a key (BLG-965, BLG-977): sure, maybe, or picked by
// you. Kept, it says so in one line and folds; Not a Key, it says it won't ask again, with Undo.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { maskKey } from '@beluga/shared/key-detect.js';
import { Icon } from '../components/Icon.js';
import { Button, Kbd, Tip, cx } from '../components/ui.js';
import { type Offer, type OfferedKey, keepLabel, kindOf, nameProblems, scopeLine, scopeShort, subOf, titleOf } from './key-paste-model.js';
import s from './key-paste.module.css';

/** How long "Kept safe" stays (a pointer on it holds it) before the card folds away. */
const DONE_MS = 3600;
/** "Won't ask again" stays longer: there's an Undo on it. */
const DISMISSED_MS = 5200;
/** After the pointer leaves an ended card, the moment before it folds. */
const LINGER_MS = 1400;
/** A row taken off the card (Not a Key) folds this long before it goes. */
export const ROW_OUT_MS = 280;

export interface KeyCardProps {
  readonly offer: Offer;
  readonly agent: string;
  readonly saving: boolean;
  readonly onRename: (i: number, name: string) => void;
  readonly onKeep: () => void;
  readonly onClose: () => void;
  readonly onFold: () => void;
  /** Not a Key on these rows (only maybe keys). */
  readonly onNotKey: (rows: readonly number[]) => void;
  readonly onUndo: () => void;
  readonly onSeeKeys: (() => void) | undefined;
}

export function KeyCard(props: KeyCardProps) {
  const { offer } = props;
  if (offer.done || offer.dismissed) return <Ended {...props} />;
  return <Asking {...props} />;
}

/** Kept, or Not a Key: one line that settles in, stays a while (longer under the pointer), then folds. */
function Ended({ offer, agent, onFold, onUndo, onSeeKeys }: KeyCardProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wait = (ms: number): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(onFold, ms);
  };
  const dismissed = offer.dismissed && !offer.done ? offer.dismissed : undefined;
  useEffect(() => {
    wait(dismissed ? DISMISSED_MS : DONE_MS);
    return () => clearTimeout(timer.current);
  }, [offer.done, dismissed]);
  const hold = { onMouseEnter: () => clearTimeout(timer.current), onMouseLeave: () => wait(LINGER_MS) };
  if (dismissed) {
    return (
      <section className={cx(s.card, s.done, s.dismissed)} role="status" aria-live="polite" data-key-card="dismissed" {...hold}>
        <span className={cx(s.doneMark, s.dismissMark)} aria-hidden="true">
          <Icon name="key" size={11} />
        </span>
        <span className={s.doneText}>
          Got it.{' '}
          {dismissed.prefixes.map((p) => (
            <code key={p} className={s.prefix}>
              {p}…
            </code>
          ))}
          <span className={s.doneHint}> {dismissed.prefixes.length > 1 ? 'aren’t keys' : 'isn’t a key'}. Won’t ask again.</span>
        </span>
        <button type="button" className={s.seeKeys} onClick={onUndo} data-key-undo>
          Undo
        </button>
      </section>
    );
  }
  const yours = offer.keys.every((k) => k.why === 'yours');
  return (
    <section className={cx(s.card, s.done)} role="status" aria-live="polite" data-key-card="done" {...hold}>
      <span className={s.doneMark}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path className={s.tick} d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className={s.doneText}>
        {yours ? 'Using ' : 'Kept safe. '}
        {offer.keys.map((k, i) => (
          <span key={k.name}>
            {i ? ' ' : ''}
            <span className={s.ref}>
              <Icon name="key" size={10} />
              {k.name}
            </span>
          </span>
        ))}
        <span className={s.doneHint}> goes to {agent}, never the key.</span>
      </span>
      {onSeeKeys ? (
        <button type="button" className={s.seeKeys} onClick={onSeeKeys}>
          See Keys
        </button>
      ) : null}
    </section>
  );
}

/** The question: each key, sealed, with the name it'll go by. */
function Asking({ offer, agent, saving, onRename, onKeep, onClose, onNotKey }: KeyCardProps) {
  const problems = nameProblems(offer.keys);
  const n = offer.keys.length;
  const maybe = offer.keys.every((k) => k.why === 'maybe');
  const picked = offer.keys.every((k) => k.why === 'picked');
  const [leaving, setLeaving] = useState<readonly number[]>([]);
  const notKey = (rows: readonly number[]): void => {
    if (leaving.length) return;
    // Every key on the card: the card itself turns into "Got it" (no row to fold first).
    if (rows.length === n) return onNotKey(rows);
    setLeaving(rows);
    setTimeout(() => {
      setLeaving([]);
      onNotKey(rows);
    }, ROW_OUT_MS);
  };
  return (
    <section className={cx(s.card, maybe && s.soft)} role="dialog" aria-label="Keep the key out of the chat" data-key-card="ask" data-kind={maybe ? 'maybe' : picked ? 'picked' : 'sure'}>
      <header className={s.head}>
        <Badge maybe={maybe} />
        <div className={s.titles}>
          <div className={s.title}>{titleOf(offer.keys)}</div>
          <div className={s.sub}>{subOf(offer.keys, agent)}</div>
        </div>
        <Tip label="Leave it as text" keys="esc">
          <button type="button" className={s.close} aria-label="Leave it as text" onClick={onClose}>
            <Icon name="x" size={12} />
          </button>
        </Tip>
      </header>
      <ul className={s.keys}>
        {offer.keys.map((k, i) => (
          <Row key={k.value} k={k} i={i} problem={problems.get(i)} leaving={leaving.includes(i)} focus={picked && i === 0} onRename={onRename} onKeep={onKeep} onClose={onClose} onNotKey={!maybe && k.why === 'maybe' ? () => notKey([i]) : undefined} />
        ))}
      </ul>
      <footer className={s.foot}>
        {offer.keys.every((k) => k.why === 'yours') ? (
          <span className={s.scope}>
            <Icon name="lock" size={11} />
            Nothing new is saved
          </span>
        ) : (
          <Tip label={scopeLine(offer.target, agent, n)} side="top">
            <span className={s.scope} tabIndex={0}>
              <Icon name="lock" size={11} />
              {scopeShort(offer.target)}
            </span>
          </Tip>
        )}
        <span className={s.buttons}>
          {maybe ? (
            <Button size="small" variant="quiet" onClick={() => notKey(offer.keys.map((_, i) => i))} data-key-not>
              {n === 1 ? 'Not a Key' : 'Not Keys'}
            </Button>
          ) : (
            <Button size="small" variant="quiet" onClick={onClose}>
              Leave as Text
            </Button>
          )}
          <Button size="small" variant="primary" icon="lock" disabled={saving || problems.size > 0} onClick={onKeep} data-key-keep>
            {keepLabel(offer.keys)}
            <Kbd>↩</Kbd>
          </Button>
        </span>
      </footer>
    </section>
  );
}

/** The card's mark: a key; asking softly, a dashed ring turns slowly around it, still wondering. */
function Badge({ maybe }: { maybe: boolean }) {
  return (
    <span className={cx(s.badge, maybe && s.badgeSoft)} aria-hidden="true">
      {maybe ? (
        <svg className={s.ring} viewBox="0 0 28 28" width="28" height="28">
          <rect x="1" y="1" width="26" height="26" rx="8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="3 4" pathLength={84} />
        </svg>
      ) : null}
      <Icon name="key" size={14} />
    </span>
  );
}

interface RowProps {
  readonly k: OfferedKey;
  readonly i: number;
  readonly problem: string | undefined;
  readonly leaving: boolean;
  readonly focus: boolean;
  readonly onRename: (i: number, name: string) => void;
  readonly onKeep: () => void;
  readonly onClose: () => void;
  readonly onNotKey: (() => void) | undefined;
}

/** One key: what it is, the key sealed, an arrow, and the name it'll go by. Rows come in one after another. */
function Row({ k, i, problem, leaving, focus, onRename, onKeep, onClose, onNotKey }: RowProps) {
  const input = useRef<HTMLInputElement>(null);
  // A word you picked: its name is what you'd change, so it's ready to type over.
  useLayoutEffect(() => {
    if (!focus || !input.current) return;
    input.current.focus();
    input.current.select();
  }, [focus]);
  const note = problem ? (
    <span className={s.problem}>{problem}</span>
  ) : k.why === 'like-yours' && k.fromPlace ? (
    <span className={s.note}>
      Like your {k.from} in {k.fromPlace}
    </span>
  ) : k.why === 'like-yours' ? (
    <span className={s.note}>Like your {k.from}</span>
  ) : k.replaces ? (
    <span className={s.note}>Over the project’s, here</span>
  ) : null;
  return (
    <li className={cx(s.key, leaving && s.keyOut)} style={{ '--i': i } as React.CSSProperties}>
      <span className={cx(s.product, k.why === 'maybe' && s.productSoft)}>{kindOf(k)}</span>
      <Sealed value={k.value} />
      <Icon name="arrowRight" size={12} className={s.arrow} />
      <label className={cx(s.name, problem && s.bad)}>
        <Icon name="key" size={10} />
        <input ref={input} value={k.name} readOnly={k.why === 'yours'} spellCheck={false} aria-label={`Variable name for ${k.what}`} onChange={(e) => onRename(i, e.target.value)} onKeyDown={(e) => (e.key === 'Enter' ? (e.preventDefault(), onKeep()) : e.key === 'Escape' ? (e.preventDefault(), onClose()) : undefined)} />
      </label>
      {note}
      {onNotKey ? (
        <Tip label="Not a key: don’t ask about these again">
          <button type="button" className={s.rowNot} aria-label="Not a key" onClick={onNotKey}>
            <Icon name="x" size={10} />
          </button>
        </Tip>
      ) : null}
    </li>
  );
}

/** The key, hidden: its kind, then the dots seal over it one by one, then its last four. */
function Sealed({ value }: { value: string }) {
  const masked = maskKey(value);
  const at = masked.indexOf('••••');
  if (at < 0) {
    return (
      <code className={s.masked} title="The key, hidden">
        {masked}
      </code>
    );
  }
  return (
    <code className={s.masked} title="The key, hidden" aria-label={masked}>
      <span className={s.sealEnd}>{masked.slice(0, at)}</span>
      {[0, 1, 2, 3].map((d) => (
        <span key={d} className={s.seal} style={{ '--d': d } as React.CSSProperties}>
          •
        </span>
      ))}
      <span className={s.sealEnd}>{masked.slice(at + 4)}</span>
    </code>
  );
}
