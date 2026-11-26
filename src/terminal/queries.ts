/**
 * Terminal queries: what a program writes to ask its terminal something (the background colour, where
 * the cursor is, which terminal it is). The terminal answers by typing into the program.
 *
 * A screen that attaches later draws the program's backlog again; queries in it would be answered a
 * second time, long after the program stopped waiting, and the answers would land in its input (a shell
 * shows `^[]11;rgb:0000/0000/0000^[\^[[37;1R`). So replayed output goes without them.
 */
const ST = String.raw`(?:\x07|\x1b\\)`;

const QUERIES = new RegExp(
  [
    // OSC colour queries: 4;n;? (palette), 10-19;? (foreground, background, cursor…), 52;c;? (clipboard).
    String.raw`\x1b\](?:4;\d+|1\d|5;\d+|52;[^;\x07\x1b]*);\?${ST}`,
    // Device status and cursor position reports (CSI 5n, 6n, ?6n, ?15n…).
    String.raw`\x1b\[\??[\d;]*n`,
    // Device attributes (primary, secondary, tertiary).
    String.raw`\x1b\[[>=]?\d*c`,
    // Mode reports (DECRQM), the terminal's version (XTVERSION), the keyboard protocol (kitty).
    String.raw`\x1b\[\??[\d;]*\$p`,
    String.raw`\x1b\[>\d*q`,
    String.raw`\x1b\[\?u`,
    // Window reports: its size and place in pixels or cells, its title.
    String.raw`\x1b\[(?:1[13-9]|2[01])(?:;\d+)*t`,
    // Settings and capabilities (DECRQSS, XTGETTCAP).
    String.raw`\x1bP[$+]q[^\x1b]*\x1b\\`,
  ].join('|'),
  'g',
);

/** `data` without the terminal queries in it (for drawing a backlog again). */
export const withoutQueries = (data: string): string => (data.includes('\x1b') ? data.replace(QUERIES, '') : data);
