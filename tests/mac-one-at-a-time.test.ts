import { describe, expect, it } from 'vitest';
import { oneAtATime } from '../packages/mac/src/lib/one-at-a-time.js';

/** BLG-942: a poll whose answer is slow waits for it, instead of asking again and again behind it. */
describe('a look one at a time', () => {
  it('skips beats while its last look is on its way, and asks again once it came back or failed', async () => {
    const answers: Array<{ ok: () => void; fail: () => void }> = [];
    let asked = 0;
    const look = oneAtATime(() => {
      asked += 1;
      return new Promise<void>((ok, fail) => answers.push({ ok, fail: () => fail(new Error('no')) }));
    });

    look();
    look();
    look();
    expect(asked).toBe(1);

    answers[0]!.ok();
    await Promise.resolve();
    look();
    expect(asked).toBe(2);

    // A failed look frees the next one too (and isn't left as an unhandled rejection).
    answers[1]!.fail();
    await new Promise((r) => setTimeout(r, 0));
    look();
    expect(asked).toBe(3);
  });

  it('a beat that didn’t ask (the window can’t be seen) doesn’t hold the next one', () => {
    let shown = false;
    let asked = 0;
    const look = oneAtATime(() => {
      if (!shown) return;
      asked += 1;
      return new Promise(() => undefined);
    });
    look();
    shown = true;
    look();
    expect(asked).toBe(1);
  });
});
