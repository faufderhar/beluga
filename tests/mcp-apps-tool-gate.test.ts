import { describe, expect, it } from 'vitest';
import { gateToolCall } from '../src/mcp-apps/domain/tool-gate.js';

const ui = (visibility?: string[]) => ({ ui: { resourceUri: 'ui://clock/app.html', ...(visibility ? { visibility } : {}) } });

describe('gateToolCall', () => {
  it('runs a readOnly tool of the app’s own server whose visibility includes app', () => {
    expect(gateToolCall({ appServer: 'clock', server: 'clock', tool: { name: 'now', annotations: { readOnly: true }, _meta: ui(['model', 'app']) }, approved: false })).toEqual({ kind: 'run' });
  });

  it('takes MCP’s readOnlyHint as readOnly too', () => {
    expect(gateToolCall({ appServer: 'clock', server: 'clock', tool: { name: 'now', annotations: { readOnlyHint: true } }, approved: false })).toEqual({ kind: 'run' });
  });

  it('runs a tool that declares no _meta: its visibility is model and app by default', () => {
    expect(gateToolCall({ appServer: 'clock', server: 'clock', tool: { name: 'now', annotations: { readOnly: true } }, approved: false })).toEqual({ kind: 'run' });
  });

  it('asks before a tool that is not readOnly', () => {
    expect(gateToolCall({ appServer: 'clock', server: 'clock', tool: { name: 'set_alarm', _meta: ui(['app']) }, approved: false })).toEqual({ kind: 'ask' });
  });

  it('runs a tool that is not readOnly once you said Always to it', () => {
    expect(gateToolCall({ appServer: 'clock', server: 'clock', tool: { name: 'set_alarm', _meta: ui(['app']) }, approved: true })).toEqual({ kind: 'run' });
  });

  it('refuses a tool of another server, even one you said Always to', () => {
    const d = gateToolCall({ appServer: 'clock', server: 'bank', tool: { name: 'balance', annotations: { readOnly: true } }, approved: true });
    expect(d.kind).toBe('refuse');
  });

  it('refuses a tool for the model only', () => {
    const d = gateToolCall({ appServer: 'clock', server: 'clock', tool: { name: 'now', annotations: { readOnly: true }, _meta: ui(['model']) }, approved: true });
    expect(d).toMatchObject({ kind: 'refuse' });
  });

  it('refuses a tool whose ui failed validation (visibility [] : neither audience)', () => {
    expect(gateToolCall({ appServer: 'clock', server: 'clock', tool: { name: 'now', annotations: { readOnly: true }, _meta: { ui: { visibility: [] } } }, approved: false }).kind).toBe('refuse');
  });

  it('refuses a tool the server doesn’t have', () => {
    expect(gateToolCall({ appServer: 'clock', server: 'clock', tool: undefined, approved: false }).kind).toBe('refuse');
  });
});
