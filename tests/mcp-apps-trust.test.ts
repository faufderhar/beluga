import { describe, expect, it } from 'vitest';
import { tracksMcpApps } from '../src/agent/runtime/claude/runner.js';

/** MCP Apps follow your MCP servers: only runs that load them keep apps on their steps. */
describe('tracksMcpApps', () => {
  it('tracks apps in your own runs (and Full-trust ones), which load your MCP servers', () => {
    expect(tracksMcpApps({ ownerMcp: true })).toBe(true);
  });

  it('records no app in a friend’s run (no owner servers) or a guest run', () => {
    expect(tracksMcpApps({})).toBe(false);
    expect(tracksMcpApps({ ownerMcp: true, guest: { owner: 'friend' } as never })).toBe(false);
  });
});
