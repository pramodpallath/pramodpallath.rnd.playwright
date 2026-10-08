import type { Page, Locator } from 'playwright';
import type { LocatorSpec } from '../schema.js';

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

