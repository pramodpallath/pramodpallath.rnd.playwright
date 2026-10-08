import type { Page, Locator } from 'playwright';

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

