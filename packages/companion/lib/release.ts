/**
 * Which phone app the latest GitHub release carries (BLG-426): pure, so it's tested without a
 * phone. lib/update.ts looks for it, downloads it and installs it.
 */

export const RELEASE_REPO = 'faufderhar/beluga';
const APK = /^Beluga-(\d+\.\d+\.\d+)\.apk$/;

export interface Release {
  readonly version: string;
  readonly notes: string;
  readonly url: string;
  readonly size: number;
  readonly sha256?: string;
  readonly name: string;
}

/** 1.10.0 > 1.9.2. */
export function newer(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** The release's notes as plain lines: no Markdown marks, no line about which files are attached. */
export function plainNotes(body: string): string {
  return body
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => !/\.(apk|dmg)`?\)? (is|are) attached/i.test(l) && !/^The Android app/i.test(l))
    .map((l) => l.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^\s*[-*] /, '•  '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The phone's APK on GitHub's latest release, when there is one. */
export function releaseOf(json: unknown): Release | undefined {
  const r = json as { body?: string; assets?: { name: string; size: number; browser_download_url: string; digest?: string | null }[] };
  for (const a of r.assets ?? []) {
    const m = APK.exec(a.name);
    if (!m) continue;
    const sha = a.digest?.startsWith('sha256:') ? a.digest.slice(7) : undefined;
    return { version: m[1]!, notes: plainNotes(r.body ?? ''), url: a.browser_download_url, size: a.size, name: a.name, ...(sha ? { sha256: sha } : {}) };
  }
  return undefined;
}
