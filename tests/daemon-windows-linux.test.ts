// The daemon on Windows and Linux (BLG-628): what differs there, tested on any computer by handing
// each piece its system (and env) instead of reading this one's.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import { commandArgs, isPosixShell, shellArgs, shellName, takesLoginFlag } from '../src/shared/shells.js';
import { decideTool, insideFolder } from '../src/agent/policy.js';
import { isSendablePath } from '../src/agent/tools.js';
import { codexCommand, findCodex, pathVar } from '../src/agent/runtime/codex/app-server.js';
import { baseEnv, peerShell } from '../src/core/peer-run.js';
import { linkEntry } from '../src/agent/runtime/claude/skill-plugins.js';
import { CLAUDE_CODE_API } from '../src/ipc/claude-code-api.js';
import { jsThumbnailer, thumbnailersFor } from '../src/companion/files.js';
import { jsShrinker, shrinkerFor, sipsShrinker } from '../src/companion/icons.js';
import { droppedImagePaths, windowsClipboardScript } from '../src/core/attachments.js';
import { expandHome, homeDir, isFullPath, startsAtHome } from '../src/core/home-path.js';
import { expandPath } from '../src/core/remote-work.js';
import { findTool, toolCommand } from '../src/workspaces/pr.js';
import { detectSetup } from '../src/workspaces/scripts.js';
import { pastedText } from '../src/core/clipboard.js';
import { linuxOnBattery } from '../src/core/power-source.js';
import { editorCommand } from '../src/core/editor-command.js';
import { withPictures } from '../src/companion/views.js';
import { findAdb } from '../src/companion/phone-adb.js';
import type { SystemPort } from '../src/core/gateway/device.js';

const only = (...files: string[]) => (file: string) => files.includes(file);
const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-win-')));

describe('the terminal on Windows', () => {
  const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const CMD = 'C:\\Windows\\System32\\cmd.exe';
  const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

  it('names Windows shells without .exe, and knows Git Bash speaks sh', () => {
    expect(shellName(PWSH)).toBe('PowerShell');
    expect(shellName(POWERSHELL)).toBe('Windows PowerShell');
    expect(shellName(CMD)).toBe('Command Prompt');
    expect(shellName(BASH)).toBe('bash');
    expect(shellName('C:\\tools\\Fish.EXE')).toBe('fish');
    expect(isPosixShell(BASH)).toBe(true);
    expect(isPosixShell('C:\\Git\\bin\\BASH.EXE')).toBe(true);
    expect(isPosixShell(PWSH)).toBe(false);
  });

  it('starts PowerShell and cmd without -l, and Git Bash, fish and nu with it', () => {
    for (const shell of [PWSH, POWERSHELL, CMD]) {
      expect(takesLoginFlag(shell)).toBe(false);
      expect(shellArgs({ login: true, extra: ['-NoLogo'], shell })).toEqual(['-NoLogo']);
    }
    for (const shell of [BASH, 'C:\\tools\\fish.exe', 'C:\\tools\\nu.exe']) expect(shellArgs({ login: true, extra: [], shell })).toEqual(['-l']);
  });

  it('keeps every Mac and Linux shell as it was: -l whenever it is a login shell', () => {
    for (const shell of ['/bin/zsh', '/opt/homebrew/bin/fish', '/usr/local/bin/pwsh', '/usr/local/bin/elvish', undefined]) {
      expect(shellArgs({ login: true, extra: [], ...(shell ? { shell } : {}) })).toEqual(['-l']);
      expect(commandArgs(shell, 'npm i')[0]).toBe('-l');
    }
    // An sh-like shell stays to end last (so a quick command's own exit can't hang up its terminal); others run it as is.
    for (const shell of ['/bin/zsh', '/bin/bash', undefined]) expect(commandArgs(shell, 'touch .ready')).toEqual(['-l', '-c', 'touch .ready\nexit $?']);
    for (const shell of ['/opt/homebrew/bin/fish', '/usr/local/bin/pwsh', '/usr/local/bin/elvish']) expect(commandArgs(shell, 'npm i')).toEqual(['-l', '-c', 'npm i']);
    expect(shellArgs({ login: false, extra: ['-i'], shell: '/bin/zsh' })).toEqual(['-i']);
  });

  it('runs one command line the way each Windows shell takes it', () => {
    expect(commandArgs(BASH, 'npm i && npm run dev')).toEqual(['-l', '-c', 'npm i && npm run dev\nexit $?']);
    expect(commandArgs(PWSH, 'npm i')).toEqual(['-NoLogo', '-Command', 'npm i']);
    expect(commandArgs(POWERSHELL, 'npm i')).toEqual(['-NoLogo', '-Command', 'npm i']);
    expect(commandArgs(CMD, 'npm i')).toEqual(['/d', '/s', '/c', 'npm i']);
  });
});

