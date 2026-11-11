import type { SVGProps } from 'react';
import { AGENT_MARKS, AGENT_MARK_VIEWBOX, type AgentMark } from '../../../../src/shared/agent-marks.js';
import { COMPUTER_GLYPHS } from '../../../../src/shared/computer-marks.js';

/**
 * One small icon set, drawn on a 16×16 grid with 1.5 strokes (in the spirit of SF Symbols):
 * every icon in the app comes from here, so they match.
 */
const PATHS = {
  // Your computers' glyphs (desktop, server, cloud, Mac mini, PC…), shared with the phone.
  ...COMPUTER_GLYPHS,
  chat: 'M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h.5A1.5 1.5 0 0 1 3 9.5z',
  folder: 'M2.5 4.5A1 1 0 0 1 3.5 3.5h3l1.5 1.5h4.5a1 1 0 0 1 1 1V11.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z',
  file: 'M4 2.5h5l3 3v8H4z M9 2.5v3h3',
  diff: 'M5 3v6 M2 6h6 M8.5 12.5h5.5 M11 2.5l-2 11',
  terminal: 'M2.5 3.5h11v9h-11z M4.5 6.5l2 1.5-2 1.5 M8 10h3',
  plus: 'M8 3.5v9 M3.5 8h9',
  more: 'M4 8h.01 M8 8h.01 M12 8h.01',
  chevronRight: 'M6 4l4 4-4 4',
  arrowRight: 'M2.5 8h11 M9.5 4l4 4-4 4',
  chevronDown: 'M4 6l4 4 4-4',
  chevronUp: 'M4 10l4-4 4 4',
  sidebar: 'M2.5 3.5h11v9h-11z M6 3.5v9',
  inspector: 'M2.5 3.5h11v9h-11z M10 3.5v9',
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z M10.5 10.5l3 3',
  // A cog of six teeth: rays around a dot read as a sun.
  gear: 'M6.66 3.6L6.78 1.72L9.22 1.72L9.34 3.6A4.6 4.6 0 0 1 11.14 4.64L12.83 3.8L14.05 5.92L12.48 6.97A4.6 4.6 0 0 1 12.48 9.03L14.05 10.08L12.83 12.2L11.14 11.36A4.6 4.6 0 0 1 9.34 12.4L9.22 14.28L6.78 14.28L6.66 12.4A4.6 4.6 0 0 1 4.86 11.36L3.17 12.2L1.95 10.08L3.52 9.03A4.6 4.6 0 0 1 3.52 6.97L1.95 5.92L3.17 3.8L4.86 4.64A4.6 4.6 0 0 1 6.66 3.6z M9.9 8a1.9 1.9 0 1 1-3.8 0 1.9 1.9 0 1 1 3.8 0z',
  bell: 'M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z M6.5 13.5a1.5 1.5 0 0 0 3 0',
  people: 'M6 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5z M2 13c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5 M10.5 7a2 2 0 1 0 0-4 M12 9.6c1.3.4 2 1.6 2 3.1',
  person: 'M8 7.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5z M3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4',
  branch: 'M5 3v10 M5 10c0-3 6-2 6-5 M11 2.5v2.5 M5 13a1.25 1.25 0 1 0 0-.01 M5 3a1.25 1.25 0 1 0 0-.01 M11 5a1.25 1.25 0 1 0 0-.01',
  /** Claude in Beluga: the logo's prompt and cursor, at the logo's proportions. */
  claude: 'M3 4.5L6.7 8 3 11.5 M9.15 10.8h3.9',
  /** Max effort: a flame. */
  flame: 'M8 14c-2.5 0-4.5-1.8-4.5-4.3C3.5 7 6 5.8 6.5 2.5c1.6 1 2.4 2.6 2.3 4.3.6-.4 1-1.1 1.1-1.9 1.4 1.1 2.6 2.8 2.6 4.8C12.5 12.2 10.5 14 8 14z M8 14c-1 0-1.8-.8-1.8-1.8 0-1.2 1-1.7 1.4-2.8.9.6 2.2 1.5 2.2 2.8 0 1-.8 1.8-1.8 1.8z',
  /** The old name for Claude's mark (kept so every use shows the same one). */
  spark: 'M3 4.5L6.7 8 3 11.5 M9.15 10.8h3.9',
  check: 'M3.5 8.5l3 3 6-7',
  x: 'M4 4l8 8 M12 4l-8 8',
  alert: 'M8 2.5l6 10.5H2z M8 6.5v3 M8 11.3v.01',
  play: 'M5 3.5l7 4.5-7 4.5z',
  stop: 'M4.5 4.5h7v7h-7z',
  /** Experimental features: a flask. */
  flask: 'M6 2.5h4 M6.75 2.5v4.2L3.2 12.4a1 1 0 0 0 .85 1.6h7.9a1 1 0 0 0 .85-1.6L9.25 6.7V2.5 M4.6 10.2h6.8',
  archive: 'M2.5 3.5h11v3h-11z M3.5 6.5v6h9v-6 M6.5 9h3',
  share: 'M8 2.5v8 M5 5.5l3-3 3 3 M3.5 8.5v4.5h9V8.5',
  plug: 'M6 2v3 M10 2v3 M4.5 5h7v2.2a3.5 3.5 0 0 1-7 0z M8 10.7V14',
  link: 'M6.5 9.5l3-3 M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1 M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1',
  copy: 'M5.5 5.5h7v7h-7z M3.5 10.5v-7h7',
  send: 'M8 13V3.5 M4 7.5l4-4 4 4',
  /** Speak instead of typing (Settings › Voice). */
  mic: 'M8 2.5a2 2 0 0 1 2 2v3.5a2 2 0 0 1-4 0V4.5a2 2 0 0 1 2-2z M4.5 7.5a3.5 3.5 0 0 0 7 0 M8 11v2.5 M6 13.5h4',
  trash: 'M3 4.5h10 M6.5 4.5V3h3v1.5 M4.5 4.5l.7 8.5h5.6l.7-8.5 M7 7v3.5 M9 7v3.5',
  pencil: 'M10.5 2.75l2.75 2.75-7.5 7.5H3v-2.75z M9 4.25l2.75 2.75',
  image: 'M2.5 3.5h11v9h-11z M2.5 10.5l3-2.75 3 2.5 2-1.5 3 2.25 M10.25 6.25h.01',
  clip: 'M10.5 5.5l-4.3 4.3a1.4 1.4 0 0 0 2 2l4.8-4.8a2.8 2.8 0 0 0-4-4L4.2 7.8a4.2 4.2 0 0 0 6 6l4-4',
  clock: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z M8 5v3l2 1.5',
  lock: 'M4.5 7.5h7v6h-7z M6 7.5V5.5a2 2 0 0 1 4 0v2',
  globe: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z M2.5 8h11 M8 2.5c-2 2.2-2 8.8 0 11 M8 2.5c2 2.2 2 8.8 0 11',
  grid: 'M3 3h4v4H3z M9 3h4v4H9z M3 9h4v4H3z M9 9h4v4H9z',
  gauge: 'M2.5 11a5.5 5.5 0 1 1 11 0 M8 11l2.5-3.5',
  command: 'M6 6V4.5A1.5 1.5 0 1 0 4.5 6H11.5A1.5 1.5 0 1 0 10 4.5v7a1.5 1.5 0 1 0 1.5-1.5h-7A1.5 1.5 0 1 0 6 11.5V6z',
  inbox: 'M2.5 9l1.8-5.5h7.4L13.5 9v3.5h-11z M2.5 9H6l.8 1.5h2.4L10 9h3.5',
  eye: 'M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z M8 9.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z',
  eyeOff: 'M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z M8 9.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z M2.5 2.5l11 11',
  download: 'M8 2.5v8 M5 7.5l3 3 3-3 M3.5 13h9',
  /** Arrow down to a line: to the end (and keep there). */
  toEnd: 'M8 2.5v8 M4.5 7l3.5 3.5L11.5 7 M3.5 13.5h9',
  refresh: 'M12.5 6A5 5 0 0 0 3.6 5.5 M3.5 3v2.6h2.6 M3.5 10a5 5 0 0 0 8.9.5 M12.5 13v-2.6H9.9',
  up: 'M8 13V3.5 M4.5 7L8 3.5 11.5 7',
  back: 'M10 3.5L5.5 8l4.5 4.5',
  forward: 'M6 3.5L10.5 8 6 12.5',
  pr: 'M4.5 3v10 M11.5 6.5V13 M11.5 6.5c0-2-1.5-3-3.5-3H7 M8.5 1.8L7 3.5l1.5 1.7 M4.5 3a1.2 1.2 0 1 0 0 .01 M4.5 13a1.2 1.2 0 1 0 0 .01 M11.5 13a1.2 1.2 0 1 0 0 .01',
  merge: 'M5 3v10 M5 6c0 3 6 2 6 5v2 M5 3a1.2 1.2 0 1 0 0 .01 M11 13a1.2 1.2 0 1 0 0 .01',
  /** A commit: a dot on a line (as git tools draw one). */
  commit: 'M8 10.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z M1.75 8h3.85 M10.4 8h3.85',
  /** Review (doc.text.magnifyingglass): a page of text under a magnifier. */
  review: 'M8.5 13.5H3.5v-11h5.25l2.75 2.75V7 M5.5 6h3 M5.5 8.5h2 M10.75 13a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5z M12.4 12.4l1.6 1.6',
  hand: 'M5 8V4.2a1 1 0 0 1 2 0V7.5 M7 7V3.2a1 1 0 0 1 2 0V7.5 M9 7V4a1 1 0 0 1 2 0v5c0 2.5-1.5 4.5-4 4.5-1.7 0-2.6-.8-3.6-2.3L2.4 9a1 1 0 0 1 1.7-1L5 9',
  /** Earnings (Stripe): a coin. */
  coin: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z M9.7 6.3c-.3-.6-.9-.9-1.7-.9-.9 0-1.7.5-1.7 1.25 0 1.75 3.4 1 3.4 2.75 0 .75-.8 1.25-1.7 1.25-.8 0-1.4-.3-1.7-.9 M8 4.4v1 M8 10.6v1',
  wand: 'M3 13l7-7 M10 3.5v2 M12.5 6h-2 M12 4l-1.2 1.2 M8.5 2.5l.5 1 M13.5 7.5l-1 .5',
  pulse: 'M1.5 8.5h2.8l1.9-4.8 3.1 8.6 1.9-3.8h3.3',
  /** Open in full (the focus view): two corners pulled out. */
  expand: 'M9.5 2.5h4v4 M13.5 2.5L9 7 M6.5 13.5h-4v-4 M2.5 13.5L7 9',
  /** Open outside Beluga (in the file's own app): an arrow leaving a box. */
  external: 'M9 2.5h4.5V7 M13.5 2.5L7.5 8.5 M11.5 9.5v4h-9v-9h4',
  /** The window with its bottom drawer (the terminal under the chat). */
  panelBottom: 'M2.5 3.5h11v9h-11z M2.5 9.5h11',
  /** The window with its right panel. */
  panelRight: 'M2.5 3.5h11v9h-11z M9.5 3.5v9',
  /** Soft wrap: a line that turns back under itself. */
  wrap: 'M2.5 4h11 M2.5 8h9a2 2 0 0 1 0 4H8 M9.5 10.5L8 12l1.5 1.5 M2.5 12h3',
  /** A document's outline (its headings). */
  outline: 'M5.5 4h8 M7.5 8h6 M7.5 12h6 M2.5 4h.01 M4.5 8h.01 M4.5 12h.01',
  minus: 'M3.5 8h9',
  /** The reader's callouts: note, tip, important, caution (warning is `alert`). */
  info: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z M8 7.5v3.5 M8 5.2v.01',
  bulb: 'M6 11.5h4 M6.5 13.5h3 M8 2.5a3.75 3.75 0 0 0-2.4 6.6c.4.4.6.8.6 1.4h3.6c0-.6.2-1 .6-1.4A3.75 3.75 0 0 0 8 2.5z',
  important: 'M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h.5A1.5 1.5 0 0 1 3 9.5z M8 5v2.6 M8 9.2v.01',
  stopSign: 'M5.7 2.5h4.6l3.2 3.2v4.6l-3.2 3.2H5.7l-3.2-3.2V5.7z M8 5.3v3.2 M8 10.7v.01',
  /** A sub-agent: a small robot (Claude's helpers, as opposed to your own work). */
  bot: 'M4.5 6.5h7A1.5 1.5 0 0 1 13 8v3.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 11.5V8a1.5 1.5 0 0 1 1.5-1.5z M8 6.5V4.2 M8 2.8v.01 M6.2 9.4v.8 M9.8 9.4v.8 M1.5 9.2v1.4 M14.5 9.2v1.4',
  /** Tasks: a ring with a check (the board). */
  task: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z M5.75 8.1l1.55 1.55 2.95-3.2',
  /** A GitHub issue: a ring with a dot, as GitHub draws one (Issues). */
  issue: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z M8 7.25a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5z',
  /** Fix It: a wrench. */
  wrench: 'M9.8 4.2a.67.67 0 0 0 0 .93l1.07 1.07a.67.67 0 0 0 .93 0l2.51-2.51a4 4 0 0 1-5.29 5.29l-4.61 4.61a1.41 1.41 0 0 1-2-2l4.61-4.61a4 4 0 0 1 5.29-5.29z',
  /** A board's columns. */
  columns: 'M2.5 3.5h3v9h-3z M6.5 3.5h3v6h-3z M10.5 3.5h3v7.5h-3z',
  /** A list's rows. */
  rows: 'M2.5 4h11 M2.5 8h11 M2.5 12h11',
  /** What waits on what. */
  graph: 'M4 4.5a1.5 1.5 0 1 0 0-.01 M12 8a1.5 1.5 0 1 0 0-.01 M4 11.5a1.5 1.5 0 1 0 0-.01 M5.4 5.2l5.2 2.3 M5.4 10.8l5.2-2.3',
  /** A flag (a due date). */
  calendar: 'M2.5 4h11v9.5h-11z M2.5 6.5h11 M5.5 2.5v3 M10.5 2.5v3',
  /** A tag (labels). */
  tag: 'M2.5 2.5h5.5l6 6-5.5 5.5-6-6z M5.25 5.25h.01',
  flag: 'M4 13.5V2.5 M4 3h8l-2 2.5 2 2.5H4',
  diamond: 'M8 2.5l5.5 5.5L8 13.5 2.5 8z',
  /** Views (beluga-view): a table, a line chart, an area chart, a bar chart, a palette. */
  table: 'M2.5 3.5h11v9h-11z M2.5 6.5h11 M2.5 9.5h11 M6.5 3.5v9',
  chartLine: 'M2.5 2.5v11h11 M4.5 10.5l2.5-3 2 1.5 3.5-4.5',
  chartArea: 'M2.5 2.5v11h11 M4.5 11.5V9l2.5-2.5 2 1.5 3.5-3.5v7z',
  chartBar: 'M2.5 2.5v11h11 M5 11.5V8.5 M8 11.5V5.5 M11 11.5V7.5',
  /** A timeline (gantt): bars that start one after another. */
  gantt: 'M2.5 2.5v11 M4.5 4.5h4.5 M6.5 8h6.5 M5.5 11.5h3.5',
  /** A heatmap: a grid of cells, some filled. */
  heat: 'M2.5 2.5h11v11h-11z M2.5 8h11 M8 2.5v11 M4.5 4.5h1.5v1.5h-1.5z M10 10h1.5v1.5H10z',
  /** Your phone (the companion): the sidebar footer's mark, Settings › Phone. */
  phone: 'M5.5 1.75h5a1 1 0 0 1 1 1v10.5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1z M7.25 12.25h1.5',
  /** Supporting Beluga (a star on GitHub), a cup (Food & Drink emoji), and a heart. */
  star: 'M8 2.25l1.75 3.55 3.9.57-2.83 2.76.67 3.89L8 11.18l-3.49 1.84.67-3.89L2.35 6.37l3.9-.57z',
  cup: 'M3 6.5h7.5v3a3.5 3.5 0 0 1-3.5 3.5h-.5A3.5 3.5 0 0 1 3 9.5z M10.5 7.5h.75a1.75 1.75 0 0 1 0 3.5h-1.1 M5.5 2.5c-.4.6.4 1.1 0 1.75 M8 2.5c-.4.6.4 1.1 0 1.75',
  heart: 'M8 13.25S2.75 10.1 2.75 6.4A2.65 2.65 0 0 1 8 5.1a2.65 2.65 0 0 1 5.25 1.3C13.25 10.1 8 13.25 8 13.25z',
  /** Sentinel (docs/sentinel.md): a shield with a small dot at its centre, a watcher. */
  sentinel: 'M8 2l5 1.9v4c0 3-2.1 5.1-5 6.1-2.9-1-5-3.1-5-6.1v-4z M8 7.1a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z',
  /** Paused: two bars. */
  pause: 'M5.75 3.75v8.5 M10.25 3.75v8.5',
  /** Labels (core/board/labels.ts): a bug, an exclamation in a ring, sparkles, an open book, a bolt. */
  bug: 'M5.5 6.75a2.5 2.5 0 0 1 5 0v3a2.5 2.5 0 0 1-5 0z M6.25 4.6L5.25 3.25 M9.75 4.6l1-1.35 M5.5 8.25H3 M13 8.25h-2.5 M5.6 10.6l-1.85 1.4 M10.4 10.6l1.85 1.4 M5.6 6.1L3.75 4.9 M10.4 6.1l1.85-1.2 M8 7.25v4.9',
  exclaim: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z M8 5v3.4 M8 10.75v.01',
  sparkles: 'M7 2.5l1.15 3.1 3.1 1.15-3.1 1.15L7 11 5.85 7.9 2.75 6.75l3.1-1.15z M12 9.5v4 M10 11.5h4',
  book: 'M2.75 3.5H6A2 2 0 0 1 8 5.5v8a1.5 1.5 0 0 0-1.5-1.5H2.75z M13.25 3.5H10A2 2 0 0 0 8 5.5v8A1.5 1.5 0 0 1 9.5 12h3.75z',
  bolt: 'M9 2L3.75 9h4l-1 5 5.5-7.25h-4z',
  /** An epic: a task with sub-tasks, as stacked layers. */
  epic: 'M8 2.5l5.5 2.75L8 8 2.5 5.25z M2.5 8L8 10.75 13.5 8 M2.5 10.75L8 13.5l5.5-2.75',
  /** A status's emoji, before you pick one: a smiling face. */
  smile: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z M5.6 9.2a2.9 2.9 0 0 0 4.8 0 M6.1 6.6v.01 M9.9 6.6v.01',
  /** Add a reaction (BLG-702): a smile with a plus at its shoulder. */
  smilePlus: 'M13 7.4A5.25 5.25 0 1 1 8.6 3 M5.4 9.3a2.8 2.8 0 0 0 4.6 0 M5.9 6.6v.01 M9.3 6.6v.01 M12.5 1.8v3.8 M10.6 3.7h3.8',
  palette: 'M8 2.5a5.5 5.5 0 1 0 0 11c.9 0 1.3-.6 1.3-1.2 0-.8-.7-1-.7-1.8 0-.6.5-1 1.1-1h1.4A2.4 2.4 0 0 0 13.5 7c0-2.5-2.5-4.5-5.5-4.5z M5.25 7.25h.01 M7.25 5.25h.01 M10 5.5h.01',
  // Calls (BLG-706): the handset, hanging up, the microphone off, sharing a screen, pointing, rubbing out.
  call: 'M5.4 2.5l1.3 2.6-1.2 1.2a7.6 7.6 0 0 0 4.2 4.2l1.2-1.2 2.6 1.3-.5 2.1a1 1 0 0 1-1 .8A10 10 0 0 1 2.5 4a1 1 0 0 1 .8-1z',
  callEnd: 'M2 9.4c3.3-3.2 8.7-3.2 12 0l-1.1 1.9-2.6-.8V8.7a8.4 8.4 0 0 0-4.6 0v1.8l-2.6.8z',
  micOff: 'M10 7.2V4.5a2 2 0 0 0-3.8-.9 M6 6.5v1.5a2 2 0 0 0 3 1.7 M4.5 7.5a3.5 3.5 0 0 0 5.6 2.8 M11.4 8.2c.07-.23.1-.46.1-.7 M8 11v2.5 M6 13.5h4 M2.5 2.5l11 11',
  screenShare: 'M2.5 3.5h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z M5.5 14h5 M8 12v2 M8 9.5V5.75 M6.25 7.5 8 5.75l1.75 1.75',
  pointer: 'M3.5 2.5l9 3.6-3.9 1.4 3.4 3.4-1.4 1.4-3.4-3.4-1.4 3.9z',
  video: 'M2.5 4.5h7.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z M11 7l3.5-2v6L11 9',
  videoOff: 'M5 4.5h5a1 1 0 0 1 1 1v3 M11 9.5v1a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1 M11 7l3.5-2v6l-2-1.15 M2 2l12 12',
  eraser: 'M9.2 3.3l3.5 3.5a1 1 0 0 1 0 1.4L8.4 12.5H5.6l-2.3-2.3a1 1 0 0 1 0-1.4l4.5-4.5a1 1 0 0 1 1.4 0z M6.2 6.3l3.5 3.5 M8.4 12.5h5',
  square: 'M4.5 3h7A1.5 1.5 0 0 1 13 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 11.5v-7A1.5 1.5 0 0 1 4.5 3z',
  speaker: 'M2.75 6.25h2.5L8.5 3.5v9L5.25 9.75h-2.5z M10.75 5.75a3 3 0 0 1 0 4.5 M12.5 4a5.5 5.5 0 0 1 0 8',
  // Your computers (BLG-813): a Mac mini, a server in a rack, a cloud machine, one that's always on.
  power: 'M8 2.5v5 M5 4.25a5 5 0 1 0 6 0',
} as const;

/** Agents and model makers (BLG-497) are their makers' own logos, filled (shared/agent-marks.ts; the phone draws the same). */
export type IconName = keyof typeof PATHS | AgentMark;

const isMark = (name: IconName): name is AgentMark => name in AGENT_MARKS;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  if (isMark(name)) {
    const mark = AGENT_MARKS[name];
    return (
      <svg width={size} height={size} viewBox={AGENT_MARK_VIEWBOX} fill={mark.color ?? 'currentColor'} aria-hidden="true" {...rest}>
        <path d={mark.d} {...(mark.evenOdd ? { fillRule: 'evenodd' as const, clipRule: 'evenodd' as const } : {})} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}
