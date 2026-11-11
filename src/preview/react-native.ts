import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import type { OnResolveArgs, Plugin, PluginBuild } from 'esbuild';

/**
 * A preview frame is a web page, so a component written for somewhere else is built the way that
 * place's own web build would build it:
 * - React Native (Expo and the like): `react-native` is the project's react-native-web, a package's
 *   `.web.js` file wins over its `.ios.js` and `.android.js` ones, and React Native's own internals
 *   (Flow source the browser never runs) stand in as empty modules.
 * - Node's built-in modules a package reaches for (`events`, `crypto`) are an installed polyfill when
 *   there is one, otherwise a small stand-in, as browser bundlers do.
 * - A file a build step makes (`dist/…`) that hasn't been made yet is an empty module, so the
 *   component draws and only the code that uses it would fail.
 */

/** Where the project's react-native-web is, seen from the component: its React Native setup for the web. */
export function reactNativeWebOf(file: string): string | undefined {
  try {
    return path.dirname(createRequire(file).resolve('react-native-web/package.json'));
  } catch {
    return undefined;
  }
}

/** The order files are looked for in, web variants first (Metro's and Expo's web order). */
export const WEB_FIRST_EXTENSIONS = ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.web.mjs', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.css', '.json'];

/** Globals React Native libraries read, as a production web build sets them. */
export const REACT_NATIVE_DEFINE: Readonly<Record<string, string>> = { __DEV__: 'false', 'process.env.EXPO_OS': '"web"' };

const STUB = 'beluga-stub';
/** Set on the resolve a plugin does itself, so it doesn't answer its own question. */
const AGAIN = 'belugaResolveAgain';

const EMPTY = 'module.exports = {};';

/** Node's EventEmitter, enough for the packages that extend it at load. */
const EVENTS = `function EventEmitter() { this._events = this._events || {}; }
const proto = EventEmitter.prototype;
proto.on = proto.addListener = function (name, fn) { (this._events[name] ||= []).push(fn); return this; };
proto.prependListener = function (name, fn) { (this._events[name] ||= []).unshift(fn); return this; };
proto.once = function (name, fn) { const self = this; function once(...a) { self.off(name, once); fn.apply(self, a); } once.listener = fn; return this.on(name, once); };
proto.off = proto.removeListener = function (name, fn) { const l = this._events[name]; if (l) this._events[name] = l.filter((f) => f !== fn && f.listener !== fn); return this; };
proto.removeAllListeners = function (name) { if (name === undefined) this._events = {}; else delete this._events[name]; return this; };
proto.emit = function (name, ...a) { const l = this._events[name]; if (!l || !l.length) return false; for (const f of l.slice()) f.apply(this, a); return true; };
proto.listeners = function (name) { return (this._events[name] || []).map((f) => f.listener || f); };
proto.listenerCount = function (name) { return (this._events[name] || []).length; };
proto.eventNames = function () { return Object.keys(this._events); };
proto.setMaxListeners = function () { return this; };
proto.getMaxListeners = function () { return 10; };
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.defaultMaxListeners = 10;
EventEmitter.once = (em, name) => new Promise((resolve) => em.once(name, (...a) => resolve(a)));
module.exports = EventEmitter;`;

const STUBS: Readonly<Record<string, string>> = { events: EVENTS };

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const BUILTINS = builtinModules.filter((m) => !m.startsWith('_'));
/** `events`, `node:events`, `fs/promises`: a Node built-in, as imported. */
const BUILTIN = new RegExp(`^(node:)?(${BUILTINS.map(escape).join('|')})$`);
/** A path into what a build step makes. */
const GENERATED = /^\.{1,2}\/(.*\/)?(dist|build|out|generated|\.generated)\//;

const stub = (name: string): { path: string; namespace: string } => ({ path: name, namespace: STUB });

