# Live previews (experimental)

Your agent can show a component or a web page it built drawn live in its answer, and you can
change its props beside it. It's Beluga's first experimental feature: off until you turn it on in
**Settings › Experimental**, which explains what it changes and what it costs this computer. The
list of experiments is `src/shared/experiments.ts`; turning one on saves its id in
`settings.experiments`.

## Off costs nothing

With the experiment off, Beluga only knows it exists:

- The daemon loads none of it. `src/preview/off.ts` (a way to close previews) is all it always
  has; the previews themselves (`manager.ts`, esbuild, the server) load with the first preview
  opened. `preview.open` and `preview.snapshot` refuse.
- Your agent is told nothing (`src/agent/preview-prompt.ts` is added only while it's on).
- The window loads none of it: the block, its controls and the props reader are loaded the first
  time a preview shows (`Markdown.tsx`, `component-preview.tsx`). Files reads a file for components
  only while it's on.
- Turning it off closes every preview at once (`Session.setPrefs`).

On, nothing is held while nothing shows: a preview no frame has shown for two minutes is let go
(its build, its watcher); with none left, the server closes, esbuild's helper and the compiler
processes stop. A frame far off screen, or while you've been away from Beluga for two minutes, is
unloaded, and draws again, with the same props, on the way back. A frame's tools (below) load the
first time one is used. A chat holding a preview while it's off loads only a small notice
(`PreviewNotice.tsx`).

## What your agent writes

A fenced block whose first line says what to draw (`src/shared/preview/ref.ts`):

````
```beluga-preview
src/components/PriceCard.tsx
export: PriceCard
props: {"plan": "pro"}
css: src/index.css
wrap: src/test/Providers.tsx
```
````

- A component file in the worktree: React (`.tsx`, `.jsx`, its default export or `export:`), Vue
  (`.vue`) or Svelte (`.svelte`); an `.html` file (with the files next to it); or a page on this
  computer's own dev server (`http://localhost:5173/…` or `127.0.0.1`; never the open web).
- `props:` are the ones that matter; the rest are filled in from the component's types.
- `css:` bundles a stylesheet; `wrap:` names a wrapper other than the project's own (below);
  `size: phone|tablet|desktop` sets the width it's drawn at.

## Props from types, without a model

`src/shared/preview/props.ts` reads the component file itself: a small parser of declarations
(never a component's body) that follows the props type through interfaces, type aliases, inline
objects, `React.FC<P>`, `forwardRef<R, P>`, class components, `Pick`, `Omit`, `Partial`,
`Record`, unions and tuples, and reads class-variance-authority variants (shadcn's
`VariantProps<typeof buttonVariants>`) as choices with their defaults. In the daemon it follows
types into the project's other files (relative imports, tsconfig path aliases, re-exports and
`export *`, up to four files; `src/preview/project.ts` reads them, inside the worktree only). It
keeps the defaults a component destructures and each prop's doc comment (the control's tooltip).

`src/shared/preview/sfc.ts` reads Vue's `defineProps<…>()`, `withDefaults`, runtime props (and the
Options API's), and `defineEmits` (each event a callback prop: `select` is `onSelect`); Svelte 5's
`$props()` and Svelte 4's `export let`. It turns them into a signature the same reader knows.

`src/shared/preview/samples.ts` fills them: a `title` gets a title, an `email` an address,
`members: User[]` three people with faces, `number[][]` a 2×3 grid, a callback a stub that reports
when it fires. The same component always gets the same values. Sample pictures are short names
(`picture/1-LP.svg`) the preview's server draws.

## How it's built

`src/preview/bundle.ts`: esbuild builds the component with the project's own packages (React's
production build, an IIFE and its CSS, in memory; the context is kept, so a change rebuilds in
milliseconds), through `src/preview/plugins.ts`:

- A fence first: the build reads only the worktree's files and installed packages, never a
  secret, so a component's imports can't reach the rest of the disk.
- The project's own compilers (Tailwind, Vue, Svelte) run the project's code (a Tailwind config, a
  plugin), so never in the daemon: `src/preview/compilers.ts` runs them in a process per worktree
  started with Node's permission model (`compile-child.ts`). It reads only the worktree and the
  node_modules folders from it up, can't write, start a program or open workers, and exits a
  minute after its last job.
- **Tailwind**: a stylesheet where Tailwind is set up (v4's `@import "tailwindcss"`, v3's
  `@tailwind`) is built with the project's own Tailwind (v4's compiler and scanner; v3 through
  PostCSS with its config). A Tailwind project's global stylesheet comes with every preview.
- **Next.js**: `next/image`, `next/link`, `next/font/*`, `next/navigation`, `next/router`,
  `next/head`, `next/script` and `next/dynamic` have small stand-ins, so a Next component draws on
  its own; following a link or a router push shows as an event.
