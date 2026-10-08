import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { acquireProfileLock } from './profile-lock.js';
import path from 'node:path';
import type { LocatorSpec, Condition } from './schema.js';
import { interpolate } from './schema.js';

export function locate(page: Page, spec: LocatorSpec): Locator {
  const root = spec.frame ? page.frameLocator(spec.frame) : page;
  const apply = (base: typeof root | Locator, target: LocatorSpec['target']): Locator => {
    switch (target.by) {
      case 'role': return base.getByRole(target.role, { name: target.name, exact: target.exact });
      case 'label': return base.getByLabel(target.value, { exact: target.exact });
      case 'text': return base.getByText(target.value, { exact: target.exact });
      case 'placeholder': return base.getByPlaceholder(target.value, { exact: target.exact });
      case 'testId': return base.getByTestId(target.value);
      case 'css': return base.locator(target.value);
    }
  };
  return apply(spec.scope ? apply(root, spec.scope) : root, spec.target);
}

export async function unique(locator: Locator) {
  const count = await locator.count();
  if (count !== 1) throw new Error(`Target must match exactly one element; found ${count}`);
}

// Shared by action preflight and screenshot masking, including framed controls.
function sensitiveControl(el: Element) {
    const input = el as HTMLInputElement;
    const labels = Array.from(input.labels ?? []).map(label => label.textContent).join(' ');
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ');
    const hint = [input.type, input.name, input.id, input.autocomplete, el.getAttribute('aria-label'), el.getAttribute('placeholder'), labels, labelledBy].join(' ');
    return /password|passwd|otp|one.?time|\bpin\b|secret|token|credit.?card|cc-/i.test(hint);
}

export async function ensureNonSecret(locator: Locator) {
  const secret = await locator.evaluate(sensitiveControl);
  if (secret) throw new Error('Sensitive controls require manual browser entry');
}

// Passwords may only come from the named run input, never a literal saved value.
export async function ensureFillAllowed(locator: Locator, value: string) {
  const password = await locator.evaluate(el => el instanceof HTMLInputElement && el.type === 'password');
  if (password && value === '{Password}') return;
  await ensureNonSecret(locator);
}

export async function screenshotMasks(page: Page): Promise<Locator[]> {
  const masks: Locator[] = [];
  for (const frame of page.frames()) {
    const controls = frame.locator('input, textarea, select, [contenteditable], [autocomplete], [id*="otp" i], [id*="token" i], [id*="secret" i]');
    for (let i = 0, count = await controls.count(); i < count; i++) {
      const control = controls.nth(i);
      if (await control.evaluate(sensitiveControl)) masks.push(control);
    }
  }
  return masks;
}

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

const profileCleanup = new Map<string, Promise<void>>();

export async function openProfile(dataDir: string, profile: string, headless = false) {
  const directory = path.resolve(dataDir, 'profiles', profile);
  await profileCleanup.get(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireProfileLock(directory, profile);
  const release = () => {
    const cleanup = releaseLock();
    profileCleanup.set(directory, cleanup);
    void cleanup.finally(() => {
      if (profileCleanup.get(directory) === cleanup) profileCleanup.delete(directory);
    }).catch(() => {});
    return cleanup;
  };
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(directory, { headless, viewport: { width: 1280, height: 850 } });
  } catch (error) { await release(); throw error; }
  context.once('close', () => { void release().catch(() => {}); });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    let closing: Promise<void> | undefined;
    return {
      context, page,
      close: () => closing ??= (async () => { try { await context.close(); } finally { await release(); } })(),
    };
  } catch (error) { await context.close(); await release(); throw error; }
}

// Select at step boundaries so a click's own outcome checks stay on its page.
// Only pages opened during this run can become the next step's target.
export class StepPages {
  private seen: Set<Page>;
  private current: Page;
  private initialUrl: string;
  constructor(private context: BrowserContext, private initial: Page) {
    this.current = initial;
    this.initialUrl = initial.url();
    this.seen = new Set(context.pages());
  }

  // Authentication popups belong to the manual action; subsequent steps stay on
  // the application whose completion conditions were verified.
  retainApplication(page: Page) {
    this.current = page;
    for (const opened of this.context.pages()) this.seen.add(opened);
  }

