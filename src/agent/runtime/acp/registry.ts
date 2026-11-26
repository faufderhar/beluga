import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { belugaHome } from '../../../core/home.js';
import { BUILTIN_ACP_AGENTS } from './catalog.js';
import type { AcpAgents } from './agents.js';
import { type AcpAgentEntry, acpRuntimeId } from './entry.js';
import { forgetAcpStatus } from './status.js';

/**
 * The ACP Registry (agentclientprotocol.com/get-started/registry), as Beluga uses it (BLG-ACP):
 * the list of ACP agents, searched by name; one installed on your say, at the version the
 * Registry names. A binary is downloaded over HTTPS (checked against its SHA-256 when the Registry
 * gives one) into ~/.beluga/acp/tools/<agent>/<version>/; an npx or uvx package runs at its exact
 * version. Nothing is downloaded or run until you press Install. Registry agents are other
 * people's code: the screens say so before you install one.
 */
export const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
/** An agent's download: the largest today (Cursor's) is about a tenth of this. */
const MAX_ARCHIVE_BYTES = 600 * 1024 * 1024;
/** The Registry changes a few times a day: a search reads it again after a quarter of an hour. */
const REGISTRY_MAX_AGE_MS = 15 * 60_000;

const Id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const Version = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/);
const Arg = z.string().max(1024);
const Env = z.record(z.string(), z.string().max(4096));
const Binary = z.object({ archive: z.string().url(), cmd: z.string().min(1).max(512), args: z.array(Arg).max(32).optional(), env: Env.optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional() });
const Package = z.object({ package: z.string().min(1).max(256), args: z.array(Arg).max(32).optional(), env: Env.optional() });

const Agent = z.object({
  id: Id,
  name: z.string().min(1).max(160),
  version: Version,
  description: z.string().max(2000).optional(),
  repository: z.string().max(512).optional(),
  website: z.string().max(512).optional(),
  license: z.string().max(128).optional(),
  authors: z.array(z.string().max(200)).max(20).optional(),
  icon: z.string().max(512).optional(),
  distribution: z.object({ binary: z.record(z.string(), Binary).optional(), npx: Package.optional(), uvx: Package.optional() }),
});
export type RegistryAgent = z.infer<typeof Agent>;

const RegistryFile = z.object({ version: z.string().optional(), agents: z.array(z.unknown()) });

/** Registry agents Beluga runs with a runtime of its own: they don't show in a search (Your agents has them, or Beluga's own ACP list: Antigravity). */
export const OWN_RUNTIME_AGENTS: Readonly<Record<string, string>> = {
  'claude-acp': 'claude',
  'codex-acp': 'codex',
  'github-copilot-cli': 'copilot',
  'antigravity-acp': 'antigravity',
  opencode: 'opencode',
  'opencode-v2': 'opencode',
};

/** The Registry's agents, those that don't parse left out (a newer Registry's fields don't break an older Beluga). */
export function parseRegistry(json: unknown): RegistryAgent[] {
  const file = RegistryFile.parse(json);
  return file.agents.flatMap((a) => {
    const ok = Agent.safeParse(a);
    return ok.success ? [ok.data] : [];
  });
}

/** This computer as the Registry names platforms: darwin-aarch64, linux-x86_64, windows-x86_64. */
export function registryPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : platform === 'win32' ? 'windows' : undefined;
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined;
  return os && cpu ? `${os}-${cpu}` : undefined;
}

/** How an agent would install here: a binary for this platform first, else npx, else uvx; undefined: not on this computer. */
export function installKind(agent: RegistryAgent, platform = registryPlatform()): 'binary' | 'npx' | 'uvx' | undefined {
  if (platform && agent.distribution.binary?.[platform]) return 'binary';
  if (agent.distribution.npx) return 'npx';
  if (agent.distribution.uvx) return 'uvx';
  return undefined;
}

/** The runtime id an agent gets: a built-in one's when it's one of those (Cursor stays `cursor`), else `acp-<id>`. */
export function registryRuntimeId(agentId: string): string {
  return BUILTIN_ACP_AGENTS.find((b) => b.registryId === agentId)?.id ?? acpRuntimeId(agentId);
}

/** One search result, as the screens show it. */
export interface RegistryHit {
  readonly id: string;
  readonly runtime: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly website?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly icon?: string;
  /** How it installs here (binary, npx, uvx); none: it doesn't run on this computer. */
  readonly kind?: 'binary' | 'npx' | 'uvx';
  /** It's installed already, and at which version. */
  readonly installed?: string;
}

