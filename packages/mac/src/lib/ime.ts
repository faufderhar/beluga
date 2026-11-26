/**
 * Is this key press part of an input method's composition (Chinese, Japanese, Korean…)?
 * Then Enter picks the characters and must not send. WebKit (the Mac app's webview) ends the
 * composition before keydown fires for that Enter, so `isComposing` is already false there;
 * the keyCode 229 it still carries is the sign. Every Enter-to-submit handler asks this first.
 */
export interface KeyLike {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

export function isImeComposing(e: KeyLike): boolean {
  const n = e.nativeEvent ?? e;
  return Boolean(n.isComposing || e.isComposing) || n.keyCode === 229 || e.keyCode === 229;
}
