import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, promises as fs, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { belugaHome } from './home.js';
export { ATTACHMENT_SHARE, ATTACHMENT_SCHEME } from './attachment-share.js';
import { ATTACHMENT_SHARE, ATTACHMENT_SCHEME } from './attachment-share.js';

/**
 * Images pasted into the box you type in. Each becomes a chip like "[image 1]" in the
 * text; the file is saved under ~/.beluga/attachments. On send, chips turn into links
 * ("📎 image 1 (png, 120K)") that open the image, and your own Claude gets the pixels.
 */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
/** Biggest image accepted (the Claude API takes up to 5 MB per image once base64-encoded, a third bigger). */
export const MAX_ATTACHMENT_BYTES = Math.floor(3.7 * 1024 * 1024);

export const attachmentsDir = (): string => path.join(belugaHome(), 'attachments');
/** Copies of images sent to the room, the only ones friends can fetch. */
export const roomAttachmentsDir = (): string => path.join(attachmentsDir(), 'room');

export interface Attachment {
  readonly n: number;
  readonly path: string;
  readonly size: number;
}

// Chips in the box map to files here (numbers keep counting up for the whole session).
const registry = new Map<number, Attachment>();
let counter = 0;

export function registerAttachment(file: string, size: number): Attachment {
  const a = { n: ++counter, path: file, size };
  registry.set(a.n, a);
  return a;
}

export const attachment = (n: number): Attachment | undefined => registry.get(n);

/**
 * An image you linked in a message, waiting again (a queued message pulled back into the box):
 * the number it had while this session still knows it, else a new one for the same file.
 */
export function reattach(file: string, dir = attachmentsDir()): Attachment | undefined {
  for (const a of registry.values()) if (path.basename(a.path) === file && isFile(a.path)) return a;
  const own = ownAttachment(file, dir);
  return own ? registerAttachment(own, statSync(own).size) : undefined;
}
export const chipText = (n: number): string => `[image ${n}]`;
const CHIP = /\[image (\d+)\]/g;

/** Insert text at the cursor, with a space on each side where needed. */
export function insertChip(buffer: string, cursor: number, chip: string): { buffer: string; cursor: number } {
  const before = buffer.slice(0, cursor);
  const after = buffer.slice(cursor);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const text = `${lead}${chip} `;
  return { buffer: before + text + after.replace(/^ /, ''), cursor: cursor + text.length };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

/** The label shown in the chat for an image (`shown`: the number it had in the box, else its own). */
export const attachmentLabel = (a: Attachment, shown = a.n): string => `📎 image ${shown} (${path.extname(a.path).slice(1).toLowerCase() || 'image'}, ${formatBytes(a.size)})`;

/**
 * Replace "[image N]" chips with Markdown links to the images. `publish` is told about each
 * image (to make it available to the room) and returns the file name to link to. `only`: the
 * images waiting in the box (an "[image 1]" typed after its picture was taken out stays words).
 * `shown`: with `only`, the number each of them has in the box (the box counts the images of one
 * message from 1, these numbers count for the whole session): its chip says that number, and so
 * does its link.
 */
export function expandChips(text: string, selfId: string, publish: (a: Attachment) => string = (a) => path.basename(a.path), only?: readonly number[], shown?: readonly number[]): { text: string; attachments: Attachment[] } {
  const used: Attachment[] = [];
  const out = text.replace(CHIP, (chip, n: string) => {
    const at = shown && only ? shown.indexOf(Number(n)) : -1;
    const a = shown && only ? (at >= 0 ? registry.get(only[at]!) : undefined) : registry.get(Number(n));
    if (!a || (only && !only.includes(a.n))) return chip;
    used.push(a);
    return `[${attachmentLabel(a, Number(n))}](${ATTACHMENT_SCHEME}${selfId}/${publish(a)})`;
  });
  return { text: out, attachments: used };
}

const IMAGE_LINK = /klaud-attachment:[^/\s)]+\/([^/\s)]+)/g;

/** Images on this computer linked from a prompt (only files in the attachments folder count). */
export function linkedImages(prompt: string, dir = attachmentsDir()): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(IMAGE_LINK)) {
    const abs = ownAttachment(m[1] ?? '', dir);
    if (abs && !out.includes(abs)) out.push(abs);
  }
  return out;
}

/**
 * Links to images you attached pointed at their files, for words that reach Claude as plain text
 * (an answer to its question): it reads the file with Read, which policy.ts lets your own run do
 * for an image right in the attachments folder (isOwnImageFile). A room copy, a friend's image or a
 * missing one stays a link.
 */
