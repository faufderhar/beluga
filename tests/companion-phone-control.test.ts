import os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { ExecBytesResult, ExecResult, SystemPort } from '../src/core/gateway/device.js';
import { adbCandidates, parseDevices, parseUsbPhones, parseWmSize } from '../src/companion/phone-adb.js';
import { AnnexBSplitter, videoSize } from '../src/companion/phone-video.js';
import { LINK_PACKAGE, LINK_SERVICE, type MirrorStatus, PhoneControl, type PhoneLinkHandle, type PhoneTouch, type VideoPiece, describeScreen, describeUiautomator, parseNotifications, phoneErrorText, signerOf, withLinkService } from '../src/companion/phone-control.js';
import { DeviceBook, type DeviceRecord } from '../src/companion/devices.js';
import { type DeviceCert, MacFrame, PhoneFrame, type PhoneControl as PhoneControlState, type PhoneOp, type ScreenView } from '../src/companion/protocol.js';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { waitFor } from './helpers.js';

/** A fake adb: exec/execBytes answer from scripted matchers (first whose args match the join). */
function fakeSys(script: Array<{ match: RegExp; out?: string; code?: number; bytes?: Buffer }>): { sys: SystemPort; calls: string[] } {
  const calls: string[] = [];
  const answer = (args: readonly string[]): { out: string; code: number; bytes?: Buffer } => {
    const line = args.join(' ');
    calls.push(line);
    const hit = script.find((s) => s.match.test(line));
    return { out: hit?.out ?? '', code: hit?.code ?? 0, ...(hit?.bytes ? { bytes: hit.bytes } : {}) };
  };
  const sys: SystemPort = {
    exec: (_cmd, args): Promise<ExecResult> => {
      const a = answer(args);
      return Promise.resolve({ code: a.code, stdout: a.out, stderr: '' });
    },
    execBytes: (_cmd, args): Promise<ExecBytesResult> => {
      const a = answer(args);
      return Promise.resolve({ code: a.code, stdout: a.bytes ?? Buffer.from(a.out), stderr: Buffer.alloc(0) });
    },
    readdir: () => Promise.resolve([]),
    os: { ...os, homedir: () => '/Users/test' },
  };
  return { sys, calls };
}

function cert(device: string, platform: 'android' | 'ios' = 'android'): DeviceCert {
  return { v: 1, owner: 'me', ownerKey: 'k', device: device.padEnd(64, '0'), link: device.padEnd(64, '1'), box: device.padEnd(64, '2'), name: 'Test Phone', platform, issuedAt: 1, sig: 's' };
}

function book(records: DeviceRecord[]): DeviceBook {
  const b = new DeviceBook(path.join(mkdtempSync(path.join(os.tmpdir(), 'dev-')), 'devices.json'));
  for (const r of records) (b as unknown as { list: DeviceRecord[]; save(x: readonly DeviceRecord[]): void }).save([...(b.all()), r]);
  return b;
}

const control = (over: Partial<PhoneControlState> = {}): PhoneControlState => ({
  allowed: true,
  accessibility: true,
  screenshots: true,
  adb: { on: false },
  device: { model: 'Pixel 9', manufacturer: 'Google', android: '15', sdk: 35, w: 1080, h: 2400 },
  ...over,
});

/** A fake link whose requests record the op and return a scripted value. */
function fakeLink(id: string, state: PhoneControlState | undefined, onReq?: (op: PhoneOp, args: Record<string, unknown>) => unknown): PhoneLinkHandle & { reqs: Array<{ op: string }> } {
  const reqs: Array<{ op: string }> = [];
  return {
    deviceId: id,
    control: state,
    reqs,
    request: (op, args) => {
      reqs.push({ op });
      return Promise.resolve(onReq?.(op, args) ?? {});
    },
    openTunnel: () => ({ send: () => {}, ack: () => {}, close: () => {} }),
  };
}

describe('phone-adb', () => {
  // Not on Windows: POSIX paths in the fixtures.
  it.skipIf(process.platform === 'win32')('lists likely adb locations, SDK first', () => {
    const list = adbCandidates('/Users/x');
    expect(list[0]).toBe('/Users/x/Library/Android/sdk/platform-tools/adb');
    expect(list).toContain('/opt/homebrew/bin/adb');
  });

  it('parses `adb devices -l`, telling USB from Wi-Fi', () => {
    const out = 'List of devices attached\nR5CX12 device usb:1-1 product:x\n192.168.1.5:5555 device\n';
    const list = parseDevices(out);
    expect(list).toEqual([
      { serial: 'R5CX12', state: 'device', usb: true },
      { serial: '192.168.1.5:5555', state: 'device', usb: false },
    ]);
  });
});

