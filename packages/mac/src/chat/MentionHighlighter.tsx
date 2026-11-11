import { type RefObject, useEffect, useMemo, useRef } from "react";
import { splitWorktreeRefs } from "@beluga/shared/worktree-refs.js";
import { useApp } from "../lib/beluga.js";
import { ImageChip } from "./ImageChip.js";
import { IMAGE_REF, refOf } from "./image-refs.js";
import {
  type MentionPiece,
  type MentionWorld,
  splitMentions,
} from "./mentions.js";
import m from "./mention.module.css";
import type { ChipSpan } from "./chip-caret.js";
import { useChipCaret } from "./use-chip-caret.js";
import { boxedWorktrees, plainWorktrees, type WorktreeNames, worktreeNamesOf } from "./worktree-box.js";

function withImages(piece: MentionPiece): MentionPiece[] {
  if ("ref" in piece) return [piece];
  const out: MentionPiece[] = [];
  let last = 0;
  for (const m of piece.text.matchAll(IMAGE_REF)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: piece.text.slice(last, at) });
    // "[2 …142525-fpxw]": the pasted image it points at, a chip with the end of its name.
    const { n, name } = refOf(m);
    out.push({ raw: m[0], ref: { kind: "image", label: name ?? `image ${n}` } });
    last = at + m[0].length;
  }
  if (last < piece.text.length) out.push({ text: piece.text.slice(last) });
  return out;
}

/**
 * A pasted worktree link to one of yours (BLG-878): a chip with its name, as an image's. Written
 * short in the box ("[\u2007name]", worktree-box.ts), or bare ("worktree:wt-…") from before.
 */
function withWorktrees(piece: MentionPiece, names: WorktreeNames): MentionPiece[] {
  if ("ref" in piece || !names.size) return [piece];
  const out: MentionPiece[] = [];
  let last = 0;
  for (const w of boxedWorktrees(piece.text, names)) {
    if (w.start > last) out.push({ text: piece.text.slice(last, w.start) });
    out.push({ raw: piece.text.slice(w.start, w.end), ref: { kind: "worktree", label: names.get(w.id)!, id: w.id } });
    last = w.end;
  }
  if (last < piece.text.length) out.push({ text: piece.text.slice(last) });
  return out.flatMap((p): MentionPiece[] =>
    "ref" in p
      ? [p]
      : splitWorktreeRefs(p.text, (id) => names.has(id)).map((q) =>
          "id" in q ? { raw: q.raw, ref: { kind: "worktree" as const, label: names.get(q.id)!, id: q.id } } : q,
        ),
  );
}

/** Each worktree's name by id, as one string (so the box draws again only when one changes). */
const namesOf = new WeakMap<object, string>();
function worktreeNames(projects: Parameters<typeof worktreeNamesOf>[0]): string {
  let names = namesOf.get(projects);
  if (names === undefined) namesOf.set(projects, (names = JSON.stringify([...worktreeNamesOf(projects)])));
  return names;
}

/** A bare "worktree:wt-…" takes more room than its name: its chip starts at the start of that room. */
const isBare = (p: MentionPiece): boolean => "ref" in p && p.raw.startsWith("worktree:");

