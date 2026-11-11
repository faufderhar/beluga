import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIRequestContext, type Page } from './fixtures.js';

/**
 * At level ask, a live tool call from a signed-in agent shows its card while you have a worktree
 * open: a call with no chat (a room card), and a call about that chat. Screenshots go to $SHOTS.
 */

test.use({ video: 'on' });

const VERIFIER = 'v'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const card = (page: Page) => page.getByRole('alertdialog', { name: 'Approval needed' });
const shot = async (page: Page, name: string): Promise<void> => {
  if (!process.env.SHOTS) return;
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

/** The whole sign-in, as in external-agents.spec.ts → a token for the first project at level ask. */
async function signIn(page: Page, request: APIRequestContext): Promise<{ url: string; token: string }> {
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: 'External agents' }).click();
  await settings.getByRole('switch', { name: 'Let other agents connect' }).click();
  const url = await settings.getByText(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/).innerText();
  const origin = new URL(url).origin;
  await settings.getByRole('combobox', { name: 'What it may do' }).click();
  await page.getByRole('option', { name: /Ask/ }).click();
  await settings.getByRole('switch', { name: 'Reach all projects and chats' }).click();
  await settings.getByRole('switch', { name: 'Reach bob-api' }).click();
  await settings.getByRole('button', { name: 'Make a Code' }).click();
  const code = await settings.locator('[data-pairing-code]').innerText();
  const callback = http.createServer((_req, res) => res.end('Signed in'));
  const got: string[] = [];
  callback.on('request', (req) => got.push(req.url ?? ''));
  await new Promise<void>((resolve) => callback.listen(0, '127.0.0.1', resolve));
  const redirect = `http://127.0.0.1:${(callback.address() as AddressInfo).port}/callback`;
  const registered = await request.post(`${origin}/register`, { data: { client_name: 'GrokBot', redirect_uris: [redirect] } });
  const { client_id } = (await registered.json()) as { client_id: string };
  const tab = await page.context().newPage();
  await tab.goto(`${origin}/authorize?${new URLSearchParams({ response_type: 'code', client_id, redirect_uri: redirect, state: 's', code_challenge: CHALLENGE, code_challenge_method: 'S256', resource: url })}`);
  await tab.getByLabel('Pairing code').fill(code);
  await tab.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(tab.getByText('Signed in')).toBeVisible();
  await tab.close();
  callback.close();
  const authCode = new URL(got[0]!, redirect).searchParams.get('code')!;
  const res = await request.post(`${origin}/token`, { form: { grant_type: 'authorization_code', code: authCode, client_id, redirect_uri: redirect, code_verifier: VERIFIER, resource: url } });
  const { access_token } = (await res.json()) as { access_token: string };
  await page.keyboard.press('Escape');
  return { url, token: access_token };
}

test('a tool call at level ask shows its card with a worktree open', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const { url, token } = await signIn(page, request);
  const call = (name: string, args: Record<string, unknown>) =>
    request.post(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }).then((r) => r.text());

  await sidebar(page).getByRole('button', { name: "Show what's in bob-api" }).first().click();
  await sidebar(page).getByRole('button', { name: /add-auth/ }).first().click();

  // No chat in the call: a room card, shown here all the same.
  const listed = call('beluga_chat_list', {});
  await expect(card(page)).toContainText('GrokBot wants to use beluga_chat_list');
  await shot(page, '06-mac-card-room-channel');
  await card(page).getByRole('button', { name: 'Allow', exact: true }).click();
  const text = await listed;
  const id = /\\?"id\\?":\\?"([a-z0-9-]+)\\?",\\?"kind\\?":\\?"project\\?",\\?"title\\?":\{\\?"untrusted\\?":true,\\?"text\\?":\\?"add-auth/.exec(text)?.[1] ?? /([\w-]+)\\?",\\?"kind\\?":\\?"project\\?"/.exec(text)?.[1];
  expect(id).toBeTruthy();

  // About this chat: the card holds it up.
  const sent = call('beluga_chat_interrupt', { chat: id });
  await expect(card(page)).toContainText('GrokBot wants to use beluga_chat_interrupt');
  await shot(page, '07-mac-card-chat-channel');
  await card(page).getByRole('button', { name: /Decline|Deny/ }).click();
  expect(await sent).toContain('declined');
});
