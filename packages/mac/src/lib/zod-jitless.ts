import { config } from 'zod';

/**
 * zod checks schemas without compiling them (BLG-672). Its compiled fast path first probes
 * `new Function("")`; under a page's content security policy (the web port's, the app's: no
 * unsafe-eval) that probe is blocked, and browsers report it as a CSP error even though zod
 * catches it. Imported first by each window's main.tsx. The probe runs when a z.object() is made,
 * and a bundled chunk can make one before this module runs, so public/zod-jitless.js (a classic
 * script in each window's <head>) sets the same flag before any module; this stays for the rest.
 */
config({ jitless: true });
