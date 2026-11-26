// An ACP agent for tests/acp-runtime.test.ts, run with node: an older version that doesn't know
// `--new-flag` (it says so as Go's flag package does, and exits), else it answers initialize with
// the flags it was started with as its name.
import readline from 'node:readline';

const flags = process.argv.slice(2);
if (flags.includes('--new-flag') && process.env.ACP_OLD === '1') {
  process.stderr.write('Usage: old-agent acp [flags]\nError: flags provided but not defined: -new-flag\n');
  process.exit(1);
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: flags.join(' ') } } })}\n`);
});