describe('paths from home and full paths, anywhere', () => {
  it('expands ~/ and ~\\ with your home, and only those', () => {
    expect(expandHome('~/a', '/Users/me')).toBe(path.join('/Users/me', 'a'));
    expect(expandHome('~\\Documents\\a.txt', 'C:\\Users\\me')).toBe(path.join('C:\\Users\\me', 'Documents\\a.txt'));
    expect(expandHome('~', 'C:\\Users\\me')).toBe('C:\\Users\\me');
    expect(expandHome('~bob/a', '/Users/me')).toBe('~bob/a');
    expect(expandHome('a/~/b', '/Users/me')).toBe('a/~/b');
    expect(startsAtHome('~\\x')).toBe(true);
    expect(startsAtHome('~x')).toBe(false);
  });

  it('lands on the same file the tools open, so a check and its tool agree', () => {
    for (const p of ['~/proj/x', '~\\proj/x', '~']) expect(expandHome(p, '/Users/me')).toBe(expandPath(p, '/Users/me'));
  });

  it('finds the home folder where Windows has no $HOME', () => {
    expect(homeDir({ HOME: '/Users/me' })).toBe('/Users/me');
    expect(homeDir({})).toBe(os.homedir());
  });

  it('knows a full path on every system', () => {
    for (const p of ['/Users/me/a', 'C:\\Users\\me', 'c:/x', '\\\\server\\share\\x']) expect(isFullPath(p), p).toBe(true);
    for (const p of ['a/b', 'C:relative', '~/x', '', '.\\x']) expect(isFullPath(p), p).toBe(false);
  });

  it('lets send_file take a Windows path or one from home', () => {
    for (const p of ['/tmp/a.pdf', '~/a.pdf', '~\\a.pdf', 'C:\\Users\\me\\a.pdf', 'D:/out/a.png', '\\\\nas\\share\\a.pdf']) expect(isSendablePath(p), p).toBe(true);
    for (const p of ['a.pdf', 'out\\a.pdf', '~a.pdf']) expect(isSendablePath(p), p).toBe(false);
  });
});

describe("Claude's tools and where they may reach", () => {
  it('compares Windows folders without regard to letter case, and others as they are', () => {
    expect(insideFolder('C:\\Code\\App', 'c:\\code\\app\\vendor', 'win32')).toBe(true);
    expect(insideFolder('C:\\Code\\App', 'C:\\CODE\\APP', 'win32')).toBe(true);
    expect(insideFolder('C:\\Code\\App', 'C:\\Code\\App-old\\x', 'win32')).toBe(false);
    expect(insideFolder('C:\\Code\\App', 'C:\\Code\\Other', 'win32')).toBe(false);
    expect(insideFolder('/code/App', '/code/app/x', 'darwin')).toBe(false);
    expect(insideFolder('/code/app', '/code/app/x', 'linux')).toBe(true);
  });

  it("keeps a friend's file out of the main folder, reached through ~ or a link", () => {
    const dir = tmp();
    const main = path.join(dir, 'app');
    mkdirSync(main);
    symlinkSync(main, path.join(dir, 'shortcut'));
    const ctx = { cwd: main, roots: [main], autoEdit: false, askOnly: true, scope: 'full' as const };
    const fetch = (save_to: string) => decideTool('mcp__beluga__get_peer_file', { peer: 'bob', path: '~/x', save_to }, ctx);
    expect(fetch(path.join(dir, 'shortcut', 'vendor'))).toBe('deny');
    expect(fetch(path.join(main, 'vendor'))).toBe('deny');
    expect(fetch(path.join(dir, 'elsewhere'))).toBe('ask');
    const home = process.env.HOME;
    process.env.HOME = dir;
    try {
      expect(fetch('~/app/vendor')).toBe('deny');
      // Written "~\\app" it's the same folder to the tool that saves it: still denied.
      expect(fetch('~\\app')).toBe('deny');
      expect(fetch('~\\app/vendor')).toBe('deny');
      expect(fetch('~/downloads')).toBe('ask');
    } finally {
      process.env.HOME = home;
    }
  });
});

