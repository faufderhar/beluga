import { describe, expect, it } from 'vitest';
import { EXPERIMENTS, experimentOn } from '../src/shared/experiments.js';

/** Chat schedules left Experimental (BLG-1023): they're always there, whatever an older Beluga saved. */
describe('chat schedules are no experiment', () => {
  it('is not listed in Settings › Experimental', () => {
    expect(EXPERIMENTS as readonly string[]).not.toContain('chat-schedules');
  });

  it('an old off mark in the saved list turns no other experiment on or off', () => {
    expect(experimentOn(['-chat-schedules'], 'previews')).toBe(false);
    expect(experimentOn(['-chat-schedules', 'previews'], 'previews')).toBe(true);
  });
});
