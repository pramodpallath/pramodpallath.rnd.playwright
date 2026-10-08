import type { Page } from 'playwright';
import { interpolate, type Condition } from '../schema.js';
import { locate, unique } from './locators.js';
import { ensureFillAllowed, ensureNonSecret } from './sensitive-controls.js';

export async function waitCondition(page: Page, condition: Condition, inputs: Record<string, string>, timeoutMs: number) {
  if (condition.kind === 'origin') {
    const origin = new URL(interpolate(condition.value, inputs)).origin;
    await page.waitForURL(url => url.origin === origin, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    return;
  }
  if (condition.kind === 'url') {
    await page.waitForURL(interpolate(condition.value, inputs), { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    return;
  }
  const target = locate(page, condition.locator);
  if (condition.kind === 'visible' || condition.kind === 'hidden') {
    await target.waitFor({ state: condition.kind, timeout: timeoutMs });
    return;
  }
  await target.waitFor({ state: 'visible', timeout: timeoutMs });
  await unique(target);
  if (condition.kind === 'value') await ensureFillAllowed(target, condition.value);
  else await ensureNonSecret(target);
  const expected = interpolate(condition.value, inputs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const actual = condition.kind === 'value' ? await target.inputValue() : (await target.innerText()).trim();
    if (actual === expected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Expected ${condition.kind} condition was not reached`);
}

// A non-blocking snapshot: every completion condition must hold on the application
// page together. Login popups may open/close without becoming the action's target.
export async function conditionsMet(page: Page, conditions: Condition[], inputs: Record<string, string>): Promise<boolean> {
  if (page.isClosed()) return false;
  try {
    const url = page.url();
    if (await page.evaluate(() => document.readyState === 'loading')) return false;
    for (const condition of conditions) {
      if (condition.kind === 'origin' || condition.kind === 'url') {
        const expected = interpolate(condition.value, inputs);
        if (condition.kind === 'origin' ? new URL(url).origin !== new URL(expected).origin : url !== expected) return false;
        continue;
      }
      const target = locate(page, condition.locator);
      const count = await target.count();
      if (condition.kind === 'hidden') {
        if (count > 1 || (count === 1 && await target.isVisible())) return false;
        continue;
      }
      if (count !== 1 || !await target.isVisible()) return false;
      if (condition.kind === 'visible') continue;
      if (condition.kind === 'value') await ensureFillAllowed(target, condition.value);
      else await ensureNonSecret(target);
      const actual = condition.kind === 'value' ? await target.inputValue({ timeout: 250 }) : (await target.innerText({ timeout: 250 })).trim();
      if (actual !== interpolate(condition.value, inputs)) return false;
    }
    return !page.isClosed() && page.url() === url;
  } catch { return false; } // Redirects can destroy the execution context mid-check.
}

