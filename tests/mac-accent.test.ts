import { describe, expect, it } from 'vitest';
import { ACCENTS, accentCss } from '../packages/mac/src/lib/prefs.js';

/** The system accent is CSS's AccentColor: WebKit (the Mac) draws it, Chromium (WebView2 on Windows, headless browsers) does not. */
describe('accentCss', () => {
  it('keeps the system accent where AccentColor is drawn', () => {
    expect(accentCss('system', true)).toBe('AccentColor');
    expect(accentCss('theme', true)).toBe('var(--theme-accent, AccentColor)');
  });

  it('falls back to macOS blue where it is not, so primary buttons never draw white on nothing', () => {
    expect(accentCss('system', false)).toBe('#007aff');
    expect(accentCss('theme', false)).toBe('var(--theme-accent, #007aff)');
  });

  it('leaves a picked colour alone', () => {
    expect(accentCss('rose', false)).toBe(ACCENTS.rose);
    expect(accentCss('rose', true)).toBe(ACCENTS.rose);
  });
});
