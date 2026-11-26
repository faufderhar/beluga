import { constants, promises as fs, readdirSync } from 'node:fs';
import path from 'node:path';
import { MAX_CHAT_FILE, cleanFileName } from '../../net/mesh/extras.js';
import { COMPUTER } from '../../shared/assistant.js';
import type { ChatFile } from '../../net/mesh/views.js';
import { sha256File } from '../gateway/transfer.js';

/**
 * The chat files on this Mac, by checksum: `<root>/<sha>/<name>`. What you share is cloned in
 * (instant and free on APFS, a copy elsewhere), so editing or deleting the original later
 * doesn't change what friends download; what you receive lands in the same place after its
 * checksum is checked. A file being received is `<root>/<sha>/.part` until then.
 */

const IMAGE_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const OTHER_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  svg: 'image/svg+xml',
  heic: 'image/heic',
};

/** The MIME type a name suggests, and whether the chat can show it as a picture. */
export function kindOf(name: string): { mime?: string; image?: boolean } {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (IMAGE_TYPES[ext]) return { mime: IMAGE_TYPES[ext], image: true };
  return OTHER_TYPES[ext] ? { mime: OTHER_TYPES[ext] } : {};
}

const SHA = /^[0-9a-f]{64}$/;
const PART = '.part';

export class FileStore {
  /** sha → the file's path, for every complete file here. */
  private readonly here = new Map<string, string>();

  constructor(readonly root: string) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root).filter((d) => SHA.test(d));
    } catch {
      // Nothing yet.
    }
    for (const sha of dirs) {
      try {
        const name = readdirSync(path.join(root, sha)).find((f) => f !== PART && !f.startsWith('.'));
        if (name) this.here.set(sha, path.join(root, sha, name));
      } catch {
        // Unreadable: treated as not here.
      }
    }
  }

  /** Where the file with this checksum is on this Mac, if it's here. */
  pathOf(sha: string): string | undefined {
    return SHA.test(sha) ? this.here.get(sha) : undefined;
  }

  has = (sha: string): boolean => this.here.has(sha);

  /** Take a file of yours in (checksummed, cloned): → what a message says about it. */
  async add(file: string, as?: string): Promise<ChatFile> {
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat) throw new Error(`${path.basename(file)} isn’t there any more`);
    // computer-wording: mac (only on a Mac)
    if (stat.isDirectory()) throw new Error(`${path.basename(file)} is a folder: compress it first${COMPUTER === 'mac' ? ' (right-click › Compress in Finder)' : ''}`);
    if (!stat.isFile()) throw new Error(`${path.basename(file)} can’t be sent`);
    if (stat.size > MAX_CHAT_FILE) throw new Error(`${path.basename(file)} is too big to send`);
    const sha = await sha256File(file);
    const name = cleanFileName(as ?? path.basename(file));
    if (!this.here.has(sha)) {
      const dir = path.join(this.root, sha);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const target = path.join(dir, name);
      // A clone on APFS: no time, no space. Elsewhere a plain copy.
      await fs.copyFile(file, target, constants.COPYFILE_FICLONE);
      await fs.chmod(target, 0o600).catch(() => undefined);
      this.here.set(sha, target);
    }
    return { sha, name, size: stat.size, ...kindOf(name) };
  }

  /**
   * Bytes without a file behind them (pasted media), any size: they come in parts (`part`), each
   * appended to `incoming/<id>`; the last one takes the whole file in.
   */
  async addPart(name: string, data: Buffer, part: { id: string; last: boolean }): Promise<ChatFile | undefined> {
    if (!/^[\w-]{8,64}$/.test(part.id)) throw new Error('Not an upload id');
    const dir = path.join(this.root, 'incoming');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, part.id);
    await fs.appendFile(tmp, data, { mode: 0o600 });
    if (!part.last) return undefined;
    try {
      return await this.add(tmp, name);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  /** Bytes pasted or dropped without a file behind them (a screenshot from the clipboard). */
  async addData(name: string, data: Buffer): Promise<ChatFile> {
    const dir = path.join(this.root, 'incoming');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await fs.writeFile(tmp, data, { mode: 0o600 });
    try {
      return await this.add(tmp, name);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  /** Where a file being received is written until it's checked (its folder is made when it's opened). */
  partFor(sha: string): string {
    if (!SHA.test(sha)) throw new Error('Not a file id');
    return path.join(this.root, sha, PART);
  }

  /** A received file came whole: check it and keep it under its name. False when the checksum is wrong. */
  async finish(sha: string, name: string): Promise<string | undefined> {
    const part = path.join(this.root, sha, PART);
    if ((await sha256File(part).catch(() => '')) !== sha) {
      await fs.rm(part, { force: true });
      return undefined;
    }
    const target = path.join(this.root, sha, cleanFileName(name));
    await fs.rename(part, target);
    this.here.set(sha, target);
    return target;
  }

  /** Give up on a file being received (and its folder, unless the file is here after all). */
  async discard(sha: string): Promise<void> {
    if (!SHA.test(sha)) return;
    await fs.rm(path.join(this.root, sha, PART), { force: true });
    if (!this.here.has(sha)) await fs.rmdir(path.join(this.root, sha)).catch(() => undefined);
  }
}