describe('PhoneControl routes', () => {
  const id = 'aa';
  const device: DeviceRecord = { cert: cert(id), pairedAt: 1, use: 'use' };

  it('uses USB when a phone is plugged in', async () => {
    const { sys } = fakeSys([{ match: /devices -l/, out: 'List\nR5CX12 device usb:1-1\n' }]);
    const link = fakeLink(id.padEnd(16, '0'), control());
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    const r = await ctl.reach(id.padEnd(16, '0'));
    expect(r?.route).toBe('usb');
    expect(r?.adb?.serial).toBe('R5CX12');
  });

  it('reaches Wireless debugging only through the link, never straight to an address on the network (BLG-187)', async () => {
    const { sys, calls } = fakeSys([
      { match: /devices -l/, out: 'List\n' },
      { match: /connect 127\.0\.0\.1:\d+/, out: 'connected to 127.0.0.1' },
    ]);
    const link = fakeLink(id.padEnd(16, '0'), control({ adb: { on: true, port: 40000 }, wifi: { ip: '192.168.1.9' } }));
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    const r = await ctl.reach(id.padEnd(16, '0'));
    ctl.stop();
    expect(r?.route).toBe('link');
    expect(r?.adb?.serial).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(calls.some((c) => /192\.168\.1\.9/.test(c))).toBe(false);
  });

  it('falls back to the Accessibility service when there is no adb', async () => {
    const { sys } = fakeSys([{ match: /version/, code: 1 }]);
    const link = fakeLink(id.padEnd(16, '0'), control());
    // No adbPath override: discovery runs and finds nothing.
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, home: '/nope' });
    const r = await ctl.reach(id.padEnd(16, '0'));
    expect(r?.route).toBe('accessibility');
  });

  it('is off (no reach) until the phone is turned on', async () => {
    const { sys } = fakeSys([]);
    const off: DeviceRecord = { cert: cert(id), pairedAt: 1, use: 'off' };
    const link = fakeLink(id.padEnd(16, '0'), control());
    const ctl = new PhoneControl({ sys, devices: book([off]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    await expect(ctl.screenshot(id.padEnd(16, '0'))).rejects.toThrow(/off for your agent/);
  });
});

describe('PhoneControl operations', () => {
  const id = 'bb'.padEnd(16, '0');
  const device: DeviceRecord = { cert: cert('bb'), pairedAt: 1, use: 'use' };

  it('taps over adb with input tap', async () => {
    const { sys, calls } = fakeSys([{ match: /devices -l/, out: 'List\nR5 device usb:1\n' }]);
    const link = fakeLink(id, control());
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    await ctl.tap(id, { x: 100, y: 200 });
    expect(calls.some((c) => /shell input tap 100 200/.test(c))).toBe(true);
  });

  it('taps a screen node over the Accessibility service when there is no adb', async () => {
    const { sys } = fakeSys([{ match: /version/, code: 1 }]);
    const link = fakeLink(id, control());
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, home: '/nope' });
    await ctl.tap(id, { x: 0, y: 0, node: 3 });
    expect(link.reqs).toEqual([{ op: 'tap' }]);
  });

  it('refuses a shell command when only the Accessibility service is there', async () => {
    const { sys } = fakeSys([{ match: /version/, code: 1 }]);
    const link = fakeLink(id, control());
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, home: '/nope' });
    await expect(ctl.shell(id, 'ls')).rejects.toThrow(/Wireless debugging/);
  });

  it('screenshots over adb as PNG bytes', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const { sys } = fakeSys([
      { match: /devices -l/, out: 'List\nR5 device usb:1\n' },
      { match: /exec-out screencap/, bytes: png },
    ]);
    const link = fakeLink(id, control());
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    const shot = await ctl.screenshot(id);
    expect(shot.mime).toBe('image/png');
    expect(shot.image.equals(png)).toBe(true);
  });
});

