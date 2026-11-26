import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import type { ViewerState } from '@beluga/core/store.js';
import { experimentOn } from '@beluga/shared/experiments.js';
import type { PreviewRef } from '@beluga/shared/preview/ref.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { Segmented } from '../../components/ui.js';
import { useApp } from '../../lib/beluga.js';

/**
 * Files' Preview view of a component file (Settings › Experimental › Live previews): offered for a
 * .tsx, .jsx, .vue or .svelte file of your own worktree that holds a component, beside its Source. Off: the
 * file shows as it always has.
 */

// Loaded only with the experiment on and a component file open: off, none of it is ever loaded.
const PreviewView = lazy(() => import('../../components/preview/PreviewBlock.js').then((m) => ({ default: m.PreviewView })));

/** A file that may hold components (worth reading for them at all). */
const MAYBE = /\.(tsx|jsx|vue|svelte)$/i;

/** What a file's Preview draws, when it has one. */
export function useComponentPreview(viewer: ViewerState, wsId: string | undefined): PreviewRef | undefined {
  const on = useApp((st) => experimentOn(st.prefs.experiments, 'previews'));
  const mine = useApp((st) => Boolean(wsId) && viewer.owner === st.selfId && viewer.share === shareNameOf(wsId ?? ''));
  const [components, setComponents] = useState(false);
  const worth = on && mine && !viewer.loading && MAYBE.test(viewer.path);
  useEffect(() => {
    if (!worth) return setComponents(false);
    let alive = true;
    // The props reader, loaded the first time it's needed.
    void import('@beluga/shared/preview/components.js').then((m) => alive && setComponents(m.looksLikeComponentFile(viewer.path, viewer.content)));
    return () => {
      alive = false;
    };
  }, [worth, viewer.path, viewer.content]);
  return useMemo(() => (worth && components ? { target: { kind: 'component', file: viewer.path } } : undefined), [worth, components, viewer.path]);
}

/** Source or Preview, back to Source when another file opens. */
export function usePreviewing(path: string): [boolean, (on: boolean) => void] {
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => setPreviewing(false), [path]);
  return [previewing, setPreviewing];
}

export function PreviewToggle({ previewing, onChange }: { previewing: boolean; onChange: (on: boolean) => void }) {
  return (
    <Segmented size="small"
      label="Show as"
      value={previewing ? 'preview' : 'source'}
      onChange={(v) => onChange(v === 'preview')}
      options={[
        { value: 'preview', label: 'Preview' },
        { value: 'source', label: 'Source' },
      ]}
    />
  );
}

/** The file drawn live, with its props beside it. */
export function ComponentPreview({ previewRef, wsId }: { previewRef: PreviewRef; wsId: string }) {
  return (
    <div style={{ padding: 12 }}>
      <Suspense fallback={null}>
        <PreviewView ref_={previewRef} wsId={wsId} embedded />
      </Suspense>
    </div>
  );
}
