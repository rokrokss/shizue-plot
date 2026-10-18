import type { Page } from '@playwright/test';

/**
 * Opens the app as its owner. There is no sign-in: a browser on this computer is
 * the owner (the API's `ownerGate`), so this only loads the front page. The
 * account a spec passes is from when each spec signed up an account of its own;
 * every spec of a run now shares the one owner of the run's app folder.
 */
export async function seedSession(page: Page, _account?: { email: string; password: string; name: string }): Promise<void> {
  await page.goto('/ko');
}
