import { expect, test, type Page } from './fixtures.js';
import { openGroupChat, pick } from './helpers.js';

/**
 * Speaking instead of typing (BLG-145, BLG-146): the microphone beside Send in the chat's box and
 * a friends' chat, and Settings › Voice (the suggested model, the language, the talk shortcut
 * recorded by pressing it). Writing it down needs a model on the Mac, so it's tested in the daemon.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const shots = process.env.BELUGA_SHOTS;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('the chat box has a microphone beside Send', async ({ page }) => {
  await openGroupChat(page);
  const mic = page.getByRole('button', { name: 'Speak instead of typing' }).first();
  await expect(mic).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' }).first()).toBeVisible();
  await mic.hover();
  await expect(page.getByText(/hold ⌥Space to talk/)).toBeVisible();
  if (shots) await page.locator('textarea:not(.xterm-helper-textarea)').first().locator('xpath=ancestor::div[3]').screenshot({ path: `${shots}/03-mac-composer-mic.png` });
});

test('Settings › Voice suggests a model and records the talk shortcut', async ({ page }) => {
  await page.keyboard.press('Meta+Comma');
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Voice' })).toBeVisible();
  await expect(page.getByText(/Suggested for your language: Whisper Turbo/)).toBeVisible();
  if (shots) await page.getByRole('dialog').screenshot({ path: `${shots}/04-mac-voice-settings.png` });

  // English: Parakeet is suggested (as exact there, and faster).
  await pick(page, 'Language', 'English');
  await expect(page.getByText(/Suggested for English: Parakeet/)).toBeVisible();

  // A letter alone would type: refused. ⌃⌥V is taken.
  await page.getByRole('button', { name: '⌥Space' }).click();
  await expect(page.getByRole('button', { name: 'Press Keys…' })).toBeVisible();
  await page.keyboard.press('v');
  await expect(page.getByText(/would type: add ⌘, ⌃ or ⌥/)).toBeVisible();
  await page.keyboard.press('Control+Alt+KeyV');
  await expect(page.getByRole('button', { name: '⌃⌥V' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByText('None: use the microphone beside Send.')).toBeVisible();
});

test('Settings › Voice picks the microphone dictation listens to (BLG-766)', async ({ page }) => {
  // Two microphones, named only once Beluga may use one (as WebKit does).
  await page.addInitScript(() => {
    let allowed = false;
    const mic = (deviceId: string, label: string) => ({ kind: 'audioinput', deviceId, label: allowed ? label : '', groupId: '' });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        enumerateDevices: async () => [mic('default', 'Default - MacBook Pro Microphone'), mic('built-in', 'MacBook Pro Microphone'), mic('usb', 'Yeti USB Microphone')],
        getUserMedia: async () => ((allowed = true), { getTracks: () => [{ stop: () => undefined }] }),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
  });
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Meta+Comma');
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await expect(page.getByText(/Show them by name to pick one/)).toBeVisible();
  await page.getByRole('button', { name: 'Show Microphones' }).click();

  await expect(page.getByRole('combobox', { name: 'Microphone' })).toHaveText(/Same as macOS/);
  await pick(page, 'Microphone', 'Yeti USB Microphone');
  await expect(page.getByText('Dictation listens to this one. Calls pick their own, beside Mute.')).toBeVisible();
  if (shots) await page.getByRole('dialog').screenshot({ path: `${shots}/05-mac-voice-microphone.png` });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('beluga.prefs.v1') ?? '{}').voiceMic)).toBe('usb');
});
