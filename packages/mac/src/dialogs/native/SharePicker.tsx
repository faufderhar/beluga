import { useEffect, useState } from 'react';
import { type ShareLevel, levelsFor } from '@beluga/shared/share-levels.js';
import { Checkbox } from '../../components/Alert.js';
import { Avatar, Button } from '../../components/ui.js';
import { Select } from '../settings-controls.js';
import s from './sharing.module.css';

/** A friend you could share with: why not yet, when their Beluga can't take it. */
export interface ShareCandidate {
  readonly peerId: string;
  readonly name: string;
  readonly why?: string;
  /** Under their name in the list: where they are ("In your room", "Friend · offline: it waits for them"). */
  readonly detail?: string;
}

export type Access = ShareLevel | 'none';

/**
 * What someone you share with can do, as a row's pop-up offers it (BLG-1019): see, chat, fork, fork
 * with secrets (`forks`: where there's a project to fork and they're a friend over the network), or remove them.
 */
export const accessOptions = (forks: boolean): ReadonlyArray<{ value: Access; label: string; description?: string }> => [...levelsFor(forks), { value: 'none', label: 'Remove access' }];

/** What the add row offers: see, chat, fork, fork with secrets, or (a worktree, BLG-967) take it over on their own computer. */
type Level = ShareLevel | 'takeover';

const TAKE_OVER = { value: 'takeover' as const, label: 'Can take it over', description: 'Their agent continues on their computer' };

/** Asking their Beluga whether it could take this worktree: still asking, yes, or why not (BLG-614). */
type Check = 'checking' | { readonly ok: boolean; readonly why?: string };

/** Share's "take it over" (what Hand off was): who may, and whether their Mac has the repository. */
export interface TakeOver {
  readonly candidates: readonly ShareCandidate[];
  readonly check: (peerId: string) => Promise<{ ok: boolean; why?: string }>;
  readonly onTakeOver: (peerId: string) => void;
}

interface SharePickerProps {
  readonly candidates: readonly ShareCandidate[];
  /** `note`: also have your agent write a handoff note for them. */
  readonly onShare: (peerId: string, level: ShareLevel, note: boolean) => void;
  /** Offer "Can fork" and "Can fork with secrets" (a worktree or a project with a folder). */
  readonly forks?: boolean;
  readonly none: string;
  /** A worktree can also be taken over; left out for a chat or a whole project. */
  readonly takeOver?: TakeOver;
  /** Open on "Can take it over" (from /handoff, or the palette). */
  readonly startTakingOver?: boolean;
  /** Offer "Write a handoff note" (a workspace's sheet, not a project's). */
  readonly canNote?: boolean;
}

/**
 * The share sheets' add row (BLG-623): pick one of your friends who doesn't have it yet, pick what
 * they can do, Share. For a worktree, "Can take it over" hands it to them instead (BLG-967), and a
 * handoff note can come with any of them. Who already has it is listed under it, each with their level.
 */
export function SharePicker({ candidates, onShare, none, takeOver, startTakingOver, canNote, forks = false }: SharePickerProps) {
  const LEVELS: ReadonlyArray<{ value: Level; label: string; description: string }> = levelsFor(forks);
  const [who, setWho] = useState('');
  const [level, setLevel] = useState<Level>(startTakingOver && takeOver ? 'takeover' : 'contribute');
  const [note, setNote] = useState(false);
  const [checks, setChecks] = useState<Readonly<Record<string, Check>>>({});
  const taking = level === 'takeover' && Boolean(takeOver);
  const list = taking ? (takeOver?.candidates ?? []) : candidates;
  const picked = list.find((c) => c.peerId === who);
  const check = picked && taking ? checks[picked.peerId] : undefined;
  useEffect(() => {
    if (!taking || !picked || picked.why || checks[picked.peerId] || !takeOver) return;
    let live = true;
    const peerId = picked.peerId;
    setChecks((c) => ({ ...c, [peerId]: 'checking' }));
    void takeOver
      .check(peerId)
      .then((r) => r, () => ({ ok: true }))
      .then((r) => live && setChecks((c) => ({ ...c, [peerId]: r })));
    return () => {
      live = false;
    };
    // Asked once per person while the sheet is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taking, picked?.peerId]);
  if (!list.length && !candidates.length) return <div className={s.addNone}>{none}</div>;
  const why = picked?.why ?? (check && check !== 'checking' && !check.ok ? (check.why ?? `${picked?.name ?? 'They'} can’t take it`) : undefined);
  const blocked = !picked || Boolean(why) || check === 'checking';
  const go = (): void => {
    if (!picked || blocked) return;
    if (taking) takeOver?.onTakeOver(picked.peerId);
    else onShare(picked.peerId, level as ShareLevel, canNote === true && note);
    setWho('');
  };
  const say = why ?? (check === 'checking' ? `Checking ${picked?.name} has this repository…` : taking && picked ? `${picked.name} gets the latest branch, this chat and the note in a worktree on their computer. You can follow along.` : undefined);
  return (
    <div className={s.addWrap}>
      <div className={s.add}>
        <Select
          label="Friend to share with"
          placeholder="Choose a friend…"
          value={picked ? picked.peerId : ''}
          width="full"
          options={list.map((c) => ({ value: c.peerId, label: c.name, icon: <Avatar name={c.name} id={c.peerId} size={16} />, ...(c.why ? { description: 'Needs a newer Beluga' } : c.detail ? { description: c.detail } : {}) }))}
          onChange={setWho}
        />
        <Select<Level> label="What they can do" value={level} options={takeOver ? [...LEVELS, TAKE_OVER] : LEVELS} onChange={setLevel} />
        <Button variant={taking ? 'primary' : undefined} onClick={go} disabled={blocked}>
          {taking ? 'Hand Over' : 'Share'}
        </Button>
      </div>
      {say ? <p className={s.addWhy}>{say}</p> : null}
      {canNote || taking ? (
        <div className={s.addNote}>
          <Checkbox
            checked={taking || note}
            disabled={taking}
            onChange={setNote}
            label="Write a handoff note"
            detail={taking ? 'Always written when someone takes it over' : 'Your agent sums up where it stands and what’s left, in the chat and as HANDOFF.md in Scratch'}
          />
        </div>
      ) : null}
    </div>
  );
}
