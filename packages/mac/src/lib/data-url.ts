/**
 * The bytes of a base64 data URL of the given type ("data:image/png;base64,…"), or undefined when
 * the URL is something else. Read here because the app's CSP (connect-src) refuses fetch on data:.
 */
export function dataUrlBytes(url: string, mime: string): Uint8Array<ArrayBuffer> | undefined {
  const head = `data:${mime};base64,`;
  if (!url.toLowerCase().startsWith(head)) return undefined;
  try {
    const raw = atob(url.slice(head.length));
    return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  } catch {
    return undefined;
  }
}
