/**
 * Beluga's environment variables: BELUGA_<name>, else the KLAUD_<name> it had before the rename
 * (scripts, tests and shell profiles that still set the old name keep working).
 */
export const belugaEnv = (name: string, env: NodeJS.ProcessEnv = process.env): string | undefined => env[`BELUGA_${name}`] ?? env[`KLAUD_${name}`];

/** A variable Beluga sets for a program it starts, under both names, so older readers see it too. */
export const belugaEnvBoth = (name: string, value: string): Record<string, string> => ({ [`BELUGA_${name}`]: value, [`KLAUD_${name}`]: value });

/** Fork repository where custom releases, server tarballs and companion APKs are published. */
export const RELEASE_REPO = 'faufderhar/beluga';
export const RELEASE_DOWNLOAD_BASE = `https://github.com/${RELEASE_REPO}/releases/latest/download`;

