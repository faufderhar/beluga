#!/usr/bin/env node
// A stand-in for the GitHub CLI in the end-to-end tests (the demo daemon runs it as BELUGA_GH).
// Its pull requests live in BELUGA_FAKE_GH (JSON); a test writes them there and reads back what
// was merged. With no file there are no pull requests, so other tests see none.
//
//   { "prs": { "<branch or its last part>": { number, url, state, title, isDraft, statusCheckRollup,
//              reviewDecision, mergeable, autoMergeRequest } },
//     "mergeError": "what gh says when GitHub refuses (optional)",
//     "merges": [["pr", "merge", "7", "--squash"], …],
//     "reruns": [["run", "rerun", "5", "--failed"], …],
//     "repos": [{ full_name, clone_url, ssh_url, private, pushed_at, description }, …] }
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const file = process.env.BELUGA_FAKE_GH ?? process.env.KLAUD_FAKE_GH;
const args = process.argv.slice(2);
const load = () => (file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { prs: {} });
const fail = (text) => {
  process.stderr.write(`${text}\n`);
  process.exit(1);
};

const state = load();
const entries = () => Object.entries(state.prs ?? {});
const find = (ref) => entries().find(([branch, pr]) => branch === ref || ref.endsWith(`/${branch}`) || String(pr.number) === ref);
const withBranch = (ref, branch) => (ref.includes('/') ? ref : branch);

if (args[0] === 'auth' && args[1] === 'status') process.exit(0);

// Your repositories for the Clone tab (src/workspaces/github-repos.ts): `repos`, GitHub's REST rows.
if (args[0] === 'api' && args[1]?.startsWith('user/repos')) {
  process.stdout.write(JSON.stringify(state.repos ?? []));
  process.exit(0);
}
if (args[0] === 'config' && args[1] === 'get' && args[2] === 'git_protocol') {
  process.stdout.write(`${state.gitProtocol ?? 'https'}\n`);
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'view') {
  const hit = find(args[2] ?? '');
  if (!hit) fail(`no pull requests found for branch "${args[2]}"`);
  process.stdout.write(JSON.stringify(hit[1]));
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(entries().map(([branch, pr]) => ({ ...pr, headRefName: withBranch(pr.headRefName ?? `beluga/${branch}`, branch) }))));
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'merge') {
  const hit = find(args[2] ?? '');
  if (!hit) fail(`no pull requests found for "${args[2]}"`);
  state.merges = [...(state.merges ?? []), args];
  if (state.mergeError) {
    writeFileSync(file, JSON.stringify(state, null, 2));
    fail(state.mergeError);
  }
  const [branch, pr] = hit;
  const method = (args.find((a) => ['--squash', '--merge', '--rebase'].includes(a)) ?? '--merge').slice(2).toUpperCase();
  state.prs[branch] = args.includes('--auto') ? { ...pr, autoMergeRequest: { mergeMethod: method } } : { ...pr, state: 'MERGED', autoMergeRequest: null };
  writeFileSync(file, JSON.stringify(state, null, 2));
  process.exit(0);
}

// Re-run Failed Checks (BLG-753): kept, so a test can read back which runs it asked for.
if (args[0] === 'run' && args[1] === 'rerun') {
  state.reruns = [...(state.reruns ?? []), args];
  writeFileSync(file, JSON.stringify(state, null, 2));
  process.exit(0);
}

// A PR's conversation (src/workspaces/pr-review.ts): `conversations` holds each PR's pullRequest
// node by number; replies, resolves and comments change it and are kept in `posts`.
const field = (name) => args.find((a, i) => args[i - 1]?.match(/^-[fF]$/) && a.startsWith(`${name}=`))?.slice(name.length + 1);
if (args[0] === 'api' && args[1] === 'graphql') {
  const query = field('query') ?? '';
  const conv = state.conversations ?? {};
  if (query.includes('reviewThreads')) {
    const pr = conv[field('number') ?? ''];
    process.stdout.write(JSON.stringify({ data: { viewer: { login: 'you' }, repository: { pullRequest: pr ?? null } } }));
    process.exit(0);
  }
  const thread = field('thread');
  const pr = Object.values(conv).find((p) => p.reviewThreads.nodes.some((t) => t.id === thread));
  const t = pr?.reviewThreads.nodes.find((x) => x.id === thread);
  if (!t) fail('GraphQL: Could not resolve to a node');
  state.posts = [...(state.posts ?? []), args.filter((a) => !a.startsWith('query='))];
  if (query.includes('addPullRequestReviewThreadReply')) t.comments.nodes.push({ id: `R${Date.now()}`, author: { login: 'you' }, body: field('body'), createdAt: new Date().toISOString(), url: `${pr.url}#reply` });
  else t.isResolved = !query.includes('unresolveReviewThread');
  writeFileSync(file, JSON.stringify(state, null, 2));
  process.stdout.write('{"data":{}}');
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'comment') {
  const pr = (state.conversations ?? {})[args[2]];
  if (!pr) fail(`no pull request ${args[2]}`);
  const body = args[args.indexOf('--body') + 1];
  pr.comments.nodes.push({ id: `C${Date.now()}`, author: { login: 'you' }, body, createdAt: new Date().toISOString(), url: `${pr.url}#comment` });
  state.posts = [...(state.posts ?? []), args];
  writeFileSync(file, JSON.stringify(state, null, 2));
  process.exit(0);
}

fail(`fake gh: ${args.join(' ')} isn't something it knows`);
