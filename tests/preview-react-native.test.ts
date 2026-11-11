import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeBundler } from '../src/preview/bundle.js';

/**
 * A React Native component previews as its web build would draw it (preview/react-native.ts):
 * react-native is react-native-web, a package's .web.js wins, React Native's internals and Node's
 * built-ins stand in, and a file a build step hasn't made yet doesn't stop the preview.
 */

const REACT = path.resolve('packages/mac/node_modules');
const haveReact = existsSync(path.join(REACT, 'react', 'package.json'));

let root: string;

const write = (rel: string, text: string): void => {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'beluga-preview-rn-'));
  if (haveReact) symlinkSync(REACT, path.join(root, 'node_modules'));
  // The app's own packages: a stand-in react-native-web and a library with platform files.
  write('app/node_modules/react-native-web/package.json', '{"name":"react-native-web","main":"index.js"}');
  write('app/node_modules/react-native-web/index.js', "export const Text = (p) => p.children;\nexport const View = (p) => p.children;\n");
  write('app/node_modules/lib-platform/package.json', '{"name":"lib-platform","main":"index"}');
  write('app/node_modules/lib-platform/index.ios.js', "module.exports = 'ios-variant';\n");
  write('app/node_modules/lib-platform/index.web.js', "module.exports = 'web-variant';\n");
  write('app/node_modules/lib-flow/package.json', '{"name":"lib-flow","main":"index.js"}');
  write('app/node_modules/lib-flow/index.js', "import 'react-native/Libraries/Pressability/PressabilityDebug';\nimport { getAssetByID } from '@react-native/assets-registry/registry';\nexport default typeof getAssetByID;\n");
  write('app/node_modules/react-native-web/dist/modules/AssetRegistry/index.js', 'export function getAssetByID(id) { return id; }\n');
  write(
    'app/components/Hello.tsx',
    [
      "import { Text, TurboModuleRegistry } from 'react-native';",
      "import { EventEmitter } from 'events';",
      "import platform from 'lib-platform';",
      "import flow from 'lib-flow';",
      "import made from '../dist/made.mjs';",
      "const native = TurboModuleRegistry.get('Haptics');",
      'class Bus extends EventEmitter {}',
      'export default function Hello() { return <Text>{platform} {flow} {String(native)} {String(made)} {String(new Bus().emit("x"))}</Text>; }',
    ].join('\n'),
  );
  write('web/Plain.tsx', "import { EventEmitter } from 'node:events';\nexport default function Plain() { return <b>{typeof EventEmitter}</b>; }\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!haveReact)('previews of React Native components', () => {
  it('builds against react-native-web, web variants first, native internals stood in', async () => {
    const bundler = await makeBundler(root, path.join(root, 'app/components/Hello.tsx'), 'app/components/Hello.tsx', { framework: 'react', pick: 'default' });
    const out = await bundler.build();
    await bundler.dispose();
    expect(out.ok ? '' : out.problem.forClaude).toBe('');
    if (!out.ok) return;
    expect(out.bundle.js).toContain('web-variant');
    expect(out.bundle.js).not.toContain('ios-variant');
    expect(out.bundle.js).toContain('TurboModuleRegistry');
    expect(out.bundle.js).toContain('removeAllListeners');
  });

  it('gives any component a stand-in for a Node built-in it imports', async () => {
    const bundler = await makeBundler(root, path.join(root, 'web/Plain.tsx'), 'web/Plain.tsx', { framework: 'react', pick: 'default' });
    const out = await bundler.build();
    await bundler.dispose();
    expect(out.ok).toBe(true);
  });
});
