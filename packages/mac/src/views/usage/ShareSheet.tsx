import { useEffect, useState } from 'react';
import { joinPath } from '@beluga/shared/os-path.js';
import { FormSheet } from '../../components/FormSheet.js';
import { Button } from '../../components/ui.js';
import { inApp } from '../../lib/boot.js';
import { copyPng } from '../../lib/copy.js';
import { toast, useApi, useBeluga } from '../../lib/beluga.js';
import { type ShareInput, drawShare } from './share-image.js';
import s from './your-card.module.css';

const FILE = 'My Beluga stats.png';

/** Save the picture: the Save panel picks where (starting in Downloads) and the daemon writes it; outside the app, a download. */
async function savePicture(png: string, save: (b64: string, to: string) => Promise<unknown>): Promise<boolean> {
  if (!inApp()) {
    const a = document.createElement('a');
    a.href = png;
    a.download = FILE;
    a.click();
    return true;
  }
  const [{ save: savePanel }, { downloadDir }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/api/path')]);
  const dir = await downloadDir().catch(() => '');
  const to = await savePanel({ title: 'Save Your Stats', defaultPath: dir ? joinPath(dir, FILE) : FILE, filters: [{ name: 'PNG image', extensions: ['png'] }] });
  if (!to) return false;
  await save(png.slice(png.indexOf(',') + 1), to.toLowerCase().endsWith('.png') ? to : `${to}.png`);
  return true;
}

/**
 * Share your stats: the picture (share-image.ts) as it will be, Save Image… (the main action) and
 * Copy Image. Nothing is sent anywhere: you take it from here.
 */
export function ShareSheet({ input, onClose }: { input: ShareInput; onClose: () => void }) {
  const api = useApi();
  const { client } = useBeluga();
  const [png, setPng] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    void drawShare(input)
      .then((url) => alive && setPng(url))
      .catch((err: unknown) => toast(client, `Couldn’t draw your stats: ${err instanceof Error ? err.message : String(err)}`, 'warn'));
    return () => {
      alive = false;
    };
  }, [input, client]);
  const copy = (): void => {
    if (!png) return;
    // The picture, to paste into a chat or a post.
    copyPng(fetch(png).then((r) => r.blob()))
      .then(() => setCopied(true))
      .catch(() => toast(client, 'Couldn’t copy the picture: save it instead', 'warn'));
  };
  return (
    <FormSheet
      title="Share Your Stats"
      intro="A picture of your title and numbers, to post or send. It stays on this Mac until you do."
      icon="share"
      width={560}
      submitLabel="Save Image…"
      canSubmit={Boolean(png)}
      onSubmit={async () => {
        if (!png) return;
        if (await savePicture(png, (b64, to) => api.stats.saveImage(b64, to))) {
          toast(client, 'Saved your stats', 'success');
          onClose();
        }
      }}
      onCancel={onClose}
      footer={
        <Button variant="plain" icon={copied ? 'check' : 'copy'} onClick={copy} disabled={!png}>
          {copied ? 'Copied' : 'Copy Image'}
        </Button>
      }
    >
      <div className={s.sharePreview}>{png ? <img src={png} alt="Your stats, as the picture you'll share" /> : <span className={s.shareDrawing} />}</div>
    </FormSheet>
  );
}