describe('mirror and action (BLG-171)', () => {
  const id = 'cc'.padEnd(16, '0');
  const device: DeviceRecord = { cert: cert('cc'), pairedAt: 1, use: 'use' };
  // A 1×1 PNG (valid IHDR: 1×1), so pngSize reads 1×1.
  const onePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA', 'base64');

  it('action() taps over adb when the Accessibility service is off', async () => {
    const { sys, calls } = fakeSys([{ match: /devices -l/, out: 'List\nR5 device usb:1\n' }]);
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => fakeLink(id, control({ accessibility: false })), onChange: () => {}, adbPath: '/fake/adb' });
    await ctl.action(id, 'tap', { x: 5, y: 9 });
    expect(calls.some((c) => /shell input tap 5 9/.test(c))).toBe(true);
  });

  it('runEnv puts adb on PATH for the owner’s Bash (at Full)', () => {
    const { sys } = fakeSys([]);
    const ctl = new PhoneControl({ sys, devices: book([{ ...device, use: 'full' }]), link: () => fakeLink(id, control()), onChange: () => {}, adbPath: '/opt/sdk/platform-tools/adb' });
    const env = ctl.runEnv();
    expect(env.PATH?.startsWith('/opt/sdk/platform-tools')).toBe(true);
  });

  it('startMirror streams frames over adb and stops cleanly', async () => {
    const { sys } = fakeSys([
      { match: /devices -l/, out: 'List\nR5 device usb:1\n' },
      { match: /exec-out screencap/, bytes: onePng },
    ]);
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => fakeLink(id, control()), onChange: () => {}, adbPath: '/fake/adb' });
    const frames: Array<{ mime: string }> = [];
    let route: string | undefined;
    const stop = ctl.startMirror(id, { fps: 30 }, (f) => frames.push(f), (srv) => { if (srv.route) route = srv.route; });
    await new Promise((r) => setTimeout(r, 120));
    stop();
    const got = frames.length;
    expect(got).toBeGreaterThan(0);
    expect(frames[0]!.mime).toBe('image/png');
    expect(route).toBe('usb');
    // After stop, no more frames arrive.
    await new Promise((r) => setTimeout(r, 80));
    expect(frames.length).toBe(got);
  });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('a smooth mirror (BLG-184)', () => {
  const id = 'ee'.padEnd(16, '0');
  const device: DeviceRecord = { cert: cert('ee'), pairedAt: 1, use: 'use' };
  const shot = { b64: 'AAAA', mime: 'image/jpeg', w: 1080, h: 2400 };

  it('waits out Android’s screenshot gap instead of showing an error, and finds the route once', async () => {
    const { sys, calls } = fakeSys([{ match: /devices -l/, out: 'List\n' }]);
    let n = 0;
    const link = fakeLink(id, control(), (op) => {
      if (op !== 'screenshot') return {};
      // Every other one comes too soon after the last (Android's 333 ms rule): code 3.
      if (++n % 2 === 0) throw new Error("Call to function 'PhoneControl.perform' has been rejected.\n\u00e2\u0086\u0092 Caused by: java.lang.IllegalStateException: The screenshot failed (code 3); the screen may be protected");
      return shot;
    });
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    const frames: unknown[] = [];
    const statuses: MirrorStatus[] = [];
    const stop = ctl.startMirror(id, { fps: 30 }, (f) => frames.push(f), (st) => statuses.push(st));
    await sleep(1300);
    stop();
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(statuses.filter((st) => st.error)).toEqual([]);
    expect(statuses[0]).toMatchObject({ on: true, route: 'accessibility' });
    expect(calls.filter((c) => /devices -l/.test(c))).toHaveLength(1);
    // An app without video is never asked for it.
    expect(link.reqs.some((r) => r.op === 'mirror')).toBe(false);
  });

  it('plays live video once the phone streams, and shows pictures again when it stops', async () => {
    const { sys } = fakeSys([{ match: /devices -l/, out: 'List\n' }]);
    let piece: ((p: VideoPiece) => void) | undefined;
    let end: ((reason?: string) => void) | undefined;
    const asked: Array<Record<string, unknown>> = [];
    const base = fakeLink(id, control({ video: true }), (op, args) => {
      if (op === 'mirror') {
        asked.push(args);
        return { state: args.on ? 'asking' : 'off' };
      }
      return op === 'screenshot' ? shot : {};
    });
    const link: PhoneLinkHandle = {
      ...base,
      video: true,
      watchVideo: (onPiece, onEnd) => {
        piece = onPiece;
        end = onEnd;
        return () => (piece = undefined);
      },
    };
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    const frames: unknown[] = [];
    const pieces: VideoPiece[] = [];
    const statuses: MirrorStatus[] = [];
    const stop = ctl.startMirror(id, { fps: 30, video: true }, (f) => frames.push(f), (st) => statuses.push(st), (p) => pieces.push(p));
    await sleep(60);
    expect(asked[0]).toMatchObject({ on: true, max: 1280, fps: 30 });
    expect(statuses.some((st) => st.video === 'asking')).toBe(true);
    expect(frames.length).toBeGreaterThan(0); // pictures while the phone asks "Start now"

    // "Start now": pieces flow (a still screen still sends a few a second), and pictures stop.
    const flow = setInterval(() => piece?.({ seq: pieces.length, b64: 'AAAB', key: pieces.length === 0, ts: 0, w: 592, h: 1280, sw: 1440, sh: 3120 }), 50);
    await sleep(500);
    const shown = frames.length;
    await sleep(700);
    expect(pieces.length).toBeGreaterThan(10);
    expect(statuses.at(-1)).toMatchObject({ on: true, video: 'on' });
    expect(frames.length).toBe(shown);

    // The phone stops it (said no, or pressed Stop): pictures again, with a word why.
    clearInterval(flow);
    end?.('Not allowed on the phone');
    await sleep(700);
    expect(frames.length).toBeGreaterThan(shown);
    expect(statuses.at(-1)?.video).toBeUndefined();
    expect(statuses.some((st) => st.note === 'Not allowed on the phone')).toBe(true);
    stop();
    await sleep(10);
    expect(asked.at(-1)).toEqual({ on: false });
  });

  it('keeps only the cause’s own words from the app’s native errors', () => {
    expect(phoneErrorText("Call to function 'PhoneControl.perform' has been rejected.\n\u00e2\u0086\u0092 Caused by: java.lang.IllegalStateException: No text field has the focus")).toBe('No text field has the focus');
    expect(phoneErrorText("Call to function 'PhoneControl.perform' has been rejected.\n→ Caused by: java.util.concurrent.ExecutionException: java.lang.IllegalStateException: The screenshot failed (code 3); x")).toBe('The screenshot failed (code 3); x');
    expect(phoneErrorText('sh.ratel.beluga.control.BelugaAccessibilityService$TooSoon: The screenshot failed (code 3): asked too soon')).toBe('The screenshot failed (code 3): asked too soon');
    expect(phoneErrorText('Turn on Accessibility for Beluga on the phone')).toBe('Turn on Accessibility for Beluga on the phone');
  });

  it('has the video frames in the protocol', () => {
    expect(PhoneFrame.safeParse({ t: 'vid', seq: 3, b64: 'AAAB', key: true, ts: 1000, w: 592, h: 1280, sw: 1440, sh: 3120 }).success).toBe(true);
    expect(PhoneFrame.safeParse({ t: 'vid_end', reason: 'Not allowed on the phone' }).success).toBe(true);
    expect(MacFrame.safeParse({ t: 'vid_ack', seq: 3 }).success).toBe(true);
    expect(MacFrame.safeParse({ t: 'req', id: 1, op: 'mirror', args: { on: true } }).success).toBe(true);
  });
});

// ---- BLG-185/186/187: video over adb, quick taps, Claude's touches, Wi-Fi debugging found by name

/** Annex B units: a start code (4-byte for parameter sets, 3-byte for pictures, as encoders write them) and the unit. */
const unit = (bytes: number[], long = false): number[] => [...(long ? [0, 0, 0, 1] : [0, 0, 1]), ...bytes];
const SPS_U = [0x67, 0x42, 0xc0, 0x1f, 0xda];
const PPS_U = [0x68, 0xce, 0x3c, 0x80];
// A key picture and a following one (first_mb_in_slice 0: the byte after the header has its top bit set).
const IDR_U = [0x65, 0x88, 0x84, 0x21, 0x10];
const P_U = [0x41, 0x9a, 0x22, 0x33];

/** A SystemPort whose `stream` plays `chunks` (a phone's screenrecord), then stays open until stop(). */
function streamingSys(script: Array<{ match: RegExp; out?: string; code?: number; bytes?: Buffer }>, chunks: Buffer[]): { sys: SystemPort; calls: string[]; stopped: () => boolean } {
  const base = fakeSys(script);
  let stopped = false;
  const sys: SystemPort = {
    ...base.sys,
    stream: (_cmd, args, onData) => {
      base.calls.push(args.join(' '));
      let i = 0;
      const tick = setInterval(() => {
        if (stopped || i >= chunks.length) return clearInterval(tick);
        onData(chunks[i++]!);
      }, 30);
      return { stop: () => void (stopped = true) };
    },
  };
  return { sys, calls: base.calls, stopped: () => stopped };
}

