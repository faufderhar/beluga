import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EnvVar } from '@beluga/shared/env-vars.js';
import { findKeys, mayHoldKey, withKeyRefs } from '@beluga/shared/key-detect.js';
import { suggestName } from '@beluga/shared/key-shape.js';
import { cx } from '../components/ui.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { isShortcut, shortcutKeys } from '../lib/shortcuts.js';
import { ChatKeys, type KeyStore } from './ChatKeys.js';
import { KeyCard } from './KeyCard.js';
import { KeyMarks, type TextPick, useTextPick } from './KeyMarks.js';
import { knownKeyNames } from './key-refs.js';
import { type Offer, type OfferedKey, type KeyTarget, heldList, holdKeys, nameProblems, notKeyPrefixOf, pickedKey, placeOf, renameRef, rowsOf, setHeld, tidyName } from './key-paste-model.js';
import m from './mention.module.css';
import s from './key-paste.module.css';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** How long the pasted key takes to dissolve, and the chip to grow in where it was. */
const DISSOLVE_MS = 700;
const ENTER_MS = 1100;
/** The card's fold, with a fallback when transitions are off (reduced motion). */
const FOLD_MS = 460;
const NO_NAMES: readonly string[] = [];

/** The words as they were when a key was kept, for the moment its key dissolves where it was. */
interface Ghost {
  readonly id: number;
  readonly text: string;
  readonly values: readonly string[];
}

export interface KeyPaste {
  /** For the text field's paste (it doesn't stop the paste: the words land, then the card asks). */
  readonly onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  /** For the text field's keydown, first: ↩ keeps the keys, esc leaves them as text. True when handled. */
  readonly onKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /**
   * A card is asking, or a paste is still being looked at: Send keeps the keys first (or waits for
   * the look, then sends if there was nothing), so a key never goes by a quick ↩.
   */
  readonly asking: boolean;
  readonly keep: () => void;
  /** The card, for above the box. */
  readonly card: ReactNode;
  /** The pasted key dissolving, for over the box's words (inside its input's wrapper). */
  readonly ghost: ReactNode;
  /** The keys the card asks about, marked in the box, and Keep as Key over a picked word: behind the box's words, before its highlighter. */
  readonly marks: ReactNode;
  /** The Keys pill and its panel, for the box's bar. */
  readonly button: ReactNode;
  /** Names `$NAME` may mean here (drawn as chips), and those growing in now. */
  readonly names: readonly string[];
  readonly entering: readonly string[];
  /** This chat's own keys, for "@" (the box's suggestions put them first). */
  readonly chatKeys: readonly string[];
  /** A key's chip was put in the words (picked from "@"): it grows in too. */
  readonly pop: (name: string) => void;
}

/**
 * API keys pasted into the chat box (BLG-965): when what you paste holds one, a card above the box
 * says what it is and offers to keep it in Beluga as a variable. Kept, the key dissolves where it
 * was and a chip grows in its place (the words say `$NAME`); the card says so, then folds away.
 * ↩ keeps it (so a key never goes by accident), esc leaves it as text. The Keys pill lists them.
 */
