import { describe, expect, it } from 'vitest';
import { isImeComposing } from '../packages/mac/src/lib/ime.js';

describe('isImeComposing', () => {
  it('is composing while the native event says so', () => {
    expect(isImeComposing({ keyCode: 13, nativeEvent: { isComposing: true, keyCode: 13 } })).toBe(true);
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  it('is composing for keyCode 229 even when isComposing is already false (WebKit)', () => {
    expect(isImeComposing({ keyCode: 229, nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it('a plain Enter is not composing', () => {
    expect(isImeComposing({ keyCode: 13, nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(false);
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