/** What resolving it the usual way finds, or undefined when nothing is there. */
async function resolveAsUsual(build: PluginBuild, args: OnResolveArgs, spec = args.path): Promise<{ path: string; namespace: string; sideEffects?: boolean } | undefined> {
  const found = await build.resolve(spec, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, namespace: args.namespace === STUB ? 'file' : args.namespace, pluginData: { [AGAIN]: true } });
  return found.errors.length ? undefined : { path: found.path, namespace: found.namespace, ...(found.sideEffects === false ? { sideEffects: false } : {}) };
}

const again = (args: OnResolveArgs): boolean => Boolean((args.pluginData as Record<string, unknown> | undefined)?.[AGAIN]);

/** Node's built-ins and not-yet-built files, for every preview. */
export function browserPlugin(): Plugin {
  return {
    name: 'beluga-browser',
    setup(build) {
      build.onResolve({ filter: BUILTIN }, async (args) => {
        if (again(args)) return undefined;
        const name = args.path.replace(/^node:/, '');
        return (await resolveAsUsual(build, args, name)) ?? stub(name);
      });
      build.onResolve({ filter: GENERATED }, async (args) => {
        if (again(args) || args.namespace !== 'file') return undefined;
        // Named so its extension (.mjs) doesn't make the empty module strict ESM, with no default.
        return (await resolveAsUsual(build, args)) ?? stub(`${path.resolve(args.resolveDir, args.path)} (not built yet)`);
      });
      build.onLoad({ filter: /.*/, namespace: STUB }, (args) => ({ contents: STUBS[args.path] ?? EMPTY, loader: 'js' }));
    },
  };
}

/**
 * `react-native` on the web: react-native-web, plus what native-only libraries reach for at load
 * (TurboModuleRegistry, codegenNativeComponent) as do-nothing stand-ins. CommonJS on purpose: a
 * name neither has is undefined, never a failed build.
 */
const REACT_NATIVE = `const web = require('react-native-web');
const React = require('react');
const none = () => null;
const nativeComponent = (name) => React.forwardRef(function NativeComponent(props, ref) { return React.createElement(web.View, { ref, style: props.style }, props.children); });
module.exports = {
  TurboModuleRegistry: { get: none, getEnforcing: () => ({}) },
  codegenNativeComponent: nativeComponent,
  codegenNativeCommands: () => ({}),
  requireNativeComponent: nativeComponent,
  NativeEventEmitter: web.NativeEventEmitter || function NativeEventEmitter() { return { addListener: () => ({ remove() {} }), removeAllListeners() {}, emit() {} }; },
  DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit() {}, removeAllListeners() {} },
  NativeModules: {},
  ...web,
};`;

/** React Native for the web: `react-native` is react-native-web, its internals empty modules. */
export function reactNativePlugin(): Plugin {
  return {
    name: 'beluga-react-native',
    setup(build) {
      build.onResolve({ filter: /^react-native$/ }, (args) => (again(args) || args.namespace === 'beluga-react-native' ? undefined : { path: 'react-native', namespace: 'beluga-react-native', pluginData: { resolveDir: args.resolveDir } }));
      build.onLoad({ filter: /.*/, namespace: 'beluga-react-native' }, (args) => ({ contents: REACT_NATIVE, loader: 'js', resolveDir: (args.pluginData as { resolveDir: string }).resolveDir }));
      build.onResolve({ filter: /^react-native-web$/ }, async (args) => (again(args) || args.namespace !== 'beluga-react-native' ? undefined : resolveAsUsual(build, { ...args, namespace: 'file' })));
      // Deep imports into React Native are its native internals, in Flow: nothing a web page runs.
      build.onResolve({ filter: /^react-native\/./ }, (args) => (again(args) ? undefined : stub(args.path)));
      // React Native's own packages: as installed, or react-native-web's asset registry for the
      // one web libraries ask for (React Native leaves it to the app to install), otherwise empty.
      build.onResolve({ filter: /^@react-native\// }, async (args) => {
        if (again(args)) return undefined;
        const found = await resolveAsUsual(build, args);
        if (found) return found;
        if (args.path.startsWith('@react-native/assets-registry')) return (await resolveAsUsual(build, args, 'react-native-web/dist/modules/AssetRegistry')) ?? stub(args.path);
        return stub(args.path);
      });
    },
  };
}