/** The agents whose name, id or description has every word of `query` (all of them for none), runnable ones first. */
export function searchRegistry(agents: readonly RegistryAgent[], query: string, installed: ReadonlyMap<string, string> = new Map(), limit = 50, platform = registryPlatform()): RegistryHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return agents
    .filter((a) => !OWN_RUNTIME_AGENTS[a.id])
    .filter((a) => words.every((w) => `${a.name} ${a.id} ${a.description ?? ''}`.toLowerCase().includes(w)))
    .map((a): RegistryHit => {
      const kind = installKind(a, platform);
      const at = installed.get(a.id);
      return { id: a.id, runtime: registryRuntimeId(a.id), name: a.name, version: a.version, ...(a.description ? { description: a.description } : {}), ...(a.website ? { website: a.website } : {}), ...(a.repository ? { repository: a.repository } : {}), ...(a.license ? { license: a.license } : {}), ...(a.icon ? { icon: a.icon } : {}), ...(kind ? { kind } : {}), ...(at ? { installed: at } : {}) };
    })
    .sort((x, y) => Number(!x.kind) - Number(!y.kind) || x.name.localeCompare(y.name))
    .slice(0, limit);
}

/** Where installed Registry binaries live. */
export const acpToolsDir = (home: string = belugaHome()): string => path.join(home, 'acp', 'tools');