  async select(instruction: string, timeoutMs: number): Promise<Page> {
    const requestsNewPage = /\b(?:in|on|within|to)\s+(?:(?:the|a|this|that)\s+)?(?:new\s+(?:browser\s+)?(?:page|tab|window)\b|newly\s+opened\s+(?:page|tab|window)\b|pop[ -]?up\b)/i.test(instruction);
    let candidates = this.context.pages().filter(page => !page.isClosed() && !this.seen.has(page));
    // A same-tab navigation also satisfies "the new page". Once selected,
    // a popup stays active for subsequent steps that refer to that page.
    if (!candidates.length && requestsNewPage && this.current === this.initial && this.current.url() === this.initialUrl) {
      try {
        await this.context.waitForEvent('page', { timeout: timeoutMs });
      } catch {
        throw new Error('No new page opened before the step timeout');
      }
      candidates = this.context.pages().filter(page => !page.isClosed() && !this.seen.has(page));
    }
    if (candidates.length > 1) throw new Error('Multiple new pages opened; the next step target is ambiguous');
    if (candidates.length === 1) this.current = candidates[0];
    if (this.current.isClosed()) throw new Error('The active page was closed; stop and restart the flow');
    await this.current.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
    for (const page of candidates) this.seen.add(page);
    return this.current;
  }
}

export type Candidate = { id: string; label: string; tag: string; locator: LocatorSpec; options?: { label: string; value: string }[] };
export type Observation = { url: string; title: string; headings: string[]; candidates: Candidate[] };

export async function observe(page: Page): Promise<Observation> {
  const candidates: Candidate[] = [];
  const headings: string[] = [];
  for (const frame of page.frames()) {
    let frameSelector: string | undefined;
    if (frame !== page.mainFrame()) {
      if (frame.parentFrame() !== page.mainFrame()) continue; // Nested frames require an authored frame locator in v1.
      const element = await frame.frameElement();
      frameSelector = await element.evaluate(node => { const el = node as Element; return el.id ? `iframe#${CSS.escape(el.id)}` : el.getAttribute('name') ? `iframe[name=${JSON.stringify(el.getAttribute('name'))}]` : ''; });
      await element.dispose();
      if (!frameSelector || await page.locator(frameSelector).count() !== 1) continue;
    }
    const controls = await frame.evaluate(() => {
      const elements = [...document.querySelectorAll('button,a[href],input,textarea,select,[role],h1,h2,h3')].filter(el => {
        const style = getComputedStyle(el);
        return el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }).slice(0, 300);
      return elements.map(el => {
        const input = el as HTMLInputElement;
        const hint = [input.type, input.name, input.id, input.autocomplete, el.getAttribute('aria-label')].join(' ');
        const secret = /password|passwd|otp|one.?time|\bpin\b|secret|token|cc-number|cc-csc/i.test(hint);
        const labels = Array.from((el as HTMLInputElement).labels ?? []).map(l => l.textContent?.trim()).join(' ');
        const labelledBy = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim();
        const name = (el.getAttribute('aria-label') || labelledBy || labels || el.textContent?.trim() || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').slice(0, 160);
        const tag = el.tagName.toLowerCase();
        const nativeRole = tag === 'button' ? 'button' : tag === 'a' ? 'link' : tag === 'select' ? 'combobox' : /^h[123]$/.test(tag) ? 'heading' : tag === 'textarea' ? 'textbox' : tag === 'input' ? ({ checkbox: 'checkbox', radio: 'radio', number: 'spinbutton', button: 'button', submit: 'button' }[input.type] ?? 'textbox') : '';
        return { tag, secret, password: tag === 'input' && input.type === 'password', name, label: labels, role: el.getAttribute('role') || nativeRole, id: el.id, testId: el.getAttribute('data-testid'), placeholder: el.getAttribute('placeholder'), options: tag === 'select' ? Array.from((el as HTMLSelectElement).options).map(o => ({ label: o.label, value: o.value })).slice(0, 100) : undefined };
      });
    });
    for (const control of controls) {
      if (control.secret && !control.password) continue;
      if (control.role === 'heading') { headings.push(control.name); continue; }
      const choices: LocatorSpec['target'][] = [];
      if (control.testId) choices.push({ by: 'testId', value: control.testId });
      if (control.label) choices.push({ by: 'label', value: control.label, exact: true });
      if (control.role && control.name) choices.push({ by: 'role', role: control.role as 'button', name: control.name, exact: true });
      if (control.placeholder) choices.push({ by: 'placeholder', value: control.placeholder, exact: true });
      if (control.id) choices.push({ by: 'css', value: `[id=${JSON.stringify(control.id)}]` });
      for (const target of choices) {
        const spec = { target, ...(frameSelector ? { frame: frameSelector } : {}) };
        try {
          if (await locate(page, spec).count() !== 1) continue;
          candidates.push({ id: `e${candidates.length + 1}`, tag: control.tag, label: control.name, locator: spec, ...(control.options ? { options: control.options } : {}) });
          break;
        } catch { /* A role may be unsupported; try another locator. */ }
      }
    }
  }
  const url = new URL(page.url()); url.search = ''; url.hash = ''; url.username = ''; url.password = '';
  return { url: url.toString(), title: await page.title(), headings: headings.slice(0, 30), candidates };
}