export function useKeyPaste({ target, box, agent, text, setText, input, resend, inputClass }: { target: KeyTarget | undefined; box: string; agent: string; text: () => string; setText: (text: string) => void; input: React.RefObject<HTMLTextAreaElement | null>; resend: () => void; inputClass: string }): KeyPaste {
  const api = useApi();
  const { client } = useBeluga();
  const [offer, setOffer] = useState<Offer>();
  const [folding, setFolding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ghost, setGhost] = useState<Ghost>();
  const [entering, setEntering] = useState<readonly string[]>(NO_NAMES);
  const [panelOpen, setPanelOpen] = useState(false);
  const [held, setHeldRows] = useState<readonly EnvVar[]>(() => heldList(box));
  const asked = useRef(0);
  // A paste still being looked at, and whether Send was pressed meanwhile (it goes once the look found nothing).
  const [checking, setChecking] = useState(false);
  const sendAfter = useRef(false);
  const resendRef = useRef(resend);
  resendRef.current = resend;
  const ghostIds = useRef(0);

  // Another chat, another box: a card asking about this one's paste goes; the keys held are that box's.
  useEffect(() => {
    setOffer(undefined);
    setFolding(false);
    setHeldRows(heldList(box));
  }, [box]);
  // Send was pressed while the paste was looked at, and it held no key: it goes now (after this render, with the box as it is).
  useEffect(() => {
    if (checking || (offer && !offer.done) || !sendAfter.current) return;
    sendAfter.current = false;
    resendRef.current();
  }, [checking, offer]);
  useEffect(() => {
    if (!ghost) return;
    const timer = setTimeout(() => setGhost((g) => (g?.id === ghost.id ? undefined : g)), DISSOLVE_MS);
    return () => clearTimeout(timer);
  }, [ghost]);
  useEffect(() => {
    if (!entering.length) return;
    const timer = setTimeout(() => setEntering(NO_NAMES), ENTER_MS);
    return () => clearTimeout(timer);
  }, [entering]);

  // The names `$NAME` may mean here: the chat's own, its project's and yours, and keys a new worktree's page holds.
  const wsId = target?.kind === 'chat' ? target.workspaceId : undefined;
  const projectId = target && (target.kind === 'draft' || target.kind === 'project') ? target.projectId : undefined;
  const knownJoined = useApp((st) => {
    const project = wsId ? st.projects.find((p) => p.workspaces.some((w) => w.id === wsId)) : st.projects.find((p) => p.id === projectId);
    return knownKeyNames(st.envKeys, wsId, project?.root).join(' ');
  });
  const ownJoined = useApp((st) => (wsId ? (st.envKeys.worktrees?.[wsId] ?? []).join(' ') : ''));
  const heldNames = held.map((r) => r.key).join(' ');
  const names = useMemo(() => [...new Set([...knownJoined.split(' '), ...heldNames.split(' ')].filter(Boolean))], [knownJoined, heldNames]);
  const chatKeys = useMemo(() => [...new Set([...ownJoined.split(' '), ...heldNames.split(' ')].filter(Boolean))], [ownJoined, heldNames]);

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    // A friend's worktree (no target): their agent runs there, and Beluga can't keep a key on their computer.
    const pasted = e.clipboardData.getData('text/plain');
    if (!target || !mayHoldKey(pasted)) return;
    const ask = ++asked.current;
    sendAfter.current = false;
    setChecking(true);
    const settle = (keys: readonly OfferedKey[]): void => {
      if (ask !== asked.current) return;
      setChecking(false);
      // Only what's still in the box (a paste undone before the answer came isn't asked about).
      const here = keys.filter((k) => text().includes(k.value));
      if (here.length) {
        sendAfter.current = false;
        setFolding(false);
        setOffer({ keys: here.map((k) => ({ ...k })), target });
      }
    };
    // The daemon names them the project's way; if it can't answer, this Mac still knows the formats (never fails open).
    api.env.pastedKeys(placeOf(target), pasted).then(settle, () => settle(findKeys(pasted)));
  };

  const close = (): void => {
    asked.current++;
    setChecking(false);
    sendAfter.current = false;
    setOffer(undefined);
    input.current?.focus();
  };

  const keep = (): void => {
    // Still looking at the paste: Send waits for it (and goes on its own if there was no key).
    if (checking && !offer) {
      sendAfter.current = true;
      return;
    }
    if (!offer || offer.done || offer.dismissed || saving || nameProblems(offer.keys).size) return;
    // A key taken out of the box since the card asked isn't kept.
    const before = text();
    const keys = offer.keys.filter((k) => before.includes(k.value));
    if (!keys.length) return close();
    const rows = rowsOf(keys);
    const swap = (): void => {
      // The words as they were stay a moment over the box, only their keys showing, and dissolve
      // while each key's chip grows in where it starts. The box keeps its height meanwhile (a key
      // that wrapped dissolves whole), then eases to the shorter words.
      holdHeight(input.current, DISSOLVE_MS - 120);
      setGhost({ id: ++ghostIds.current, text: before, values: keys.map((k) => k.value) });
      setEntering(keys.map((k) => k.name));
      setText(withKeyRefs(text(), keys));
      setOffer({ ...offer, keys, done: true });
      input.current?.focus();
    };
    if (!rows.length) return swap();
    if (offer.target.kind === 'draft') {
      holdKeys(box, rows);
      setHeldRows(heldList(box));
      return swap();
    }
    setSaving(true);
    const where = offer.target.kind === 'chat' ? { workspaceId: offer.target.workspaceId } : offer.target.kind === 'project' ? { projectId: offer.target.projectId } : {};
    api.env
      .keepPasted(where, rows)
      .then(
        (r) => {
          swap();
          if (r?.example) toast(client, `Listed ${rows.map((k) => k.key).join(', ')} in ${r.example} (no value), so it ships with this work`, 'info');
        },
        (err: unknown) => toast(client, `Couldn’t keep the key: ${errorText(err)}`, 'error'),
      )
      .finally(() => setSaving(false));
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (pick && isShortcut('composer-keep-key', e)) {
      e.preventDefault();
      pickKey(pick);
      return true;
    }
    if (!offer || offer.done || offer.dismissed) return false;
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      keep();
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return true;
    }
    return false;
  };

  const rename = (i: number, name: string): void => setOffer((o) => (o ? { ...o, keys: o.keys.map((k, j) => (j === i ? { ...k, name: tidyName(name) } : k)) } : o));

  // The panel's keys: this chat's own variables, or what a new worktree's page holds.
  const marks = useMemo(() => marksOf(offer), [offer]);
  // A word picked in the box (no card asking): Keep as Key over it.
  const asking = Boolean(offer && !offer.done && !offer.dismissed);
  const pick = useTextPick(input, !target || asking || checking);

  const pickKey = (p: TextPick): void => {
    if (!target) return;
    const ask = ++asked.current;
    const open = (key: OfferedKey): void => {
      if (ask !== asked.current || !text().includes(key.value)) return;
      setFolding(false);
      setOffer({ keys: [key], target });
      // The pick is the card's now: the box's selection goes, so the pill does too.
      input.current?.setSelectionRange(p.end, p.end);
    };
    const fallback = (): void => open(pickedKey(p.value, suggestName(p.value, names)));
    // Something Beluga knows (a provider's key, one like yours): its name. Anything else: named after its prefix.
    api.env.pastedKeys(placeOf(target), p.value).then((found) => {
      const same = found.find((k) => k.value === p.value);
      return same ? open({ ...same, ...(same.why === 'maybe' ? { why: 'picked' as const } : {}) }) : fallback();
    }, fallback);
  };

  const notKey = (rows: readonly number[]): void => {
    if (!offer) return;
    const off = offer.keys.filter((_, i) => rows.includes(i));
    const prefixes = [...new Set(off.flatMap((k) => notKeyPrefixOf(k.value) ?? []))];
    for (const p of prefixes) api.env.notAKey(p, true).catch((err: unknown) => toast(client, `Couldn’t remember that: ${errorText(err)}`, 'error'));
    const keys = offer.keys.filter((_, i) => !rows.includes(i));
    setOffer(keys.length ? { ...offer, keys } : { ...offer, keys, dismissed: { prefixes, keys: off } });
    if (!keys.length) input.current?.focus();
  };

  const undo = (): void => {
    const was = offer?.dismissed;
    if (!offer || !was) return;
    for (const p of was.prefixes) api.env.notAKey(p, false).catch((err: unknown) => toast(client, `Couldn’t undo: ${errorText(err)}`, 'error'));
    const keys = was.keys.filter((k) => text().includes(k.value));
    if (!keys.length) return setFolding(true);
    setOffer({ keys, target: offer.target });
  };

  const store = useMemo<KeyStore | undefined>(() => {
    if (wsId) return { load: () => api.env.worktree(wsId).then((w) => w.vars), save: (rows) => api.env.setWorktree(wsId, [...rows]).then(() => undefined) };
    if (target?.kind === 'draft')
      return {
        load: () => Promise.resolve(heldList(box)),
        save: (rows) => {
          setHeld(box, rows);
          setHeldRows(heldList(box));
          return Promise.resolve();
        },
      };
    return undefined;
  }, [wsId, target?.kind, box]);

  const card = offer ? (
    <Fold
      folding={folding}
      onGone={() => {
        setOffer(undefined);
        setFolding(false);
      }}
    >
      <KeyCard
        offer={offer}
        agent={agent}
        saving={saving}
        onRename={rename}
        onKeep={keep}
        onClose={close}
        onFold={() => setFolding(true)}
        onNotKey={notKey}
        onUndo={undo}
        onSeeKeys={store && chatKeys.length ? () => setPanelOpen(true) : undefined}
      />
    </Fold>
  ) : null;

  return {
    onPaste,
    onKey,
    asking: checking || asking,
    keep,
    card,
    ghost: ghost ? <KeyGhost key={ghost.id} ghost={ghost} input={input} className={inputClass} /> : null,
    marks: target ? <KeyMarks text={text()} marks={marks} fading={Boolean(offer?.dismissed)} pick={pick} input={input} className={inputClass} keys={shortcutKeys('composer-keep-key')} onPick={pickKey} /> : null,
    button:
      target && store ? (
        <ChatKeys
          target={target}
          names={chatKeys}
          store={store}
          open={panelOpen}
          onOpen={setPanelOpen}
          agent={agent}
          onInsert={(name) => {
            const now = text();
            setText(`${now}${now && !/\s$/.test(now) ? ' ' : ''}$${name} `);
            setEntering([name]);
            input.current?.focus();
          }}
          onRenamed={(from, to) => {
            setText(renameRef(text(), from, to));
            setEntering([to]);
          }}
        />
      ) : null,
    names,
    entering,
    chatKeys,
    pop: (name) => setEntering([name]),
  };
}

