import { describe, expect, it } from 'vitest';
import { IPC_VERSION } from '../src/ipc/protocol.js';

/** The maintainer's Mac release script (scripts/release-mac.mjs): what it writes, not what it runs. */

interface ReleaseScript {
  isNewer(next: string, prev: string | undefined): boolean;
  archOf(nodeArch: string): string;
  updateAsset(version: string, arch: string): string;
  dmgAsset(version: string, arch: string): string;
  assetUrl(tag: string, name: string): string;
  latestJson(o: { version: string; notes: string; pubDate: string; signature: string; url: string; arch: string }): unknown;
  pinsOneBuild(requirement: string): boolean;
}

const script = (): Promise<ReleaseScript> => import('../scripts/release-mac.mjs' as string) as Promise<ReleaseScript>;

describe('release-mac', () => {
  it('tells an ad-hoc signature, which macOS forgets permissions for on every update, from a certificate', async () => {
    const { pinsOneBuild } = await script();
    expect(pinsOneBuild('# designated => cdhash H"819ee528739f948f8ecc64669f1150731f09e605"\n')).toBe(true);
    expect(pinsOneBuild('designated => identifier "io.github.kayraucklnc.beluga" and certificate leaf = H"05e38bc1"\n')).toBe(false);
  });

  it('only releases a version newer than what GitHub offers', async () => {
    const { isNewer } = await script();
    expect(isNewer('0.4.1', '0.4.0')).toBe(true);
    expect(isNewer('0.5.0', 'v0.4.9-mac')).toBe(true);
    expect(isNewer('0.4.0', '0.4.0')).toBe(false);
    expect(isNewer('0.4.0', '0.10.0')).toBe(false);
    expect(isNewer('1.0.0', undefined)).toBe(true);
    expect(isNewer('nope', '0.1.0')).toBe(false);
  });

  it('writes the latest.json every installed copy reads, with Beluga-named files', async () => {
    const { archOf, assetUrl, dmgAsset, latestJson, updateAsset } = await script();
    const arch = archOf('arm64');
    const name = updateAsset('0.5.0', arch);
    expect(name).toBe('Beluga_0.5.0_aarch64.app.tar.gz');
    expect(dmgAsset('0.5.0', arch)).toBe('Beluga_0.5.0_aarch64.dmg');
    const url = assetUrl('v0.5.0-mac', name);
    expect(url).toBe('https://github.com/beluga-labs/beluga/releases/download/v0.5.0-mac/Beluga_0.5.0_aarch64.app.tar.gz');
    expect(latestJson({ version: '0.5.0', notes: '- Faster', pubDate: '2026-10-18T10:00:00.000Z', signature: 'c2ln\n', url, arch })).toEqual({
      version: '0.5.0',
      notes: '- Faster',
      pub_date: '2026-10-18T10:00:00.000Z',
      // The app protocol the release speaks (BLG-777): an installed app warns about computers it would leave behind.
      ipc: IPC_VERSION,
      platforms: { 'darwin-aarch64': { signature: 'c2ln', url } },
    });
  });
});
