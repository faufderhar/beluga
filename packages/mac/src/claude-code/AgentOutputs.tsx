import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { CcOutput, CcOutputFile, CcOutputs } from '@beluga/core/claude-code/model.js';
import { formatBytes } from '@beluga/shared/format.js';
import { Markdown } from '../chat/Markdown.js';
import { Icon, type IconName } from '../components/Icon.js';
import { VideoPlayer, useBlobUrl } from '../components/VideoPlayer.js';
import { Button, Empty, EmptyActions, IconButton, Segmented, cx } from '../components/ui.js';
import { useApi, useBeluga } from '../lib/beluga.js';
import { openWithDefaultApp, revealInFinder } from '../lib/files.js';
import { followed, isFresh, timeAgo } from '../layout/panel/scratch-model.js';
import { type Places, howLabel, outputsKey, placeOf } from './outputs-model.js';
import s from './agent-outputs.module.css';
import { everyWhileShown } from '../lib/window-active.js';
import { oneAtATime } from '../lib/one-at-a-time.js';
import { revealLabel } from '../lib/os-words.js';
import { useRevealFileLabel, useRevealLabel } from '../lib/remote-open.js';
import { revealThereLabel } from '@beluga/machines/open.js';
import { useMachine } from '../lib/beluga.js';

/**
 * A sub-agent's Outputs: what it made or looked at while it worked (screenshots, test output,
 * logs, JSON), wherever it put them: its own scratch folder, /tmp, test-results/… Newest first and
 * live; following, the preview shows each new file as it lands; pick one to stay on it.
 */

const POLL_LIVE_MS = 1500;
const POLL_MS = 6000;
const ICONS: Record<CcOutput['kind'], IconName> = { image: 'image', pdf: 'file', video: 'play', json: 'file', markdown: 'file', text: 'terminal', file: 'file' };

/** The agent's outputs, looked at again every moment while it works (and the window is in front). */
export function useAgentOutputs(sessionId: string, agentId: string, live: boolean): CcOutputs | undefined {
  const api = useApi();
  const [list, setList] = useState<CcOutputs>();
  useEffect(() => {
    let alive = true;
    let sig: string | undefined;
    const look = oneAtATime(() => {
      if (document.visibilityState !== 'visible') return;
      return api.claudeCode.outputs(sessionId, agentId).then(
        (res) => {
          const key = `${res.scratch ?? ''}#${res.missing ? 'missing' : outputsKey(res.outputs)}`;
          if (!alive || key === sig) return;
          sig = key;
          setList(res);
        },
        // A failed look keeps what's on screen until the next one.
        () => undefined,
      );
    });
    look();
    const stop = everyWhileShown(look, live ? POLL_LIVE_MS : POLL_MS);
    return () => {
      alive = false;
      stop();
    };
  }, [sessionId, agentId, live]);
  return list;
}

/** "now", "12s", "3m": kept current without a new listing. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  // Resting only while the page can't be seen; on time again the moment it can.
  useEffect(() => everyWhileShown(() => setNow(Date.now()), 5000), []);
  return now;
}

const pretty = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

/** A video the agent made (a screen recording, a demo), playing inline. */
function VideoContents({ file, fallback }: { file: CcOutputFile; fallback: ReactNode }) {
  const url = useBlobUrl(file.data, file.mime);
  return url ? <VideoPlayer url={url} name={placeOf(file.path, {}).name} fallback={fallback} /> : null;
}

function Contents({ file, fallback }: { file: CcOutputFile; fallback: ReactNode }) {
  if (file.kind === 'video') return file.data && file.mime ? <VideoContents file={file} fallback={fallback} /> : null;
  if (file.data && file.mime) return <img className={s.image} src={`data:${file.mime};base64,${file.data}`} alt={placeOf(file.path, {}).name} />;
  if (file.text !== undefined) {
    if (file.kind === 'markdown') return <div className={s.doc}><Markdown text={file.text} /></div>;
    return <pre className={s.text}>{file.kind === 'json' && !file.truncated ? pretty(file.text) : file.text}</pre>;
  }
  return null;
}

function Preview({ sessionId, agentId, item, places, onClose }: { sessionId: string; agentId: string; item: CcOutput; places: Places; onClose: () => void }) {
  const api = useApi();
  const { client } = useBeluga();
  // On a computer's page: Download for a file, Copy Path for a folder (BLG-852).
  const revealFile = useRevealFileLabel();
  const now = useNow();
  const [file, setFile] = useState<CcOutputFile | null>();
  useEffect(() => {
    let alive = true;
    setFile((prev) => (prev?.path === item.path ? prev : undefined));
    api.claudeCode.output(sessionId, agentId, item.path).then(
      (res) => alive && setFile(res ?? null),
      () => alive && setFile(null),
    );
    return () => {
      alive = false;
    };
  }, [sessionId, agentId, item.path, item.mtime]);
  const { name, dir } = placeOf(item.path, places);
  const openIt = (
    <Button icon="external" onClick={() => void openWithDefaultApp(client, item.path)}>
      Open With Its App
    </Button>
  );
  const shown = file && (file.data || file.text !== undefined) ? <Contents file={file} fallback={openIt} /> : null;
  return (
    <section className={s.preview} aria-label={name}>
      <div className={s.previewHead}>
        <Icon name={ICONS[item.kind]} size={13} className={s.icon} />
        <span className={s.previewName} title={item.path}>
          {name}
        </span>
        <span className={s.dim}>
          {howLabel(item.how)} · {timeAgo(item.mtime, Math.max(now, Date.now()))}
        </span>
        <span className={s.flex} />
        <IconButton icon="external" label="Open With Its App" onClick={() => void openWithDefaultApp(client, item.path)} />
        <IconButton icon="folder" label={revealFile} onClick={() => void revealInFinder(client, item.path)} />
        <IconButton icon="x" label="Close" keys="Esc" onClick={onClose} />
      </div>
      {dir ? <div className={cx(s.previewPath, 'selectable')} title={item.path}>{dir}</div> : null}
      <div className={cx(s.previewBody, 'selectable')} tabIndex={0}>
        {file === undefined ? (
          <div className={s.dimPad}>Opening…</div>
        ) : shown ? (
          <>
            {shown}
            {file?.truncated ? <div className={s.dimPad}>Only the start is shown: open it with its app for the rest.</div> : null}
          </>
        ) : (
          <Empty
            icon={ICONS[item.kind]}
            title={item.kind === 'image' || item.kind === 'video' ? 'Too big to show here' : 'Not shown here'}
            detail={`${formatBytes(item.size)}. Open it with its app to look at it.`}
            action={
              <EmptyActions>
                <Button icon="external" onClick={() => void openWithDefaultApp(client, item.path)}>
                  Open With Its App
                </Button>
              </EmptyActions>
            }
          />
        )}
      </div>
    </section>
  );
}

