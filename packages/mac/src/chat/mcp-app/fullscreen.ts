/**
 * An app's fullscreen covers the whole window (BLG-392). The chat's rows are moved with transforms
 * (virtual list), and a transform traps `position: fixed` in its row. While an app is fullscreen,
 * <html> has `data-mcp-app-fullscreen` and the app's ancestors have `data-mcp-app-lift`: the CSS
 * (mcp-app.module.css) drops their transforms. This replaces a `:has()` rule, which WebKit checks on
 * each style recalculation while the chat streams.
 */

const HTML_FLAG = 'data-mcp-app-fullscreen';
const LIFT = 'data-mcp-app-lift';

/** Apps fullscreen now (the flag on <html> stays while one is). */
let fullscreenApps = 0;
/** For each lifted ancestor, how many fullscreen apps it holds (two apps can share ancestors). */
const liftedBy = new Map<HTMLElement, number>();

/** Mark `app` fullscreen. Returns how to undo it (on exit and on unmount). */
export function liftForFullscreen(app: HTMLElement): () => void {
  const lifted: HTMLElement[] = [];
  for (let el = app.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    liftedBy.set(el, (liftedBy.get(el) ?? 0) + 1);
    el.setAttribute(LIFT, '');
    lifted.push(el);
  }
  fullscreenApps++;
  document.documentElement.setAttribute(HTML_FLAG, '');
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const el of lifted) {
      const left = (liftedBy.get(el) ?? 1) - 1;
      if (left > 0) liftedBy.set(el, left);
      else {
        liftedBy.delete(el);
        el.removeAttribute(LIFT);
      }
    }
    fullscreenApps--;
    if (fullscreenApps === 0) document.documentElement.removeAttribute(HTML_FLAG);
  };
}
