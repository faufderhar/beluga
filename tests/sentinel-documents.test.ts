import { describe, expect, it } from 'vitest';
import { documentLook, kindWords } from '../src/core/sentinel/columns.js';
import { brief, setup } from './sentinel-fakes.js';

/** A kept table's documents in Beluga's viewer (BLG-381): storage objects fetched for it, and what each kind is. */

const ENV = { SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };

function withStorage(objects: Readonly<Record<string, { readonly body: Uint8Array<ArrayBuffer> | string; readonly type?: string; readonly status?: number }>>) {
  const asked: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${init?.method ?? 'GET'} ${url}`);
    const sign = /\/storage\/v1\/object\/sign\/([^?]+)$/.exec(url);
    if (sign && init?.method === 'POST') return new Response(JSON.stringify({ signedURL: `/object/sign/${sign[1]}?token=t` }), { status: 200 });
    const got = Object.entries(objects).find(([key]) => url.includes(`/object/sign/${key}?token=t`))?.[1];
    if (!got) return new Response('missing', { status: 404 });
    return new Response(got.body, { status: got.status ?? 200, headers: got.type ? { 'content-type': got.type } : {} });
  }) as typeof fetch;
  const s = setup({ fetch: fetchFn, envFor: () => ENV });
  const sn = s.sentinels.create(brief);
  const run = s.sentinels.addHistory(sn.id, { by: 'schedule', trigger: { kind: 'schedule', summary: 'On its schedule' }, state: 'done', startedAt: Date.now() - 1000, endedAt: Date.now(), headline: 'Kept files', steps: [], tasks: [] }, { outputs: [] });
  s.sentinels.demoKeep(sn.id, run.id, [
    {
      name: 'files',
      label: 'Files',
      better: 'none',
      columns: ['file'],
      columnTypes: [{ key: 'file', type: 'storage', bucket: 'docs', path: 'path' }],
      rows: [{ file: 'docs/a/report.md' }, { file: 'docs/a/build.zip' }, { file: 'docs/a/blob' }],
    },
  ]);
  return { ...s, sn, asked };
}

describe('documents in the viewer', () => {
  it('fetches a storage object through a link signed for a minute, as a kept document reads', async () => {
    const s = withStorage({ 'docs/a/report.md': { body: '# Report\n\nAll good.', type: 'text/markdown; charset=utf-8' }, 'docs/a/build.zip': { body: new Uint8Array([80, 75, 5, 6]) }, 'docs/a/blob': { body: new Uint8Array([1, 2, 3]), type: 'image/png' } });
    const md = await s.sentinels.storageDocument(s.sn.id, 'files', 'file', 'docs/a/report.md');
    expect(md).toMatchObject({ name: 'report.md', mime: 'text/markdown', size: 19, text: '# Report\n\nAll good.', bucket: 'docs', path: 'a/report.md' });
    expect(s.asked).toEqual(['POST https://abc.supabase.co/storage/v1/object/sign/docs/a/report.md', 'GET https://abc.supabase.co/storage/v1/object/sign/docs/a/report.md?token=t']);
    // Bytes as base64; Storage's own type when the name says nothing.
    expect(await s.sentinels.storageDocument(s.sn.id, 'files', 'file', 'docs/a/build.zip')).toMatchObject({ name: 'build.zip', mime: 'application/zip', base64: 'UEsFBg==' });
    expect(await s.sentinels.storageDocument(s.sn.id, 'files', 'file', 'docs/a/blob')).toMatchObject({ mime: 'image/png', size: 3 });
    // Only a cell its latest rows hold, and only of a storage column.
    await expect(s.sentinels.storageDocument(s.sn.id, 'files', 'file', 'docs/other.md')).rejects.toThrow(/has no file/);
    // Saving a copy to open needs a run folder (none in memory): it says so.
    await expect(s.sentinels.storagePath(s.sn.id, 'files', 'file', 'docs/a/build.zip')).rejects.toThrow(/Couldn’t save build.zip/);
  });

  it('hands a PDF to the viewer as its bytes, which PDF.js draws (BLG-936)', async () => {
    // The Mac's web view leaves a PDF in an iframe blank: the sheet draws the pages from these bytes.
    const pdf = new TextEncoder().encode('%PDF-1.7\n%%EOF\n');
    const s = withStorage({ 'docs/a/blob': { body: pdf, type: 'application/pdf' } });
    const read = await s.sentinels.storageDocument(s.sn.id, 'files', 'file', 'docs/a/blob');
    expect(read).toMatchObject({ mime: 'application/pdf', size: pdf.byteLength, base64: Buffer.from(pdf).toString('base64') });
    expect(read.text).toBeUndefined();
    expect(documentLook(read.mime)).toBe('pdf');
  });

  it('streams a document to the phone from memory: fetched once for all its pieces, then gone (BLG-386)', async () => {
    const s = withStorage({ 'docs/a/report.md': { body: '# Report', type: 'text/markdown' } });
    const one = await s.sentinels.documentBytes(s.sn.id, 'files', 'file', 'docs/a/report.md');
    const two = await s.sentinels.documentBytes(s.sn.id, 'files', 'file', 'docs/a/report.md');
    expect(two).toBe(one);
    expect(new TextDecoder().decode(one.bytes)).toBe('# Report');
    expect(s.asked.filter((a) => a.startsWith('GET'))).toHaveLength(1);
    await expect(s.sentinels.documentBytes(s.sn.id, 'files', 'file', 'docs/elsewhere.md')).rejects.toThrow(/has no file/);
  });

  it('says when Storage refuses the object', async () => {
    const s = withStorage({ 'docs/a/report.md': { body: 'nope', status: 403 } });
    await expect(s.sentinels.storageDocument(s.sn.id, 'files', 'file', 'docs/a/report.md')).rejects.toThrow('Supabase Storage answered 403 for report.md');
  });

  it('knows how to show each kind, and says what the others are', () => {
    expect(['text/html', 'text/markdown', 'application/json', 'text/csv', 'image/svg+xml', 'application/pdf', 'video/mp4', 'audio/mpeg', 'application/zip'].map(documentLook)).toEqual(['html', 'markdown', 'json', 'text', 'image', 'pdf', 'video', 'audio', 'other']);
    expect(kindWords('build.zip', 'application/zip')).toBe('ZIP archive');
    expect(kindWords('a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('Word document');
    expect(kindWords('shot.png', 'image/png')).toBe('PNG image');
    expect(kindWords('Beluga.dmg', 'application/octet-stream')).toBe('DMG file');
    expect(kindWords('blob', 'application/octet-stream')).toBe('File');
  });

  it('runs an action from the columns a phone has, when they name one row (BLG-386)', () => {
    const s = setup();
    const sn = s.sentinels.create(brief);
    const target = s.sentinels.create({ ...brief, name: 'Retry a job' });
    const run = s.sentinels.addHistory(sn.id, { by: 'schedule', trigger: { kind: 'schedule', summary: 'On its schedule' }, state: 'done', startedAt: Date.now() - 1000, endedAt: Date.now(), headline: 'Kept jobs', steps: [], tasks: [] }, { outputs: [] });
    s.sentinels.demoKeep(sn.id, run.id, [{ name: 'jobs', label: 'Jobs', better: 'none', columns: ['job', 'who', 'note'], columnTypes: [{ key: 'retry', type: 'action', sentinel: target.id, button: 'Retry' }], rows: [{ job: 'deploy', who: 'lena', note: 'x'.repeat(400), retry: null }, { job: 'tests', who: 'ci', note: 'ok', retry: null }, { job: 'tests', who: 'ci', note: 'again', retry: null }] }]);
    // The long note never reached the phone: the rest names the row.
    const started = s.sentinels.runRow(sn.id, 'jobs', 'retry', { job: 'deploy', who: 'lena' }, 'phone');
    expect(started.sentinelId).toBe(target.id);
    // Two rows alike: it asks for the Mac rather than guess.
    expect(() => s.sentinels.runRow(sn.id, 'jobs', 'retry', { job: 'tests', who: 'ci' }, 'phone')).toThrow(/Several of Jobs’s rows/);
    expect(() => s.sentinels.runRow(sn.id, 'jobs', 'retry', { job: 'gone' }, 'phone')).toThrow(/isn’t in Jobs’s latest rows/);
  });
});