describe('the mirror over adb plays video (BLG-185)', () => {
  it('cuts a screenrecord stream into pictures, the SPS/PPS ahead of each key frame, whatever the chunks', async () => {
    const pieces: Array<{ bytes: number[]; key: boolean }> = [];
    const split = new AnnexBSplitter((bytes, key) => pieces.push({ bytes: [...bytes], key }), 20);
    const stream = Buffer.from([...unit(SPS_U, true), ...unit(PPS_U, true), ...unit(IDR_U), ...unit(P_U), ...unit(P_U)]);
    // In awkward pieces, as adb hands them over.
    for (const at of [3, 9, 17, 22]) split.push(stream.subarray([0, 3, 9, 17, 22].at([3, 9, 17, 22].indexOf(at))!, at));
    split.push(stream.subarray(22));
    await new Promise((r) => setTimeout(r, 60));
    expect(pieces.map((p) => p.key)).toEqual([true, false, false]);
    expect(pieces[0]!.bytes).toEqual([...unit(SPS_U, true), ...unit(PPS_U, true), ...unit(IDR_U)]);
    // The last picture isn't held back until the screen changes again: a pause lets it go.
    expect(pieces[2]!.bytes).toEqual(unit(P_U));
    split.close();
  });

  it('after a picture cut short, waits for the next key frame', async () => {
    const pieces: boolean[] = [];
    const split = new AnnexBSplitter((_b, key) => pieces.push(key), 10);
    split.push(Buffer.from([...unit(SPS_U, true), ...unit(PPS_U, true), ...unit(IDR_U)]));
    await new Promise((r) => setTimeout(r, 30));
    // The rest of that picture came late (no start code): broken until a key frame.
    split.push(Buffer.from([0x11, 0x22, ...unit(P_U), ...unit(P_U)]));
    await new Promise((r) => setTimeout(r, 30));
    split.push(Buffer.from([...unit(IDR_U), ...unit(P_U)]));
    await new Promise((r) => setTimeout(r, 30));
    expect(pieces).toEqual([true, true, false]);
    split.close();
  });

  it('reads the screen’s size, the video’s size, and the phone on the network', () => {
    expect(parseWmSize('Physical size: 1440x3120\n')).toEqual({ w: 1440, h: 3120 });
    expect(parseWmSize('Physical size: 1440x3120\nOverride size: 1080x2340\n')).toEqual({ w: 1080, h: 2340 });
    expect(videoSize({ w: 1440, h: 3120 }, 1280)).toEqual({ w: 592, h: 1280 });
    // adb's own name for a phone it reached over Wi-Fi isn't a USB one.
    expect(parseDevices('List\nadb-R5CX72-Ab1Cd2._adb-tls-connect._tcp device product:x\n')[0]?.usb).toBe(false);
  });

  const id = 'ff'.padEnd(16, '0');
  const device: DeviceRecord = { cert: cert('ff'), pairedAt: 1, use: 'use' };
  const onePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA', 'base64');

  it('streams screenrecord over USB instead of a picture each time, and stops it with the mirror', async () => {
    const chunks = [Buffer.from([...unit(SPS_U, true), ...unit(PPS_U, true), ...unit(IDR_U)]), Buffer.from(unit(P_U)), Buffer.from(unit(P_U))];
    const { sys, calls, stopped } = streamingSys(
      [
        { match: /devices -l/, out: 'List\nR5CX72 device usb:1-1\n' },
        { match: /wm size/, out: 'Physical size: 1440x3120\n' },
        { match: /exec-out screencap/, bytes: onePng },
      ],
      chunks,
    );
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => fakeLink(id, control()), onChange: () => {}, adbPath: '/fake/adb' });
    const pieces: VideoPiece[] = [];
    const statuses: MirrorStatus[] = [];
    const stop = ctl.startMirror(id, { fps: 30, video: true }, () => {}, (st) => statuses.push(st), (p) => pieces.push(p));
    // The three pieces, however long a busy machine takes to pass them on (a fixed wait failed under load).
    await waitFor(() => pieces.length >= 3, 10_000);
    const record = calls.find((c) => /screenrecord/.test(c));
    expect(record).toContain('--output-format=h264 --size 592x1280 --bit-rate 6000000');
    expect(pieces.map((p) => p.key)).toEqual([true, false, false]);
    expect(pieces[0]).toMatchObject({ w: 592, h: 1280, sw: 1440, sh: 3120 });
    expect(statuses.at(-1)).toMatchObject({ on: true, route: 'usb', video: 'on' });
    // A still screen sends nothing over adb, and that's fine: no pictures while the stream runs.
    const shots = calls.filter((c) => /screencap/.test(c)).length;
    await sleep(400);
    expect(calls.filter((c) => /screencap/.test(c)).length).toBe(shots);
    stop();
    expect(stopped()).toBe(true);
  });

  it('the mirror’s own taps go by the Accessibility service when it’s on, and the route is reused', async () => {
    const { sys, calls } = fakeSys([{ match: /devices -l/, out: 'List\nR5CX72 device usb:1-1\n' }]);
    const link = fakeLink(id, control());
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    await ctl.action(id, 'tap', { x: 5, y: 9 });
    await ctl.action(id, 'swipe', { x1: 1, y1: 2, x2: 3, y2: 4 });
    expect(link.reqs.map((r) => r.op)).toEqual(['tap', 'swipe']);
    expect(calls.some((c) => /input tap/.test(c))).toBe(false);
    expect(calls.filter((c) => /devices -l/.test(c))).toHaveLength(1);
  });

  it('shows the mirrors what Claude does, and counts the phone busy a while', async () => {
    const { sys } = fakeSys([{ match: /version/, code: 1 }]);
    const link = fakeLink(id, control());
    let changes = 0;
    const devices = book([device]);
    const ctl = new PhoneControl({ sys, devices, link: () => link, onChange: () => void changes++, home: '/nope' });
    const seen: PhoneTouch[] = [];
    const off = ctl.onTouch(id, (t) => seen.push(t));
    const kit = ctl.toolsFor()!;
    expect(ctl.controlView(id).busy).toBeUndefined();
    await kit.tools.tap({ x: 100, y: 200 });
    await kit.tools.swipe({ x1: 1, y1: 2, x2: 3, y2: 4 });
    await kit.tools.type({ text: 'secret' });
    await kit.tools.key('back');
    expect(seen).toEqual([{ op: 'tap', x: 100, y: 200 }, { op: 'swipe', x: 1, y: 2, x2: 3, y2: 4 }, { op: 'type' }, { op: 'key', what: 'back' }]);
    expect(JSON.stringify(seen)).not.toContain('secret');
    expect(ctl.controlView(id).busy).toBe(true);
    expect(changes).toBeGreaterThan(0);
    off();
  });
});

