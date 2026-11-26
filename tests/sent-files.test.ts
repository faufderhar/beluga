import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keepSent, sentFiles, sentNote, withSentFiles } from '../src/core/sent-files.js';
import { SENT_DIR, isSentPath, sentFolder, sentName } from '../src/shared/scratch-dir.js';
import { dropSent } from '../src/workspaces/scratch.js';
import { splitSent, viewTotal } from '../packages/mac/src/layout/panel/scratch-model.js';

/** What you send your agent is copied into the conversation's scratch folder, and it's told where (BLG-771). */
describe('files sent with a message', () => {
  let base: string;
  let attachments: string;
  let home: string;
  let ws: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-sent-')));
    attachments = path.join(base, 'attachments');
    home = path.join(base, 'home');
    ws = path.join(base, 'ws');
    for (const d of [attachments, path.join(attachments, 'room'), home, ws]) mkdirSync(d, { recursive: true });
    writeFileSync(path.join(attachments, '20261108-1.png'), 'png-bytes');
    writeFileSync(path.join(attachments, 'room', '20261108-2.jpg'), 'jpg-bytes');
    writeFileSync(path.join(home, 'report.pdf'), 'pdf-bytes');
    writeFileSync(path.join(home, '.env'), 'SECRET=1');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const message = (): string =>
    [
      'look at [📎 image 1 (png, 1K)](klaud-attachment:me/20261108-1.png) and [📎 image 2 (jpg, 1K)](klaud-attachment:me/20261108-2.jpg)',
      'a friend’s: [📎 image 3 (png, 1K)](klaud-attachment:friend/20261108-1.png)',
      '',
      `\`${path.join(home, 'report.pdf')}\``,
      `\`${path.join(home, '.env')}\``,
      `\`${path.join(home, 'missing.txt')}\``,
      `\`${home}\``,
      `and inline \`${path.join(home, 'report.pdf')}\` in words`,
    ].join('\n');

  it('finds your images and the files the box attached, never a secret, a folder or a friend’s image', () => {
    const files = sentFiles(message(), 'me', attachments);
    expect(files).toEqual([
      { label: 'image 1', src: path.join(attachments, '20261108-1.png') },
      { label: 'image 2', src: path.join(attachments, 'room', '20261108-2.jpg') },
      { label: 'report.pdf', src: path.join(home, 'report.pdf') },
    ]);
  });

  it('copies them into the folder and says where, once each', () => {
    const out = withSentFiles(message(), 'me', ws, SENT_DIR, attachments);
    expect(out.startsWith(message())).toBe(true);
    expect(out).toContain(`image 1: \`${SENT_DIR}/20261108-1.png\``);
    expect(out).toContain(`\`${SENT_DIR}/report.pdf\``);
    expect(readdirSync(path.join(ws, SENT_DIR)).sort()).toEqual(['20261108-1.png', '20261108-2.jpg', 'report.pdf']);
    expect(readFileSync(path.join(ws, SENT_DIR, 'report.pdf'), 'utf8')).toBe('pdf-bytes');
    // Sent again: the copy that's there, not a second one.
    withSentFiles(message(), 'me', ws, SENT_DIR, attachments);
    expect(readdirSync(path.join(ws, SENT_DIR))).toHaveLength(3);
  });

  it('another file of the same name gets a name of its own', () => {
    mkdirSync(path.join(home, 'b'));
    writeFileSync(path.join(home, 'b', 'report.pdf'), 'another, longer report');
    keepSent(ws, SENT_DIR, [{ label: 'report.pdf', src: path.join(home, 'report.pdf') }]);
    const kept = keepSent(ws, SENT_DIR, [{ label: 'report.pdf', src: path.join(home, 'b', 'report.pdf') }]);
    expect(kept).toEqual([{ label: 'report.pdf', path: `${SENT_DIR}/report-2.pdf` }]);
    expect(sentNote(kept)).toContain(`\`${SENT_DIR}/report-2.pdf\``);
  });

  it('a message with nothing sent, or a command, goes as it is and makes no folder', () => {
    expect(withSentFiles('just words', 'me', ws, SENT_DIR, attachments)).toBe('just words');
    const command = `/review \`${path.join(home, 'report.pdf')}\``;
    expect(withSentFiles(command, 'me', ws, SENT_DIR, attachments)).toBe(command);
    expect(existsSync(path.join(ws, SENT_DIR))).toBe(false);
  });

  it('never writes through a link out of the workspace', () => {
    const outside = path.join(base, 'outside');
    mkdirSync(outside);
    mkdirSync(path.join(ws, '.beluga'));
    symlinkSync(outside, path.join(ws, '.beluga', 'scratch'));
    expect(keepSent(ws, SENT_DIR, [{ label: 'report.pdf', src: path.join(home, 'report.pdf') }])).toEqual([]);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('a conversation sharing its folder keeps its own, and deleting it takes only those', async () => {
    expect(sentFolder('ws:abc', true)).toBe(SENT_DIR);
    expect(sentFolder('mac:assistant:ab12', false)).toBe(`${SENT_DIR}/mac-assistant-ab12`);
    expect(sentName('dm:Peer/../x')).toBe('dm-Peer-x');
    const mine = sentFolder('ws:chat-1', false);
    const theirs = sentFolder('ws:chat-2', false);
    keepSent(ws, mine, [{ label: 'report.pdf', src: path.join(home, 'report.pdf') }]);
    keepSent(ws, theirs, [{ label: 'report.pdf', src: path.join(home, 'report.pdf') }]);
    await dropSent(ws, mine);
    expect(existsSync(path.join(ws, mine))).toBe(false);
    expect(existsSync(path.join(ws, theirs, 'report.pdf'))).toBe(true);
    // Only ever inside the scratch folder.
    await dropSent(ws, '..');
    expect(existsSync(ws)).toBe(true);
  });
});

describe('the Scratch tab keeps what you sent apart', () => {
  const files = [
    { path: `${SENT_DIR}/shot.png`, size: 10, mtime: 3 },
    { path: '.beluga/scratch/log.txt', size: 5, mtime: 2 },
    { path: '.context/notes.md', size: 7, mtime: 1 },
  ];
  it('lists Claude’s files unless you pick yours (or Claude saved none yet)', () => {
    expect(isSentPath(`${SENT_DIR}/shot.png`)).toBe(true);
    expect(isSentPath('.beluga/scratch/sentinel.txt')).toBe(false);
    const claude = splitSent(files, 'claude', isSentPath);
    expect(claude.view).toBe('claude');
    expect(claude.shown.map((f) => f.path)).toEqual(['.beluga/scratch/log.txt', '.context/notes.md']);
    expect(splitSent(files, 'sent', isSentPath).shown.map((f) => f.path)).toEqual([`${SENT_DIR}/shot.png`]);
    // Not picked: what you sent, while your agent has saved nothing. Picked: your agent's view, empty or not.
    expect(splitSent(files.slice(0, 1), undefined, isSentPath).view).toBe('sent');
    expect(splitSent(files.slice(0, 1), 'claude', isSentPath).view).toBe('claude');
    expect(splitSent(files.slice(0, 1), 'claude', isSentPath).shown).toEqual([]);
    expect(splitSent(files, undefined, isSentPath).view).toBe('claude');
    expect(splitSent(files.slice(1), 'sent', isSentPath).view).toBe('claude');
  });
  it('counts each view on its own', () => {
    const total = { files: 400, bytes: 1000 };
    expect(viewTotal(splitSent(files, 'claude', isSentPath), total)).toEqual({ files: 399, bytes: 990 });
    expect(viewTotal(splitSent(files, 'sent', isSentPath), total)).toEqual({ files: 1, bytes: 10 });
    expect(viewTotal(splitSent(files, 'claude', isSentPath), undefined)).toBeUndefined();
  });
});