/** The Outputs of one sub-agent (its page's second tab). */
export function AgentOutputs({ sessionId, agentId, list, cwd }: { sessionId: string; agentId: string; list: CcOutputs | undefined; cwd?: string }) {
  const { client } = useBeluga();
  const revealFolder = useRevealLabel('Its Folder');
  const machine = useMachine();
  const now = useNow();
  const [follow, setFollow] = useState(true);
  const [picked, setPicked] = useState<string>();
  const [closed, setClosed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const files = list?.outputs ?? [];
  const shown = closed ? undefined : followed(files, follow, picked);
  const item = files.find((f) => f.path === shown);
  const home = cwd ? /^\/Users\/[^/]+/.exec(cwd)?.[0] : undefined;
  const places: Places = { ...(list?.scratch ? { scratch: list.scratch } : {}), ...(cwd ? { cwd } : {}), ...(home ? { home } : {}) };

  // Following: the newest file stays in sight as new ones arrive.
  useEffect(() => {
    if (follow) listRef.current?.scrollTo({ top: 0 });
  }, [follow, files[0]?.path, files[0]?.mtime]);

  const pick = (path: string): void => {
    setClosed(false);
    setPicked(path);
    setFollow(path === files[0]?.path && follow);
  };
  const onKey = (e: KeyboardEvent): void => {
    const i = files.findIndex((f) => f.path === shown);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = files[Math.max(0, Math.min(files.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        pick(next.path);
        setFollow(false);
      }
    } else if (e.key === 'Escape' && shown) {
      e.preventDefault();
      e.stopPropagation();
      setClosed(true);
    }
  };

  if (!list) return <div className={s.dimPad}>Looking for what it made…</div>;
  if (list.missing) return <Empty icon="bot" title="Not watched any more" detail="Claude Code no longer has this agent’s transcript open." />;
  if (!files.length) {
    return (
      <div className={s.empty}>
        <Empty
          icon="image"
          title="Nothing yet"
          detail={`Screenshots, test output, logs and notes this agent saves or looks at show here as it works, wherever it puts them.${list.scratch ? ' It was given its own folder for them.' : ''}`}
          {...(list.scratch
            ? {
                action: (
                  <EmptyActions>
                    <Button icon="folder" title={list.scratch} onClick={() => void revealInFinder(client, list.scratch!)}>
                      {machine ? revealThereLabel('folder') : 'Show Its Folder'}
                    </Button>
                  </EmptyActions>
                ),
              }
            : {})}
        />
      </div>
    );
  }
  return (
    <div className={s.split}>
      <div className={s.side}>
        <div className={s.summary}>
          <span className={s.summaryTitle}>
            {files.length} file{files.length === 1 ? '' : 's'}
          </span>
          <span className={s.flex} />
          <Segmented
            label="Preview"
            value={follow ? 'follow' : 'pinned'}
            onChange={(v) => {
              setFollow(v === 'follow');
              setClosed(false);
            }}
            options={[
              { value: 'follow', label: 'Latest', hint: 'Show each new file as it lands' },
              { value: 'pinned', label: 'Picked', hint: 'Stay on the file you picked' },
            ]}
          />
          {list.scratch ? <IconButton icon="folder" label={revealFolder} onClick={() => void revealInFinder(client, list.scratch!)} /> : null}
        </div>
        <div ref={listRef} className={s.list} role="listbox" aria-label="Outputs" tabIndex={0} onKeyDown={onKey}>
          {files.map((f) => {
            const { name, dir } = placeOf(f.path, places);
            const sel = f.path === shown;
            return (
              <div key={f.path} role="option" aria-selected={sel} className={cx(s.row, sel && s.rowOn)} title={`${f.path}\n${howLabel(f.how)}`} onClick={() => pick(f.path)}>
                <Icon name={ICONS[f.kind]} size={13} className={s.icon} />
                <span className={s.rowName}>
                  {name}
                  {dir ? <span className={s.rowDir}>{dir}</span> : null}
                </span>
                {isFresh(f.mtime, Math.max(now, Date.now())) ? <span className={s.freshDot} aria-label="new" /> : null}
                <span className={s.ago}>{timeAgo(f.mtime, Math.max(now, Date.now()))}</span>
              </div>
            );
          })}
        </div>
      </div>
      {item ? (
        <Preview sessionId={sessionId} agentId={agentId} item={item} places={places} onClose={() => setClosed(true)} />
      ) : (
        <div className={s.previewNone}>
          <Empty icon="eye" title="Pick a file to look at it" />
        </div>
      )}
    </div>
  );
}