describe('Wireless debugging, safely (BLG-187)', () => {
  const id = 'ab'.padEnd(16, '0');
  const device: DeviceRecord = { cert: cert('ab'), pairedAt: 1, use: 'use' };

  it('the phone’s Stop cuts every route, adb’s too, and holds while its app is away', async () => {
    const { sys } = fakeSys([{ match: /devices -l/, out: 'List\nR5CX72 device usb:1-1\n' }]);
    let link: PhoneLinkHandle | undefined = fakeLink(id, control({ allowed: false }));
    const devices = book([device]);
    const ctl = new PhoneControl({ sys, devices, link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    expect(await ctl.reach(id)).toBeUndefined();
    await expect(ctl.tap(id, { x: 1, y: 2 })).rejects.toThrow(/said Stop/);
    ctl.touched(id);
    expect(devices.get(id)?.stopped).toBe(true);
    // Its app goes away: still no, even with the cable in.
    link = undefined;
    expect(await ctl.reach(id)).toBeUndefined();
    expect(ctl.controlView(id).routes).toEqual([]);
    // It says yes again.
    link = fakeLink(id, control());
    ctl.touched(id);
    expect(devices.get(id)?.stopped).toBe(false);
    expect((await ctl.reach(id))?.route).toBe('usb');
  });

  it('Use over Wi‑Fi turns it on over the cable, waits for Allow, and reaches it through the link; Turn Off turns it off', async () => {
    let allowed = 0;
    const { sys, calls } = fakeSys([
      { match: /devices -l/, out: 'List\nR5CX72 device usb:1-1\n' },
      { match: /connect 127\.0\.0\.1:\d+/, out: 'connected to 127.0.0.1' },
    ]);
    // Android keeps it at 0 until the person taps Allow (here: the second time it's read).
    const exec = sys.exec;
    sys.exec = (cmd, args, t) => (args.join(' ').includes('settings get global adb_wifi_enabled') ? Promise.resolve({ code: 0, stdout: ++allowed > 1 ? '1\n' : '0\n', stderr: '' }) : exec(cmd, args, t));
    const link = fakeLink(id, control({ adb: { on: true, port: 40000 } }));
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    const said = await ctl.setWifiDebugging(id, true);
    expect(said).toMatch(/encrypted link/);
    expect(calls.some((c) => /shell settings put global adb_wifi_enabled 1/.test(c))).toBe(true);
    expect(calls.some((c) => /connect 127\.0\.0\.1:\d+/.test(c))).toBe(true);
    expect(await ctl.setWifiDebugging(id, false)).toBe('Wireless debugging is off.');
    expect(calls.some((c) => /shell settings put global adb_wifi_enabled 0/.test(c))).toBe(true);
    ctl.stop();
  });

  // BLG-189: straight over the Wi-Fi only once the phone proves it's the one there; else through the link.
  const wifiState = control({ adb: { on: true, port: 40000 }, wifi: { ip: '192.168.1.9' } });
  /** A link whose phone keeps the one-time code it's sent (as the app does), and a device at the address that may or may not be it. */
  function proofKit(at: 'phone' | 'impostor' | 'nobody', proofs = true) {
    let kept = '';
    const base = fakeLink(id, wifiState, (op, args) => {
      if (op !== 'proof') return {};
      kept = String(args.nonce);
      return { path: '/storage/emulated/0/Android/data/sh.ratel.beluga/files/beluga-proof' };
    });
    const link: PhoneLinkHandle = { ...base, proofs };
    const { sys, calls } = fakeSys([
      { match: /devices -l/, out: 'List\n' },
      { match: /connect 192\.168\.1\.9:40000/, out: at === 'nobody' ? 'failed to connect to 192.168.1.9:40000: Operation timed out' : 'connected to 192.168.1.9:40000' },
      { match: /connect 127\.0\.0\.1:\d+/, out: 'connected to 127.0.0.1' },
    ]);
    const exec = sys.exec;
    sys.exec = (cmd, args, t) => {
      if (!args.join(' ').includes('shell cat')) return exec(cmd, args, t);
      calls.push(args.join(' '));
      return Promise.resolve({ code: 0, stdout: at === 'phone' ? `${kept}\n` : 'something else\n', stderr: '' });
    };
    return { link, sys, calls };
  }

  it('connects straight over the Wi‑Fi once the phone proves it’s the one at that address', async () => {
    const { link, sys, calls } = proofKit('phone');
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    const r = await ctl.reach(id);
    ctl.stop();
    expect(r?.route).toBe('wifi');
    expect(r?.adb?.serial).toBe('192.168.1.9:40000');
    expect(calls.some((c) => /-s 192\.168\.1\.9:40000 shell cat \/storage\/emulated\/0\/Android\/data\/sh\.ratel\.beluga\/files\/beluga-proof/.test(c))).toBe(true);
    expect(ctl.controlView(id).wifiPath).toBe('direct');
  });

  it('never uses a device at that address that can’t read the code back: the link instead', async () => {
    const { link, sys, calls } = proofKit('impostor');
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    const r = await ctl.reach(id);
    ctl.stop();
    expect(r?.route).toBe('link');
    expect(calls.some((c) => /disconnect 192\.168\.1\.9:40000/.test(c))).toBe(true);
  });

  it('says when the Wi‑Fi keeps devices apart, and goes through the link', async () => {
    const { link, sys } = proofKit('nobody');
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    const r = await ctl.reach(id);
    ctl.stop();
    expect(r?.route).toBe('link');
    expect(ctl.controlView(id).wifiPath).toBe('blocked');
    expect(ctl.summaryLine(id)).toContain('this Wi-Fi keeps devices apart');
  });

  it('an app that can’t prove itself is only ever reached through the link', async () => {
    const { link, sys, calls } = proofKit('phone', false);
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, adbPath: '/fake/adb' });
    expect((await ctl.reach(id))?.route).toBe('link');
    ctl.stop();
    expect(calls.some((c) => /192\.168\.1\.9/.test(c))).toBe(false);
  });

  it('gives Claude’s Bash adb only at Full (it’s a shell on the phone)', () => {
    const { sys } = fakeSys([]);
    const use = new PhoneControl({ sys, devices: book([device]), link: () => fakeLink(id, control()), onChange: () => {}, adbPath: '/opt/sdk/platform-tools/adb' });
    expect(use.runEnv()).toEqual({});
    const full = new PhoneControl({ sys, devices: book([{ ...device, use: 'full' }]), link: () => fakeLink(id, control()), onChange: () => {}, adbPath: '/opt/sdk/platform-tools/adb' });
    expect(full.runEnv().PATH?.startsWith('/opt/sdk/platform-tools')).toBe(true);
    use.stop();
    full.stop();
  });
});

