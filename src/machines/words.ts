import type { LinuxDistro, MachineKind } from '../shared/machine-kinds.js';

/**
 * How a computer of yours is said, the same on the Mac and the phone (BLG-786, BLG-810): its kind
 * in words, one line of what it has free, and why it can't take new work now. Pure and
 * browser-safe: the Mac's Runs on menu (packages/mac/src/machines/runs-on-model.ts) and the lines
 * your Mac sends its phones (src/machines/phones.ts) both read it.
 */

/** What these words read of a computer (machines.ts MachineView has it all): kept structural, so the phone imports this file alone. */
export interface ComputerFacts {
  readonly status: 'online' | 'offline' | 'unknown';
  readonly lastSeen?: number;
  readonly readOnly?: boolean;
  readonly kind?: MachineKind;
  readonly platform: string;
  readonly info?: {
    readonly memory: { readonly freeGB: number };
    readonly agentsRunning?: number;
    readonly runtimes: ReadonlyArray<{ readonly id: string; readonly state: string; readonly usage?: { readonly fiveHour?: Spent; readonly week?: Spent } }>;
  };
}
interface Spent {
  readonly pct: number;
  readonly resetsAt?: number;
}

export const KIND_WORDS: Record<MachineKind, string> = {
  aws: 'AWS',
  gcp: 'Google Cloud',
  azure: 'Azure',
  digitalocean: 'DigitalOcean',
  hetzner: 'Hetzner',
  oracle: 'Oracle Cloud',
  linode: 'Akamai (Linode)',
  vultr: 'Vultr',
  scaleway: 'Scaleway',
  ovh: 'OVHcloud',
  alibaba: 'Alibaba Cloud',
  upcloud: 'UpCloud',
  exoscale: 'Exoscale',
  codespaces: 'GitHub Codespaces',
  fly: 'Fly.io',
  railway: 'Railway',
  render: 'Render',
  kubernetes: 'Kubernetes',
  'mac-mini': 'Mac mini',
  macbook: 'MacBook',
  'mac-studio': 'Mac Studio',
  imac: 'iMac',
  mac: 'Mac',
  'raspberry-pi': 'Raspberry Pi',
  docker: 'Docker',
  podman: 'Podman',
  wsl: 'WSL',
  vmware: 'VMware',
  qemu: 'QEMU/KVM',
  virtualbox: 'VirtualBox',
  parallels: 'Parallels',
  hyperv: 'Hyper-V',
  'apple-vm': 'Apple Virtualization',
  linux: 'Linux',
  windows: 'Windows',
};

/** A Linux distribution by its name ("Ubuntu"), said in place of plain Linux. */
export const DISTRO_WORDS: Record<LinuxDistro, string> = {
  ubuntu: 'Ubuntu',
  debian: 'Debian',
  fedora: 'Fedora',
  arch: 'Arch Linux',
  alpine: 'Alpine',
  centos: 'CentOS',
  rhel: 'Red Hat',
  rocky: 'Rocky Linux',
  alma: 'AlmaLinux',
  opensuse: 'openSUSE',
  nixos: 'NixOS',
  mint: 'Linux Mint',
  manjaro: 'Manjaro',
  pop: 'Pop!_OS',
  gentoo: 'Gentoo',
  kali: 'Kali Linux',
};

const RUNTIME_WORDS: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', copilot: 'Copilot', grok: 'Grok Build', gemini: 'Gemini' };
export const runtimeWords = (id: string): string => RUNTIME_WORDS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

/** 14:02, as this device's clock says it. */
const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** "16:00" today, "Tue 16:00" later. */
export function when(at: number, now: number): string {
  const day = new Date(at).toDateString() === new Date(now).toDateString();
  return day ? clock(at) : `${new Date(at).toLocaleDateString([], { weekday: 'short' })} ${clock(at)}`;
}

/** Why a computer can't take work for `runtime` now; undefined when it can. */
export function whyNot(m: Pick<ComputerFacts, 'status' | 'lastSeen' | 'readOnly' | 'info'>, runtime: string, now = Date.now()): string | undefined {
  if (m.status === 'unknown') return 'Not reached yet';
  if (m.status !== 'online') return m.lastSeen ? `Offline since ${when(m.lastSeen, now)}` : 'Offline';
  if (m.readOnly) return 'On another version: update it in Settings';
  const words = runtimeWords(runtime);
  const r = m.info?.runtimes.find((x) => x.id === runtime);
  if (!r || r.state === 'missing') return `${words} isn’t set up there`;
  if (r.state === 'signed_out') return `${words} isn’t signed in there`;
  const spent = [r.usage?.fiveHour, r.usage?.week].find((u) => u && u.pct >= 100 && (u.resetsAt === undefined || u.resetsAt > now));
  if (spent) return spent.resetsAt ? `${words}’s limit resets at ${when(spent.resetsAt, now)}` : `${words}’s limit is reached there`;
  return undefined;
}

/** "AWS · 12 GB free · 1 task running". */
export function statusLine(m: Pick<ComputerFacts, 'kind' | 'platform' | 'info'>): string {
  const kind = m.kind ? KIND_WORDS[m.kind] : m.platform === 'macos' ? 'Mac' : m.platform === 'windows' ? 'Windows' : 'Linux';
  const i = m.info;
  if (!i) return kind;
  const running = i.agentsRunning ? [`${i.agentsRunning} ${i.agentsRunning === 1 ? 'task' : 'tasks'} running`] : [];
  return [kind, `${Math.round(i.memory.freeGB)} GB free`, ...running].join(' · ');
}
