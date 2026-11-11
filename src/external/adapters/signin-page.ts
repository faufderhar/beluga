import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { BELUGA } from '../../shared/beluga-path.js';
import { REMOTE_FULL_WARNING } from '../../shared/remote-full.js';
import type { Route } from '../domain/decide.js';

/**
 * The page where you prove with a pairing code that an agent may sign in. No scripts, no framing,
 * and nothing from another address: its look (the Mac app's tokens, packages/mac/src/styles/tokens.css)
 * and Beluga's mark are inline, under the style's nonce.
 */

export interface SignInPage {
  readonly agent: string;
  readonly route: Route;
  /** Where its access goes: the redirect's host. */
  readonly host: string;
  /** Its redirect is a loopback address: on a remote route that is the computer that opened this page. */
  readonly loopback?: boolean;
  readonly pending: string;
  /** Where the form's redirect goes, which the page's CSP must allow. */
  readonly redirectOrigin: string;
  readonly error?: string;
  /** The code entered gives this remote agent Full trust: the page asks again, with the warning. */
  readonly confirmFullCode?: string;
}

/** A sign-in that stopped: a short title, then one sentence on what to do next. */
export interface SignInStop {
  readonly title: string;
  readonly message: string;
}

/** The Mac app's tokens, copied: the page is served alone and can't load the app's CSS. One fixed accent, since a browser has no app accent. */
const STYLE = `
:root{color-scheme:light dark;
--font:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',system-ui,'Segoe UI Variable Text','Segoe UI',Ubuntu,Cantarell,'Noto Sans',sans-serif;
--font-mono:ui-monospace,'SF Mono',Menlo,'Cascadia Mono',Consolas,'DejaVu Sans Mono','Liberation Mono','Ubuntu Mono',monospace;
--radius-s:5px;--radius:7px;--radius-l:11px;--space-2:4px;--space-3:8px;--space-4:12px;--space-5:16px;--space-6:24px;
--ease-out:cubic-bezier(0.22,1,0.36,1);--dur:180ms;
--bg:#f8f9fb;--bg-raised:#fff;--bg-hover:rgba(0,0,0,.045);--bg-press:rgba(0,0,0,.08);
--text:#1d1d1f;--text-2:#5d5d63;--hairline:rgba(0,0,0,.1);--hairline-strong:rgba(0,0,0,.17);
--shadow-pop:0 0 0 .5px rgba(0,0,0,.12),0 8px 28px rgba(0,0,0,.14);
--accent:#0a64d6;--on-accent:#fff;--focus:#0a64d6;--error:#c4352e;--warn:#b36b00;--code-bg:#f4f4f6}
@media (prefers-color-scheme:dark){:root{
--bg:#19191b;--bg-raised:#2a2a2e;--bg-hover:rgba(255,255,255,.06);--bg-press:rgba(255,255,255,.1);
--text:#ececee;--text-2:#a8a8ae;--hairline:rgba(255,255,255,.075);--hairline-strong:rgba(255,255,255,.14);
--shadow-pop:0 0 0 .5px rgba(255,255,255,.1),0 10px 32px rgba(0,0,0,.5);
--accent:#2f72d6;--focus:#79aef0;--error:#ef7a72;--warn:#e3a64a;--code-bg:#242427}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--space-5);padding:var(--space-6) var(--space-5);background:var(--bg);color:var(--text);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:28rem;padding:28px;background:var(--bg-raised);border-radius:var(--radius-l);box-shadow:var(--shadow-pop);animation:rise var(--dur) var(--ease-out) both}
@keyframes rise{from{opacity:0;transform:translateY(6px)}}
@media (prefers-reduced-motion:reduce){.card{animation:none}}
.brand{display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-6);color:var(--text-2);font-size:13px;font-weight:600;letter-spacing:.01em}
.mark{display:grid;place-items:center;width:28px;height:28px;border-radius:7px;background:linear-gradient(#2c2c30,#0b0b0c);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.12)}
.mark svg{width:22px;height:22px;fill:#fff}
h1{margin:0 0 var(--space-5);font-size:20px;line-height:1.3;font-weight:650;letter-spacing:-.01em;overflow-wrap:anywhere}
p{margin:0}
.dest{padding:var(--space-4) var(--space-5);border:1px solid var(--hairline);border-radius:var(--radius);background:var(--bg)}
.dest-label{font-size:12px;color:var(--text-2)}
.dest-place{font-weight:600;overflow-wrap:anywhere}
.dest-detail{font-size:13px;color:var(--text-2);overflow-wrap:anywhere}
.caution{margin-top:var(--space-3);font-size:13px;color:var(--text-2)}
.caution::before{content:"";display:inline-block;width:6px;height:6px;margin:0 var(--space-3) 1px 2px;border-radius:50%;background:var(--warn)}
.panel{margin-top:var(--space-5);padding:var(--space-4) var(--space-5);border:1px solid color-mix(in srgb,var(--error) 38%,transparent);border-left-width:3px;border-left-color:var(--error);border-radius:var(--radius);background:color-mix(in srgb,var(--error) 8%,var(--bg-raised))}
.panel-title{margin-bottom:var(--space-2);font-weight:600;color:var(--error)}
form{margin-top:var(--space-6)}
.field-label{display:block;margin-bottom:var(--space-3);font-weight:600}
.code{display:block;width:100%;padding:10px var(--space-4);border:1px solid var(--hairline-strong);border-radius:var(--radius);background:var(--code-bg);color:var(--text);font:600 15px/1.7 var(--font-mono);letter-spacing:.04em;text-transform:uppercase}
.code:focus-visible,button:focus-visible,input[type=checkbox]:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.hint{margin-top:var(--space-3);font-size:13px;color:var(--text-2)}
.check{display:flex;gap:var(--space-3);align-items:flex-start;font-weight:600}
.check input{width:16px;height:16px;margin:2px 0 0;flex:none;accent-color:var(--accent)}
.actions{display:flex;flex-wrap:wrap;gap:var(--space-3);margin-top:var(--space-6)}
button{flex:1 1 9rem;min-height:36px;padding:var(--space-3) var(--space-5);border:1px solid var(--hairline-strong);border-radius:var(--radius);background:var(--bg-raised);color:var(--text);font:600 14px var(--font);cursor:pointer;transition:background var(--dur) var(--ease-out)}
button:hover{background:var(--bg-hover)}
button:active{background:var(--bg-press)}
button.primary{border-color:transparent;background:var(--accent);color:var(--on-accent)}
button.primary:hover{background:color-mix(in srgb,var(--accent) 88%,#000)}
.foot{font-size:12px;color:var(--text-2);text-align:center}
@media (max-width:420px){.card{padding:var(--space-6) 20px}.code{font-size:13px;letter-spacing:.02em;padding:10px}body{justify-content:flex-start;padding:var(--space-5) var(--space-4)}}
`.replace(/\n/g, '');