describe('a phone on the cable (BLG-190)', () => {
  const ioreg = [
    '+-o Root  <class IORegistryEntry, id 0x100000100, retain 25>',
    '  +-o USB3.1 Hub@01100000  <class IOUSBHostDevice, id 0x1000, registered>',
    '  |   "idVendor" = 3034',
    '  |   "USB Product Name" = "USB3.1 Hub"',
    '  +-o SAMSUNG_Android@01120000  <class IOUSBHostDevice, id 0x2000, registered>',
    '      "idVendor" = 1256',
    '      "USB Product Name" = "SAMSUNG_Android"',
    '      "USB Vendor Name" = "SAMSUNG"',
    '      "USB Serial Number" = "R5CX72"',
  ].join('\n');
  const id = 'cb'.padEnd(16, '0');
  const record = (name: string): DeviceRecord => ({ cert: { ...cert('cb'), name }, pairedAt: 1, use: 'use' });

  it('sees an Android phone on USB from macOS’s own list, without adb', () => {
    expect(parseUsbPhones(ioreg)).toEqual([{ name: 'SAMSUNG Android', serial: 'R5CX72' }]);
    expect(parseUsbPhones('+-o Keyboard@1 <class IOUSBHostDevice>\n  "idVendor" = 1452\n  "USB Product Name" = "Magic Keyboard"')).toEqual([]);
  });

  it('says USB debugging is off when adb can’t see the phone, and asks for Allow when it’s unauthorized', async () => {
    const off = fakeSys([{ match: /-p IOUSB/, out: ioreg }, { match: /devices -l/, out: 'List of devices attached\n' }]);
    const a = new PhoneControl({ sys: off.sys, devices: book([]), link: () => undefined, onChange: () => {}, adbPath: '/fake/adb' });
    expect(await a.scanCable()).toEqual({ state: 'no-debugging', name: 'SAMSUNG Android' });
    expect(a.adbView().cable?.state).toBe('no-debugging');
    const asking = fakeSys([{ match: /-p IOUSB/, out: ioreg }, { match: /devices -l/, out: 'List of devices attached\nR5CX72 unauthorized usb:1-1 transport_id:1\n' }]);
    const b = new PhoneControl({ sys: asking.sys, devices: book([]), link: () => undefined, onChange: () => {}, adbPath: '/fake/adb' });
    expect((await b.scanCable())?.state).toBe('unauthorized');
    // Nothing on the cable: nothing said, and adb isn't even asked.
    const none = fakeSys([{ match: /-p IOUSB/, out: '+-o Root\n' }]);
    const c = new PhoneControl({ sys: none.sys, devices: book([]), link: () => undefined, onChange: () => {}, adbPath: '/fake/adb' });
    expect(await c.scanCable()).toBeUndefined();
    expect(none.calls.some((l) => /devices/.test(l))).toBe(false);
  });

  it('offers to pair over the cable when Beluga is on it but it isn’t paired here, and opens the pairing on the phone', async () => {
    const script = [
      { match: /-p IOUSB/, out: ioreg },
      { match: /devices -l/, out: 'List of devices attached\nR5CX72 device usb:1-1 product:x model:SM_S926B\n' },
      { match: /pm path sh\.ratel\.beluga/, out: 'package:/data/app/sh.ratel.beluga/base.apk\nSad Printer\n' },
    ];
    const fresh = fakeSys(script);
    const ctl = new PhoneControl({ sys: fresh.sys, devices: book([]), link: () => undefined, onChange: () => {}, adbPath: '/fake/adb' });
    expect(await ctl.scanCable()).toEqual({ state: 'ready', name: 'Sad Printer', canPair: true });
    await ctl.openPairingOnCable('beluga://device#AbCdEfGhIjKlMnOpQrStUv?r=wss%3A%2F%2Fx.trycloudflare.com');
    expect(fresh.calls.some((l) => l.includes("shell am start -a android.intent.action.VIEW -d 'beluga://device#AbCdEfGhIjKlMnOpQrStUv?r=wss%3A%2F%2Fx.trycloudflare.com' sh.ratel.beluga"))).toBe(true);
    await expect(ctl.openPairingOnCable("beluga://device#x'; reboot; '")).rejects.toThrow(/Not a pairing link/);
    // Already paired with this Mac (its name): nothing to offer.
    const paired = fakeSys(script);
    const known = new PhoneControl({ sys: paired.sys, devices: book([record('Sad Printer')]), link: () => undefined, onChange: () => {}, adbPath: '/fake/adb' });
    expect(await known.scanCable()).toEqual({ state: 'ready', name: 'Sad Printer' });
    // Its Settings › Phone knows it's on the cable, so Set Up Beluga Link can be pressed.
    expect(known.controlView(id).usb).toBe(true);
    const other = new PhoneControl({ sys: paired.sys, devices: book([record('Other Phone')]), link: () => undefined, onChange: () => {}, adbPath: '/fake/adb' });
    await other.scanCable();
    expect(other.controlView(id).usb).toBe(false);
  });

  it('reads every device’s properties only when the USB tree isn’t the one that had no phone last time (BLG-407)', async () => {
    const tree = (...devices: string[]) =>
      [
        '+-o Root  <class IORegistryEntry, id 0x100000100, retain 36>',
        '  +-o AppleT8132USBXHCI@00000000  <class AppleT8132USBXHCI, id 0x100000530, registered, matched, active, busy 0 (17 ms), retain 37>',
        ...devices,
      ].join('\n');
    const phoneLine = '    +-o SAMSUNG_Android@01120000  <class IOUSBHostDevice, id 0x2000, registered, matched, active, busy 0 (5 ms), retain 20>';
    let short = tree();
    let full = `${tree()}\n    "IOClass" = "AppleT8132USBXHCI"`;
    const calls: string[] = [];
    const sys = {
      exec: (_cmd: string, args: readonly string[]) => {
        const line = args.join(' ');
        calls.push(line);
        if (line === '-p IOUSB -w0') return Promise.resolve({ code: 0, stdout: short, stderr: '' });
        if (line === '-p IOUSB -l -w0') return Promise.resolve({ code: 0, stdout: full, stderr: '' });
        return Promise.resolve({ code: 0, stdout: 'List of devices attached\n', stderr: '' });
      },
    } as unknown as SystemPort;
    const fullReads = () => calls.filter((l) => l === '-p IOUSB -l -w0').length;
    const ctl = new PhoneControl({ sys, devices: book([]), link: () => undefined, onChange: () => {}, adbPath: '/fake/adb' });
    expect(await ctl.scanCable()).toBeUndefined();
    expect(fullReads()).toBe(1);
    // The same tree (busy times and retain counts move on their own): nothing new on it.
    short = short.replace('busy 0 (17 ms), retain 37', 'busy 0 (19 ms), retain 41');
    expect(await ctl.scanCable()).toBeUndefined();
    expect(fullReads()).toBe(1);
    // Plugged in: seen on that very scan.
    short = tree(phoneLine);
    full = `${tree(phoneLine)}\n      "idVendor" = 1256\n      "USB Product Name" = "SAMSUNG_Android"`;
    expect(await ctl.scanCable()).toEqual({ state: 'no-debugging', name: 'SAMSUNG Android' });
    expect(fullReads()).toBe(2);
    // While a phone is there, every scan reads it all, as before.
    expect((await ctl.scanCable())?.state).toBe('no-debugging');
    expect(fullReads()).toBe(3);
    // A device still settling (not yet matched) is read in full until it has.
    short = tree('    +-o Thing@1  <class IOUSBHostDevice, id 0x3000, registered, busy 1 (2 ms), retain 5>');
    full = short;
    expect(await ctl.scanCable()).toBeUndefined();
    expect(await ctl.scanCable()).toBeUndefined();
    expect(fullReads()).toBe(5);
    // The short list failing: the full one, as before.
    short = '';
    expect(await ctl.scanCable()).toBeUndefined();
    expect(fullReads()).toBe(6);
    ctl.stop();
  });
});

