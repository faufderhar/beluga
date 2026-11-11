// zod checks schemas without compiling them (BLG-672), set before any module runs.
// zod probes `new Function("")` when a z.object() is made unless jitless is on; under the page's
// content security policy (no unsafe-eval) that probe is reported as a CSP violation. A bundled
// chunk can make schemas before src/lib/zod-jitless.ts runs, so this classic script, which runs
// before every module script, sets the global config zod reads (globalThis.__zod_globalConfig).
globalThis.__zod_globalConfig = Object.assign(globalThis.__zod_globalConfig || {}, { jitless: true });