describe('Codex on Windows', () => {
  const env = { Path: 'C:\\Users\\me\\AppData\\Roaming\\npm;C:\\tools' };

  it('reads PATH however Windows spells it', () => {
    expect(pathVar(env)).toBe(env.Path);
    expect(pathVar({ PATH: '/usr/bin' })).toBe('/usr/bin');
    expect(pathVar({})).toBe('');
  });

  it('finds codex.exe first, then npm\'s codex.cmd, never the extensionless shim', () => {
    expect(findCodex(env, 'win32', only('C:\\Users\\me\\AppData\\Roaming\\npm\\codex', 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd', 'C:\\tools\\codex.exe'))).toBe('C:\\tools\\codex.exe');
    expect(findCodex(env, 'win32', only('C:\\Users\\me\\AppData\\Roaming\\npm\\codex', 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd'))).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd');
    expect(findCodex(env, 'win32', only('C:\\Users\\me\\AppData\\Roaming\\npm\\codex'))).toBeUndefined();
    expect(findCodex({ PATH: '/usr/bin:/opt/bin' }, 'linux', only('/opt/bin/codex'))).toBe('/opt/bin/codex');
  });

  it('starts a .cmd through cmd with everything quoted, and anything else as it is', () => {
    expect(codexCommand('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd', ['app-server'])).toEqual({ command: '"C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd" "app-server"', args: [], shell: true });
    expect(codexCommand('C:\\a b\\codex.CMD', ['say "hi" & x'])).toEqual({ command: '"C:\\a b\\codex.CMD" "say ""hi"" & x"', args: [], shell: true });
    expect(codexCommand('C:\\tools\\codex.exe', ['app-server'])).toEqual({ command: 'C:\\tools\\codex.exe', args: ['app-server'], shell: false });
    expect(codexCommand('/usr/local/bin/codex', ['app-server']).shell).toBe(false);
  });
});

describe("a friend's command on Windows", () => {
  it('keeps what Windows needs to start programs, whatever the case of PATH, and never tokens', () => {
    const env = { Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.EXE;.CMD', TEMP: 'C:\\Temp', USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', GITHUB_TOKEN: 'sekret', ANTHROPIC_API_KEY: 'sekret' };
    const out = baseEnv(env, 'win32');
    expect(out).toMatchObject({ PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', ComSpec: env.ComSpec, PATHEXT: '.EXE;.CMD', TEMP: 'C:\\Temp', USERPROFILE: env.USERPROFILE, APPDATA: env.APPDATA, 'ProgramFiles(x86)': env['ProgramFiles(x86)'] });
    expect(Object.values(out)).not.toContain('sekret');
  });

  it('gives a Mac and Linux only the basics, as before', () => {
    expect(baseEnv({ PATH: '/usr/bin', HOME: '/Users/me', SystemRoot: 'x', Path: 'y', GITHUB_TOKEN: 'sekret' }, 'darwin')).toEqual({ PATH: '/usr/bin', HOME: '/Users/me' });
  });

  it('runs it in Git Bash when Windows has it, else cmd', () => {
    expect(peerShell('ls -la', 'win32', () => 'C:\\Program Files\\Git\\bin\\bash.exe')).toEqual({ file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['-c', 'ls -la'] });
    expect(peerShell('dir', 'win32', () => undefined)).toEqual({ file: 'cmd.exe', args: ['/d', '/s', '/c', 'dir'] });
    expect(peerShell('ls', 'darwin')).toEqual({ file: '/bin/sh', args: ['-c', 'ls'] });
  });
});

describe("a project's skills on Windows", () => {
  it('links a folder (a junction there) and copies a file, where Windows allows no plain link', () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'skills'));
    writeFileSync(path.join(dir, 'skills', 'a.md'), 'skill');
    writeFileSync(path.join(dir, 'notes.md'), 'notes');
    linkEntry(path.join(dir, 'skills'), path.join(dir, 'skills-link'), 'win32');
    linkEntry(path.join(dir, 'notes.md'), path.join(dir, 'notes-copy.md'), 'win32');
    linkEntry(path.join(dir, 'skills'), path.join(dir, 'skills-mac'), 'darwin');
    expect(readFileSync(path.join(dir, 'skills-link', 'a.md'), 'utf8')).toBe('skill');
    expect(lstatSync(path.join(dir, 'notes-copy.md')).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(dir, 'notes-copy.md'), 'utf8')).toBe('notes');
    expect(lstatSync(path.join(dir, 'skills-mac')).isSymbolicLink()).toBe(true);
  });
});

describe("the API's full paths", () => {
  const output = CLAUDE_CODE_API['claudeCode.output'].args;
  const ok = (file: string): boolean => output.safeParse(['0123abcd', 'agent-1', file]).success;

  it('takes Windows paths as well as Mac ones, never a relative path or a NUL', () => {
    for (const p of ['/Users/me/shot.png', 'C:\\Users\\me\\shot.png', 'C:/x/shot.png', '\\\\nas\\share\\shot.png']) expect(ok(p), p).toBe(true);
    for (const p of ['shot.png', 'C:shot.png', '..\\x', '/x\0y']) expect(ok(p), p).toBe(false);
  });
});

/** A 40×20 PNG, half transparent. */
function writePng(file: string): void {
  const png = new PNG({ width: 40, height: 20 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([200, 50, 50, i < png.data.length / 2 ? 255 : 0], i);
  writeFileSync(file, PNG.sync.write(png));
}

describe('pictures made small without sips (Windows and Linux)', () => {
  it('makes a JPEG thumbnail and a PNG icon of a picture', async () => {
    const dir = tmp();
    const src = path.join(dir, 'a.png');
    writePng(src);
    await jsThumbnailer(src, path.join(dir, 'thumb.jpg'));
    const thumb = jpeg.decode(readFileSync(path.join(dir, 'thumb.jpg')));
    expect([thumb.width, thumb.height]).toEqual([40, 20]);
    await jsShrinker(src, path.join(dir, 'icon.png'), 10);
    const icon = PNG.sync.read(readFileSync(path.join(dir, 'icon.png')));
    expect([icon.width, icon.height]).toEqual([10, 5]);
  });

  it("fails clearly on what it can't read, and gives videos no poster", async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'x.webp'), 'not a picture');
    await expect(jsThumbnailer(path.join(dir, 'x.webp'), path.join(dir, 't.jpg'))).rejects.toThrow('Could not make a thumbnail');
    await expect(thumbnailersFor('linux').poster(path.join(dir, 'a.mp4'), path.join(dir, 'p.jpg'))).rejects.toThrow(/No poster/);
    expect(existsSync(path.join(dir, 't.jpg'))).toBe(false);
  });

  it('keeps sips and Quick Look on a Mac', () => {
    expect(shrinkerFor('darwin')).toBe(sipsShrinker);
    expect(shrinkerFor('win32')).toBe(jsShrinker);
    expect(thumbnailersFor('linux').thumbnail).toBe(jsThumbnailer);
  });
});

describe('pasting and dropping pictures on Windows', () => {
  const exists = () => true;

  it('keeps the backslashes of a dropped Windows path', () => {
    expect(droppedImagePaths('C:\\Users\\me\\Pictures\\shot.png', exists, 'win32')).toEqual(['C:\\Users\\me\\Pictures\\shot.png']);
    expect(droppedImagePaths('"C:\\Users\\me\\My Shots\\a.jpg" \\\\nas\\pics\\b.gif', exists, 'win32')).toEqual(['C:\\Users\\me\\My Shots\\a.jpg', '\\\\nas\\pics\\b.gif']);
    expect(droppedImagePaths('~\\Pictures\\a.png', exists, 'win32', 'C:\\Users\\me')).toEqual(['C:\\Users\\me\\Pictures\\a.png']);
  });

  it('reads a file:// URL as a Windows path there, and as before on a Mac', () => {
    expect(droppedImagePaths('file:///C:/Users/me/x%20y.png', exists, 'win32')).toEqual(['C:\\Users\\me\\x y.png']);
    expect(droppedImagePaths('file:///img/x%20y.png', exists, 'darwin')).toEqual(['/img/x y.png']);
    expect(droppedImagePaths('/img/My\\ Shot.png', exists, 'darwin')).toEqual(['/img/My Shot.png']);
  });

  it("saves the clipboard's picture with PowerShell, the path quoted for it", () => {
    const script = windowsClipboardScript("C:\\Users\\o'neil\\.beluga\\attachments\\a.png");
    expect(script).toContain("$img.Save('C:\\Users\\o''neil\\.beluga\\attachments\\a.png', [System.Drawing.Imaging.ImageFormat]::Png)");
    expect(script).toContain('GetFileDropList');
  });

  it('pastes text without the line end Get-Clipboard adds', () => {
    expect(pastedText('hello\r\n', 'win32')).toBe('hello');
    expect(pastedText('a\r\nb\r\n', 'win32')).toBe('a\r\nb');
    expect(pastedText('hello\n', 'darwin')).toBe('hello\n');
  });
});

describe('tools found on Windows', () => {
  it('finds a program by the endings PATHEXT lists', () => {
    const PATH = 'C:\\Windows\\System32;C:\\Program Files\\GitHub CLI';
    expect(findTool('gh', PATH, only('C:\\Program Files\\GitHub CLI\\gh.exe'), 'win32', '.COM;.EXE;.BAT;.CMD')).toBe('C:\\Program Files\\GitHub CLI\\gh.exe');
    expect(findTool('brew', PATH, only('/opt/homebrew/bin/brew'), 'win32', '.EXE')).toBeUndefined();
    expect(toolCommand('gh', PATH, only('C:\\Program Files\\GitHub CLI\\gh.exe'), 'win32')).toBe('gh');
    // PATH's folder written with a trailing backslash, in another case: still on PATH.
    expect(toolCommand('gh', 'C:\\program files\\github cli\\;C:\\Windows', only('C:\\Program Files\\GitHub CLI\\gh.exe'), 'win32')).toBe('gh');
    expect(findTool('gh', '/usr/bin:/bin', only('/opt/homebrew/bin/gh'), 'darwin')).toBe('/opt/homebrew/bin/gh');
  });

  it("sets Python projects up with Windows' venv layout", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'requirements.txt'), 'requests\n');
    expect(detectSetup(dir, 'win32')).toBe('python -m venv .venv && .venv/Scripts/pip install -r requirements.txt');
    expect(detectSetup(dir, 'darwin')).toBe('python3 -m venv .venv && .venv/bin/pip install -r requirements.txt');
  });

  it("opens your editor through cmd on Windows (code is code.cmd there)", () => {
    expect(editorCommand('code', 'C:\\Users\\me\\.beluga\\pr.md', 'win32')).toEqual({ command: 'code', args: ['"C:\\Users\\me\\.beluga\\pr.md"'], shell: true });
    expect(editorCommand('code', '/Users/me/.beluga/pr.md', 'darwin')).toEqual({ command: 'code', args: ['/Users/me/.beluga/pr.md'], shell: false });
  });

  it('tries adb on PATH where there is no which', async () => {
    const tried: string[] = [];
    const sys = {
      exec: vi.fn(async (cmd: string) => {
        tried.push(cmd);
        if (cmd === '/usr/bin/which') throw new Error('ENOENT');
        return cmd === 'adb' ? { code: 0, stdout: 'Android Debug Bridge version 1.0.41\n', stderr: '' } : { code: 1, stdout: '', stderr: '' };
      }),
    } as unknown as SystemPort;
    expect(await findAdb(sys, 'C:\\Users\\me')).toEqual({ path: 'adb', version: '1.0.41' });
    expect(tried).toEqual(['/usr/bin/which', 'adb']);
  });
});

