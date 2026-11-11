import { describe, expect, it } from 'vitest';
import { EXTERNAL_ACCESS, type ExternalAccess } from '../src/external/coverage.js';
import { type Method, METHODS } from '../src/ipc/api.js';

const entries = Object.entries(EXTERNAL_ACCESS) as ReadonlyArray<readonly [Method, ExternalAccess]>;
const refusals = entries.flatMap(([m, a]) => (typeof a === 'object' ? [[m, a.refused] as const] : []));
const named = (access: ExternalAccess): Method[] => entries.filter(([, a]) => a === access).map(([m]) => m);

/** Methods that look like screen work but change what Beluga keeps, or read data. Kept short, by hand. */
const NEVER_UI_ONLY: readonly Method[] = ['session.clearChat', 'session.setPrefs', 'session.rename', 'workspaces.remove', 'workspaces.setGroup', 'workspaces.hideProject', 'workspaces.commit', 'files.save', 'files.read', 'diff.load', 'board.move', 'plans.approve', 'people.setTrust', 'network.messages.delete'];

describe('the external classification table', () => {
  it('decides each API method, and nothing else', () => {
    expect([...METHODS].sort()).toEqual(entries.map(([m]) => m).sort());
  });

  it('gives each refused method a reason of one line', () => {
    expect(refusals.length).toBeGreaterThan(0);
    for (const [method, reason] of refusals) {
      expect(reason.trim(), method).not.toBe('');
      expect(reason, method).not.toMatch(/\n/);
      expect(reason.length, method).toBeLessThanOrEqual(120);
    }
  });

  it('keeps a method that changes state or reads data out of ui_only', () => {
    const uiOnly = named('ui_only');
    expect(uiOnly.length).toBeGreaterThan(0);
    expect(NEVER_UI_ONLY.filter((m) => uiOnly.includes(m))).toEqual([]);
  });

  it('leaves no method without a final answer', () => {
    const answers = new Set(entries.map(([, a]) => (typeof a === 'object' ? 'refused' : a)));
    expect([...answers].sort()).toEqual(['covered', 'gated', 'refused', 'ui_only']);
  });

  it('refuses what no answer opens: approvals, grants, secret values, a browser session', () => {
    for (const m of METHODS.filter((x) => x.startsWith('external.'))) expect(EXTERNAL_ACCESS[m], m).toHaveProperty('refused');
    for (const m of ['host.answerApproval', 'gateway.confirm', 'gateway.decide', 'env.get', 'env.claudeDotenv', 'stripe.connect', 'sentinel.rotateSecret', 'web.link', 'web.public', 'web.tailscale'] as const) expect(EXTERNAL_ACCESS[m], m).toHaveProperty('refused');
  });

  it('an agent acts on the phone with a tool, and sets it up after one card', () => {
    for (const m of ['act', 'setUpLink', 'macros', 'macroRun', 'macroDelete'] as const) expect(EXTERNAL_ACCESS[`companion.phone.${m}`], m).toBe('covered');
    for (const m of ['use', 'pairAdb', 'wifi', 'pairCable', 'settings'] as const) expect(EXTERNAL_ACCESS[`companion.phone.${m}`], m).toBe('gated');
  });

  it('the former human-only operations ask one time', () => {
    for (const m of ['people.setTrust', 'session.setAccess', 'plans.approve', 'invites.create', 'session.setPrefs'] as const) expect(EXTERNAL_ACCESS[m], m).toBe('gated');
  });
});