/** Keep a text field at least as tall as now for `ms`, then ease it to its own height. */
function holdHeight(el: HTMLTextAreaElement | null, ms: number): void {
  if (!el) return;
  const now = el.offsetHeight;
  el.style.minHeight = `${now}px`;
  setTimeout(() => {
    el.style.minHeight = '';
    const to = el.offsetHeight;
    if (to < now) el.animate([{ minHeight: `${now}px` }, { minHeight: `${to}px` }], { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
  }, ms);
}

/**
 * The card's way in and out: it grows to the size of what it shows (asking, then the shorter kept
 * line, smoothly), and folds away to nothing instead of vanishing, so the chat above never jumps.
 */
function Fold({ folding, onGone, children }: { folding: boolean; onGone: () => void; children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const last = useRef<number | undefined>(undefined);
  const gone = useRef(onGone);
  gone.current = onGone;
  // Its height follows what it shows, eased (the asking card to the kept line).
  useLayoutEffect(() => {
    const el = inner.current;
    const wrap = outer.current;
    if (!el || !wrap) return;
    const observer = new ResizeObserver(() => {
      const now = el.offsetHeight;
      const before = last.current;
      last.current = now;
      if (before === undefined || before === now || folding) return;
      wrap.animate([{ height: `${before}px` }, { height: `${now}px` }], { duration: 380, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [folding]);
  useEffect(() => {
    if (!folding) return;
    const timer = setTimeout(() => gone.current(), FOLD_MS + 120);
    return () => clearTimeout(timer);
  }, [folding]);
  return (
    <div ref={outer} className={cx(s.fold, folding && s.folding)} onTransitionEnd={(e) => (folding && e.target === outer.current && e.propertyName === 'grid-template-rows' ? gone.current() : undefined)}>
      <div className={s.foldInner}>
        {/* Measured here: its own height, never the fold's (which it would follow while folding). */}
        <div ref={inner}>{children}</div>
      </div>
    </div>
  );
}

/**
 * The words as they were, over the box, laid out as the box lays them out: only the keys show, and
 * they blur, draw together and fade, where the chip now grows in.
 */
function KeyGhost({ ghost, input, className }: { ghost: Ghost; input: React.RefObject<HTMLTextAreaElement | null>; className: string }) {
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (layer.current && input.current) layer.current.scrollTop = input.current.scrollTop;
  }, [input]);
  const pieces = useMemo(() => {
    const out: Array<{ text: string; key: boolean }> = [];
    let rest = ghost.text;
    while (rest) {
      const hits = ghost.values.map((v) => ({ v, at: rest.indexOf(v) })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at);
      const hit = hits[0];
      if (!hit) {
        out.push({ text: rest, key: false });
        break;
      }
      if (hit.at) out.push({ text: rest.slice(0, hit.at), key: false });
      out.push({ text: hit.v, key: true });
      rest = rest.slice(hit.at + hit.v.length);
    }
    return out;
  }, [ghost]);
  return (
    <div ref={layer} className={`${className} ${m.highlighter} ${s.ghost}`} aria-hidden="true" data-key-ghost>
      {pieces.map((p, i) => (p.key ? <span key={i} className={s.dissolving}>{p.text}</span> : <span key={i}>{p.text}</span>))}
      {'​'}
    </div>
  );
}

const NO_MARKS: readonly { value: string; soft: boolean }[] = [];
/** What the card asks about, for marking in the box: while it asks, and while "Got it" fades them. */
function marksOf(offer: Offer | undefined): readonly { value: string; soft: boolean }[] {
  if (!offer || offer.done) return NO_MARKS;
  const keys = offer.dismissed ? offer.dismissed.keys : offer.keys;
  return keys.map((k) => ({ value: k.value, soft: k.why === 'maybe' }));
}
