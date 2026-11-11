import { inApp } from './boot.js';

/** Put text on the clipboard (the app's own clipboard, or the browser's in development). */
export async function copyText(text: string): Promise<void> {
  if (inApp()) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
  } else await navigator.clipboard?.writeText(text);
}

/**
 * Put HTML on the clipboard with its plain text beside it: a table pastes as a table where the
 * other side reads HTML (Sheets, Numbers, Docs, Notion), and as the text everywhere else.
 */
export async function copyRich(html: string, text: string): Promise<void> {
  if (inApp()) {
    const { writeHtml } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeHtml(html, text);
  } else if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
  } else await copyText(text);
}

/**
 * Put a PNG on the clipboard. The app writes it through its own clipboard: WebKit refuses a
 * picture written after an await, once the click no longer counts. A browser gets the picture
 * as a promise, so the write starts inside the click and the bytes follow.
 */
export async function copyPng(png: Blob | Promise<Blob>): Promise<void> {
  if (inApp()) {
    const { writeImage } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeImage(new Uint8Array(await (await png).arrayBuffer()));
  } else await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
