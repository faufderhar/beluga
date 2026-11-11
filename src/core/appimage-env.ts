import path from 'node:path';

/**
 * Started from Beluga's Linux AppImage, the daemon inherits the AppImage's loader and plugin paths
 * (LD_LIBRARY_PATH and friends pointing inside $APPDIR), meant for the app's own window. Everything
 * the daemon starts would load those bundled libraries too: git's https helper then mixed the
 * system's libcurl with the AppImage's older libnghttp2 and died ("remote helper 'https' aborted
 * session"). Dropped once at start, so git, ssh, gh, terminals and Claude's commands use the
 * system's own libraries. Elsewhere (no $APPDIR) nothing changes.
 */
export const APPIMAGE_PATH_ENV = [
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'GIO_MODULE_DIR',
  'GIO_EXTRA_MODULES',
  'GTK_PATH',
  'GTK_EXE_PREFIX',
  'GTK_DATA_PREFIX',
  'GTK_IM_MODULE_FILE',
  'GDK_PIXBUF_MODULE_FILE',
  'GDK_PIXBUF_MODULEDIR',
  'GSETTINGS_SCHEMA_DIR',
  'GI_TYPELIB_PATH',
  'GST_PLUGIN_PATH',
  'GST_PLUGIN_PATH_1_0',
  'GST_PLUGIN_SYSTEM_PATH',
  'GST_PLUGIN_SYSTEM_PATH_1_0',
  'GST_PLUGIN_SCANNER',
  'GST_PLUGIN_SCANNER_1_0',
  'PYTHONHOME',
  'PYTHONPATH',
  'PERLLIB',
  'QT_PLUGIN_PATH',
  'XDG_DATA_DIRS',
] as const;

/** `entry` is $APPDIR or inside it. */
const insideApp = (entry: string, appDir: string): boolean => {
  const rel = path.posix.relative(appDir, path.posix.resolve(appDir, entry));
  return path.posix.isAbsolute(entry) && (rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel)));
};

/**
 * Drop the AppImage's own entries from `env`'s loader and plugin paths (this process's own, by
 * default: everything it starts inherits it); what the user had set stays. → the variables changed.
 */
export function dropAppImageEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const appDir = env.APPDIR?.replace(/\/+$/, '');
  if (!appDir || !path.posix.isAbsolute(appDir)) return [];
  return APPIMAGE_PATH_ENV.filter((k) => {
    const value = env[k];
    if (value === undefined) return false;
    // LD_PRELOAD may also separate with spaces; the rest are colon lists.
    const sep = k === 'LD_PRELOAD' && !value.includes(':') ? ' ' : ':';
    const parts = value.split(sep);
    const kept = parts.filter((p) => p !== '' && !insideApp(p, appDir));
    if (kept.length === parts.filter((p) => p !== '').length) return false;
    if (kept.length) env[k] = kept.join(sep);
    else delete env[k];
    return true;
  });
}
