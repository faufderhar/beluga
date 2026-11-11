import { describe, expect, it } from 'vitest';
import { WEB_ADMIN } from '../src/daemon/server.js';
import { ClientRegistry } from '../src/daemon/clients.js';
import { METHODS } from '../src/ipc/api.js';
import { COMPUTER_CAPS, webUrl } from '../src/ipc/protocol.js';
import { MACHINE, machineRefuses } from '../src/machines/coverage.js';

/** What a driving app may do on a computer (BLG-776): the table, the caps, who is told. */

describe('the table of what your app may do on a computer', () => {
  it('names every API method, and nothing else', () => {
    expect(Object.keys(MACHINE).sort()).toEqual([...METHODS].sort());
  });

  it('refuses managing who gets in, and only that', () => {
    const refused = METHODS.filter((m) => MACHINE[m] === 'refuse').sort();
    expect(refused).toEqual(
      [
        ...WEB_ADMIN,
        'web.ways',
        'web.sessions.list',
        'companion.pair.start',
        'companion.pair.approve',
        'companion.pair.cancel',
        'companion.phone.pairAdb',
        'companion.phone.pairCable',
        'companion.devices.remove',
        'machines.pair.start',
        'machines.pair.status',
        'machines.pair.cancel',
        'machines.join.start',
        'machines.join.approve',
        'machines.join.cancel',
        'machines.ssh.hosts',
        'machines.ssh.pair',
        'machines.forget',
        'machines.update',
        'machines.leftBehind',
        'machines.look',
        // The .env asks and Always for This Project are your app's own (BLG-800).
        'machines.forwards',
        'machines.share',
        'machines.unshare',
        'machines.env.decide',
        // Sending this Mac's files to a computer is your app's own (BLG-793).
        'machines.upload.send',
        'machines.upload.check',
        'machines.download.fetch',
        'machines.editor',
        'machines.env.always',
        'machines.env.forget',
        // Who gets your secrets is said from your app's own Settings (BLG-805).
        'machines.secrets',
        // Your identity moves only from your app's own Settings (BLG-796).
        'machines.alwaysOn',
        // An external agent is let in from the computer itself.
        'external.pairingCode',
        'external.localToken',
        'external.setEnabled',
        'external.setRoute',
        'session.quit',
        'daemon.stop',
      ].sort(),
    );
  });

  it('lets everything a user does through', () => {
    for (const m of ['session.submit', 'workspaces.create', 'agent.stop', 'terminals.open', 'git.commit', 'board.create', 'sentinel.run', 'machines.list', 'machines.devices', 'network.friends.invite'] as const) {
      if (m in MACHINE) expect(machineRefuses(m)).toBe(false);
    }
    expect(machineRefuses('no.such.method')).toBe(false);
  });
});

describe('what a computer may ask of your app', () => {
  it('notify, copy, raise, a pasted image, and web pages only', () => {
    expect([...COMPUTER_CAPS].sort()).toEqual(['copyText', 'notify', 'openExternal', 'raise', 'readClipboardImage']);
    expect(webUrl('https://github.com/kayraucklnc/beluga/pull/1')).toBe(true);
    expect(webUrl('http://localhost:5173/')).toBe(true);
    for (const bad of ['file:///etc/hosts', 'vscode://file/x', 'javascript:alert(1)', 'smb://nas/share', '/etc/hosts', 'notaurl', 42, undefined]) expect(webUrl(bad)).toBe(false);
  });

  it('a computer’s notices go to your Mac app first, else your app driving it', () => {
    const reg = new ClientRegistry();
    const send = (): void => undefined;
    reg.add({ kind: 'web', version: '1', caps: ['notify'], send });
    const machine = reg.add({ kind: 'machine', version: '1', caps: ['notify'], send });
    expect(reg.pickNotifier()?.id).toBe(machine.id);
    const mac = reg.add({ kind: 'mac', version: '1', caps: ['notify'], send });
    expect(reg.pickNotifier()?.id).toBe(mac.id);
  });
});
