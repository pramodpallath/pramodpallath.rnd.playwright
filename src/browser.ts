import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { mkdir, open, unlink } from 'node:fs/promises';
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

export async function ensureNonSecret(locator: Locator) {
  const secret = await locator.evaluate(el => {
    const input = el as HTMLInputElement;
    const hint = [input.type, input.name, input.id, input.autocomplete, el.getAttribute('aria-label')].join(' ');
    return /password|passwd|otp|one.?time|\bpin\b|secret|token|credit.?card|cc-number|cc-csc/i.test(hint);
  });
  if (secret) throw new Error('Sensitive controls require manual browser entry');
}

export async function waitCondition(page: Page, condition: Condition, inputs: Record<string, string>, timeoutMs: number) {
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
  await ensureNonSecret(target);
  const expected = interpolate(condition.value, inputs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const actual = condition.kind === 'value' ? await target.inputValue() : (await target.innerText()).trim();
    if (actual === expected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Expected ${condition.kind} condition was not reached`);
}

export async function openProfile(dataDir: string, profile: string, headless = false) {
  const directory = path.join(dataDir, 'profiles', profile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, '.flow-run.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => {
    throw new Error(`Profile '${profile}' is already in use. If a previous process crashed, verify it has stopped before removing its .flow-run.lock.`);
  });
  await lock.writeFile(String(process.pid));
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(directory, { headless, viewport: { width: 1280, height: 850 } });
  } catch (error) { await lock.close(); await unlink(lockPath); throw error; }
  return {
    context,
    page: context.pages()[0] ?? await context.newPage(),
    close: async () => { try { await context.close(); } finally { await lock.close(); await unlink(lockPath).catch(() => {}); } },
  };
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
      const visible = (el: Element) => {
        const style = getComputedStyle(el);
        return el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const elements = [...document.querySelectorAll('button,a[href],input,textarea,select,[role],h1,h2,h3')].filter(visible).slice(0, 300);
      return elements.map(el => {
        const input = el as HTMLInputElement;
        const hint = [input.type, input.name, input.id, input.autocomplete, el.getAttribute('aria-label')].join(' ');
        const secret = /password|passwd|otp|one.?time|\bpin\b|secret|token|cc-number|cc-csc/i.test(hint);
        const labels = Array.from((el as HTMLInputElement).labels ?? []).map(l => l.textContent?.trim()).join(' ');
        const labelledBy = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim();
        const name = (el.getAttribute('aria-label') || labelledBy || labels || el.textContent?.trim() || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').slice(0, 160);
        const tag = el.tagName.toLowerCase();
        const nativeRole = tag === 'button' ? 'button' : tag === 'a' ? 'link' : tag === 'select' ? 'combobox' : /^h[123]$/.test(tag) ? 'heading' : tag === 'textarea' ? 'textbox' : tag === 'input' ? ({ checkbox: 'checkbox', radio: 'radio', number: 'spinbutton', button: 'button', submit: 'button' }[input.type] ?? 'textbox') : '';
        return { tag, secret, name, label: labels, role: el.getAttribute('role') || nativeRole, id: el.id, testId: el.getAttribute('data-testid'), placeholder: el.getAttribute('placeholder'), options: tag === 'select' ? Array.from((el as HTMLSelectElement).options).map(o => ({ label: o.label, value: o.value })).slice(0, 100) : undefined };
      });
    });
    for (const control of controls) {
      if (control.secret) continue;
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