const run = (file: string, args: readonly string[], cwd?: string): Promise<void> =>
  new Promise((resolve, reject) => execFile(file, [...args], { cwd, windowsHide: true, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n').slice(-3).join(' '))) : resolve())));

export interface RegistryDeps {
  readonly fetch?: typeof fetch;
  readonly toolsDir?: string;
  readonly platform?: string;
  readonly now?: () => number;
  /** Unpacks an archive into a folder (tests: a fake); default `tar`, which reads .tar.gz and .zip alike. */
  readonly unpack?: (archive: string, into: string) => Promise<void>;
}

/** Reads, searches and installs from the ACP Registry (one per daemon). */
export class AcpRegistry {
  private index: { readonly at: number; readonly agents: readonly RegistryAgent[] } | undefined;

  constructor(
    private readonly agents: AcpAgents,
    private readonly deps: RegistryDeps & { readonly url?: string } = {},
  ) {}

  private get fetch(): typeof fetch {
    return this.deps.fetch ?? fetch;
  }

  /** The Registry's agents: one fetched in the last quarter of an hour is used again unless `fresh`. */
  async load(fresh = false): Promise<readonly RegistryAgent[]> {
    const now = (this.deps.now ?? Date.now)();
    if (!fresh && this.index && now - this.index.at < REGISTRY_MAX_AGE_MS) return this.index.agents;
    const res = await this.fetch(this.deps.url ?? ACP_REGISTRY_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`The ACP Registry didn’t answer (${res.status}).`);
    const text = await res.text();
    if (text.length > MAX_REGISTRY_BYTES) throw new Error('The ACP Registry sent more than Beluga reads.');
    const agents = parseRegistry(JSON.parse(text));
    this.index = { at: now, agents };
    return agents;
  }

  /** What's installed from the Registry, by its agent id: the version. */
  private installed(): Map<string, string> {
    return new Map(this.agents.list().flatMap((a) => (a.source === 'registry' && a.registryId ? [[a.registryId, a.version ?? '']] : [])));
  }

  async search(query: string, limit = 50): Promise<RegistryHit[]> {
    return searchRegistry(await this.load(), query, this.installed(), limit, this.deps.platform ?? registryPlatform());
  }

  /**
   * Install one agent at the Registry's version, and add it to your agents. A binary: downloaded
   * (HTTPS only, up to 600 MB, SHA-256 checked when given) and unpacked into its own folder, its
   * command kept inside it. A package: run through npx or uvx at that exact version (they fetch it
   * on first start).
   */
  async install(agentId: string): Promise<{ readonly ok: true; readonly runtime: string; readonly version: string } | { readonly ok: false; readonly error: string }> {
    const agent = (await this.load(true)).find((a) => a.id === agentId);
    if (!agent) return { ok: false, error: 'That agent isn’t in the ACP Registry any more.' };
    if (OWN_RUNTIME_AGENTS[agent.id] === 'antigravity') return { ok: false, error: 'Beluga runs Antigravity with its own runtime: add it from Beluga’s own list, in Settings › Agent › ACP agents.' };
    if (OWN_RUNTIME_AGENTS[agent.id]) return { ok: false, error: `Beluga runs ${agent.name} with its own runtime: pick it in Settings › Agent.` };
    const platform = this.deps.platform ?? registryPlatform();
    const kind = installKind(agent, platform);
    if (!kind) return { ok: false, error: `${agent.name} doesn’t run on this computer.` };
    const runtime = registryRuntimeId(agent.id);
    const base = { id: runtime, label: agent.name, source: 'registry' as const, registryId: agent.id, version: agent.version, ...(agent.website ? { website: agent.website } : {}), ...(agent.description ? { description: agent.description.slice(0, 1000) } : {}) };
    try {
      let spec: Omit<AcpAgentEntry, 'source'> & { readonly source: 'registry' };
      if (kind === 'binary') {
        const bin = agent.distribution.binary![platform!]!;
        const command = await this.installBinary(agent, bin);
        spec = { ...base, command, args: bin.args ?? [], ...(bin.env ? { env: bin.env } : {}) };
      } else {
        const pkg = (kind === 'npx' ? agent.distribution.npx : agent.distribution.uvx)!;
        spec = kind === 'npx' ? { ...base, command: 'npx', args: ['-y', pkg.package, ...(pkg.args ?? [])], ...(pkg.env ? { env: pkg.env } : {}) } : { ...base, command: 'uvx', args: [pkg.package, ...(pkg.args ?? [])], ...(pkg.env ? { env: pkg.env } : {}) };
      }
      const added = this.agents.addWhole(spec);
      if (!added.ok) return added;
      forgetAcpStatus();
      return { ok: true, runtime, version: agent.version };
    } catch (err) {
      return { ok: false, error: `${agent.name} couldn’t be installed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Remove an installed agent: its entry, and the files Beluga downloaded for it. */
  async uninstall(runtime: string): Promise<boolean> {
    const spec = this.agents.list().find((a) => a.id === runtime);
    if (!spec || !this.agents.remove(runtime)) return false;
    if (spec.source === 'registry' && spec.registryId) await fs.rm(path.join(this.deps.toolsDir ?? acpToolsDir(), spec.registryId), { recursive: true, force: true }).catch(() => undefined);
    forgetAcpStatus();
    return true;
  }

  private async installBinary(agent: RegistryAgent, bin: z.infer<typeof Binary>): Promise<string> {
    const url = new URL(bin.archive);
    if (url.protocol !== 'https:') throw new Error('its download isn’t over HTTPS');
    const root = path.join(this.deps.toolsDir ?? acpToolsDir(), agent.id);
    const dir = path.join(root, agent.version);
    const command = path.resolve(dir, bin.cmd);
    if (!command.startsWith(dir + path.sep)) throw new Error('its command points outside its own folder');
    if (existsSync(command)) return command;
    const staging = `${dir}.partial-${process.pid}`;
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const file = path.join(staging, '.download');
      const digest = await this.download(url, file);
      if (bin.sha256 && digest !== bin.sha256.toLowerCase()) throw new Error('its download doesn’t match the Registry’s checksum');
      if (/\.(tar\.gz|tgz|tar\.xz|tar\.bz2|tar|zip)$/i.test(url.pathname)) {
        // GNU tar (Linux) reads no .zip; macOS's and Windows' tar (bsdtar) read both.
        const zip = /\.zip$/i.test(url.pathname) && process.platform === 'linux';
        await (this.deps.unpack ?? ((a, into) => (zip ? run('unzip', ['-q', a, '-d', into]) : run('tar', ['-xf', a, '-C', into]))))(file, staging);
        await fs.rm(file, { force: true });
      } else {
        // A bare executable (Muse's): it is the command.
        const at = path.resolve(staging, bin.cmd);
        if (!at.startsWith(staging + path.sep)) throw new Error('its command points outside its own folder');
        await fs.mkdir(path.dirname(at), { recursive: true });
        await fs.rename(file, at);
      }
      const staged = path.resolve(staging, bin.cmd);
      if (!existsSync(staged)) throw new Error(`its download has no ${bin.cmd}`);
      const real = await fs.realpath(staged);
      if (!real.startsWith((await fs.realpath(staging)) + path.sep)) throw new Error('its command points outside its own folder');
      if (process.platform !== 'win32') await fs.chmod(staged, 0o755);
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rename(staging, dir);
      // Older versions go: only the one in use stays.
      for (const old of await fs.readdir(root).catch(() => [] as string[])) if (old !== agent.version) await fs.rm(path.join(root, old), { recursive: true, force: true }).catch(() => undefined);
      return command;
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Download to `file` (up to 600 MB), its SHA-256 as hex. */
  private async download(url: URL, file: string): Promise<string> {
    const res = await this.fetch(url, { signal: AbortSignal.timeout(20 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`its download didn’t answer (${res.status})`);
    if (res.url && new URL(res.url).protocol !== 'https:') throw new Error('its download was sent somewhere not over HTTPS');
    const hash = createHash('sha256');
    const out = createWriteStream(file, { mode: 0o600 });
    let size = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > MAX_ARCHIVE_BYTES) throw new Error('its download is larger than 600 MB');
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
    return hash.digest('hex');
  }
}