export const withImagePaths = (text: string, dir = attachmentsDir()): string =>
  text.replace(IMAGE_LINK, (link, name: string) => {
    const abs = ownAttachment(name, dir);
    return abs && path.dirname(abs) === path.resolve(dir) ? abs : link;
  });

/**
 * An image file right in the attachments folder (one you pasted or dropped), where it really is:
 * links followed, never one in `room/`, `received/` or any other folder below it.
 */
export function isOwnImageFile(target: string, dir = attachmentsDir()): boolean {
  let real: string;
  let realDir: string;
  try {
    real = realpathSync.native(target);
    realDir = realpathSync.native(dir);
  } catch {
    return false;
  }
  const rel = path.relative(realDir, real);
  return rel === path.basename(real) && isAttachmentName(rel) && isFile(real);
}

export const mediaTypeOf = (file: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' => {
  const ext = path.extname(file).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/png';
};

const stamp = (): string => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-') + `-${Math.random().toString(36).slice(2, 6)}`;

const run = (cmd: string, args: readonly string[]): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    execFile(cmd, [...args], { encoding: 'buffer', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

const isPng = (b: Buffer): boolean => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/**
 * Save the image on the clipboard (if there is one) in the attachments folder. macOS: an image
 * file copied in Finder is copied over as is, else AppleScript hands over the clipboard as PNG
 * (screenshots, images copied from a browser or Preview). Linux uses wl-paste or xclip; Windows
 * PowerShell (an image file copied in Explorer, else the picture itself as PNG). Never throws for
 * a missing tool or an empty clipboard: undefined.
 */
export async function saveClipboardImage(dir = attachmentsDir()): Promise<string | undefined> {
  await fs.mkdir(dir, { recursive: true });
  if (process.platform === 'darwin') return (await copiedImageFile(dir)) ?? (await macClipboardPng(dir));
  if (process.platform === 'win32') return windowsClipboardImage(dir);
  if (process.platform === 'linux') {
    const file = path.join(dir, `${stamp()}.png`);
    for (const [cmd, args] of [['wl-paste', ['--type', 'image/png']], ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']]] as const) {
      try {
        const bytes = await run(cmd, args);
        if (!isPng(bytes)) continue;
        await fs.writeFile(file, bytes);
        return bytes.length > MAX_ATTACHMENT_BYTES ? shrinkImage(file) : file;
      } catch {
        // try the next tool
      }
    }
  }
  return undefined;
}

/** A PowerShell string: in single quotes, its own single quotes doubled. */
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * Windows: the PowerShell that saves the clipboard's picture as a PNG at `file` and prints "image",
 * or prints "file:" and the path of one file copied in Explorer; prints nothing when there's neither.
 */
export const windowsClipboardScript = (file: string): string =>
  [
    // What it prints is read as UTF-8 (PowerShell's own default is the old code page: a copied file under "Zoë" got lost).
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    'if ([Windows.Forms.Clipboard]::ContainsFileDropList()) { $f = [Windows.Forms.Clipboard]::GetFileDropList(); if ($f.Count -eq 1) { Write-Output ("file:" + $f[0]) }; exit 0 }',
    '$img = [Windows.Forms.Clipboard]::GetImage()',
    'if ($img -eq $null) { exit 0 }',
    `$img.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    "Write-Output 'image'",
  ].join('; ');

async function windowsClipboardImage(dir: string): Promise<string | undefined> {
  const file = path.join(dir, `${stamp()}.png`);
  let said: string;
  try {
    said = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', windowsClipboardScript(file)])).toString('utf8').trim();
  } catch {
    await fs.rm(file, { force: true });
    return undefined; // no PowerShell, or it couldn't read the clipboard
  }
  if (said.startsWith('file:')) {
    const copied = said.slice(5).trim();
    if (!isFile(copied)) return undefined;
    if (!IMAGE_EXT.test(copied)) throw new Error(`${path.basename(copied)} isn't an image (png, jpg, gif or webp)`);
    return importImageFitting(copied, dir);
  }
  const size = said === 'image' && isFile(file) ? statSync(file).size : 0;
  if (!size) return undefined;
  return size > MAX_ATTACHMENT_BYTES ? shrinkImage(file) : file;
}

/** An image file copied in Finder (the clipboard holds its location, plus only its icon as a picture). */
async function copiedImageFile(dir: string): Promise<string | undefined> {
  let copied: string;
  try {
    copied = (await run('osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)'])).toString('utf8').trim();
  } catch {
    return undefined; // no file on the clipboard
  }
  // Plain text coerces to a made-up path ("hello" → "/hello"), so it must really be a file.
  if (!isFile(copied)) return undefined;
  // Another kind of file: its only picture is its icon, which isn't what you meant.
  if (!IMAGE_EXT.test(copied)) throw new Error(`${path.basename(copied)} isn't an image (png, jpg, gif or webp)`);
  return importImage(copied, dir);
}

async function macClipboardPng(dir: string): Promise<string | undefined> {
  const file = path.join(dir, `${stamp()}.png`);
  const target = file.replace(/["\\]/g, '\\$&');
  try {
    await run('osascript', [
      '-e', 'set png_data to (the clipboard as «class PNGf»)',
      '-e', `set fp to open for access POSIX file "${target}" with write permission`,
      '-e', 'write png_data to fp',
      '-e', 'close access fp',
    ]);
  } catch {
    await fs.rm(file, { force: true });
    return undefined; // no image on the clipboard
  }
  const size = statSync(file).size;
  return size > MAX_ATTACHMENT_BYTES ? shrinkImage(file) : size > 0 ? file : undefined;
}

/**
 * Big screenshots (a full Retina screen can pass the limit) become a smaller JPEG. Claude
 * scales images down to about 1568 pixels on the long side anyway.
 */
async function shrinkImage(file: string): Promise<string> {
  const out = /\.png$/i.test(file) ? file.replace(/\.png$/i, '.jpg') : file.replace(/(\.\w+)?$/, '.small.jpg');
  try {
    for (const [edge, quality] of [['2000', '80'], ['1568', '60']] as const) {
      // sips is the Mac's; elsewhere Beluga reads the picture itself (PNG, JPEG, GIF).
      if (process.platform === 'darwin') await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', quality, '-Z', edge, file, '--out', out]);
      else await (await import('../image/shrink.js')).shrinkImageFile(file, out, Number(edge), 'jpeg', Number(quality));
      if (statSync(out).size <= MAX_ATTACHMENT_BYTES) return out;
    }
  } finally {
    await fs.rm(file, { force: true });
  }
  await fs.rm(out, { force: true });
  throw new Error(`the image is too big (up to ${formatBytes(MAX_ATTACHMENT_BYTES)})`);
}

/**
 * Text pasted by dragging files into the terminal: one or more paths, maybe quoted,
 * with escaped spaces, or file:// URLs. Returns them only if every one is an image file.
 */
/** decodeURIComponent that never throws (a pasted "%zz" would otherwise crash the input handler). */
const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function droppedImagePaths(text: string, exists: (p: string) => boolean = isFile, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string[] | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 4000) return undefined;
  const tokens: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|((?:\\.|[^\s\\])+)/g;
  // On Windows, and in a Windows path (C:\… or \\server\…), a backslash separates folders, never escapes.
  const plain = (t: string): boolean => platform === 'win32' || WINDOWS_PATH.test(t);
  for (const m of trimmed.matchAll(re)) tokens.push(m[1] ?? m[2] ?? (plain(m[3] ?? '') ? (m[3] ?? '') : (m[3] ?? '').replace(/\\(.)/g, '$1')));
  if (!tokens.length) return undefined;
  const isAbsolute = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  const paths = tokens.map((t) => (t.startsWith('file://') ? fileUrlPath(t, platform) : t).replace(/^~(?=$|[\\/])/, () => home));
  return paths.every((p) => isAbsolute(p) && IMAGE_EXT.test(p) && exists(p)) ? paths : undefined;
}

const WINDOWS_PATH = /^[A-Za-z]:\\|^\\\\/;

/** A file:// URL's path on this system: file:///C:/x is C:\x on Windows, never /C:/x. */
function fileUrlPath(url: string, platform: NodeJS.Platform): string {
  try {
    return fileURLToPath(url, { windows: platform === 'win32' });
  } catch {
    return safeDecode(url.slice(7)); // not a URL Node reads (file://host/… off Windows): as before
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Copy an image file into the attachments folder (so the link keeps working if the original moves). */
export async function importImage(src: string, dir = attachmentsDir()): Promise<string> {
  const size = statSync(src).size;
  if (size > MAX_ATTACHMENT_BYTES) throw new Error(`${path.basename(src)} is too big (${formatBytes(size)}; up to ${formatBytes(MAX_ATTACHMENT_BYTES)})`);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${stamp()}${path.extname(src).toLowerCase()}`);
  await fs.copyFile(src, file);
  return file;
}

/** Copy an image file in, made smaller when it's too big (a Retina screenshot whose path was pasted). */
export async function importImageFitting(src: string, dir = attachmentsDir()): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${stamp()}${path.extname(src).toLowerCase()}`);
  await fs.copyFile(src, file);
  return statSync(file).size > MAX_ATTACHMENT_BYTES ? shrinkImage(file) : file;
}

/** What a pasted path is on this Mac, so the box can attach it (it only looks). */
export interface PathInfo {
  /** Absolute, with "~" expanded. */
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'folder' | 'missing';
  readonly size: number;
  readonly image: boolean;
}

export function pathInfo(p: string): PathInfo {
  // ~ and ~/x, or ~\x on Windows: the rest joined the system's way (C:\Users\you\x).
  const abs = /^~(?=$|[\\/])/.test(p) ? path.join(os.homedir(), p.slice(1)) : p;
  const base = { path: abs, name: path.basename(abs), size: 0, image: IMAGE_EXT.test(abs) };
  if (!path.isAbsolute(abs)) return { ...base, kind: 'missing' };
  try {
    const st = statSync(abs);
    return { ...base, kind: st.isFile() ? 'file' : st.isDirectory() ? 'folder' : 'missing', size: st.size };
  } catch {
    return { ...base, kind: 'missing' };
  }
}

/** Save image bytes a screen sent (a paste or a drop in the Mac app) into the attachments folder. */
export async function saveImageBytes(bytes: Uint8Array, ext: string, dir = attachmentsDir()): Promise<string> {
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`That image is too big (${formatBytes(bytes.byteLength)}; up to ${formatBytes(MAX_ATTACHMENT_BYTES)})`);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${stamp()}.${ext.toLowerCase().replace(/^\./, '')}`);
  await fs.writeFile(file, bytes);
  return file;
}

/** Put a copy where friends can fetch it; returns the file name to link to. */
export function publishForRoom(a: Attachment, dir = roomAttachmentsDir()): string {
  const name = path.basename(a.path);
  mkdirSync(dir, { recursive: true });
  copyFileSync(a.path, path.join(dir, name));
  return name;
}

/** Biggest image shown in a chat (bigger ones still open in the viewer). */
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/** A file name an image link may name: no folders, not hidden, an image. */
export const isAttachmentName = (name: string): boolean => !/[/\\]/.test(name) && !name.startsWith('.') && name.length <= 255 && IMAGE_EXT.test(name);

/** Your own copy of an image you linked: in the attachments folder, or among the room's copies. */
export function ownAttachment(file: string, dir = attachmentsDir()): string | undefined {
  if (!isAttachmentName(file)) return undefined;
  return [path.join(dir, file), path.join(dir, 'room', file)].find(isFile);
}

/** Fetches a file from a friend's share (end-to-end encrypted, refusing anything over `max` bytes). */
export type FetchShared = (at: { owner: string; share: string; path: string }, max: number) => Promise<Buffer>;

/**
 * The bytes of an image linked in a chat message: yours from disk, a friend's through their
 * share of room images (only people they sent it to may fetch it).
 */
export async function readAttachment(owner: string, file: string, selfId: string, fetchShared: FetchShared, dir = attachmentsDir()): Promise<Buffer> {
  if (!isAttachmentName(file)) throw new Error("That isn't an image link");
  if (owner === selfId) {
    const own = ownAttachment(file, dir);
    if (!own) throw new Error('That image is gone from this computer');
    if (statSync(own).size > MAX_PREVIEW_BYTES) throw new Error('That image is too big to show here');
    return fs.readFile(own);
  }
  return fetchShared({ owner, share: ATTACHMENT_SHARE, path: file }, MAX_PREVIEW_BYTES);
}

/** An image from a chat message as a file on this computer (a friend's is saved under attachments/received). */
export async function attachmentOnDisk(owner: string, file: string, selfId: string, fetchShared: FetchShared, dir = attachmentsDir()): Promise<string> {
  if (owner === selfId) {
    const own = ownAttachment(file, dir);
    if (!own) throw new Error('That image is gone from this computer');
    return own;
  }
  const bytes = await readAttachment(owner, file, selfId, fetchShared, dir);
  const received = path.join(dir, 'received');
  await fs.mkdir(received, { recursive: true });
  const saved = path.join(received, `${owner.replace(/[^\w-]/g, '').slice(0, 12)}-${file}`);
  await fs.writeFile(saved, bytes);
  return saved;
}
