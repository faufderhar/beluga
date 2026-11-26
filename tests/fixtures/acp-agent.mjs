// A tiny ACP agent for tests/acp-hardening.test.ts, run with node (never a shell script).
// ACP_FIXTURE says how it behaves:
//   child   answers initialize; asked fixture/child, starts a process of its own and answers its pid
//   signin  prints a sign-in link on stdout instead of answering
//   mute    reads everything and never answers
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const mode = process.env.ACP_FIXTURE;
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

if (mode === 'signin') process.stdout.write('Open the following link to sign in: https://accounts.example.test/o/oauth?x=1\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (mode !== 'child') return;
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (msg.method === 'fixture/child') {
    const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    send({ id: msg.id, result: { pid: kid.pid } });
  }
});
setInterval(() => {}, 1000);