- **React Native** (Expo and the like): when `react-native-web` is installed for the component, it
  is built as the app's web build would be. `react-native` is react-native-web, with do-nothing
  stand-ins for native-only names like `TurboModuleRegistry` and `codegenNativeComponent`. A
  package's `.web.js` file wins over its `.ios.js` and `.android.js` ones. React Native's own
  internals (`react-native/Libraries/…`, Flow source) are empty modules.
- **Browser stand-ins, for every preview**: a Node built-in a package imports (`events`, `crypto`)
  is the installed polyfill when there is one, otherwise a small stand-in (`events` is a working
  EventEmitter, the others are empty). A file in a build step's output (`dist/`, `build/`, `out/`,
  `generated/`) that hasn't been made yet is an empty module, so the component draws anyway.
- **Vue and Svelte**: compiled with the project's own `vue/compiler-sfc` and `svelte/compiler`
  (each file's CSS in one `<style>`, replaced by a new build). Svelte 5 components draw inside a
  small host whose props are state, so a new prop changes them in place.
- **Providers**: React components draw inside the project's `preview-wrapper.tsx` (at the root,
  in `src/` or `.beluga/`; or `wrap:`), which default-exports a component wrapping `{children}` in
  the app's router, theme, store and query client, and inside Storybook's decorators when the
  project has `.storybook/preview.*`. A component that throws for a missing provider reads as
  "Card needs to sit inside ThemeProvider", and its button asks your agent to write the wrapper;
  the preview draws itself once it's there.

## How it's drawn

- Pictures are written only into `.beluga/scratch/previews`, never through a link, and only PNGs.
- `src/preview/server.ts`: a server of its own on `127.0.0.1` (port 47791 when free, so what a
  component keeps in the browser stays under one address and is cleared as each preview loads),
  serving nothing but previews, each under `/p/<id>/` (an id nobody can guess), framed only by
  Beluga (`frame-ancestors`), under a loopback host name only. A component's page loads and
  connects only to that server, so nothing in it can be sent off this computer; workers may run.
- `src/preview/runtime.ts`: draws the component in an error boundary with the props the chat sends
  (`postMessage`, to and from the window that framed it only), reports its height (menus and
  dialogs it opens included), the callbacks that fired and failures, and swaps a new build in when
  the file changes, keeping the props.
- `src/preview/tools.ts`, loaded the first time it's used: **pinned states** (every `:hover`,
  `:focus` or `:active` rule copied as a class put on what's drawn), an **accessibility check** (no
  description on a picture, no name on a button or link, no label on a field, low contrast,
  skipped headings, each in plain words, found on the page with a click) and a **picture** (the
  drawing written out as SVG, then PNG).
- `src/preview/manager.ts`: builds each preview once (two places opening it at once share the
  build), watches the files it read, and lets go as above.

The window's policy (`tauri.conf.json`) allows frames from `127.0.0.1` and `localhost` only.

## In the window

`packages/mac/src/components/preview/`: the block builds only once it scrolls into view and only
for your own agent's answers (a friend's names it, and runs nothing). Its height follows the
component smoothly; a page is shown at the width picked, scaled down.

- **Props** opens a control per prop (choices, switches, numbers, text, colours, pictures, dates,
  a grid for a matrix, a small table for a list of objects, JSON for the rest); each change
  redraws at once without a rebuild. What you change is kept (`kept-props.ts`, the newest 100
  previews) and comes back after a restart. **Every _variant_** draws it once per choice.
- A file with several components: the title picks one, or **All Components**, each with its own
  samples.
- **•••**: Width (Fit, Phone, Tablet, Desktop), Canvas (Light, Dark: the color scheme, Tailwind's
  `dark` class and `data-theme` too), Pin State, Check Accessibility, Save as Picture (a PNG in
  the worktree's `.beluga/scratch/previews`), Use These Props (asks your agent to make them its
  defaults), Copy Props as JSON, Reset Props.
- What a callback did shows under the frame.

When it can't draw, it says why in plain words (`src/preview/problems.ts`): the packages aren't
installed, a package or file is missing, the file doesn't read right around a line, nothing answers
at the dev server's address, it needs a provider. The bundler's own words never show; **Ask Agent
to Fix** puts them in your reply. Problems that may clear up by themselves (a save, a server
starting, a wrapper written) are looked at again every few seconds while the preview is on screen.

In Files, a `.tsx`, `.jsx`, `.vue` or `.svelte` file of your own worktree that holds a component
gets **Preview** beside **Source**.

## The phone

Previews run code, and only on the Mac. The phone shows a preview's newest picture where the Mac
drew one: with a phone paired, each drawing's picture is kept in the worktree's
`.beluga/scratch/previews` once it rests (`companion/views.ts` withPictures); otherwise a line,
"A live preview of PriceCard.tsx, on your Mac." `preview.open` and `preview.snapshot` are `mac` in
`src/companion/coverage.ts`.

## Not yet

SwiftUI (that needs Xcode's previews), wrappers for Vue and Svelte, and previews from a paired
computer elsewhere (the frame loads from this computer's loopback; noted on BLG-767).
