import { useProjectIcon } from '../lib/projects.js';
import { type RowColor, tileHue } from '../lib/row-colors.js';
import s from './ProjectIcon.module.css';

/** A calm colour for a project without an icon, the same every time for the same name. */
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/**
 * A project's own icon (its app icon, favicon or logo, or one you chose), else a tile with its
 * initial: you find a project by its look, like apps in the Dock.
 */
/** `id`: a project's id, or `path:<folder>` for a folder that isn't one yet. `color`: one you gave the project, for its letter tile. */
export function ProjectIcon({ id, name, size = 16, color }: { id: string; name: string; size?: number; color?: RowColor | undefined }) {
  const icon = useProjectIcon(id);
  const radius = Math.round(size * 0.24);
  if (icon) return <img className={s.image} src={icon} alt="" width={size} height={size} style={{ borderRadius: radius }} draggable={false} />;
  return (
    <span className={s.tile} style={{ width: size, height: size, borderRadius: radius, fontSize: size * 0.58, ['--h' as string]: color ? tileHue(color) : hue(name) }} aria-hidden="true">
      {/* Before the icon is known, an empty tile (no flash of a letter, then a picture). */}
      {icon === null ? (name.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase() : null}
    </span>
  );
}