describe('macros (BLG-175)', () => {
  const id = 'dd'.padEnd(16, '0');
  const device: DeviceRecord = { cert: cert('dd'), pairedAt: 1, use: 'use' };
  const screen = { gen: 1, app: 'com.x', w: 1080, h: 2400, nodes: [{ i: 0, d: 0, c: 'Button', t: 'Send', b: [100, 200, 300, 260], f: 'c' }] };

  it('runs a flow, finding tapText by on-screen text (Accessibility route)', async () => {
    const { sys } = fakeSys([{ match: /version/, code: 1 }]); // no adb → Accessibility
    const link = fakeLink(id, control(), (op) => (op === 'screen' ? screen : {}));
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => link, onChange: () => {}, home: '/nope' });
    const log = await ctl.runMacro(id, [{ op: 'open', package: 'com.x' }, { op: 'tapText', text: 'Send' }]);
    const ops = link.reqs.map((r) => r.op);
    expect(ops).toContain('open');
    expect(ops).toContain('screen');
    expect(ops).toContain('tap');
    expect(log).toContain('tapped “Send”');
  });
});

describe('notifications (BLG-176)', () => {
  it('parses dumpsys notification records', () => {
    const dump = [
      'NotificationRecord(0x1 pkg=com.whatsapp user=0',
      '      android.title=String (Mum)',
      '      android.text=String (Call me when you land)',
      'NotificationRecord(0x2 pkg=com.google.android.gm user=0',
      '      android.title=String (3 new emails)',
      '      android.text=String (Receipts and more)',
    ].join('\n');
    const list = parseNotifications(dump);
    expect(list).toEqual([
      { app: 'com.whatsapp', title: 'Mum', text: 'Call me when you land' },
      { app: 'com.google.android.gm', title: '3 new emails', text: 'Receipts and more' },
    ]);
  });
});

describe('screen descriptions', () => {
  it('turns an Accessibility tree into tappable lines', () => {
    const view: ScreenView = {
      gen: 1,
      app: 'com.app',
      w: 1080,
      h: 2400,
      nodes: [
        { i: 0, d: 0, c: 'Button', t: 'Send', b: [0, 0, 100, 50], f: 'c' },
        { i: 1, d: 1, c: 'EditText', h: 'Message', b: [0, 60, 500, 110], f: 'e' },
      ],
    };
    const text = describeScreen(view);
    expect(text).toContain('#0 Button "Send" (tap) @50,25');
    expect(text).toContain('#1 EditText "Message" (type) @250,85');
  });

  it('turns uiautomator XML into the same kind of lines', () => {
    const xml = '<hierarchy><node text="OK" resource-id="com.app:id/ok" class="android.widget.Button" clickable="true" bounds="[10,20][110,70]"/></hierarchy>';
    const text = describeUiautomator(xml);
    expect(text).toContain('#0 Button "OK" [ok] (tap) @60,45');
  });
});

