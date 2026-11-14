import type { AppCspDomains } from './ui-meta.js';

/**
 * The Content-Security-Policy an app's frame gets (SEP-1865's defaults): its own inline HTML runs,
 * and it reaches only the domains its resource declared. Nothing declared: no network at all.
 * `frameAncestors`: who may frame it (the Beluga window only). Pure.
 */
export function appCsp(csp: AppCspDomains, frameAncestors: string): string {
  const res = csp.resourceDomains;
  return [
    "default-src 'none'",
    `script-src ${list(["'self'", "'unsafe-inline'", ...res])}`,
    `style-src ${list(["'self'", "'unsafe-inline'", ...res])}`,
    `img-src ${list(["'self'", 'data:', 'blob:', ...res])}`,
    `font-src ${list(["'self'", 'data:', ...res])}`,
    `media-src ${list(["'self'", 'data:', 'blob:', ...res])}`,
    `connect-src ${list(csp.connectDomains)}`,
    `frame-src ${list(csp.frameDomains)}`,
    `base-uri ${csp.baseUriDomains.length ? list(csp.baseUriDomains) : "'self'"}`,
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');
}

/** Sources joined; none at all is `'none'`. */
function list(sources: readonly string[]): string {
  return sources.length ? [...new Set(sources)].join(' ') : "'none'";
}