/** Writes the sign-in page. It says who and where; the code itself sets level and projects. */
export function sendSignInPage(res: ServerResponse, page: SignInPage): void {
  const agent = escapeHtml(page.agent);
  const pending = `<input type="hidden" name="pending" value="${escapeHtml(page.pending)}">`;
  if (page.confirmFullCode) {
    send(res, 200, 'Give Full trust?', `<h1>Give ${agent} Full trust?</h1>
${where(page)}
<div class="panel problem" role="alert"><p class="panel-title">Full power on this Mac</p><p>${escapeHtml(REMOTE_FULL_WARNING)}</p></div>
<form method="post" action="/authorize" autocomplete="off">
${pending}
<input type="hidden" name="code" value="${escapeHtml(page.confirmFullCode)}">
<div class="check"><input type="checkbox" id="confirm" name="confirm_full" value="yes" required><label for="confirm">I understand. Give it Full trust.</label></div>
<div class="actions"><button class="primary" name="action" value="approve">Give Full trust</button><button name="action" value="deny" formnovalidate>Don't connect</button></div>
</form>`, page.redirectOrigin);
    return;
  }
  const error = page.error ? `<div class="panel problem" role="alert"><p class="panel-title">That code didn't work</p><p>${escapeHtml(page.error)}</p></div>` : '';
  send(res, 200, 'Connect an agent', `<h1>Connect ${agent} to Beluga?</h1>
${where(page)}
${error}
<form method="post" action="/authorize" autocomplete="off">
${pending}
<label class="field-label" for="code">Pairing code</label>
<input class="code" id="code" name="code" autofocus autocomplete="off" autocapitalize="characters" spellcheck="false" aria-describedby="code-hint" required>
<p class="hint" id="code-hint">Make one in Beluga. It sets what this agent may do and in which projects, and works once.</p>
<div class="actions"><button class="primary" name="action" value="approve">Connect</button><button name="action" value="deny" formnovalidate>Don't connect</button></div>
</form>`, page.redirectOrigin);
}

/** A sign-in that can't go on, and can't safely go back to the client either. */
export function sendSignInError(res: ServerResponse, status: number, stop: SignInStop): void {
  send(res, status, escapeHtml(stop.title), `<h1>${escapeHtml(stop.title)}</h1>
<div class="panel problem" role="alert"><p>${escapeHtml(stop.message)}</p></div>
<p class="hint">You can close this tab.</p>`);
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Where its access goes, in plain words: this computer, another one, or a hosted service. */
function where(page: SignInPage): string {
  const host = escapeHtml(page.host);
  if (page.route === 'local') return dest('This computer', `${host}. Nothing leaves it.`);
  if (page.loopback) {
    return `${dest('Another computer', `A program at ${host} there. This sign-in came through a remote address.`)}
<p class="caution">Anyone who controls that computer gets the access.</p>`;
  }
  return `${dest(`The hosted service at ${host}`, 'Its servers hold the access, not this computer.')}
<p class="caution">Anyone who runs that service gets the access.</p>`;
}

function dest(place: string, detail: string): string {
  return `<div class="dest"><p class="dest-label">Its access goes to</p><p class="dest-place">${place}</p><p class="dest-detail">${detail}</p></div>`;
}

function send(res: ServerResponse, status: number, title: string, body: string, formTarget = ''): void {
  const nonce = randomBytes(16).toString('base64');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self' ${formTarget}; frame-ancestors 'none'; base-uri 'none'`,
    'x-frame-options': 'DENY',
    // Not no-referrer: with it a browser posts this page's form with `Origin: null`, which the listener refuses.
    'referrer-policy': 'same-origin',
  });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title} · Beluga</title><style nonce="${nonce}">${STYLE}</style></head><body><main class="card">
<div class="brand"><span class="mark"><svg viewBox="0 0 1024 1024" aria-hidden="true" focusable="false"><path fill-rule="evenodd" d="${BELUGA}"/></svg></span><span>Beluga</span></div>
${body}
</main><p class="foot">Sign-in for agents · served by Beluga on this computer</p></body></html>`);
}