describe('Beluga Link from the Mac (BLG-391)', () => {
  const id = 'bb'.padEnd(16, '0');
  const device: DeviceRecord = { cert: cert('bb'), pairedAt: 1, use: 'use' };

  it('adds Link to the Accessibility services on, keeps the others, and drops Beluga’s own from before 1.6.0', () => {
    expect(withLinkService('null')).toBe(LINK_SERVICE);
    expect(withLinkService('')).toBe(LINK_SERVICE);
    expect(withLinkService('com.a/.Svc:sh.ratel.beluga/sh.ratel.beluga.control.BelugaAccessibilityService')).toBe(`com.a/.Svc:${LINK_SERVICE}`);
    expect(withLinkService(`com.a/com.a.Svc$Inner:${LINK_SERVICE}`)).toBe(`com.a/com.a.Svc$Inner:${LINK_SERVICE}`);
    expect(() => withLinkService("com.a/.Svc';reboot")).toThrow(/can’t safely rewrite/);
  });

  it('installs the downloaded Link over adb and turns it on, with nothing to tap on the phone', async () => {
    const { sys, calls } = fakeSys([
      { match: /devices -l/, out: 'List\nR5CX12 device usb:1-1\n' },
      { match: /pm list packages/, out: '' },
      { match: /install -r --user 0/, out: 'Performing Streamed Install\nSuccess\n' },
      { match: /settings get secure enabled_accessibility_services/, out: 'com.a/.Svc\n' },
    ]);
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => fakeLink(id, control({ accessibility: false })), onChange: () => {}, adbPath: '/fake/adb' });
    const got: string[] = [];
    const said = await ctl.setUpLink(id, async (to) => void got.push(to));
    expect(said).toMatch(/installed and on/);
    expect(got[0]).toMatch(/Beluga-Link\.apk$/);
    expect(calls.some((c) => c.includes(`settings put secure enabled_accessibility_services 'com.a/.Svc:${LINK_SERVICE}'`))).toBe(true);
    expect(calls.some((c) => c.includes('settings put secure accessibility_enabled 1'))).toBe(true);
  });

  it('skips the download when Link is installed already, and says what’s wrong when the phone refuses', async () => {
    const { sys, calls } = fakeSys([
      { match: /devices -l/, out: 'List\nR5CX12 device usb:1-1\n' },
      { match: /pm list packages/, out: `package:${LINK_PACKAGE}\n` },
      { match: /dumpsys package/, out: 'signatures=PackageSignatures{1 version:3, signatures:[8f3c1a2b], past signatures:[]}\n' },
      { match: /settings get secure enabled_accessibility_services/, out: `${LINK_SERVICE}\n` },
    ]);
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => fakeLink(id, control({ accessibility: false })), onChange: () => {}, adbPath: '/fake/adb' });
    await ctl.setUpLink(id, () => Promise.reject(new Error('should not download')));
    expect(calls.some((c) => c.includes('settings put'))).toBe(false);

    const refusing = fakeSys([
      { match: /devices -l/, out: 'List\nR5CX12 device usb:1-1\n' },
      { match: /install -r/, out: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]\n' },
    ]);
    const ctl2 = new PhoneControl({ sys: refusing.sys, devices: book([device]), link: () => fakeLink(id, control({ accessibility: false })), onChange: () => {}, adbPath: '/fake/adb' });
    await expect(ctl2.setUpLink(id, async () => {})).rejects.toThrow(/didn’t install Beluga Link: Failure \[INSTALL_FAILED_UPDATE_INCOMPATIBLE\]/);
  });

  it('replaces a Link signed with another key than the app (BLG-430)', async () => {
    let tries = 0;
    const { sys, calls } = fakeSys([
      { match: /devices -l/, out: 'List\nR5CX12 device usb:1-1\n' },
      { match: /pm list packages/, out: `package:${LINK_PACKAGE}\n` },
      { match: new RegExp(`dumpsys package ${LINK_PACKAGE.replace(/\./g, '\\.')}$`), out: 'signatures:[aaaa1111]\n' },
      { match: /dumpsys package sh\.ratel\.beluga$/, out: 'signatures:[bbbb2222]\n' },
      { match: /install -r --user 0/, get out() { return tries++ === 0 ? 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]\n' : 'Success\n'; } },
      { match: /settings get secure enabled_accessibility_services/, out: `${LINK_SERVICE}\n` },
    ]);
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => fakeLink(id, control({ accessibility: false })), onChange: () => {}, adbPath: '/fake/adb' });
    const got: string[] = [];
    await ctl.setUpLink(id, async (to) => void got.push(to));
    expect(got).toHaveLength(1);
    expect(calls.some((c) => c.includes(`pm uninstall --user 0 ${LINK_PACKAGE}`))).toBe(true);
    expect(calls.filter((c) => /install -r --user 0/.test(c))).toHaveLength(2);
  });

  it('reads who signed a package from dumpsys', () => {
    expect(signerOf('  signatures=PackageSignatures{f1 version:3, signatures:[8f3c1a2b], past signatures:[]}')).toBe('8f3c1a2b');
    expect(signerOf('Unable to find package')).toBeUndefined();
  });

  it('asks for a cable when adb can’t reach the phone', async () => {
    const { sys } = fakeSys([{ match: /devices -l/, out: 'List\n' }]);
    const ctl = new PhoneControl({ sys, devices: book([device]), link: () => fakeLink(id, control({ accessibility: false })), onChange: () => {}, adbPath: '/fake/adb' });
    await expect(ctl.setUpLink(id, async () => {})).rejects.toThrow(/cable/);
  });
});