describe('Linux on battery', () => {
  it('is on battery when a battery discharges', () => {
    expect(linuxOnBattery([{ type: 'Mains\n' }, { type: 'Battery\n', status: 'Discharging\n' }])).toBe(true);
    expect(linuxOnBattery([{ type: 'Battery', status: 'Charging' }])).toBe(false);
    expect(linuxOnBattery([{ type: 'Battery', status: 'Full' }])).toBe(false);
    expect(linuxOnBattery([])).toBe(false);
  });
});

describe("pictures in Claude's words on the phone", () => {
  it('turns a Windows path or file:///C:/ into a ref', () => {
    const seen: string[] = [];
    const refs = { output: (p: string) => (seen.push(p), { ref: 'out:1', name: 'a.png', kind: 'image' as const }) };
    const prose = (text: string) => ({ text }) as Parameters<typeof withPictures>[0];
    expect(withPictures(prose('![shot](C:\\Users\\me\\a.png)'), refs).text).toBe('![shot](out:1)');
    expect(withPictures(prose('![shot](file:///C:/Users/me/a%20b.png)'), refs).text).toBe('![shot](out:1)');
    expect(withPictures(prose('![shot](relative/a.png)'), refs).text).toBe('![shot](relative/a.png)');
    expect(seen).toEqual(['C:\\Users\\me\\a.png', 'C:/Users/me/a b.png']);
  });
});
