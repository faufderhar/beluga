import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures.js';

/**
 * Settings › External agents: turn the server on, make a pairing code, sign an agent in through the
 * real OAuth pages with only what this screen gave, see it listed, and revoke it.
 * Screenshots go to $BELUGA_SHOTS_DIR when it's set.
 */

const shots = process.env.BELUGA_SHOTS_DIR;

test.use({ video: 'on' });

test('an agent connects with only this screen, and Revoke ends it', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: 'External agents' }).click();
  await expect(settings.getByText('Off: nothing listens.')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/01-external-off.png` });

  await settings.getByRole('switch', { name: 'Let other agents connect' }).click();
  const url = await settings.getByText(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/).innerText();
  const origin = new URL(url).origin;
  if (shots) await page.screenshot({ path: `${shots}/015-external-form-defaults.png` });
  await settings.getByRole('switch', { name: /^Reach / }).first().click();
  await settings.getByRole('button', { name: 'Make a Code' }).click();
  const code = await settings.locator('[data-pairing-code]').innerText();
  expect(code).toMatch(/^[A-Z2-7-]{20,}$/);
  if (shots) await page.screenshot({ path: `${shots}/02-external-code.png` });

  // The agent's side: no token, a challenge, and the sign-in page in a browser tab.
  const challenged = await request.post(url, { data: {} });
  expect(challenged.status()).toBe(401);
  // Its callback, as a real client runs one.
  const called: string[] = [];
  const callback = http.createServer((req, res) => {
    called.push(req.url ?? '');
    res.end('Signed in');
  });
  await new Promise<void>((resolve) => callback.listen(0, '127.0.0.1', resolve));
  const REDIRECT = `http://127.0.0.1:${(callback.address() as AddressInfo).port}/callback`;
  const registered = await request.post(`${origin}/register`, { data: { client_name: 'Demo Agent', redirect_uris: [REDIRECT] } });
  const { client_id } = (await registered.json()) as { client_id: string };
  const challenge = 'x'.repeat(43);
  const signIn = await page.context().newPage();
  await signIn.goto(`${origin}/authorize?${new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, state: 's', code_challenge: challenge, code_challenge_method: 'S256', resource: url }).toString()}`);
  await expect(signIn.getByRole('heading', { name: 'Connect Demo Agent to Beluga?' })).toBeVisible();
  await signIn.getByLabel('Pairing code').fill(code);
  if (shots) await signIn.screenshot({ path: `${shots}/03-external-sign-in.png` });
  await signIn.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(signIn.getByText('Signed in')).toBeVisible();
  expect(new URL(called[0]!, REDIRECT).searchParams.get('code')).toBeTruthy();
  await signIn.close();
  callback.close();

  // It shows here with what the code gave, then Revoke takes it away.
  await expect(settings.getByText('Demo Agent')).toBeVisible({ timeout: 10_000 });
  await expect(settings.getByText(/Full trust · On this Mac · Last seen/)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/04-external-agent.png` });
  await settings.getByRole('button', { name: 'Revoke' }).click();
  await expect(settings.getByText('Demo Agent')).toBeHidden();

  // Off closes the port.
  await settings.getByRole('switch', { name: 'Let other agents connect' }).click();
  await expect(settings.getByText('Off: nothing listens.')).toBeVisible();
  await expect(request.post(url, { data: {} })).rejects.toThrow();
});
