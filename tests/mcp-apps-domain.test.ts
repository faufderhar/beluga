import { mayHaveApps } from '../src/shared/mcp-apps.js';
import { describe, expect, it } from 'vitest';
import { appCsp } from '../src/mcp-apps/domain/csp.js';
import { boundStructured, STRUCTURED_MAX } from '../src/mcp-apps/domain/result.js';
import { splitMcpToolName } from '../src/mcp-apps/domain/tool-name.js';
import { resourceUiOf, toolUiOf } from '../src/mcp-apps/domain/ui-meta.js';

const ANCESTORS = 'tauri://localhost';

describe('toolUiOf', () => {
  it('reads ui.resourceUri and its visibility', () => {
    expect(toolUiOf({ ui: { resourceUri: 'ui://get-time/app.html', visibility: ['model', 'app'] } })).toEqual({ resourceUri: 'ui://get-time/app.html', visibility: ['model', 'app'] });
  });

  it('reads the legacy flat ui/resourceUri key', () => {
    expect(toolUiOf({ 'ui/resourceUri': 'ui://legacy/app.html' })).toEqual({ resourceUri: 'ui://legacy/app.html', visibility: ['model', 'app'] });
  });

  it('reads the ChatGPT openai/outputTemplate alias', () => {
    expect(toolUiOf({ 'openai/outputTemplate': 'ui://widget/app.html' })).toEqual({ resourceUri: 'ui://widget/app.html', visibility: ['model', 'app'] });
  });

  it('prefers ui.resourceUri over the other keys', () => {
    expect(toolUiOf({ ui: { resourceUri: 'ui://a' }, 'ui/resourceUri': 'ui://b', 'openai/outputTemplate': 'ui://c' })?.resourceUri).toBe('ui://a');
  });

  it('has no app for a missing or invalid ui', () => {
    expect(toolUiOf(undefined)).toBeUndefined();
    expect(toolUiOf(null)).toBeUndefined();
    expect(toolUiOf({})).toBeUndefined();
    expect(toolUiOf({ ui: 'ui://x' })).toBeUndefined();
    expect(toolUiOf({ ui: { resourceUri: 'https://evil.example/app.html' } })).toBeUndefined();
    expect(toolUiOf({ ui: { resourceUri: 42 } })).toBeUndefined();
    expect(toolUiOf({ ui: { resourceUri: `ui://${'x'.repeat(3000)}` } })).toBeUndefined();
  });

  it('keeps only known visibility entries', () => {
    expect(toolUiOf({ ui: { resourceUri: 'ui://a', visibility: ['app', 'bogus'] } })?.visibility).toEqual(['app']);
  });
});

describe('resourceUiOf', () => {
  it('reads csp, prefersBorder and permissions', () => {
    const ui = resourceUiOf({ ui: { csp: { connectDomains: ['https://api.example.com'], resourceDomains: ['https://cdn.example.com'] }, prefersBorder: true, permissions: { camera: {} } } });
    expect(ui).toEqual({ csp: { connectDomains: ['https://api.example.com'], resourceDomains: ['https://cdn.example.com'], frameDomains: [], baseUriDomains: [] }, prefersBorder: true, permissions: ['camera'] });
  });

  it('is empty for no meta', () => {
    expect(resourceUiOf(undefined)).toEqual({ csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, permissions: [] });
  });

  it('drops domains that are not plain https or wss origins', () => {
    const ui = resourceUiOf({ ui: { csp: { connectDomains: ['https://ok.example.com', "https://x.com; script-src 'unsafe-eval'", 'http://plain.example.com', 'javascript:alert(1)', '*', 'wss://*.live.example.com', 'https://*.osm.org'] } } });
    expect(ui.csp.connectDomains).toEqual(['https://ok.example.com', 'wss://*.live.example.com', 'https://*.osm.org']);
  });
});

describe('appCsp', () => {
  const none = { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] };

  it('allows no network by default', () => {
    const csp = appCsp(none, ANCESTORS);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain(`frame-ancestors ${ANCESTORS}`);
    expect(csp).not.toContain('https:');
  });

  it('adds connect, resource and frame domains where each belongs', () => {
    const csp = appCsp({ connectDomains: ['https://api.example.com'], resourceDomains: ['https://cdn.example.com'], frameDomains: ['https://www.youtube.com'], baseUriDomains: ['https://cdn.example.com'] }, ANCESTORS);
    const dir = (name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `));
    expect(dir('connect-src')).toBe('connect-src https://api.example.com');
    expect(dir('script-src')).toBe("script-src 'self' 'unsafe-inline' https://cdn.example.com");
    expect(dir('style-src')).toBe("style-src 'self' 'unsafe-inline' https://cdn.example.com");
    expect(dir('img-src')).toBe("img-src 'self' data: blob: https://cdn.example.com");
    expect(dir('font-src')).toBe("font-src 'self' data: https://cdn.example.com");
    expect(dir('frame-src')).toBe('frame-src https://www.youtube.com');
    expect(dir('base-uri')).toBe('base-uri https://cdn.example.com');
  });
});

describe('splitMcpToolName', () => {
  it('finds the server whose normalized name prefixes the tool', () => {
    expect(splitMcpToolName('mcp__basic__get-time', ['basic', 'map'])).toEqual({ server: 'basic', tool: 'get-time' });
    expect(splitMcpToolName('mcp__claude_ai_Slack__send', ['claude.ai Slack'])).toEqual({ server: 'claude.ai Slack', tool: 'send' });
  });

  it('prefers the longest server name', () => {
    expect(splitMcpToolName('mcp__a__b__tool', ['a', 'a__b'])).toEqual({ server: 'a__b', tool: 'tool' });
  });

  it('is undefined for other tools', () => {
    expect(splitMcpToolName('Bash', ['basic'])).toBeUndefined();
    expect(splitMcpToolName('mcp__other__x', ['basic'])).toBeUndefined();
  });
});

describe('boundStructured', () => {
  it('keeps small structured content', () => {
    expect(boundStructured({ structuredContent: { time: 'now' } })).toEqual({ time: 'now' });
  });

  it('is undefined when there is none or it is too big', () => {
    expect(boundStructured(undefined)).toBeUndefined();
    expect(boundStructured({ content: 'x' })).toBeUndefined();
    expect(boundStructured({ structuredContent: { big: 'x'.repeat(STRUCTURED_MAX) } })).toBeUndefined();
  });
});

describe('mayHaveApps', () => {
  it('is true only for a card that called an MCP tool, so other cards never read their steps for apps', () => {
    expect(mayHaveApps(['Read', 'mcp__clock__show_clock'])).toBe(true);
    expect(mayHaveApps(['Read', 'Bash'])).toBe(false);
    expect(mayHaveApps([])).toBe(false);
  });
});