/** Copied or cut from the box, a worktree's short link goes on the clipboard whole ("worktree:wt-…"). */
function useWholeLinksOnCopy(input: RefObject<HTMLTextAreaElement | null>, known: string): void {
  useEffect(() => {
    const el = input.current;
    if (!el || known === "[]") return;
    const names = new Map(JSON.parse(known) as [string, string][]);
    const onCopy = (e: ClipboardEvent): void => {
      const picked = el.value.slice(el.selectionStart, el.selectionEnd);
      const whole = plainWorktrees(picked, names);
      if (whole === picked || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", whole);
      if (e.type === "cut") document.execCommand("delete");
    };
    el.addEventListener("copy", onCopy);
    el.addEventListener("cut", onCopy);
    return () => {
      el.removeEventListener("copy", onCopy);
      el.removeEventListener("cut", onCopy);
    };
  }, [input, known]);
}

/** Drawn as a chip over the room its words take (the box's own words go see-through). */
const isChip = (p: MentionPiece): boolean => "ref" in p && (p.ref.kind === "image" || p.ref.kind === "worktree");

/** Where each chip's words are in the text (the pieces, laid end to end, are the text). */
function chipSpans(pieces: readonly MentionPiece[]): { all: ChipSpan[]; worktrees: ChipSpan[] } {
  const all: ChipSpan[] = [];
  const worktrees: ChipSpan[] = [];
  let at = 0;
  for (const p of pieces) {
    const length = "ref" in p ? p.raw.length : p.text.length;
    if (isChip(p)) {
      const span = { start: at, end: at + length };
      all.push(span);
      if ("ref" in p && p.ref.kind === "worktree") worktrees.push(span);
    }
    at += length;
  }
  return { all, worktrees };
}

/**
 * Behind the message box: the same text, invisible, with every mention that names someone or
 * something marked, so "@mia" or "@src/auth.ts" shows as a pill while you type. It follows the
 * box's scrolling; the box itself stays a plain text field (typing, selection, undo as usual).
 *
 * An image's reference is drawn as a chip (an icon and the end of its file name) over the room
 * its words take, and so is a pasted worktree link (its branch icon and name): while there is one, the words show from here and the box's own go see-through
 * (its caret and selection stay). The words under a chip are one piece: the caret steps over them
 * and Backspace takes them whole (use-chip-caret.ts).
 */
/** A box with no mentions to mark (only its images). */
const NO_MENTIONS: MentionWorld = {
  friends: [],
  peers: [],
  projects: [],
  workspaces: [],
};

export function MentionHighlighter({
  text,
  world = NO_MENTIONS,
  input,
  className,
}: {
  text: string;
  world?: MentionWorld;
  input: RefObject<HTMLTextAreaElement | null>;
  className: string;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const known = useApp((st) => (text.includes("worktree:") || text.includes("\u2007") ? worktreeNames(st.projects) : "[]"));
  const pieces = useMemo(() => {
    const names = new Map(JSON.parse(known) as [string, string][]);
    return splitMentions(text, world)
      .flatMap(withImages)
      .flatMap((p) => withWorktrees(p, names));
  }, [text, world, known]);
  const chips = pieces.some(isChip);
  const spans = useMemo(() => chipSpans(pieces), [pieces]);
  useChipCaret(input, text, spans.all, spans.worktrees);
  useWholeLinksOnCopy(input, known);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.classList.toggle(m.inkBehind!, chips);
    return () => el.classList.remove(m.inkBehind!);
  }, [input, chips]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const follow = (): void => {
      if (layer.current) layer.current.scrollTop = el.scrollTop;
    };
    follow();
    el.addEventListener("scroll", follow);
    return () => el.removeEventListener("scroll", follow);
  }, [input, text]);
  if (!pieces.some((p) => "ref" in p)) return null;
  return (
    <div
      ref={layer}
      className={`${className} ${m.highlighter}`}
      aria-hidden="true"
      data-testid="mention-highlighter"
      data-ink={chips || undefined}
    >
      {pieces.map((p, i) =>
        "ref" in p && isChip(p) ? (
          <mark key={i} className={m.imageChip} data-mention={p.raw} data-kind={p.ref.kind}>
            <span className={m.chipRoom}>{p.raw}</span>
            <ImageChip className={isBare(p) ? `${m.chipFace} ${m.chipHug}` : p.ref.kind === "worktree" ? `${m.chipFace} ${m.chipSnug}` : m.chipFace} label={p.ref.label} icon={p.ref.kind === "worktree" ? "branch" : "image"} />
          </mark>
        ) : "ref" in p ? (
          <mark
            key={i}
            className={m.mark}
            data-kind={p.ref.kind}
            data-mention={p.raw}
          >
            {p.raw}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
      {/* A last line that ends in a newline still takes its height. */}
      {"​"}
    </div>
  );
}
