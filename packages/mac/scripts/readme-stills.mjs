// A still of every README GIF, for narrow screens: the README shows them under 700px wide (GitHub's
// phone app flickers the whole README while its GIFs play), and the GIF from there up.
//   node scripts/readme-stills.mjs   → assets/<dir>/<name>-still.png beside each GIF
// Needs ffmpeg. Run it after gifs.mjs or readme-scenes.mjs.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../../..');

/** Each GIF and how far into it its still is (0 to 1): a moment where the story reads on its own. */
const STILLS = {
  'scenes/parallel-dark': 0.3,
  'scenes/scratch-dark': 0.8,
  'scenes/together-dark': 0.46,
  'scenes/tables-dark': 0.55,
  'scenes/friends-dark': 0.95,
  'scenes/sentinel-dark': 0.45,
  'scenes/machines-dark': 0.45,
  'scenes/earnings-dark': 0.75,
  'scenes/archive-dark': 0.95,
  'mac/worktree-per-task': 0.95,
  'mac/scratch': 0.95,
  'mac/views': 0.55,
  'mac/graph': 0.75,
  'mac/tasks': 0.55,
  'mac/ask-a-friend': 0.95,
  'mac/wants-to': 0.3,
  'mac/sentinel': 0.75,
  'mac/fire': 0.62,
};

for (const [name, at] of Object.entries(STILLS)) {
  const gif = path.join(repo, 'assets', `${name}.gif`);
  const png = path.join(repo, 'assets', `${name}-still.png`);
  const count = Number(
    execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', gif]).toString().trim(),
  );
  const frame = Math.min(count - 1, Math.round(count * at));
  // The GIF's own colours, so the still is as small as one of its frames.
  const vf = `select=eq(n\\,${frame}),split[a][b];[a]palettegen=max_colors=256:stats_mode=single[p];[b][p]paletteuse=dither=none`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', gif, '-lavfi', vf, '-frames:v', '1', '-fps_mode', 'vfr', png]);
  console.log(`${name}: ${path.relative(repo, png)} (frame ${frame} of ${count})`);
}
