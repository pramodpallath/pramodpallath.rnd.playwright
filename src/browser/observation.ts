import type { Page } from 'playwright';
import type { LocatorSpec } from '../schema.js';
import { locate } from './locators.js';

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
